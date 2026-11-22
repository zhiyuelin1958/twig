// Twig 侧栏：活动栏里的 Twig 容器，上面的“分类”视图对应 Zotero 左栏，下面的“论文”视图对应 Zotero 中间栏
// 只调用 library.js 规定的文献库接口，不按文献库分情况写；查哪篇已有 Twig、新建和打开 Twig 交给 extension.js（见 create 的 deps）
const vscode = require('vscode');
const library = require('./library.js');

// 图标（codicon 名），搜索框里同样用这两个
const CATEGORY_ICON = 'layers';                    // 分类：不用文件夹图标，分类不是磁盘上的文件夹
const TWIG_ICON = 'type-hierarchy';                // 已有 Twig 的论文，与“打开预览”的图标相同

// 建立两个视图并注册它们的命令；返回 { refresh }，换文献库或点刷新时重新加载
// deps：library() 当前文献库；twigKeys(lib) 文献编号 → Twig 文件；onIndexChange Twig 索引变动的事件；
//       newTwig(picked) 新建（参数同 extension.js 的 createTwig）；openTwig(file) 打开 Twig 和预览；
//       右键菜单用的 preview(file)、exportHtml(file)、openPdf(paper, twig)、newIdea(paper, twig)，twig 为该论文的 Twig 文件或空
function create(context, deps) {
  const categories = new Categories(deps);
  const papers = new Papers(deps);
  const categoryView = vscode.window.createTreeView('twig.categories', { treeDataProvider: categories });
  const paperView = vscode.window.createTreeView('twig.papers', { treeDataProvider: papers });
  categories.view = categoryView;
  papers.view = paperView;
  // 文献库连上后，论文视图先列出全部条目，和 Zotero 打开时选中“我的文库”一样
  categories.onRoot = root => { if (!papers.node) papers.show(root); };

  context.subscriptions.push(
    categoryView, paperView,
    categoryView.onDidChangeSelection(e => {
      const node = e.selection[0];
      if (node && node.kind !== 'action') papers.show(node);
    }),
    deps.onIndexChange(() => papers.redraw()),     // 新建或删掉 Twig 后标记跟着变
    vscode.commands.registerCommand('twig.newFromPaper', node => node && deps.newTwig({ item: node.paper })),
    vscode.commands.registerCommand('twig.openPaperTwig', node => node && node.twig && deps.openTwig(node.twig)),
    // 论文的右键菜单；预览、导出只对已有 Twig 的显示（见 package.json 的 view/item/context）
    vscode.commands.registerCommand('twig.paper.openPdf', node => node && deps.openPdf(node.paper, node.twig)),
    vscode.commands.registerCommand('twig.paper.preview', node => node && node.twig && deps.preview(node.twig)),
    vscode.commands.registerCommand('twig.paper.exportHtml', node => node && node.twig && deps.exportHtml(node.twig)),
    vscode.commands.registerCommand('twig.paper.newIdea', node => node && deps.newIdea(node.paper, node.twig))
  );
  return { refresh() { categories.refresh(); papers.reload(); } };
}

// 文献库出错时的说明 { label, detail }（文字见各文献库的 help）
function explain(lib, e) {
  return library.explain(lib, e) || { label: '读取 ' + lib.name + ' 出错', detail: e.message };
}

// ---------- 分类视图 ----------

// 节点：{ kind, key, name, icon, folders, parent }
// kind 为 root（文献库顶层，如“我的文库”）、folder（分类）、view（已保存的搜索、未分类条目等特殊入口）、action（连不上时的按钮）
// 子节点用到时才加载：展开某个分类时才取它的子分类
class Categories {
  constructor(deps) {
    this.deps = deps;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  refresh() { this.emitter.fire(); }

  async getChildren(node) {
    const lib = this.deps.library();
    try {
      if (!node) {
        const root = { kind: 'root', key: '', name: await lib.rootName(), icon: 'library' };
        this.view.message = undefined;
        this.onRoot(root);
        return [root];
      }
      if (node.kind === 'root') {
        const [folders, views] = await Promise.all([lib.folders(), lib.views()]);
        return [...folders.map(f => folder(f, node)), ...views.map(v => ({ kind: 'view', ...v, parent: node }))];
      }
      if (node.kind === 'folder') return (await lib.folders(node.key)).map(f => folder(f, node));
      return [];
    } catch (e) {
      // 连不上或还没设置：显示原因，下面放几个按钮，不用文献库也能新建
      const h = explain(lib, e);
      this.view.message = h.label + '：' + h.detail;
      return node ? [] : ACTIONS;
    }
  }

  getTreeItem(node) {
    if (node.kind === 'action') {
      const item = new vscode.TreeItem(node.name);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.description = node.description;
      item.command = { command: node.command, title: node.name };
      return item;
    }
    const state = node.kind === 'root' ? vscode.TreeItemCollapsibleState.Expanded
      : node.kind === 'folder' && node.folders ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.name, state);
    item.id = node.kind + ':' + node.key;          // 刷新后保留展开状态
    item.iconPath = new vscode.ThemeIcon(node.icon);
    item.contextValue = node.kind;
    return item;
  }

