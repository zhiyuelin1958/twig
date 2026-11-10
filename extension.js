// Twig VSCode 扩展：预览 *_twig.md 与灵感笔记 *_idea.md、导出 HTML、新建（可从文献库取文献信息）、新建灵感笔记、
// 按文献库分类整理文件夹、把 AI 书写规则装成各家 AI 的 skill
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tree = require('./skill/build.cjs');
const library = require('./library.js');

const SKILL_SOURCE = path.join(__dirname, 'skill');
// 各家 AI 读取个人 skill 的目录。Copilot 也读 ~/.claude/skills，所以不再单独装。与 uninstall.js 中的 AI_HOMES 相同
const AI_HOMES = { 'Claude Code': '.claude', 'Codex': '.codex', 'Gemini': '.gemini' };
const panels = new Map();   // 源文件 → 预览面板
// 工作区下的默认文件夹：追问图和灵感笔记各一个；0.5.0 以前追问图的文件夹叫 Twig阅读整理，见 renameOldFolder
const TWIG_DIR = 'Twig追问整理', OLD_TWIG_DIR = 'Twig阅读整理', IDEA_DIR = 'Twig灵感笔记';

function activate(context) {
  setupSkill(context);
  renameOldFolder(context);

  let timer;
  context.subscriptions.push(
    vscode.commands.registerCommand('twig.preview', uri => preview(uri)),
    vscode.commands.registerCommand('twig.exportHtml', uri => exportHtml(uri)),
    vscode.commands.registerCommand('twig.newTree', newTree),
    vscode.commands.registerCommand('twig.newIdea', newIdea),
    vscode.commands.registerCommand('twig.syncFolders', syncFolders),
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
      timer = setTimeout(() => panel.webview.postMessage(tree.parse(e.document.getText(), e.document.uri.fsPath)), 300);
    })
  );
}

function sourceUri(uri) {
  return uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
}

