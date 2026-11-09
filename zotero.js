// Zotero：通过 Zotero 7 起自带的本地 API 查文献、取 PDF 路径和所在分类，并把文献信息填进 Twig 模板
// 本地 API 需要 Zotero 开着，并在 设置 → 高级 勾选“允许此计算机上的其他应用程序与 Zotero 通信”
const path = require('path');
const { fileURLToPath } = require('url');

const API = 'http://localhost:23119/api/users/0';

// 出错时 error.reason 说明原因：offline 为连不上（没装或没打开 Zotero），disabled 为 Zotero 开着但没开本地 API；error.status 为返回码
async function get(url) {
  let res;
  try { res = await fetch(API + url); } catch (e) { throw Object.assign(new Error('连不上 Zotero'), { reason: 'offline' }); }
  if (!res.ok) throw Object.assign(new Error('Zotero 返回 ' + res.status), { reason: 'disabled', status: res.status });
  return res.json();
}

// 按编号取一篇文献或一个附件；Zotero 里没有或已移进回收站时为 null
async function item(key) {
  try {
    const it = await get('/items/' + key + '?format=json');
    return it.data.deleted ? null : it;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// 只要文献条目，去掉独立附件和笔记
function papers(items) { return items.filter(it => !['attachment', 'note', 'annotation'].includes(it.data.itemType)); }

// 在整个文献库里按标题、作者、年份搜索，最近改动的在前
async function search(q) {
  return papers(await get('/items/top?format=json&limit=20&sort=dateModified&direction=desc&q=' + encodeURIComponent(q)));
}

// 最近改动的几篇；多取一些，去掉附件和笔记后再截取
async function recent(limit) {
  return papers(await get('/items/top?format=json&sort=dateModified&direction=desc&limit=' + limit * 4)).slice(0, limit);
}

// 文件夹（Zotero 里叫分类）：不给 parent 时为顶层，否则为它的子文件夹；按名称排序
async function folders(parent) {
  const list = await get((parent ? '/collections/' + parent + '/collections' : '/collections/top') + '?format=json');
  return list
    .map(c => ({ key: c.key, name: c.data.name, folders: c.meta.numCollections || 0, papers: c.meta.numItems || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

// 直接放在某个文件夹里的论文，按标题排序
async function folderPapers(key) {
  return papers(await get('/collections/' + key + '/items/top?format=json&sort=title'));
}

// 全部文件夹：{ 编号: { name, parent } }，不含回收站里的
async function collections() {
  const all = {};
  for (const c of await get('/collections?format=json')) {
    if (!c.data.deleted) all[c.key] = { name: c.data.name, parent: c.data.parentCollection };
  }
  return all;
}

// 一篇文献所在的各个文件夹，每个写成从顶层往下的名称列表，如 [['大气科学文献1', '2026暑假']]
// 一次处理多篇时，先用 collections() 取一次全部文件夹传进来
async function folderPaths(it, all) {
  all = all || await collections();
  return (it.data.collections || []).filter(key => all[key]).map(key => {
    const names = [];
    for (let k = key; k && all[k]; k = all[k].parent) names.unshift(all[k].name);
    return names;
  });
}

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

// Twig 文件对应的文献编号：新建时写在元信息 zotero；没写时由 pdf 路径里的附件编号（storage/附件编号/）查它所属的文献
// 对应不上（pdf 为空、是链接的文件、附件已删）时为 null
async function paperKey(meta, twigFile) {
  if (meta.zotero) return meta.zotero;
  if (!meta.pdf) return null;
  const pdf = path.resolve(path.dirname(twigFile), meta.pdf);
  if (!dataDir(pdf)) return null;
  const attachment = await item(path.basename(path.dirname(pdf)));
  return (attachment && attachment.data.parentItem) || null;
}

// 一篇文献下的全部 PDF：[{ title, file }]，file 为本地绝对路径
async function pdfs(key) {
  const children = await get('/items/' + key + '/children?format=json');
  return children
    .filter(c => c.data.contentType === 'application/pdf' && c.links.enclosure)
    .map(c => ({ title: c.data.title, file: fileURLToPath(c.links.enclosure.href) }));
}

function year(it) { return (it.meta.parsedDate || it.data.date || '').slice(0, 4); }

// 作者简称，如 Morrison 等、Morrison和Milbrandt；由 Zotero 生成，随 Zotero 界面语言。去掉其中不可见的方向控制符
function authors(it) { return (it.meta.creatorSummary || '作者').replace(/[⁦-⁩]/g, ''); }

// 作者简称与年份，如 Morrison 等 (2009)
function label(it) { return authors(it) + ' (' + year(it) + ')'; }

// 文件名，如 01_Morrison等2009_twig.md
function fileName(it, number) {
  return String(number).padStart(2, '0') + '_' + authors(it).replace(/\s+/g, '') + year(it) + '_twig.md';
}

// 完整引文，如 Morrison, Thompson & Tatarskii (2009). 题目. *Monthly Weather Review*, 137, 991–1007.
// 作者超过 3 位时写成“第一作者 et al.”
function citation(it) {
  const d = it.data;
  const names = d.creators.filter(c => c.creatorType === 'author').map(c => c.lastName || c.name);
  const authors = names.length > 3 ? names[0] + ' et al.'
    : names.length > 1 ? names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1]
    : names[0] || '作者';
  const where = [d.publicationTitle && '*' + d.publicationTitle + '*', d.volume, d.pages && d.pages.replace('-', '–')]
    .filter(Boolean).join(', ');
  return authors + ' (' + year(it) + '). ' + d.title + '.' + (where ? ' ' + where + '.' : '');
}

// 页码字段的起始页，如 991-1007 → 991；没有页码或是文章编号（如 e2023GL…）时为 1
function firstPage(it) {
  const m = (it.data.pages || '').match(/^\s*(\d+)/);
  return m ? +m[1] : 1;
}

// 把文献信息填进模板：标题、一级标题、引文、pdf（相对 Twig 文件的路径）、zotero（文献编号）、firstPage
// 替换值写成函数：标题里的 $$、$& 等在字符串替换值中是特殊记号，会被改掉
function fill(template, it, pdf, twigFile) {
  return fillPdf(template, pdf, twigFile)
    .replace(/^zotero:.*$/m, () => 'zotero: ' + it.key)
    .replace(/^title: .*$/m, () => 'title: ' + label(it) + ' Twig')
    .replace(/^# .*$/m, () => '# ' + label(it) + ' Twig')
    .replace(/^> 论文：.*$/m, () => '> 论文：' + citation(it))
    .replace(/^firstPage:.*$/m, () => 'firstPage: ' + firstPage(it));
}

// 只填 pdf：从 PDF 新建时用，firstPage 清空，标题、引文由 AI 读 PDF 后填
function fillPdf(template, pdf, twigFile) {
  return template
    .replace(/^pdf: .*$/m, () => 'pdf: ' + pdfPath(pdf, twigFile))
    .replace(/^firstPage:.*$/m, 'firstPage:');
}

// 元信息 pdf 的写法：PDF 相对 Twig 文件的路径，用 / 分隔；不在同一个盘时用绝对路径
function pdfPath(pdf, twigFile) {
  if (!pdf) return '';
  let rel = path.relative(path.dirname(twigFile), pdf);
  if (path.isAbsolute(rel)) rel = pdf;
  return rel.split(path.sep).join('/');
}

module.exports = {
  search, recent, folders, folderPapers, item, collections, folderPaths, dataDir, libraryDir, paperKey,
  pdfs, label, fileName, fill, fillPdf, pdfPath
};
