// Twig 侧栏：活动栏里的 Twig 容器，“分类”视图对应 Zotero 左栏，“论文”视图对应 Zotero 中间栏
// 只调用 library.js 规定的文献库接口，不按文献库分情况写；查哪篇已有 Twig 和灵感笔记、新建和打开文件交给 extension.js（见 create 的 deps）
const vscode = require('vscode');
const library = require('./library.js');

// 图标（codicon 名），搜索框里同样用前两个
const CATEGORY_ICON = 'layers';                    // 分类：不用文件夹图标，分类不是磁盘上的文件夹
const TWIG_ICON = 'type-hierarchy';                // 已有 Twig 的论文，与“打开预览”的图标相同
const IDEA_ICON = 'lightbulb';                     // 只有灵感笔记、没有 Twig 的论文
const IDEA_BADGE = '💡';                           // 已有灵感笔记的论文，挂在行尾（见 IdeaBadges）

// 建立两个视图并注册它们的命令；返回 { refresh }：刷新文献库两个视图
// deps：library() 当前文献库；twigKeys(lib)、ideaKeys(lib) 文献编号 → [Twig 文件]、[灵感笔记]；onIndexChange 两份索引变动的事件；
//       newTwig(paper) 从这篇论文新建（见 extension.js 的 createTwig）；openTwig(file) 打开 Twig 和预览；openIdeas(files) 打开灵感笔记（多条时让用户选）；
//       右键菜单用的 preview(file)、exportHtml(file)、openPdf(paper, twig)、newIdea(paper, twig)，twig 为该论文的 Twig 文件或空
function create(context, deps) {
  const categories = new Categories(deps);
  const papers = new Papers(deps);
  const badges = new IdeaBadges();
  const categoryView = vscode.window.createTreeView('twig.categories', { treeDataProvider: categories });
  const paperView = vscode.window.createTreeView('twig.papers', { treeDataProvider: papers });
  categories.view = categoryView;
  papers.view = paperView;
  // 文献库连上后，论文视图先列出全部条目，和 Zotero 打开时选中“我的文库”一样
  categories.onRoot = root => { if (!papers.node) papers.show(root); };

  context.subscriptions.push(
    categoryView, paperView,
    vscode.window.registerFileDecorationProvider(badges),
    categoryView.onDidChangeSelection(e => {
      const node = e.selection[0];
      if (node && node.kind !== 'action') papers.show(node);
    }),
    deps.onIndexChange(() => papers.redraw()),     // 新建或删掉 Twig、灵感笔记后标记跟着变
    vscode.commands.registerCommand('twig.newFromPaper', node => node && deps.newTwig(node.paper)),
    vscode.commands.registerCommand('twig.openPaperTwig', node => node && node.twig && deps.openTwig(node.twig)),
    // 论文的右键菜单；各项按论文有没有 Twig、灵感笔记显示（见 package.json 的 view/item/context 和 getTreeItem 的 contextValue）
    vscode.commands.registerCommand('twig.paper.openPdf', node => node && deps.openPdf(node.paper, node.twig)),
    vscode.commands.registerCommand('twig.paper.preview', node => node && node.twig && deps.preview(node.twig)),
    vscode.commands.registerCommand('twig.paper.openIdea', node => node && deps.openIdeas(node.ideas)),
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
      // 连不上或还没设置：显示原因，下面放“选择文献库”“重试”两个按钮
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
  { kind: 'action', name: '选择文献库', icon: 'library', command: 'twig.chooseLibrary' },
  { kind: 'action', name: '重试', icon: 'refresh', description: '打开文献库或改好设置后', command: 'twig.refresh' }
];

// ---------- 论文视图 ----------

// 列出分类视图里选中的入口中的论文：每篇显示为“作者 (年份)”，标题放在说明里，完整引文放在悬停提示里
// 行首图标：已有 Twig 的为 Twig 图标，单击打开它和预览；只有灵感笔记的为灯泡，单击打开灵感笔记；都没有的单击只选中，点行内的“新建”按钮新建 Twig
// 已有灵感笔记的另在行尾挂 💡（行首只放得下一个图标）
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
      const [list, twigs, ideas] = await Promise.all([this.loading.promise, this.deps.twigKeys(lib), this.deps.ideaKeys(lib)]);
      this.view.message = list.length ? undefined : '“' + node.name + '”里没有论文';
      return list.map(p => ({ paper: p, twig: (twigs.get(p.key) || [])[0], ideas: ideas.get(p.key) || [] }));
    } catch (e) {
      if (this.loading && this.loading.node === node) this.loading = null;   // 出错的不缓存，下次重取
      const h = explain(lib, e);
      this.view.message = h.label + '：' + h.detail;
      return [];
    }
  }

  // contextValue 为 paper，有 Twig 时加 .twig，有灵感笔记时再加 .idea，右键菜单按它显示各项
  getTreeItem({ paper, twig, ideas }) {
    const item = new vscode.TreeItem(library.label(paper));
    item.description = paper.title;
    const about = [paper.citation || paper.key];   // 没有引文的（PDF 文件夹）显示文献编号，即 PDF 的路径
    if (twig) {
      item.iconPath = new vscode.ThemeIcon(TWIG_ICON, new vscode.ThemeColor('charts.green'));
      item.command = { command: 'twig.openPaperTwig', title: '打开 Twig', arguments: [{ paper, twig }] };
      about.push('已有 Twig：' + twig);
    } else if (ideas.length) {
      item.iconPath = new vscode.ThemeIcon(IDEA_ICON, new vscode.ThemeColor('charts.yellow'));
      item.command = { command: 'twig.paper.openIdea', title: '打开灵感笔记', arguments: [{ paper, ideas }] };
      about.push('还没有 Twig，点右边的 + 新建');
    } else {
      item.iconPath = new vscode.ThemeIcon('blank');   // 占位，与有标记的对齐
      about.push('还没有 Twig，点右边的 + 新建');
    }
    if (ideas.length) {
      item.resourceUri = IdeaBadges.uri(paper.key, ideas.length);
      about.push(ideas.length + ' 条灵感笔记，右键“打开灵感笔记”');
    }
    item.contextValue = 'paper' + (twig ? '.twig' : '') + (ideas.length ? '.idea' : '');
    item.tooltip = about.join('\n\n');
    return item;
  }
}

// 论文行尾的 💡：树视图的一行只有一个图标位，借用文件装饰（资源管理器里 Git 的 M、U 也是它）挂在行尾
// 有灵感笔记的论文行带一个 twig-paper: 地址（见 uri），本类只给这种地址加装饰；条数写在地址里，条数变了地址跟着变，装饰随之重取
class IdeaBadges {
  static uri(key, count) { return vscode.Uri.from({ scheme: 'twig-paper', path: '/' + encodeURIComponent(key), query: 'ideas=' + count }); }

  provideFileDecoration(uri) {
    if (uri.scheme !== 'twig-paper') return;
    const count = +(uri.query.match(/ideas=(\d+)/) || [])[1];
    return count ? new vscode.FileDecoration(IDEA_BADGE, count + ' 条灵感笔记') : undefined;
  }
}

module.exports = { create, CATEGORY_ICON, TWIG_ICON };
