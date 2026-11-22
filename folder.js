// PDF 文件夹文献库：给不用文献软件的用户，把放论文 PDF 的文件夹当作文献库；接口见 library.js
// 各级子文件夹即分类，其中的 PDF 即论文；文献编号为 PDF 相对该文件夹的路径（用 / 分隔），不写进 Twig 文件，查重按 pdf 路径比对
// 论文只有文件名，新建时只填 pdf，引文、firstPage 等由 AI 读 PDF 后填；只读，不改文件夹里的文件
const fs = require('fs');
const path = require('path');

// 各种出错原因的说明，显示在侧栏和选论文的列表顶部
const help = {
  nofolder: { label: '还没选 PDF 文件夹', detail: '点侧栏的“选择文献库”，选放论文 PDF 的文件夹' },
  missing: { label: '找不到 PDF 文件夹', detail: '在工作区里建一个“论文”文件夹放 PDF，或点侧栏的“选择文献库”另选文件夹' }
};

// 打开一个 PDF 文件夹（绝对路径），返回 library.js 规定的文献库对象；每次调用时重新读文件夹，增删文件立即可见
function open(root) {
  // 文件夹里的全部 PDF：[论文]，按相对路径排序；文件夹不在时按 help 报错
  const scan = () => {
    if (!root) throw Object.assign(new Error(help.nofolder.label), { reason: 'nofolder' });
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw Object.assign(new Error(help.missing.label + '：' + root), { reason: 'missing' });
    return fs.readdirSync(root, { recursive: true })
      .filter(f => /\.pdf$/i.test(f) && !hidden(f))
      .map(f => paper(f.split(path.sep).join('/')))
      .sort((a, b) => a.key.localeCompare(b.key, 'zh'));
  };
  // 子文件夹 dir（相对路径，空为顶层）下的直接子文件夹
  const subdirs = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
    .filter(d => d.isDirectory() && !hidden(d.name))
    .map(d => (dir ? dir + '/' : '') + d.name);
  const inside = (key, dir) => key.startsWith(dir + '/');

  return {
    name: 'PDF 文件夹', field: null, help,
    watch: root ? { base: root, pattern: '**' } : null,   // 增删、移动 PDF 和子文件夹后侧栏自动刷新
    async rootName() { scan(); return path.basename(root); },
    async allPapers() { return scan(); },
    async search(q) {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      return scan().filter(p => words.every(w => p.key.toLowerCase().includes(w))).slice(0, 20);
    },
    async recent(n) {
      const time = p => fs.statSync(path.join(root, p.key)).mtimeMs;
      return scan().map(p => ({ p, t: time(p) })).sort((a, b) => b.t - a.t).slice(0, n).map(x => x.p);
    },
    // 分类即子文件夹，key 为相对路径
    async folders(parent) {
      scan();
      return subdirs(parent || '')
        .map(key => ({ key, name: path.posix.basename(key), folders: subdirs(key).length }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    },
    // 子文件夹里的 PDF，包括更深层的
    async folderPapers(key) { return scan().filter(p => inside(p.key, key)); },
    // 有子文件夹时给出“未分类”：直接放在顶层、没进任何子文件夹的 PDF
    async views() {
      scan();
      return subdirs('').length ? [{ key: 'unfiled', name: '未分类', icon: 'inbox' }] : [];
    },
    async viewPapers(key) { return key === 'unfiled' ? scan().filter(p => !p.key.includes('/')) : []; },
    // 没开工作区时 Twig追问整理 放在 PDF 文件夹旁边
    async home() { return root ? path.dirname(root) : null; },
    // 文献编号由 pdf 指向的文件推出；不在本文件夹里时为 null
    async paperKey(meta, twigFile) {
      if (!meta.pdf || !root) return null;
      const rel = path.relative(root, path.resolve(path.dirname(twigFile), meta.pdf));
      return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : rel.split(path.sep).join('/');
    },
    async pdfs(key) {
      const file = path.join(root, key);
      return fs.existsSync(file) ? [{ title: path.basename(file), file }] : [];
    }
  };
}

// 统一的论文对象（见 library.js）：作者处放文件名，标题处放所在的子文件夹（侧栏里显示在文件名后面），引文留空
function paper(key) {
  const dir = path.posix.dirname(key);
  return { key, authors: path.posix.basename(key).replace(/\.pdf$/i, ''), year: '', title: dir === '.' ? '' : dir, citation: '', firstPage: 1 };
}

// 以 . 开头的文件和文件夹（如 .git、.obsidian）不算
function hidden(rel) { return rel.split(/[\\/]/).some(part => part.startsWith('.')); }

module.exports = { open };
