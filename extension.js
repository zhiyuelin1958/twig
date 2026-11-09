// Twig VSCode 扩展：预览 *_twig.md、导出 HTML、新建（可从 Zotero 取文献信息）、把 AI 书写规则装成各家 AI 的 skill
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tree = require('./skill/build.cjs');
const zotero = require('./zotero.js');

const SKILL_SOURCE = path.join(__dirname, 'skill');
// 各家 AI 读取个人 skill 的目录。Copilot 也读 ~/.claude/skills，所以不再单独装。与 uninstall.js 中的 AI_HOMES 相同
const AI_HOMES = { 'Claude Code': '.claude', 'Codex': '.codex', 'Gemini': '.gemini' };
const panels = new Map();   // 源文件 → 预览面板

function activate(context) {
  setupSkill(context);

  let timer;
  context.subscriptions.push(
    vscode.commands.registerCommand('twig.preview', uri => preview(uri)),
    vscode.commands.registerCommand('twig.exportHtml', uri => exportHtml(uri)),
    vscode.commands.registerCommand('twig.newTree', newTree),
    // 手动安装同时打开设置，之后扩展升级时规则跟着更新
    vscode.commands.registerCommand('twig.installSkill', async () => {
      await vscode.workspace.getConfiguration('twig').update('installSkill', true, vscode.ConfigurationTarget.Global);
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

// 新建：先从 Zotero 选论文（也可选空白模板），自动填好标题、引文、pdf、firstPage，再选保存位置
async function newTree() {
  const picked = await pickPaper();                // undefined：取消；picked.item 为 null：空白模板
  if (!picked) return;
  const item = picked.item;
  const pdf = item ? await pickPdf(item) : '';
  if (pdf === undefined) return;
  const folder = await twigFolder(item, pdf, picked.trail);
  if (folder === undefined) return;

  // 先建好文件夹，保存对话框才能定位过去；取消时删掉刚建的空文件夹
  let existing = folder;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  fs.mkdirSync(folder, { recursive: true });
  const number = fs.readdirSync(folder).filter(f => f.endsWith('_twig.md')).length + 1;   // 编号按已有文件顺延
  const name = item ? zotero.fileName(item, number) : String(number).padStart(2, '0') + '_作者年份_twig.md';
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(folder, name)),
    filters: { Markdown: ['md'] }
  });
  if (!target) {
    for (let d = folder; d !== existing && fs.readdirSync(d).length === 0; d = path.dirname(d)) fs.rmdirSync(d);
    return;
  }

  let text = fs.readFileSync(path.join(SKILL_SOURCE, '模板.md'), 'utf8');
  if (item) text = zotero.fill(text, item, pdf, target.fsPath);
  fs.writeFileSync(target.fsPath, text);
  await vscode.window.showTextDocument(target);
  preview(target);
}

// Twig 文件放在哪：根目录下按 Zotero 分类建子文件夹，如 Twig阅读整理/大气科学文献1/2026暑假
// 根目录取设置 twig.folder，没设时为 Zotero 数据目录旁的 Twig阅读整理；空白模板、推不出数据目录时用当前文件夹
// 子文件夹：浏览时点过的那条路径；搜到的论文按它所在的分类，在多个分类里时让用户选
async function twigFolder(item, pdf, trail) {
  const editor = vscode.window.activeTextEditor;
  const current = editor ? path.dirname(editor.document.uri.fsPath)
    : (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath || os.homedir();
  const data = pdf && zotero.dataDir(pdf);
  const root = vscode.workspace.getConfiguration('twig').get('folder') || (data && path.join(path.dirname(data), 'Twig阅读整理'));
  if (!root) return current;
  if (!item) return root;

  let names = trail;
  if (!names.length) {
    const paths = await zotero.folderPaths(item);
    if (paths.length > 1) {
      const chosen = await vscode.window.showQuickPick(paths.map(p => ({ label: p.join(' › '), names: p })),
        { placeHolder: '这篇论文在多个分类里，选 Twig 文件放在哪个文件夹' });
      if (!chosen) return undefined;
      names = chosen.names;
    } else {
      names = paths[0] || [];
    }
  }
  return path.join(root, ...names.map(n => n.replace(/[\\/:*?"<>|]/g, '_')));   // 去掉文件夹名里不允许的字符
}

// 选论文的搜索框，两种用法：
// - 不输入时按文件夹逐层浏览：顶层列出文件夹和最近改动的 5 篇，点文件夹进入，“返回上一级”退出
// - 输入标题、作者或年份时搜整个文献库；清空输入框回到原来所在的文件夹
// 每篇论文一行：作者 (年份) 在前，标题在后；“空白模板”总在最下面
function pickPaper() {
  const separator = label => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const paper = it => ({ label: zotero.label(it), description: it.data.title, alwaysShow: true, item: it });
  const blank = { label: '$(file) 空白模板', alwaysShow: true, item: null };
  const tail = [separator('不用 Zotero'), blank];
  // 连不上 Zotero 时显示在列表顶部的说明，选中它不做任何事
  const notices = {
    offline: { label: '$(info) 没有连上 Zotero', detail: '没装 Zotero 的话，直接选下面的空白模板；用 Zotero 的话，先打开它' },
    disabled: { label: '$(info) Zotero 没有开放本地接口', detail: '在 Zotero 设置 → 高级 勾选“允许此计算机上的其他应用程序与 Zotero 通信”；或直接选下面的空白模板' }
  };
  const box = vscode.window.createQuickPick();
  box.placeholder = '搜索 Zotero 文献（标题、作者、年份），或进入文件夹';
  box.items = tail;
  const trail = [];                                // 当前所在的文件夹，从顶层往下
  let timer, latest = 0;

  // 取数据并显示；只显示最后一次请求的结果
  async function show(load) {
    const id = ++latest;
    box.busy = true;
    try {
      const items = await load();
      if (id === latest) box.items = [...items, ...tail];
    } catch (e) {
      if (id === latest) {
        box.items = [{ ...(notices[e.reason] || notices.offline), alwaysShow: true, notice: true }, ...tail];
        box.activeItems = [blank];                 // 默认选中空白模板，回车直接新建
      }
    }
    if (id === latest) box.busy = false;
  }

  function browse() {
    const here = trail[trail.length - 1];
    box.title = here ? trail.map(f => f.name).join(' › ') : 'Zotero 文献库';
    show(async () => {
      const folders = (await zotero.folders(here && here.key)).map(f => ({
        label: '$(folder) ' + f.name,
        description: [f.folders && f.folders + ' 个子文件夹', f.papers && f.papers + ' 篇'].filter(Boolean).join(' · '),   // 数量为 0 的不显示
        alwaysShow: true, folder: f
      }));
      const list = here ? await zotero.folderPapers(here.key) : await zotero.recent(5);
      return [
        ...(here ? [{ label: '$(arrow-left) 返回上一级', alwaysShow: true, back: true }] : []),
        ...folders,
        ...(list.length ? [separator(here ? '论文' : '最近改动'), ...list.map(paper)] : [])
      ];
    });
  }

  box.onDidChangeValue(q => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!q.trim()) return browse();
      box.title = '搜索整个文献库';
      show(async () => (await zotero.search(q)).map(paper));
    }, 300);
  });
  browse();
  box.show();
  return new Promise(resolve => {
    box.onDidAccept(() => {
      const chosen = box.selectedItems[0];
      if (!chosen || chosen.notice) return;
      if (chosen.folder || chosen.back) {          // 进入或退出文件夹，搜索框不关
        chosen.folder ? trail.push(chosen.folder) : trail.pop();
        box.value = '';
        browse();
        return;
      }
      // 浏览时点过的文件夹路径；搜到的论文不一定在当前文件夹里，路径留空，之后按论文所在分类定
      resolve({ item: chosen.item, trail: box.value.trim() ? [] : trail.map(f => f.name) });
      box.dispose();
    });
    box.onDidHide(() => { resolve(undefined); box.dispose(); });
  });
}

// 一篇文献有多个 PDF（如正文和补充材料）时让用户选；没有 PDF 时 pdf 一项留空
async function pickPdf(item) {
  const list = await zotero.pdfs(item.key);
  if (list.length === 0) {
    vscode.window.showWarningMessage('这篇文献在 Zotero 里没有 PDF，pdf 一项留空，可以之后自己填。');
    return '';
  }
  if (list.length === 1) return list[0].file;
  const chosen = await vscode.window.showQuickPick(
    list.map(p => ({ label: path.basename(p.file), description: p.title, file: p.file })),
    { placeHolder: '这篇文献有多个 PDF，选正文那一个' });
  return chosen && chosen.file;
}

// 书写规则要写入用户家目录，所以第一次启动先询问；用户同意后，扩展升级或新装了某家 AI 时自动更新
async function setupSkill(context) {
  const config = vscode.workspace.getConfiguration('twig');
  if (!context.globalState.get('skillAsked')) {
    context.globalState.update('skillAsked', true);
    const answer = await vscode.window.showInformationMessage(
      'Twig：安装配套的书写规则后，对 AI 说“开始读某篇论文”，它就会边讲解边维护追问树、标出处、读完出题。' +
      '规则会写入家目录下的 .claude/skills 等文件夹，供 Claude Code、Codex、Gemini、Copilot 使用。',
      '安装（推荐）', '不安装');
    if (answer !== '安装（推荐）') return;
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