// focus：打开后定位到的节点 id（追问图）或标题（灵感笔记），从别的文件点链接过来时给出
async function preview(uri, focus) {
  uri = sourceUri(uri);
  if (!uri) return;
  const key = uri.toString();
  if (panels.has(key)) {
    panels.get(key).reveal(vscode.ViewColumn.Beside);
    if (focus) panels.get(key).webview.postMessage({ focus });
    return;
  }

  const doc = await vscode.workspace.openTextDocument(uri);
  const panel = vscode.window.createWebviewPanel('twig', 'Twig · ' + path.basename(uri.fsPath, '.md'),
    vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
  const data = tree.parse(doc.getText(), uri.fsPath);
  if (focus) data.focus = focus;                   // 面板刚建好时收不到消息，写进页面数据
  panel.webview.html = tree.toHtml(data);
  panels.set(key, panel);
  panel.onDidDispose(() => panels.delete(key));
  panel.webview.onDidReceiveMessage(m => {
    if (m.page || m.ref) openPdf(uri, m.page, m.search, m.ref);
    if (m.url) openLink(uri, m.url);
  });
}

// 卡片里的链接 [文字](地址)：网址用浏览器打开；其余是本机路径（相对 Twig 文件，或绝对路径），解析见 build.cjs 的 localLink
// - PDF：用 PDF Viewer 打开，#page=5 跳到 PDF 第 5 页；没装 PDF Viewer 时用系统默认程序
// - 追问图 *_twig.md、灵感笔记 *_idea.md：打开它的预览，#节点id 打开那张卡片，灵感笔记的 #标题 滚到该标题
// - 其他文本文件（md、tex、py 等）：在旁边的编辑器打开，#L42 跳到第 42 行，Markdown 的 #标题 跳到该标题
// - 其余（文件夹、docx、图片等）：用系统默认程序打开，文件夹在资源管理器中打开
async function openLink(uri, target) {
  if (!tree.isLocal(target)) {
    vscode.env.openExternal(vscode.Uri.parse(target));
    return;
  }
  const { file, anchor } = tree.localLink(target, uri.fsPath);
  if (!fs.existsSync(file)) { vscode.window.showWarningMessage('找不到链接的本机文件：' + file); return; }
  if (tree.isTwig(file) || tree.isIdea(file)) return preview(vscode.Uri.file(file), anchor.trim());
  const external = () => vscode.env.openExternal(vscode.Uri.file(file));
  if (fs.statSync(file).isDirectory()) return external();
  if (/\.pdf$/i.test(file)) return hasPdfViewer() ? showPdf(file, +(anchor.match(/^page=(\d+)/) || [])[1] || 1) : external();
  let doc;
  try { doc = await vscode.workspace.openTextDocument(file); } catch (e) { return external(); }   // 二进制文件打不开为文本
  let line = 0;
  if (/^L\d+$/.test(anchor)) line = Math.min(+anchor.slice(1) - 1, doc.lineCount - 1);
  else if (anchor) {
    // 先找完全相同的标题，没有时取第一个以它开头的，如 #3.2 跳到“### 3.2 碰并：…”
    const heading = anchor.trim();
    const titles = doc.getText().split(/\r?\n/).map(l => (l.match(/^#{1,6}\s+(.*?)\s*$/) || [])[1]);
    let found = titles.indexOf(heading);
    if (found < 0) found = titles.findIndex(t => t !== undefined && t.startsWith(heading));
    if (found >= 0) line = found;
    else vscode.window.showInformationMessage('没找到标题“' + heading + '”，打开了文件开头');
  }
  const at = new vscode.Range(line, 0, line, 0);
  const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, selection: at });
  editor.revealRange(at, vscode.TextEditorRevealType.AtTop);
}

// 点卡片里的页码或图表：用 PDF Viewer 扩展打开元信息 pdf 指向的论文，并跳到对应页
// 期刊页码减去 firstPage（PDF 第 1 页对应的期刊页码）再加 1，得到 PDF 页码；带引文 p.xxx「…」时定位到这句原文所在的行（见 showPdf）
// ref 是元信息 refs 中的论文名字（点【论文】标签）：改开那篇登记的本机 PDF，按它的第 1 页期刊页码换算；没有 page 时打开第 1 页
async function openPdf(uri, page, search, ref) {
  const doc = await vscode.workspace.openTextDocument(uri);
  const meta = tree.parse(doc.getText());
  let file, first;
  if (ref) {
    const r = meta.refs[ref];
    if (!r) return;
    file = r.pdf ? path.resolve(path.dirname(uri.fsPath), r.pdf) : '';
    if (!file || !fs.existsSync(file) || !hasPdfViewer()) {
      const why = file && !fs.existsSync(file) ? '找不到 ' + ref + ' 的本机 PDF：' + file : '打开本机 PDF 需要安装 PDF Viewer 扩展（mathematic.vscode-pdf）';
      if (r.url) { vscode.window.showInformationMessage(why + '，改在浏览器打开'); vscode.env.openExternal(vscode.Uri.parse(r.url)); }
      else vscode.window.showWarningMessage(why);
      return;
    }
    first = r.firstPage;
  } else {
    if (!hasPdfViewer()) {
      vscode.window.showWarningMessage('跳转原文需要安装 PDF Viewer 扩展（mathematic.vscode-pdf）');
      return;
    }
    file = await findPdf(meta, uri.fsPath);
    if (!file) return;
    first = Number(meta.firstPage);
  }
  await showPdf(file, page ? page - (first || 1) + 1 : 1, search);
}

function hasPdfViewer() { return !!vscode.extensions.getExtension('mathematic.vscode-pdf'); }

// 用 PDF Viewer 打开 PDF 第 pdfPage 页；给出 search 时让 pdf.js 从该页起搜索这句原文并高亮
// 同一篇 PDF 已打开时，PDF Viewer 不会按新页码跳转，所以先关掉旧标签页，在原位置重新打开
async function showPdf(file, pdfPage, search) {
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

// 论文 PDF 的本机路径：先按元信息 pdf；那里没有文件（如在另一台电脑上建的，PDF 位置不同）时，按文献编号向当前文献库查
// 文献库里有多个 PDF 时优先取与 pdf 同名的，否则让用户选；不改写 Twig 文件里的 pdf，免得多台电脑来回改。找不到时提示并返回空
async function findPdf(meta, twigFile) {
  const file = meta.pdf ? path.resolve(path.dirname(twigFile), meta.pdf) : '';
  if (file && fs.existsSync(file)) return file;
  const lib = currentLibrary();
  const missing = file ? '找不到元信息 pdf 指向的文件：' + file : '元信息 pdf 没有填';
  if (!meta[lib.field]) { vscode.window.showWarningMessage(missing); return ''; }
  let list;
  try {
    list = (await lib.pdfs(meta[lib.field])).filter(p => fs.existsSync(p.file));
  } catch (e) {
    const h = library.explain(lib, e);
    vscode.window.showWarningMessage(missing + '。按文献编号查 ' + lib.name + ' 也没成功：' + (h ? h.label + '，' + h.detail : e.message));
    return '';
  }
  if (!list.length) { vscode.window.showWarningMessage(missing + '，' + lib.name + ' 里这篇文献也没有本机能打开的 PDF'); return ''; }
  const same = file && list.find(p => path.basename(p.file).toLowerCase() === path.basename(file).toLowerCase());
  return same ? same.file : (await choosePdfOf(list)) || '';
}

async function exportHtml(uri) {
  uri = sourceUri(uri);
  if (!uri) return;
  const doc = await vscode.workspace.openTextDocument(uri);
  const data = tree.parse(doc.getText(), uri.fsPath);
  const output = uri.fsPath.replace(/\.md$/, '.html');
  fs.writeFileSync(output, tree.toHtml(data));
  const problems = tree.check(data, uri.fsPath);
  const note = problems.length ? `（${problems.length} 处问题：${problems.join('；')}）` : '';
  vscode.window.showInformationMessage('已导出 ' + path.basename(output) + note);
}

// 当前文献库，按设置 twig.library 取；用 .bib 文件时，twig.bibFile 写相对路径的按当前工作区解析
function currentLibrary() {
  const config = vscode.workspace.getConfiguration('twig');
  let bibFile = config.get('bibFile');
  if (bibFile && !path.isAbsolute(bibFile)) {
    const ws = currentWorkspace();
    bibFile = ws ? path.join(ws.uri.fsPath, bibFile) : '';
  }
  return library.open(config.get('library'), { bibFile });
}

// 当前工作区：当前文件所在的那个，否则第一个；没开工作区时为空
function currentWorkspace() {
  const editor = vscode.window.activeTextEditor;
  return (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)) || (vscode.workspace.workspaceFolders || [])[0];
}

// 新建：先从文献库选论文，自动填好标题、引文、pdf、firstPage，再选保存位置
// 不用文献库时可从 PDF 新建（只填 pdf），或用空白模板
async function newTree() {
  const lib = currentLibrary();
  const picked = await pickPaper(lib);             // undefined：取消；picked.item 为 null：从 PDF 新建或空白模板
  if (!picked) return;
  const item = picked.item;
  const pdf = item ? await pickPdf(lib, item) : picked.fromPdf ? await choosePdf() : '';
  if (pdf === undefined) return;
  const folder = await twigFolder(lib, item, pdf, picked.trail);
  if (folder === undefined) return;

  // 先建好文件夹，保存对话框才能定位过去；取消时删掉刚建的空文件夹
  let existing = folder;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  fs.mkdirSync(folder, { recursive: true });
  const number = fs.readdirSync(folder).filter(f => f.endsWith('_twig.md')).length + 1;   // 编号按已有文件顺延
  const name = item ? library.fileName(item, number) : String(number).padStart(2, '0') + '_作者年份_twig.md';
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(folder, name)),
    filters: { Markdown: ['md'] }
  });
  if (!target) {
    for (let d = folder; d !== existing && fs.readdirSync(d).length === 0; d = path.dirname(d)) fs.rmdirSync(d);
    return;
  }

  let text = fs.readFileSync(path.join(SKILL_SOURCE, '模板.md'), 'utf8');
  if (item) text = library.fill(text, lib, item, pdf, target.fsPath);
  else if (pdf) text = library.fillPdf(text, pdf, target.fsPath);
  fs.writeFileSync(target.fsPath, text);
  await vscode.window.showTextDocument(target);
  preview(target);
}

