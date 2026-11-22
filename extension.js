// Twig VSCode 扩展：预览 *_twig.md 与灵感笔记 *_idea.md、导出 HTML、从文献库的论文新建 Twig 和灵感笔记、
// 追问图和灵感笔记两份索引（查重和侧栏标记共用）、把 AI 书写规则装成各家 AI 的 skill；侧栏视图见 sidebar.js
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tree = require('./skill/build.cjs');
const library = require('./library.js');
const sidebar = require('./sidebar.js');

const SKILL_SOURCE = path.join(__dirname, 'skill');
// 各家 AI 读取个人 skill 的目录。Copilot 也读 ~/.claude/skills，所以不再单独装。与 uninstall.js 中的 AI_HOMES 相同
const AI_HOMES = { 'Claude Code': '.claude', 'Codex': '.codex', 'Gemini': '.gemini' };
const panels = new Map();   // 源文件 → 预览面板
// 工作区下的默认文件夹：追问图和灵感笔记各一个；0.5.0 以前追问图的文件夹叫 Twig阅读整理，见 renameOldFolder
const TWIG_DIR = 'Twig追问整理', OLD_TWIG_DIR = 'Twig阅读整理', IDEA_DIR = 'Twig灵感笔记';

function activate(context) {
  setupSkill(context);
  twigs.build();
  ideas.build();
  renameOldFolder(context);                        // 改了名会重新扫描

  const side = sidebar.create(context, {
    library: currentLibrary,
    twigKeys: lib => twigs.keyMap(lib),
    ideaKeys: lib => ideas.keyMap(lib),
    onIndexChange: indexChanged.event,
    newTwig: item => createTwig(currentLibrary(), item),
    openTwig: file => openTwig(file),
    openIdeas,
    preview: file => preview(vscode.Uri.file(file)),
    exportHtml: file => exportHtml(vscode.Uri.file(file)),
    openPdf: openPaperPdf,
    newIdea
  });
  // 刷新，以及换了文献库或 Twig 文件夹时：侧栏重新向文献库取，两份索引重新扫描
  const refresh = () => { watchLibrary(side.refresh); side.refresh(); return Promise.all([twigs.build(), ideas.build()]); };
  watchLibrary(side.refresh);

  let timer;
  context.subscriptions.push(
    vscode.commands.registerCommand('twig.preview', uri => preview(uri)),
    vscode.commands.registerCommand('twig.exportHtml', uri => exportHtml(uri)),
    vscode.commands.registerCommand('twig.newTree', newTree),
    vscode.commands.registerCommand('twig.search', newTree),
    vscode.commands.registerCommand('twig.chooseLibrary', chooseLibrary),
    vscode.commands.registerCommand('twig.refresh', refresh),
    // 只列 Twig 自己的设置
    vscode.commands.registerCommand('twig.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:' + context.extension.id)),
    vscode.commands.registerCommand('twig.newIdea', () => newIdea()),   // 先在搜索框选论文；菜单会传入别的参数，不往下传
    vscode.workspace.onDidChangeConfiguration(e => {
      if (['library', 'folder', ...library.PATH_SETTINGS].some(k => e.affectsConfiguration('twig.' + k))) refresh();
      if (e.affectsConfiguration('twig.ideaFolder')) ideas.build();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    { dispose: () => { twigs.dispose(); ideas.dispose(); if (libraryWatch && libraryWatch.watcher) libraryWatch.watcher.dispose(); } },
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

// 侧栏论文右键菜单的“打开 PDF”：用 PDF Viewer 打开第 1 页，没装时用系统默认程序
async function openPaperPdf(paper, twig) {
  const file = await paperPdf(paper, twig);
  if (!file) return;
  if (hasPdfViewer()) showPdf(file, 1);
  else vscode.env.openExternal(vscode.Uri.file(file));
}

// 一篇论文的本机 PDF：已有 Twig 的取它元信息 pdf 指向的那个；否则向文献库取，多个时让用户选（quiet 时取第一个）
// 取不到时返回空，quiet 时不提示
async function paperPdf(paper, twig, quiet) {
  const entry = twig && twigs.files.get(twig);
  if (entry && entry.pdf && fs.existsSync(entry.pdf)) return entry.pdf;
  const lib = currentLibrary();
  let list;
  try { list = (await lib.pdfs(paper.key)).filter(p => fs.existsSync(p.file)); }
  catch (e) { if (!quiet) libraryError(lib, e); return ''; }
  if (!list.length) {
    if (!quiet) vscode.window.showWarningMessage(library.label(paper) + ' 在 ' + lib.name + ' 里没有本机能打开的 PDF');
    return '';
  }
  return quiet ? list[0].file : (await choosePdfOf(list)) || '';
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

// 当前文献库，按设置 twig.library 取；各文献库用到的路径设置（见 library.js 的 PATH_SETTINGS，如 twig.bibFile）
// 写相对路径的按当前工作区解析，没开工作区时当作没填；没设置过 twig.library 的，连不上时提示先选文献库（见 library.js 的 open）
// 设置不变时返回同一个对象，Twig 索引按它缓存文献编号表，侧栏按它判断是否换了文献库
let libraryCache = null;
function currentLibrary() {
  const config = vscode.workspace.getConfiguration('twig');
  const ws = currentWorkspace();
  const inspect = config.inspect('library');
  const options = { chosen: [inspect.globalValue, inspect.workspaceValue, inspect.workspaceFolderValue].some(v => v !== undefined) };
  for (const name of library.PATH_SETTINGS) {
    const value = config.get(name);
    options[name] = !value || path.isAbsolute(value) ? value : ws ? path.join(ws.uri.fsPath, value) : '';
  }
  const sign = config.get('library') + '|' + JSON.stringify(options);
  if (!libraryCache || libraryCache.sign !== sign) libraryCache = { sign, lib: library.open(config.get('library'), options) };
  return libraryCache.lib;
}

// 文献库是本地的 .bib 或 PDF 文件夹时盯住它（见各文献库的 watch），改动后停顿 0.5 秒调用 onChange 刷新侧栏；
// 换了文献库时换着盯，Zotero 不盯
let libraryWatch = null;                           // { lib, watcher }
function watchLibrary(onChange) {
  const lib = currentLibrary();
  if (libraryWatch && libraryWatch.lib === lib) return;
  if (libraryWatch && libraryWatch.watcher) libraryWatch.watcher.dispose();
  libraryWatch = { lib, watcher: null };
  if (!lib.watch) return;
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(lib.watch.base), lib.watch.pattern));
  let timer;
  const changed = () => { clearTimeout(timer); timer = setTimeout(onChange, 500); };
  watcher.onDidCreate(changed);
  watcher.onDidChange(changed);
  watcher.onDidDelete(changed);
  libraryWatch.watcher = watcher;
}

// 选择文献库（侧栏标题栏和连不上时的按钮）：按 library.js 的 KINDS 列出；要用文件或文件夹的，接着弹出选择框，
// 选好后写进设置，在工作区里的写相对路径（换电脑、走云盘都对得上）。用户不用进设置页面
// 写到哪：选的文件或文件夹在工作区里时，路径和文献库类型都写进工作区设置，只对这个项目生效（写进用户设置的话，
// 相对路径到了别的工作区会指向那里的同名文件夹，别的项目的文献库类型也跟着变）；其余（Zotero、工作区外的）写进用户设置，
// 各项目通用，但工作区设置里已写了的改工作区的，否则会被它盖住。设置改了由 activate 里的监听刷新侧栏
async function chooseLibrary() {
  const config = vscode.workspace.getConfiguration('twig');
  const now = config.get('library');
  const chosen = await vscode.window.showQuickPick(Object.entries(library.KINDS).map(([kind, k]) => ({
    label: k.label,
    description: kind === now ? '当前' + (k.path && config.get(k.path.setting) ? '：' + config.get(k.path.setting) : '') : '',
    detail: k.detail, kind
  })), { placeHolder: '从哪个文献库取论文' });
  if (!chosen) return;
  const kind = library.KINDS[chosen.kind];
  let local = false;                               // 选的在工作区里，存的是相对路径
  const target = name => local || config.inspect(name).workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  if (kind.path) {
    const ws = currentWorkspace();
    const files = await vscode.window.showOpenDialog({
      title: kind.path.title, openLabel: '选这个',
      canSelectFiles: kind.path.pick === 'file', canSelectFolders: kind.path.pick === 'folder', filters: kind.path.filters,
      defaultUri: ws && ws.uri
    });
    if (!files) return;
    let value = files[0].fsPath;
    const rel = ws ? path.relative(ws.uri.fsPath, value) : '..';
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      value = rel.split(path.sep).join('/') || '.';
      local = true;
    }
    await config.update(kind.path.setting, value, target(kind.path.setting));
  }
  await config.update('library', chosen.kind, target('library'));
  const lib = currentLibrary();
  try { vscode.window.showInformationMessage('文献库已换成 ' + kind.label + '：' + await lib.rootName()); }
  catch (e) { libraryError(lib, e); }
}

// 当前工作区：当前文件所在的那个，否则第一个；没开工作区时为空
function currentWorkspace() {
  const editor = vscode.window.activeTextEditor;
  return (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)) || (vscode.workspace.workspaceFolders || [])[0];
}

