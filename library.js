// 文献库：Twig 从哪个文献库取论文、分类和 PDF，以及与具体文献库无关的部分（文件名、填模板、pdf 路径写法）；不用 vscode 接口
//
// 接口：各文献库模块（zotero.js、bibtex.js、folder.js）导出同一组成员；侧栏和搜索框只调用这些成员，不按文献库分情况写
//   name                 显示名，如 Zotero
//   field                Twig 元信息里存文献编号的字段，如 zotero；为 null 时不存，文献编号由 pdf 推出（见 paperKey）
//   help                 { 出错原因: { label, detail } }，出错时 error.reason 为其中一个原因
//   rootName()           文献库顶层的名字，如“我的文库”；侧栏先调用它，出错即文献库连不上或没设置
//   allPapers()          全部论文，按标题（PDF 文件夹按路径）排序 → [论文]，下同
//   search(q)            按标题、作者、年份搜索 → [论文]
//   recent(n)            最近改动的 n 篇 → [论文]
//   folders(parent)      分类：不给 parent 为顶层，否则为其子分类，按名称排序 → [{ key, name, folders }]，folders 为子分类数
//   folderPapers(key)    分类里的论文，包括各级子分类中的，去重后按标题排序 → [论文]
//   views()              分类以外的特殊入口，如已保存的搜索、未分类条目；没有时为空列表 → [{ key, name, icon }]，icon 为 codicon 名
//   viewPapers(key)      特殊入口里的论文，按标题排序 → [论文]
//   home(pdf)            没开工作区时 Twig追问整理 放在哪个文件夹下 → 路径 | null
//   paperKey(meta, file) Twig 文件对应的文献编号 → 编号 | null
//   pdfs(key)            一篇文献的全部 PDF → [{ title, file }]，file 为本地绝对路径
// 论文：{ key, authors, year, title, citation, firstPage }，authors 为作者简称（如 Morrison 等），citation 为完整引文（见 citation）
//   没有引文的（PDF 文件夹）citation 为空，authors 处放文件名，新建时只填 pdf，引文等由 AI 读 PDF 后填
const fs = require('fs');
const path = require('path');

// 可选的文献库，键与 package.json 里 twig.library 的选项一致；侧栏“选择文献库”按这里列出并引导设置，用户不用进设置页面
//   label、detail  列表里的名字和说明
//   path           要用一个路径设置的：setting 为设置名（twig. 后的部分），pick 为 file（选文件，filters 为可选的类型）或 folder（选文件夹）
// extension.js 按当前工作区把路径设置的相对路径解析成绝对路径，放进 open 的 options；新的文献库在这里登记，extension.js 不用改
const KINDS = {
  zotero: { label: 'Zotero', detail: '需要 Zotero 7 以上开着，并开放本地接口' },
  bibtex: {
    label: '.bib 文件', detail: 'JabRef 维护的，或从 Zotero、EndNote 等导出的；接着选 .bib 文件',
    path: { setting: 'bibFile', pick: 'file', filters: { BibTeX: ['bib'] }, title: '选择 .bib 文件' }
  },
  folder: {
    label: 'PDF 文件夹', detail: '不用文献软件：放论文 PDF 的文件夹，子文件夹即分类；接着选文件夹',
    path: { setting: 'pdfFolder', pick: 'folder', title: '选择放论文 PDF 的文件夹' }
  }
};
const PATH_SETTINGS = Object.values(KINDS).filter(k => k.path).map(k => k.path.setting);

// 按设置 twig.library 取文献库；options.bibFile 为 bibtex 用的 .bib 文件，options.pdfFolder 为 folder 用的 PDF 文件夹（都是绝对路径）
// 各文献库模块要用本文件的 citation 等，所以在这里用到时才加载，避免互相引用
function open(kind, options = {}) {
  if (kind === 'bibtex') return require('./bibtex.js').open(options.bibFile);
  if (kind === 'folder') return require('./folder.js').open(options.pdfFolder);
  return require('./zotero.js');
}

// 完整引文，如 Morrison, Thompson & Tatarskii (2009). 题目. *Monthly Weather Review*, 137, 991–1007.
// names 为作者姓氏列表，超过 3 位或 etal（作者列表本身写了“等”）时写成“第一作者 et al.”
function citation({ names, etal, year, title, venue, volume, pages }) {
  const authors = names.length > 3 || (etal && names.length) ? names[0] + ' et al.'
    : names.length > 1 ? names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1]
    : names[0] || '作者';
  const where = [venue && '*' + venue + '*', volume, pages && pages.replace(/-+/, '–')].filter(Boolean).join(', ');
  return authors + ' (' + year + '). ' + title + '.' + (where ? ' ' + where + '.' : '');
}