// Twig 文件放在哪：根目录下按文献库分类建子文件夹，如 Twig追问整理/大气科学文献1/2026暑假
// 根目录见 twigRoot；取不到时（没开工作区，又推不出文献库的位置）用当前文件夹
// 不是从文献库选的论文：当前文件夹在根目录之下（如正开着同一主题的 Twig 文件）时用当前文件夹，否则用根目录
// 子文件夹：浏览时点过的那条路径；搜到的论文按它所在的分类，在多个分类里时让用户选
async function twigFolder(lib, item, pdf, trail) {
  const editor = vscode.window.activeTextEditor;
  const ws = currentWorkspace();
  const current = editor ? path.dirname(editor.document.uri.fsPath) : ws ? ws.uri.fsPath : os.homedir();
  const root = await twigRoot(item || pdf ? lib : null, pdf);
  if (!root) return current;
  if (!item) {
    const rel = path.relative(root, current);
    return rel.startsWith('..') || path.isAbsolute(rel) ? root : current;
  }

  let names = trail;
  if (!names.length) {
    const paths = await lib.folderPaths(item);
    if (paths.length > 1) {
      const chosen = await vscode.window.showQuickPick(paths.map(p => ({ label: p.join(' › '), names: p })),
        { placeHolder: '这篇论文在多个分类里，选 Twig 文件放在哪个文件夹' });
      if (!chosen) return undefined;
      names = chosen.names;
    } else {
      names = paths[0] || [];
    }
  }
  return categoryDir(root, names);
}