// 新建：先在搜索框里从文献库选论文（见 pickPaper），再按 createTwig 新建；同一篇论文已有 Twig 时直接打开
async function newTree() {
  const lib = currentLibrary();
  const item = await pickPaper(lib);               // undefined：取消
  if (item) await createTwig(lib, item);
}

// 从文献库的一篇论文新建 Twig，平铺保存到根目录，自动填好标题、引文、pdf、firstPage；同一篇论文已有 Twig 时直接打开
// 只从文献库新建：论文先在文献库里整理好再读。搜索框和侧栏论文行的“新建”按钮都走这里
async function createTwig(lib, item) {
  // 第一步：确定根目录并做一对一查重，已存在时直接打开
  let pdf = '';
  let pdfList;
  try { pdfList = await lib.pdfs(item.key); }      // 一次取出该文献的全部 PDF，供查重和后续选择共用
  catch (e) { return libraryError(lib, e); }
  const folder = await twigFolder(lib, pdfList[0] && pdfList[0].file);
  const existing = await findExistingTwig(folder, lib, item, pdfList.map(p => p.file));
  if (existing) return openExistingTwig(existing, folder);
  if (pdfList.length === 0) {
    vscode.window.showWarningMessage('这篇文献在 ' + lib.name + ' 里没有 PDF，pdf 一项留空，可以之后自己填。');
  } else {
    pdf = await choosePdfOf(pdfList);              // 多个 PDF 时让用户选正文那一个
    if (pdf === undefined) return;
  }

  // 第二步：准备根目录、生成不重名默认文件名、弹出保存对话框
  const existed = fs.existsSync(folder);
  if (!existed) fs.mkdirSync(folder, { recursive: true });
  const name = library.fileName(item, folder);
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(folder, name)),
    filters: { Markdown: ['md'] }
  });
  if (!target) {
    if (!existed && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder); // 取消保存时删掉刚建的空根目录
    return;
  }

  // 第三步：填充模板、写入文件并打开编辑器和预览
  const text = library.fill(fs.readFileSync(path.join(SKILL_SOURCE, '模板.md'), 'utf8'), lib, item, pdf, target.fsPath);
  fs.writeFileSync(target.fsPath, text);
  if (!existed) await twigs.build();               // 根目录刚建好，重新扫描，文件监视才能盯住它
  else twigs.add(target.fsPath);                   // 不等文件监视，侧栏标记立即刷新
  await openTwig(target.fsPath);
}

