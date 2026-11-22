// Zotero 文献库：通过 Zotero 7 起自带的本地 API 查文献、列分类和已保存的搜索、取 PDF 路径；接口见 library.js
// 本地 API 需要 Zotero 开着，并在 设置 → 高级 勾选“允许此计算机上的其他应用程序与 Zotero 通信”
const path = require('path');
const { fileURLToPath } = require('url');
const library = require('./library.js');

const API = 'http://localhost:23119/api/users/0';

const name = 'Zotero';
const field = 'zotero';                            // Twig 元信息里存文献编号的字段

// 出错时 error.reason 说明原因：offline 为连不上（没装或没打开 Zotero），disabled 为 Zotero 开着但没开本地 API；error.status 为返回码
async function get(url) {
  let res;
  try { res = await fetch(API + url); } catch (e) { throw Object.assign(new Error('连不上 Zotero'), { reason: 'offline' }); }
  if (!res.ok) throw Object.assign(new Error('Zotero 返回 ' + res.status), { reason: 'disabled', status: res.status });
  return res.json();
}

// 各种出错原因的说明，显示在侧栏和选论文的列表顶部
const help = {
  offline: { label: '没有连上 Zotero', detail: '先打开 Zotero' },
  disabled: { label: 'Zotero 没有开放本地接口', detail: '在 Zotero 设置 → 高级 勾选“允许此计算机上的其他应用程序与 Zotero 通信”' }
};

// ---------- 论文 ----------

// 统一的论文对象（见 library.js）
function paper(it) {
  const d = it.data;
  const names = (d.creators || []).filter(c => c.creatorType === 'author').map(c => c.lastName || c.name);
  return {
    key: it.key, authors: authors(it), year: year(it), title: d.title,
    citation: library.citation({ names, year: year(it), title: d.title, venue: d.publicationTitle, volume: d.volume, pages: d.pages }),
    firstPage: library.firstPage(d.pages)
  };
}

// 只要文献条目，去掉独立附件、笔记和回收站里的
function papers(items) {
  return items.filter(it => !['attachment', 'note', 'annotation'].includes(it.data.itemType) && !it.data.deleted).map(paper);
}