// Twig 文件的根目录，依次取：设置 twig.folder；工作区（当前文件所在的那个，否则第一个）下的 Twig追问整理；
// 没开工作区时为文献库旁的 Twig追问整理（见各文献库的 home；不给 lib 时不取）；都没有时为空
// 用户没同意把旧的 Twig阅读整理 改名时（见 renameOldFolder），继续用旧文件夹
async function twigRoot(lib, pdf) {
  const setting = vscode.workspace.getConfiguration('twig').get('folder');
  if (setting) return setting;
  const ws = currentWorkspace();
  let home = ws && ws.uri.fsPath;
  if (!home) try { home = lib && await lib.home(pdf); } catch (e) { }   // 文献库连不上时当作推不出
  if (!home) return null;
  const now = path.join(home, TWIG_DIR), old = path.join(home, OLD_TWIG_DIR);
  return !fs.existsSync(now) && fs.existsSync(old) ? old : now;
}

// 灵感笔记的根目录：设置 twig.ideaFolder，否则为工作区下的 Twig灵感笔记；没开工作区时为空
function ideaRoot() {
  const setting = vscode.workspace.getConfiguration('twig').get('ideaFolder');
  if (setting) return setting;
  const ws = currentWorkspace();
  return ws ? path.join(ws.uri.fsPath, IDEA_DIR) : null;
}