// 文献库读不了时提示原因（见各文献库的 help）
function libraryError(lib, e) {
  const h = library.explain(lib, e) || { label: '读取 ' + lib.name + ' 出错', detail: e.message };
  vscode.window.showWarningMessage(h.label + '：' + h.detail);
}

// 打开 Twig 文件或灵感笔记，以及它的预览
async function openTwig(file) {
  const uri = vscode.Uri.file(file);
  await vscode.window.showTextDocument(uri);
  preview(uri);
}

// 查找同一篇论文已有的 Twig 文件（查追问图索引，根目录含旧子文件夹），找到返回绝对路径，否则返回 null
// 先比对文献编号（zotero / citekey；没写编号的旧文件由文献库按 pdf 推出），再比对 pdf 路径
// 已写了另一篇文献编号的文件不参与 pdf 比对
async function findExistingTwig(root, lib, item, pdfs) {
  if (!twigs.root || !library.samePath(twigs.root, root)) await twigs.build(root);   // 没开工作区时根目录随文献库变，按这次的重新扫描
  const hit = (await twigs.keyMap(lib)).get(item.key);
  if (hit) return hit[0];
  for (const p of pdfs) {
    const file = (twigs.byPdf.get(library.pathKey(p)) || []).find(f => !(lib.field && twigs.files.get(f).meta[lib.field]));
    if (file) return file;
  }
  return null;
}

// 查到同一篇论文已有 Twig 时，直接打开并提示，不再新建
async function openExistingTwig(file, root) {
  await openTwig(file);
  vscode.window.showInformationMessage('这篇论文已有 Twig，已打开：' + path.relative(root, file));
}

