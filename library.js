// 文献库：Twig 从哪个文献库取论文、分类和 PDF，以及与具体文献库无关的部分（文件名、填模板、pdf 路径写法）；不用 vscode 接口
//
// 接口：各文献库模块（zotero.js、bibtex.js）导出同一组成员
//   name                 显示名，如 Zotero
//   field                Twig 元信息里存文献编号的字段，如 zotero
//   help                 { 出错原因: { label, detail } }，出错时 error.reason 为其中一个原因
//   search(q)            按标题、作者、年份搜索 → [论文]
//   recent(n)            最近改动的 n 篇 → [论文]
//   item(key)            按编号取一篇 → 论文 | null（没有或已删除）
//   folders(parent)      分类：不给 parent 为顶层，否则为其子分类 → [{ key, name, folders, papers }]，后两项为数量
//   folderPapers(key)    直接放在某个分类里的论文 → [论文]
//   collections()        全部分类，一次整理多篇时先取一次，传给 folderPaths
//   folderPaths(p, all)  论文所在的各个分类，每个为从顶层往下的名称列表 → [[名称]]
//   home(pdf)            没开工作区时 Twig阅读整理 放在哪个文件夹下 → 路径 | null
//   paperKey(meta, file) Twig 文件对应的文献编号 → 编号 | null
//   pdfs(key)            一篇文献的全部 PDF → [{ title, file }]，file 为本地绝对路径
// 论文：{ key, authors, year, title, citation, firstPage }，authors 为作者简称（如 Morrison 等），citation 为完整引文
const path = require('path');
const zotero = require('./zotero.js');

// 按设置 twig.library 取文献库
function open(kind) {
  return zotero;
}

// 作者简称与年份，如 Morrison 等 (2009)
function label(p) { return p.authors + ' (' + p.year + ')'; }

// 文件名，如 01_Morrison等2009_twig.md
function fileName(p, number) {
  return String(number).padStart(2, '0') + '_' + p.authors.replace(/\s+/g, '') + p.year + '_twig.md';
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
// 替换值写成函数：标题里的 $$、$& 等在字符串替换值中是特殊记号，会被改掉
function fill(template, lib, p, pdf, twigFile) {
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

module.exports = { open, label, fileName, setKey, fill, fillPdf, pdfPath };