// 0.5.0 起追问图的默认文件夹改名为 Twig追问整理：工作区里只有旧的 Twig阅读整理 时问一次是否改名
// 只改文件夹名，层级不变，Twig 文件里指向 PDF 的相对路径不受影响；文件夹外的 Twig 文件（追问图、灵感笔记）里指向它的链接跟着改写
async function renameOldFolder(context) {
  if (vscode.workspace.getConfiguration('twig').get('folder')) return;
  for (const ws of vscode.workspace.workspaceFolders || []) {
    const old = path.join(ws.uri.fsPath, OLD_TWIG_DIR), now = path.join(ws.uri.fsPath, TWIG_DIR);
    const asked = 'renameAsked:' + old;
    if (!fs.existsSync(old) || fs.existsSync(now) || context.globalState.get(asked)) continue;
    context.globalState.update(asked, true);
    const answer = await vscode.window.showInformationMessage(
      `Twig 0.5.0 新增了灵感笔记（放在 ${IDEA_DIR}），追问图的文件夹改名为 ${TWIG_DIR}。现在把 ${OLD_TWIG_DIR} 改名吗？` +
      '里面的文件和指向 PDF 的路径都不受影响；不改名也能照常使用。', '改名', '保持原名');
    if (answer !== '改名') continue;
    const edit = new vscode.WorkspaceEdit();       // 由 VSCode 改名，开着的编辑器跟着换到新位置
    edit.renameFile(vscode.Uri.file(old), vscode.Uri.file(now));
    if (!await vscode.workspace.applyEdit(edit)) { vscode.window.showWarningMessage('改名失败：' + old); continue; }
    for (const [key, panel] of panels) if (vscode.Uri.parse(key).fsPath.startsWith(old + path.sep)) panel.dispose();
    const moved = f => f.startsWith(old + path.sep) ? now + f.slice(old.length) : f;
    const ideas = path.join(ws.uri.fsPath, IDEA_DIR);
    fixLinks(fs.existsSync(ideas) ? [ideas] : [], moved);
  }
}

// 文件移走后，改写 dirs 下各 Twig 文件（追问图、灵感笔记）里指向它们的本机链接；moved 把旧路径换成新路径
function fixLinks(dirs, moved) {
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir, { recursive: true })) {
      const file = path.join(dir, f);
      if (!tree.isTwig(file) && !tree.isIdea(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      const now = tree.relocate(text, file, file, moved);
      if (now !== text) fs.writeFileSync(file, now);
    }
  }
}