// ---------- 索引 ----------

// 一份索引：根目录（含子文件夹）里一种文件（追问图或灵感笔记）的元信息，建成“文献编号 → 文件”“PDF 路径 → 文件”两张表，
// 表的值都是文件列表（追问图一篇一个，灵感笔记一篇可以有多条）。新建时的查重、搜索框和侧栏的标记共用
// 开工作区时扫描一次，之后由文件监视跟着增删改；文献编号表按当前文献库算，用到时才算并缓存：没写编号的旧文件要问文献库（见各文献库的 paperKey）
class Index {
  // test(file) 是不是这种文件；glob 文件监视的模式；home() 取根目录（可以是异步的），取不到时为空
  constructor(test, glob, home) {
    this.test = test;
    this.glob = glob;
    this.home = home;
    this.root = null;                              // 扫描的根目录
    this.files = new Map();                        // 文件 → { meta, pdf }，meta 为元信息各项，pdf 为绝对路径或空
    this.byPdf = new Map();                        // PDF 路径（library.pathKey）→ [文件]
    this.keys = null;                              // 文献编号表的缓存 { lib, promise → Map(文献编号 → [文件]) }
    this.watcher = null;
    this.timer = null;
  }

  // 扫描根目录，建立索引并监视其中这种文件；不给 root 时取 home()，取不到时索引为空
  async build(root) {
    if (root === undefined) root = await this.home();
    this.dispose();
    this.root = root;
    this.files.clear();
    if (root && fs.existsSync(root)) {
      for (const f of fs.readdirSync(root, { recursive: true })) if (this.test(f)) this.read(path.join(root, f));
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), this.glob));
      w.onDidCreate(uri => this.add(uri.fsPath));
      w.onDidChange(uri => this.add(uri.fsPath));
      w.onDidDelete(() => this.drop());
      this.watcher = w;
    }
    this.changed();
  }

  dispose() {
    if (this.watcher) this.watcher.dispose();
    this.watcher = null;
  }

  // 读一个文件开头的元信息进索引，正文不读（改正文不会让索引变）；读不了（刚被删、正在写）时从索引去掉。返回是否变了
  read(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch (e) { return this.files.delete(file); }
    const end = text.startsWith('---') ? text.indexOf('\n---', 3) : -1;
    const meta = tree.parse(end > 0 ? text.slice(0, end + 4) : '');
    const fields = Object.fromEntries(Object.entries(meta).filter(([, v]) => typeof v === 'string'));
    const entry = { meta: fields, pdf: fields.pdf ? path.resolve(path.dirname(file), fields.pdf) : '' };
    const old = this.files.get(file);
    this.files.set(file, entry);
    return !old || JSON.stringify(old) !== JSON.stringify(entry);
  }

  // 文件监视和新建后调用：只有元信息变了才重算两张表
  add(file) { if (this.read(file)) this.changed(); }

  // 删掉文件或整个文件夹时调用（文件夹删除时监视器可能只报文件夹本身）：去掉索引里已不存在的文件
  drop() {
    let changed = false;
    for (const file of [...this.files.keys()]) if (!fs.existsSync(file)) changed = this.files.delete(file) || changed;
    if (changed) this.changed();
  }

  // 索引变了：重建 PDF 表，清掉文献编号表的缓存，通知侧栏（停顿 0.3 秒后通知一次）
  changed() {
    this.byPdf = new Map();
    for (const [file, e] of this.files) if (e.pdf) push(this.byPdf, library.pathKey(e.pdf), file);
    this.keys = null;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => indexChanged.fire(), 300);
  }

  // 当前文献库下的“文献编号 → [文件]”表，同一篇的文件按文件名排：元信息写了编号的直接用，没写的由文献库按 pdf 推出
  // 文献库连不上时推不出的先跳过，表不缓存，下次用到再算
  keyMap(lib) {
    if (this.keys && this.keys.lib === lib) return this.keys.promise;
    const entry = { lib };
    entry.promise = (async () => {
      const map = new Map();
      let complete = true;
      await Promise.all([...this.files].map(async ([file, e]) => {
        let key = e.meta[lib.field];
        if (!key) try { key = await lib.paperKey(e.meta, file); } catch (err) { complete = false; }
        if (key) push(map, key, file);
      }));
      for (const list of map.values()) list.sort();
      if (!complete && this.keys === entry) this.keys = null;
      return map;
    })();
    this.keys = entry;
    return entry.promise;
  }
}