  getParent(node) { return node.parent; }
}

function folder(f, parent) {
  return { kind: 'folder', key: f.key, name: f.name, icon: CATEGORY_ICON, folders: f.folders, parent };
}

// 文献库连不上或还没设置时，分类视图里的按钮
const ACTIONS = [
  { kind: 'action', name: '从 PDF 新建', icon: 'file-pdf', description: '引文等由 AI 读 PDF 后填', command: 'twig.newFromPdf' },
  { kind: 'action', name: '空白模板', icon: 'file', command: 'twig.newBlank' },
  { kind: 'action', name: '选择文献库', icon: 'library', command: 'twig.chooseLibrary' },
  { kind: 'action', name: '重试', icon: 'refresh', description: '打开文献库或改好设置后', command: 'twig.refresh' }
];

// ---------- 论文视图 ----------

// 列出分类视图里选中的入口中的论文：每篇显示为“作者 (年份)”，标题放在说明里，完整引文放在悬停提示里
// 已有 Twig 的加标记，单击打开它和预览；没有的单击只选中，点行内的“新建”按钮新建
class Papers {
  constructor(deps) {
    this.deps = deps;
    this.node = null;                              // 当前入口（分类视图的节点）
    this.loading = null;                           // { node, promise → [论文] }，同一入口只取一次，重画时不再向文献库取
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  // 换成另一个入口；同一个入口重复选中时不重取
  show(node) {
    if (this.node && this.node.kind === node.kind && this.node.key === node.key) return;
    this.node = node;
    this.lib = this.deps.library();
    this.view.description = node.name;
    this.reload();
  }

  // 重新向文献库取；换了文献库时原来的入口作废，等分类视图加载出新的顶层再列全部条目
  reload() {
    if (this.node && this.deps.library() !== this.lib) {
      this.node = null;
      this.view.description = undefined;
      this.view.message = undefined;
    }
    this.loading = null;
    this.emitter.fire();
  }

  redraw() { this.emitter.fire(); }                // 只重画标记

  // 入口里的论文：顶层为全部条目，分类包括各级子分类中的，特殊入口由文献库给出
  load(lib, node) {
    if (node.kind === 'root') return lib.allPapers();
    if (node.kind === 'folder') return lib.folderPapers(node.key);
    return lib.viewPapers(node.key);
  }

  async getChildren(parent) {
    if (parent || !this.node) return [];
    const lib = this.deps.library();
    const node = this.node;
    if (!this.loading || this.loading.node !== node) this.loading = { node, promise: this.load(lib, node) };
    try {
      const [list, twigs] = await Promise.all([this.loading.promise, this.deps.twigKeys(lib)]);
      this.view.message = list.length ? undefined : '“' + node.name + '”里没有论文';
      return list.map(p => ({ paper: p, twig: twigs.get(p.key) }));
    } catch (e) {
      if (this.loading && this.loading.node === node) this.loading = null;   // 出错的不缓存，下次重取
      const h = explain(lib, e);
      this.view.message = h.label + '：' + h.detail;
      return [];
    }
  }

  getTreeItem({ paper, twig }) {
    const item = new vscode.TreeItem(library.label(paper));
    item.description = paper.title;
    const about = paper.citation || paper.key;     // 没有引文的（PDF 文件夹）显示文献编号，即 PDF 的路径
    if (twig) {
      item.iconPath = new vscode.ThemeIcon(TWIG_ICON, new vscode.ThemeColor('charts.green'));
      item.contextValue = 'paper.twig';
      item.command = { command: 'twig.openPaperTwig', title: '打开 Twig', arguments: [{ paper, twig }] };
      item.tooltip = about + '\n\n已有 Twig：' + twig;
    } else {
      item.iconPath = new vscode.ThemeIcon('blank');   // 占位，与有标记的对齐
      item.contextValue = 'paper';
      item.tooltip = about + '\n\n还没有 Twig，点右边的 + 新建';
    }
    return item;
  }
}

module.exports = { create, CATEGORY_ICON, TWIG_ICON };
