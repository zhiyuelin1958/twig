// Twig VSCode 扩展：预览 *_twig.md、导出 HTML、新建、把 AI 书写规则装成各家 AI 的 skill
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tree = require('./skill/build.cjs');

const SKILL_SOURCE = path.join(__dirname, 'skill');
// 各家 AI 读取个人 skill 的目录。Copilot 也读 ~/.claude/skills，所以不再单独装
const AI_HOMES = { 'Claude Code': '.claude', 'Codex': '.codex', 'Gemini': '.gemini' };
const panels = new Map();   // 源文件 → 预览面板

function activate(context) {
  setupSkill(context);

  let timer;
  context.subscriptions.push(
    vscode.commands.registerCommand('twig.preview', uri => preview(uri)),
    vscode.commands.registerCommand('twig.exportHtml', uri => exportHtml(uri)),
    vscode.commands.registerCommand('twig.newTree', newTree),
    vscode.commands.registerCommand('twig.installSkill', () => {
      const names = installSkill();
      vscode.window.showInformationMessage('已为 ' + names.join('、') + ' 安装书写规则（Copilot 读取 Claude Code 的目录）');
    }),
    // 编辑源文件时实时刷新预览（停顿 0.3 秒后刷新）
    vscode.workspace.onDidChangeTextDocument(e => {
      const panel = panels.get(e.document.uri.toString());
      if (!panel) return;
      clearTimeout(timer);
      timer = setTimeout(() => panel.webview.postMessage(tree.parse(e.document.getText())), 300);
    })
  );
}

function sourceUri(uri) {
  return uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
}

async function preview(uri) {
  uri = sourceUri(uri);
  if (!uri) return;
  const key = uri.toString();
  if (panels.has(key)) { panels.get(key).reveal(vscode.ViewColumn.Beside); return; }

  const doc = await vscode.workspace.openTextDocument(uri);
  const panel = vscode.window.createWebviewPanel('twig', 'Twig · ' + path.basename(uri.fsPath, '.md'),
    vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = tree.toHtml(tree.parse(doc.getText()));
  panels.set(key, panel);
  panel.onDidDispose(() => panels.delete(key));
  panel.webview.onDidReceiveMessage(m => { if (m.page) openPdf(uri, m.page, m.search); });
}

// 点卡片里的页码或图表：用 PDF Viewer 扩展打开元信息 pdf 指向的论文，并跳到对应页
// 期刊页码减去 firstPage（PDF 第 1 页对应的期刊页码）再加 1，得到 PDF 页码
// 带引文 p.xxx「…」时，让 PDF Viewer 里的 pdf.js 从该页起搜索这句原文并高亮，定位到行
async function openPdf(uri, page, search) {
  if (!vscode.extensions.getExtension('mathematic.vscode-pdf')) {
    vscode.window.showWarningMessage('跳转原文需要安装 PDF Viewer 扩展（mathematic.vscode-pdf）');
    return;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  const meta = tree.parse(doc.getText());
  const file = path.resolve(path.dirname(uri.fsPath), meta.pdf);
  if (!fs.existsSync(file)) {
    vscode.window.showWarningMessage('找不到元信息 pdf 指向的文件：' + file);
    return;
  }
  const pdfPage = page - (Number(meta.firstPage) || 1) + 1;

  // 同一篇 PDF 已打开时，PDF Viewer 不会按新页码跳转，所以先关掉旧标签页，在原位置重新打开
  let column = vscode.ViewColumn.Beside;
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputCustom && tab.input.uri.fsPath === file) {
        column = group.viewColumn;
        await vscode.window.tabGroups.close(tab);
      }
    }
  }
  let fragment = 'page=' + pdfPage;
  if (search) fragment += '&search=' + encodeURIComponent(search) + '&phrase=true';
  const target = vscode.Uri.file(file).with({ fragment });
  await vscode.commands.executeCommand('vscode.openWith', target, 'pdf.view', column);
}

async function exportHtml(uri) {
  uri = sourceUri(uri);
  if (!uri) return;
  const doc = await vscode.workspace.openTextDocument(uri);
  const data = tree.parse(doc.getText());
  const output = uri.fsPath.replace(/\.md$/, '.html');
  fs.writeFileSync(output, tree.toHtml(data));
  const problems = tree.check(data);
  const note = problems.length ? `（${problems.length} 处问题：${problems.join('；')}）` : '';
  vscode.window.showInformationMessage('已导出 ' + path.basename(output) + note);
}

async function newTree() {
  const editor = vscode.window.activeTextEditor;
  const folder = editor ? path.dirname(editor.document.uri.fsPath)
    : (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath || os.homedir();
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(folder, '01_作者年份_twig.md')),
    filters: { Markdown: ['md'] }
  });
  if (!target) return;
  fs.copyFileSync(path.join(SKILL_SOURCE, '模板.md'), target.fsPath);
  await vscode.window.showTextDocument(target);
  preview(target);
}

// 书写规则要写入用户家目录，所以第一次启动先询问；用户同意后，扩展升级或新装了某家 AI 时自动更新
async function setupSkill(context) {
  const config = vscode.workspace.getConfiguration('twig');
  if (!context.globalState.get('skillAsked')) {
    context.globalState.update('skillAsked', true);
    const answer = await vscode.window.showInformationMessage(
      'Twig：是否把配套的书写规则装成 skill（twig），供本机的 Claude Code、Codex、Gemini 和 Copilot 使用？' +
      '会写入家目录下的 .claude/skills 等文件夹，之后可在设置 twig.installSkill 中关闭。',
      '安装', '不安装');
    if (answer !== '安装') return;
    await config.update('installSkill', true, vscode.ConfigurationTarget.Global);
  }
  if (!config.get('installSkill')) return;
  const version = context.extension.packageJSON.version;
  const upgraded = context.globalState.get('skillVersion') !== version;
  if (skillTargets().some(t => upgraded || !fs.existsSync(t.dir))) {
    installSkill();
    context.globalState.update('skillVersion', version);
  }
}

// 本机装了哪家 AI（家目录下有它的配置文件夹），就装到哪家；Claude Code 的目录总是装，供 Copilot 读取
function skillTargets() {
  return Object.entries(AI_HOMES)
    .filter(([name, home]) => name === 'Claude Code' || fs.existsSync(path.join(os.homedir(), home)))
    .map(([name, home]) => ({ name, dir: path.join(os.homedir(), home, 'skills', 'twig') }));
}

function installSkill() {
  const targets = skillTargets();
  for (const t of targets) {
    fs.mkdirSync(t.dir, { recursive: true });
    for (const file of fs.readdirSync(SKILL_SOURCE)) {
      fs.copyFileSync(path.join(SKILL_SOURCE, file), path.join(t.dir, file));
    }
  }
  return targets.map(t => t.name);
}

module.exports = { activate, deactivate() {} };