// 按编号取原始条目（附件反查所属文献时用）；Zotero 里没有或已移进回收站时为 null
async function raw(key) {
  try {
    const it = await get('/items/' + key + '?format=json');
    return it.data.deleted ? null : it;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// 同一篇只留一次（多个分类、多个附件指向同一篇时）
function unique(items) {
  const seen = new Set();
  return items.filter(it => !seen.has(it.key) && seen.add(it.key));
}

// 文献库的名字，如“我的文库”，随 Zotero 界面语言；库里还没有条目时取不到，用“我的文库”
async function rootName() {
  const [it] = await get('/items/top?format=json&limit=1');
  return (it && it.library && it.library.name) || '我的文库';
}

// 全部条目，对应 Zotero 左栏的“我的文库”
async function allPapers() {
  return library.byTitle(papers(await get('/items/top?format=json')));
}

// 在整个文献库里按标题、作者、年份搜索，最近改动的在前
async function search(q) {
  return papers(await get('/items/top?format=json&limit=20&sort=dateModified&direction=desc&q=' + encodeURIComponent(q)));
}

// 最近改动的几篇；多取一些，去掉附件和笔记后再截取
async function recent(limit) {
  return papers(await get('/items/top?format=json&sort=dateModified&direction=desc&limit=' + limit * 4)).slice(0, limit);
}

// ---------- 分类 ----------

// 分类：不给 parent 时为顶层，否则为它的子分类；按名称排序
async function folders(parent) {
  const list = await get((parent ? '/collections/' + parent + '/collections' : '/collections/top') + '?format=json');
  return list
    .map(c => ({ key: c.key, name: c.data.name, folders: c.meta.numCollections || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

// 分类里的论文，包括各级子分类中的，和 Zotero 打开“显示子分类中的条目”时一样；按标题排序
// 先取全部分类找出各级子分类，再逐个取其中的条目，合并去重
async function folderPapers(key) {
  const all = await get('/collections?format=json');
  const keys = [key];
  for (let i = 0; i < keys.length; i++) keys.push(...all.filter(c => c.data.parentCollection === keys[i]).map(c => c.key));
  const lists = await Promise.all(keys.map(k => get('/collections/' + k + '/items/top?format=json')));
  return library.byTitle(papers(unique(lists.flat())));
}

// ---------- 特殊入口 ----------

// 左栏分类以下的入口：各个已保存的搜索、未分类条目；重复条目、我的出版物、回收站用不到，不列
async function views() {
  const searches = (await get('/searches?format=json'))
    .map(s => ({ key: 'search:' + s.key, name: s.data.name, icon: 'search' }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return [...searches, { key: 'unfiled', name: '未分类条目', icon: 'inbox' }];
}

// 特殊入口里的论文，按标题排序
// - 未分类条目：Zotero 没有专门接口，取不在任何分类里的条目
// - 已保存的搜索：结果里含 PDF、笔记等子条目，换成它们所属的文献
async function viewPapers(key) {
  if (key === 'unfiled') {
    return library.byTitle(papers((await get('/items/top?format=json')).filter(it => !(it.data.collections || []).length)));
  }
  const found = await get('/searches/' + key.replace(/^search:/, '') + '/items?format=json');
  const top = found.filter(it => !it.data.parentItem);
  const have = new Set(top.map(it => it.key));
  const missing = [...new Set(found.map(it => it.data.parentItem).filter(k => k && !have.has(k)))];
  // 按编号批量取所属文献；本地接口可能连带返回子条目，再按编号筛一遍
  for (let i = 0; i < missing.length; i += 50) {
    const want = new Set(missing.slice(i, i + 50));
    top.push(...(await get('/items?format=json&itemKey=' + [...want].join(','))).filter(it => want.has(it.key)));
  }
  return library.byTitle(papers(unique(top)));
}

// ---------- PDF 与数据目录 ----------

// 由 PDF 路径推出 Zotero 数据目录：存储的附件在 数据目录/storage/编号/文件.pdf；不是这种结构（如链接的文件）时为 null
function dataDir(pdf) {
  const storage = path.dirname(path.dirname(pdf));
  return path.basename(storage) === 'storage' ? path.dirname(storage) : null;
}

// 手头没有 PDF 时推出数据目录：取库里任意一个存储的附件；库里没有时为 null
async function libraryDir() {
  for (const a of await get('/items?format=json&itemType=attachment&limit=50')) {
    const href = a.links && a.links.enclosure && a.links.enclosure.href;
    const dir = href && href.startsWith('file:') && dataDir(fileURLToPath(href));
    if (dir) return dir;
  }
  return null;
}

// 没开工作区时 Twig追问整理 放在哪个文件夹下：Zotero 数据目录的上一级；推不出时为 null
async function home(pdf) {
  const dir = pdf ? dataDir(pdf) : await libraryDir();
  return dir && path.dirname(dir);
}

// Twig 文件对应的文献编号：新建时写在元信息 zotero；没写时由 pdf 路径里的附件编号（storage/附件编号/）查它所属的文献
// 对应不上（pdf 为空、是链接的文件、附件已删）时为 null
async function paperKey(meta, twigFile) {
  if (meta.zotero) return meta.zotero;
  if (!meta.pdf) return null;
  const pdf = path.resolve(path.dirname(twigFile), meta.pdf);
  if (!dataDir(pdf)) return null;
  const attachment = await raw(path.basename(path.dirname(pdf)));
  return (attachment && attachment.data.parentItem) || null;
}

// 一篇文献下的全部 PDF：[{ title, file }]，file 为本地绝对路径
async function pdfs(key) {
  const children = await get('/items/' + key + '/children?format=json');
  return children
    .filter(c => c.data.contentType === 'application/pdf' && c.links.enclosure)
    .map(c => ({ title: c.data.title, file: fileURLToPath(c.links.enclosure.href) }));
}

// ---------- 引文 ----------

function year(it) { return (it.meta.parsedDate || it.data.date || '').slice(0, 4); }

// 作者简称，如 Morrison 等、Morrison和Milbrandt；由 Zotero 生成，随 Zotero 界面语言。去掉其中不可见的方向控制符
function authors(it) { return (it.meta.creatorSummary || '作者').replace(/[⁦-⁩]/g, ''); }

module.exports = {
  name, field, help, rootName, allPapers, search, recent, folders, folderPapers, views, viewPapers, home, paperKey, pdfs
};