// 新建灵感笔记：在灵感笔记根目录下选一个主题文件夹（或新建），填简题，从 idea-template.md 生成 <编号>_<简题>_idea.md
// 当前编辑器开着追问图时，在“起因”里放一个指回它的链接，AI 再补具体节点
async function newIdea() {
  const root = ideaRoot();
  if (!root) { vscode.window.showWarningMessage('先打开一个工作区，或在设置里填 twig.ideaFolder'); return; }
  const topics = fs.existsSync(root)
    ? fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : [];
  const chosen = await vscode.window.showQuickPick([
    ...topics.map(t => ({ label: '$(folder) ' + t, dir: path.join(root, t) })),
    { label: '$(new-folder) 新建主题文件夹…', create: true },
    { label: '$(root-folder) 直接放在 ' + path.basename(root), dir: root }
  ], { placeHolder: '灵感笔记放在哪个主题下' });
  if (!chosen) return;
  let dir = chosen.dir;
  if (chosen.create) {
    const name = await vscode.window.showInputBox({ prompt: '主题文件夹名', validateInput: v => /[\\/:*?"<>|]/.test(v) ? '不能含 \\ / : * ? " < > |' : '' });
    if (!name || !name.trim()) return;
    dir = path.join(root, name.trim());
  }
  const title = await vscode.window.showInputBox({ prompt: '简题：这条灵感想做什么，如“按物质层建立云滴谱方程”' });
  if (!title || !title.trim()) return;
  fs.mkdirSync(dir, { recursive: true });
  const number = String(fs.readdirSync(dir).filter(f => tree.isIdea(f)).length + 1).padStart(2, '0');   // 编号按已有文件顺延
  const file = path.join(dir, number + '_' + title.trim().replace(/[\\/:*?"<>|\s]+/g, '') + '_idea.md');
  if (fs.existsSync(file)) { vscode.window.showWarningMessage('已有同名文件：' + file); return; }

  let text = fs.readFileSync(path.join(SKILL_SOURCE, 'idea-template.md'), 'utf8').replace(/^# .*$/m, '# ' + title.trim());
  const editor = vscode.window.activeTextEditor;
  const from = editor && editor.document.uri.fsPath;
  if (from && tree.isTwig(from)) {
    const rel = path.relative(dir, from).split(path.sep).join('/');
    const name = tree.parse(editor.document.getText(), from).title || path.basename(from, '.md');
    text = text.replace(/^(起因：).*$/m, (_, key) => key + '读 [' + name + '](' + (/[\s()<>]/.test(rel) ? '<' + rel + '>' : rel) + ') 时想到。');
  }
  fs.writeFileSync(file, text);
  await vscode.window.showTextDocument(vscode.Uri.file(file));
  preview(vscode.Uri.file(file));
}

// 文献库分类对应的文件夹，names 为从顶层往下的分类名；去掉文件夹名里不允许的字符
function categoryDir(root, names) {
  return path.join(root, ...names.map(n => n.replace(/[\\/:*?"<>|]/g, '_')));
}

// 选论文的搜索框，两种用法：
// - 不输入时按文件夹逐层浏览：顶层列出文件夹和最近改动的 5 篇，点文件夹进入，“返回上一级”退出
// - 输入标题、作者或年份时搜整个文献库；清空输入框回到原来所在的文件夹
// 每篇论文一行：作者 (年份) 在前，标题在后；“从 PDF 新建”“空白模板”总在最下面
function pickPaper(lib) {
  const separator = label => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const paper = p => ({ label: library.label(p), description: p.title, alwaysShow: true, item: p });
  const fromPdf = { label: '$(file-pdf) 从 PDF 新建', description: '只填 PDF 路径，引文等由 AI 读 PDF 后填', alwaysShow: true, item: null, fromPdf: true };
  const blank = { label: '$(file) 空白模板', alwaysShow: true, item: null };
  const tail = [separator('不用 ' + lib.name), fromPdf, blank];
  // 读不了文献库时显示在列表顶部的说明（文字见各文献库的 help），选中它不做任何事
  const notice = e => {
    const h = library.explain(lib, e) || { label: '读取 ' + lib.name + ' 出错', detail: e.message };
    return { label: '$(info) ' + h.label, detail: h.detail + '；或选下面的“从 PDF 新建”', alwaysShow: true, notice: true };
  };
  const box = vscode.window.createQuickPick();
  box.placeholder = '搜索 ' + lib.name + ' 文献（标题、作者、年份），或进入文件夹';
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
        box.items = [notice(e), ...tail];
        box.activeItems = [fromPdf];               // 默认选中“从 PDF 新建”，回车直接选 PDF
      }
    }
    if (id === latest) box.busy = false;
  }

  function browse() {
    const here = trail[trail.length - 1];
    box.title = here ? trail.map(f => f.name).join(' › ') : lib.name + ' 文献库';
    show(async () => {
      const folders = (await lib.folders(here && here.key)).map(f => ({
        label: '$(folder) ' + f.name,
        description: [f.folders && f.folders + ' 个子文件夹', f.papers && f.papers + ' 篇'].filter(Boolean).join(' · '),   // 数量为 0 的不显示
        alwaysShow: true, folder: f
      }));
      const list = here ? await lib.folderPapers(here.key) : await lib.recent(5);
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
      show(async () => (await lib.search(q)).map(paper));
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
      resolve({ item: chosen.item, fromPdf: chosen.fromPdf, trail: box.value.trim() ? [] : trail.map(f => f.name) });
      box.dispose();
    });
    box.onDidHide(() => { resolve(undefined); box.dispose(); });
  });
}

// 一篇文献有多个 PDF（如正文和补充材料）时让用户选；没有 PDF 时 pdf 一项留空
async function pickPdf(lib, item) {
  const list = await lib.pdfs(item.key);
  if (list.length === 0) {
    vscode.window.showWarningMessage('这篇文献在 ' + lib.name + ' 里没有 PDF，pdf 一项留空，可以之后自己填。');
    return '';
  }
  return choosePdfOf(list);
}

// 一篇文献的多个 PDF 里选一个（只有一个时直接用它）；取消时返回 undefined
async function choosePdfOf(list) {
  if (list.length === 1) return list[0].file;
  const chosen = await vscode.window.showQuickPick(
    list.map(p => ({ label: path.basename(p.file), description: p.title, file: p.file })),
    { placeHolder: '这篇文献有多个 PDF，选正文那一个' });
  return chosen && chosen.file;
}

// 从 PDF 新建：弹出选文件框选一篇 PDF；取消时返回 undefined
async function choosePdf() {
  const files = await vscode.window.showOpenDialog({ filters: { PDF: ['pdf'] }, openLabel: '用这篇论文新建' });
  return files && files[0].fsPath;
}

// 整理文件夹：文献库里分类改名、移动，或论文换了分类后，把 Twig 文件移到论文现在所在分类的文件夹
// 同一前缀的文件（如 01_Morrison等2009_提问清单.md、导出的 .html）一起移；移动后改写 pdf、refs 里的 PDF 路径和正文本机链接的相对路径，没写文献编号的补上；
// 灵感笔记和其他 Twig 文件里指向移走文件的链接也跟着改
// 不动的：已在论文所在的某个分类文件夹里的；对应不上文献库里的文献、文献已删除或不在任何分类里的，列在结果里
async function syncFolders() {
  const lib = currentLibrary();
  let plan;
  try {
    plan = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Twig：对照 ' + lib.name + ' 分类' }, () => planMoves(lib));
  } catch (e) {
    const h = library.explain(lib, e);
    vscode.window.showWarningMessage(h ?'整理文件夹需要读取 ' + lib.name + '：' + h.label + '。' + h.detail : e.message);
    return;
  }
  const { root, moves, skipped } = plan;

  for (const m of moves) {                         // 论文在多个分类里时选一个
    if (m.dirs.length === 1) { m.to = m.dirs[0]; continue; }
    const chosen = await vscode.window.showQuickPick(m.dirs.map(d => ({ label: path.relative(root, d), dir: d })),
      { placeHolder: m.label + ' 在多个分类里，选 Twig 文件移到哪个文件夹' });
    m.to = chosen && chosen.dir;
  }
  const todo = moves.filter(m => m.to);
  let moved = 0;
  if (todo.length) {
    const picked = await vscode.window.showQuickPick(todo.map(m => ({
      label: path.basename(m.file),
      description: path.relative(root, path.dirname(m.file)) + ' → ' + path.relative(root, m.to),
      picked: true, move: m
    })), { canPickMany: true, placeHolder: '按 ' + lib.name + ' 分类移动这些 Twig 文件（同一前缀的提问清单、参考答案一起移）' });
    if (!picked) return;
    const pairs = [];                              // 移动过的文件：[旧路径, 新路径]
    for (const { move } of picked) {
      const problem = await moveTwig(move, root, lib.field, pairs);
      if (problem) skipped.push(path.relative(root, move.file) + '：' + problem);
      else moved++;
    }
    // 灵感笔记和其他 Twig 文件里指向移走文件的链接跟着改
    const after = f => { const p = pairs.find(([a]) => library.samePath(a, f)); return p ? p[1] : f; };
    if (pairs.length) fixLinks([ideaRoot(), root].filter(d => d && fs.existsSync(d)), after);
  }
  const message = moved ? `已移动 ${moved} 篇 Twig` : '没有移动 Twig 文件';
  if (skipped.length) vscode.window.showInformationMessage(`${message}，${skipped.length} 篇没动`, { modal: true, detail: skipped.join('\n') });
  else vscode.window.showInformationMessage(message + (todo.length ? '' : '，都已在论文所在分类的文件夹里'));
}

// 找出根目录下要移动的 Twig 文件：{ root, moves: [{ file, key, label, dirs }], skipped }，dirs 为论文所在各分类的文件夹
async function planMoves(lib) {
  const root = await twigRoot(lib);
  if (!root || !fs.existsSync(root)) throw new Error('找不到 Twig 文件的根目录' + (root ? '：' + root : '，请在设置里填 twig.folder'));
  const all = await lib.collections();
  const moves = [], skipped = [];
  const files = fs.readdirSync(root, { recursive: true }).filter(f => f.endsWith('_twig.md')).map(f => path.join(root, f));
  for (const file of files) {
    const name = path.relative(root, file);
    const key = await lib.paperKey(tree.parse(fs.readFileSync(file, 'utf8')), file);
    const p = key && await lib.item(key);
    if (!p) { skipped.push(name + '：' + (key ? lib.name + ' 里已删除这篇文献' : '对应不到 ' + lib.name + ' 里的文献')); continue; }
    const dirs = (await lib.folderPaths(p, all)).map(names => categoryDir(root, names));
    if (!dirs.length) { skipped.push(name + '：这篇文献不在任何分类里'); continue; }
    if (dirs.some(d => library.samePath(d, path.dirname(file)))) continue;
    moves.push({ file, key: p.key, label: library.label(p), dirs });
  }
  return { root, moves, skipped };
}

// 移动一篇 Twig 及同一前缀的文件到 m.to；返回没移动的原因，移好时返回空
// 编号在目标文件夹里已被占用时顺延，提问清单、参考答案第一行标题里的编号跟着改；field 为文献库存编号的元信息字段
// pairs 收集移动过的文件 [旧路径, 新路径]，供之后改写其他文件里指向它们的链接
async function moveTwig(m, root, field, pairs) {
  const from = path.dirname(m.file);
  const prefix = path.basename(m.file).slice(0, -'twig.md'.length);         // 如 01_Morrison等2009_
  const group = fs.readdirSync(from).filter(f => f.startsWith(prefix));
  const uris = group.map(f => vscode.Uri.file(path.join(from, f)));
  if (vscode.workspace.textDocuments.some(d => d.isDirty && uris.some(u => library.samePath(u.fsPath, d.uri.fsPath)))) {
    return '有未保存的修改，保存后再整理';
  }

  fs.mkdirSync(m.to, { recursive: true });
  const used = fs.readdirSync(m.to).map(f => (f.match(/^(\d+)_.*_twig\.md$/) || [])[1]).filter(Boolean).map(Number);
  const number = prefix.match(/^(\d+)_/);
  const renumber = number && used.includes(+number[1]);
  const newNumber = renumber ? String(Math.max(...used) + 1).padStart(2, '0') : number && number[1];
  const newPrefix = renumber ? newNumber + prefix.slice(number[1].length) : prefix;
  const target = f => path.join(m.to, newPrefix + f.slice(prefix.length));
  if (group.some(f => fs.existsSync(target(f)))) return '目标文件夹里已有同名文件';

  const edit = new vscode.WorkspaceEdit();         // 由 VSCode 改名，开着的编辑器跟着换到新位置
  group.forEach((f, i) => edit.renameFile(uris[i], vscode.Uri.file(target(f))));
  if (!await vscode.workspace.applyEdit(edit)) return '移动失败';
  const panel = panels.get(vscode.Uri.file(m.file).toString());
  if (panel) panel.dispose();                      // 旧位置的预览点不到原文了，关掉

  const moved = f => { const g = group.find(g => library.samePath(path.join(from, g), f)); return g ? target(g) : f; };
  group.forEach(f => pairs.push([path.join(from, f), target(f)]));
  for (const f of group.filter(f => f.endsWith('.md'))) {   // 改写相对路径，PDF 和本机链接仍指向原来的文件
    const file = target(f);
    let text = tree.relocate(fs.readFileSync(file, 'utf8'), path.join(from, f), file, moved);
    if (f === path.basename(m.file)) { if (!tree.parse(text)[field]) text = library.setKey(text, field, m.key); }
    else if (renumber) text = text.replace(/^# \d+ /, '# ' + newNumber + ' ');
    fs.writeFileSync(file, text);
  }
  for (let d = from; !library.samePath(d, root) && fs.readdirSync(d).length === 0; d = path.dirname(d)) fs.rmdirSync(d);   // 删掉搬空的文件夹
  return '';
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