// 页码字段的起始页，如 991-1007 → 991；没有页码或是文章编号（如 e2023GL…）时为 1
function firstPage(pages) {
  const m = (pages || '').match(/^\s*(\d+)/);
  return m ? +m[1] : 1;
}

// 作者简称与年份，如 Morrison 等 (2009)；没有年份（如网页）时只写作者
function label(p) { return p.authors + (p.year ? ' (' + p.year + ')' : ''); }

// 生成不重名的 Twig 文件名，如 Morrison等2009_twig.md；同名时依次加 b、c…（Morrison等2015b_twig.md）
// p 为空（从 PDF 新建或空白模板）时用默认名“作者年份”
function fileName(p, folder) {
  // 去掉空格和文件名非法字符；PDF 文件夹的论文以文件名作“作者”，可能很长，截短
  const base = p ? (p.authors.replace(/[\\/:*?"<>|\s]+/g, '') + p.year).slice(0, 40) : '作者年份';
  let name = base + '_twig.md';
  if (!folder || !fs.existsSync(path.join(folder, name))) return name;            // 根目录还没有同名文件，直接用
  for (const suffix of 'bcdefghijklmnopqrstuvwxyz') {                              // 同名时从 b 起顺延字母后缀
    name = base + suffix + '_twig.md';
    if (!fs.existsSync(path.join(folder, name))) return name;
  }
  for (let i = 2; ; i++) {                                                         // 极端情况用完字母后改用数字后缀
    name = base + '_' + i + '_twig.md';
    if (!fs.existsSync(path.join(folder, name))) return name;
  }
}

// 在 Twig 文本里写入文献编号：已有该字段时改写；模板里空的 zotero: 是编号的位置，换成该字段；都没有时加在 pdf 一行后
function setKey(text, field, key) {
  const line = field + ': ' + key;
  const own = new RegExp('^' + field + ':.*$', 'm');
  if (own.test(text)) return text.replace(own, () => line);
  if (/^zotero:\s*$/m.test(text)) return text.replace(/^zotero:\s*$/m, () => line);
  return text.replace(/^pdf:.*$/m, pdfLine => pdfLine + '\n' + line);
}

// 把论文信息填进模板：标题、一级标题、引文、pdf（相对 Twig 文件的路径）、文献编号、firstPage
// 没有引文的（PDF 文件夹）同“从 PDF 新建”，只填 pdf
// 替换值写成函数：标题里的 $$、$& 等在字符串替换值中是特殊记号，会被改掉
function fill(template, lib, p, pdf, twigFile) {
  if (!p.citation) return fillPdf(template, pdf, twigFile);
  return setKey(fillPdf(template, pdf, twigFile), lib.field, p.key)
    .replace(/^title: .*$/m, () => 'title: ' + label(p) + ' Twig')
    .replace(/^# .*$/m, () => '# ' + label(p) + ' Twig')
    .replace(/^> 论文：.*$/m, () => '> 论文：' + p.citation)
    .replace(/^firstPage:.*$/m, () => 'firstPage: ' + p.firstPage);
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

// 文献库出错时给用户看的说明 { label, detail }（见各文献库的 help）；不是文献库报的错（没有 reason）时为 null
function explain(lib, e) {
  return e && e.reason ? lib.help[e.reason] || Object.values(lib.help)[0] : null;
}

// 两个路径是否同一位置（Windows 上不分大小写）
function samePath(a, b) {
  return path.relative(a, b) === '';
}

// 路径的比对形式，作查找表的键：绝对路径，Windows 上转小写；与 samePath 的判断一致
function pathKey(p) {
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

// 论文列表按标题排序（中文按拼音）；和 Zotero 一样不计开头的引号等标点
function byTitle(list) {
  const key = p => (p.title || '').replace(/^[^\p{L}\p{N}]+/u, '');
  return list.sort((a, b) => key(a).localeCompare(key(b), 'zh'));
}

module.exports = { KINDS, PATH_SETTINGS, open, citation, firstPage, label, fileName, setKey, fill, fillPdf, pdfPath, explain, samePath, pathKey, byTitle };