function push(map, key, value) {
  if (map.has(key)) map.get(key).push(value);
  else map.set(key, [value]);
}

const indexChanged = new vscode.EventEmitter();    // 两份索引有增删改时通知侧栏重画标记
const twigs = new Index(tree.isTwig, '**/*_twig.md', () => twigRoot(currentLibrary(), ''));   // 追问图，根目录见 twigRoot
const ideas = new Index(tree.isIdea, '**/*_idea.md', () => ideaRoot());                       // 灵感笔记，根目录见 ideaRoot

// Twig 文件放在哪：恒返回根目录（见 twigRoot）；取不到根目录时（没开工作区又推不出文献库位置）用当前文件夹
async function twigFolder(lib, pdf) {
  const root = await twigRoot(lib, pdf);
  if (root) return root;
  const editor = vscode.window.activeTextEditor;
  const ws = currentWorkspace();
  return editor ? path.dirname(editor.document.uri.fsPath) : ws ? ws.uri.fsPath : os.homedir();
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
    const ideaDir = path.join(ws.uri.fsPath, IDEA_DIR);
    fixLinks(fs.existsSync(ideaDir) ? [ideaDir] : [], moved);
    twigs.build();                                 // Twig 文件换了位置，重新扫描
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

// ---------- 灵感笔记 ----------

// 新建灵感笔记：一篇论文可以有多条，平铺在灵感笔记根目录（见 ideaRoot），文件名为 作者年份_简题_idea.md（见 library.fileName）
// 从侧栏论文的右键菜单新建时给出 paper 和它的 Twig 文件 twig（没有时为空）；从命令面板新建时先在搜索框里选论文
// 元信息填标题、pdf 和文献编号（与 Twig 相同，侧栏靠后两项认出它属于哪篇）；“起因”链接回来源：有 Twig 时指向 Twig，没有时指向 PDF，AI 再补具体节点
async function newIdea(paper, twig) {
  const root = ideaRoot();
  if (!root) { vscode.window.showWarningMessage('先打开一个工作区，或在设置里填 twig.ideaFolder'); return; }
  const lib = currentLibrary();
  if (!paper) {
    paper = await pickPaper(lib);
    if (!paper) return;
    twig = ((await twigs.keyMap(lib)).get(paper.key) || [])[0];
  }
  let topic = await vscode.window.showInputBox({
    title: '新建灵感笔记 · ' + library.label(paper),
    prompt: '简题：这条灵感想做什么，如“按物质层建立云滴谱方程”'
  });
  topic = topic && topic.trim();
  if (!topic) return;
  const pdf = await paperPdf(paper, twig, true);
  const existed = fs.existsSync(root);
  if (!existed) fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, library.fileName(paper, root, '_' + topic.replace(/[\/:*?"<>|\s]+/g, '') + '_idea.md'));

  // 替换值写成函数，免得简题里的 $& 等被当作特殊记号（见 library.fill）
  let text = library.fill(fs.readFileSync(path.join(SKILL_SOURCE, 'idea-template.md'), 'utf8'), lib, paper, pdf, file)
    .replace(/^title:.*$/m, () => 'title: ' + library.label(paper) + ' · ' + topic)
    .replace(/^# .*$/m, () => '# ' + topic);
  const source = twig
    ? { name: (twigs.files.get(twig) && twigs.files.get(twig).meta.title) || path.basename(twig, '.md'), file: twig }
    : { name: library.label(paper), file: pdf };
  const rel = source.file && path.relative(root, source.file).split(path.sep).join('/');
  const link = rel ? '[' + source.name + '](' + (/[\s()<>]/.test(rel) ? '<' + rel + '>' : rel) + ')' : source.name;
  text = text.replace(/^(起因：).*$/m, (_, key) => key + '读 ' + link + ' 时想到。');
  fs.writeFileSync(file, text);
  if (!existed) await ideas.build();               // 根目录刚建好，重新扫描，文件监视才能盯住它
  else ideas.add(file);                            // 不等文件监视，侧栏标记立即刷新
  await openTwig(file);
}

// 打开一篇论文的灵感笔记（侧栏论文的单击和右键菜单）：只有一条时直接打开，多条时列出标题让用户选
async function openIdeas(files) {
  if (!files || !files.length) return;
  let file = files[0];
  if (files.length > 1) {
    const chosen = await vscode.window.showQuickPick(files.map(f => {
      const entry = ideas.files.get(f);
      return { label: (entry && entry.meta.title) || path.basename(f, '_idea.md'), description: path.basename(f), file: f };
    }), { placeHolder: '这篇论文有 ' + files.length + ' 条灵感笔记，打开哪一条' });
    if (!chosen) return;
    file = chosen.file;
  }
  await openTwig(file);
}

// 选论文的搜索框（命令面板和侧栏标题栏里的“搜索文献”），两种用法：
// - 不输入时按分类逐层浏览：顶层列出分类、特殊入口（已保存的搜索等）和最近改动的 5 篇，点分类进入，“返回上一级”退出；
//   分类里的论文包括各级子分类中的
// - 输入标题、作者或年份时搜整个文献库；清空输入框回到原来所在的分类
// 每篇论文一行：作者 (年份) 在前，标题在后，已有 Twig 的标出来；选中返回该论文，取消返回 undefined
function pickPaper(lib) {
  const separator = label => ({ label, kind: vscode.QuickPickItemKind.Separator });
  // 论文行；keys 为追问图索引的文献编号表
  const paper = keys => p => keys.has(p.key)
    ? { label: '$(' + sidebar.TWIG_ICON + ') ' + library.label(p), description: '已有 Twig · ' + p.title, alwaysShow: true, item: p }
    : { label: library.label(p), description: p.title, alwaysShow: true, item: p };
  // 读不了文献库时显示在列表顶部的说明（文字见各文献库的 help），选中它不做任何事
  const notice = e => {
    const h = library.explain(lib, e) || { label: '读取 ' + lib.name + ' 出错', detail: e.message };
    return { label: '$(info) ' + h.label, detail: h.detail, alwaysShow: true, notice: true };
  };
  const box = vscode.window.createQuickPick();
  box.placeholder = '搜索 ' + lib.name + ' 文献（标题、作者、年份），或进入分类';
  const trail = [];                                // 当前所在的分类，从顶层往下；特殊入口也算一层，view 为真
  let timer, latest = 0;

  // 取数据并显示；只显示最后一次请求的结果
  async function show(load) {
    const id = ++latest;
    box.busy = true;
    try {
      const items = await load();
      if (id === latest) box.items = items;
    } catch (e) {
      if (id === latest) box.items = [notice(e)];
    }
    if (id === latest) box.busy = false;
  }

  function browse() {
    const here = trail[trail.length - 1];
    box.title = here ? trail.map(f => f.name).join(' › ') : lib.name + ' 文献库';
    show(async () => {
      const keys = await twigs.keyMap(lib);
      if (here && here.view) {
        const list = await lib.viewPapers(here.key);
        return [{ label: '$(arrow-left) 返回上一级', alwaysShow: true, back: true }, ...(list.length ? [separator('论文'), ...list.map(paper(keys))] : [])];
      }
      const folders = (await lib.folders(here && here.key)).map(f => ({
        label: '$(' + sidebar.CATEGORY_ICON + ') ' + f.name,
        description: f.folders ? f.folders + ' 个子分类' : '',
        alwaysShow: true, folder: f
      }));
      const views = here ? [] : (await lib.views()).map(v => ({ label: '$(' + v.icon + ') ' + v.name, alwaysShow: true, folder: { ...v, view: true } }));
      const list = here ? await lib.folderPapers(here.key) : await lib.recent(5);
      return [
        ...(here ? [{ label: '$(arrow-left) 返回上一级', alwaysShow: true, back: true }] : []),
        ...folders,
        ...views,
        ...(list.length ? [separator(here ? '论文' : '最近改动'), ...list.map(paper(keys))] : [])
      ];
    });
  }

  box.onDidChangeValue(q => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!q.trim()) return browse();
      box.title = '搜索整个文献库';
      show(async () => (await lib.search(q)).map(paper(await twigs.keyMap(lib))));
    }, 300);
  });
  browse();
  box.show();
  return new Promise(resolve => {
    box.onDidAccept(() => {
      const chosen = box.selectedItems[0];
      if (!chosen || chosen.notice) return;
      if (chosen.folder || chosen.back) {          // 进入或退出分类，搜索框不关
        chosen.folder ? trail.push(chosen.folder) : trail.pop();
        box.value = '';
        browse();
        return;
      }
      resolve(chosen.item);
      box.dispose();
    });
    box.onDidHide(() => { resolve(undefined); box.dispose(); });
  });
}

// 一篇文献的多个 PDF 里选一个（只有一个时直接用它）；取消时返回 undefined
async function choosePdfOf(list) {
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
