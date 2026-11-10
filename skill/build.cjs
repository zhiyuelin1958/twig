// Twig：解析源文件，生成独立页面。
// 命令行用法：node build.cjs 文件_twig.md [更多文件.md ...] → 在同一文件夹生成同名 .html
//           node build.cjs --compare 旧文件.md 新文件.md → 列出整理后丢掉的节点和引文，不生成页面
const fs = require('fs');
const path = require('path');

// 节点标题：## 标签 {#id parent=父节点id rel=next status=pending}
// rel 是与父节点的连线：不写为指向父节点的实线箭头（子节点是父节点的基础），next 为指向子节点的实线箭头（由父节点推出），
// assoc 为虚线（只是关联）；与 viewer.html 中画连线的 edge 相同
// status 可取 pending（暂挂）或 extra（超出本文）
const NODE = /^## (.+?)\s*\{#([\w-]+)([^}]*)\}\s*$/;
const RELS = ['next', 'assoc'], STATUSES = ['pending', 'extra'];

function parse(text) {
  text = text.replace(/\r\n/g, '\n');
  const tree = {};
  if (text.startsWith('---')) {                       // 开头的元信息
    const end = text.indexOf('\n---', 3);
    for (const line of text.slice(3, end).trim().split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) tree[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    text = text.slice(end + 4);
  }
  const nodes = [];
  tree.bad = [];                                       // 以 ## 开头却不是合法节点标题的行
  for (const line of text.split('\n')) {
    const m = line.match(NODE);
    if (!m && line.startsWith('## ')) tree.bad.push(line.trim());
    if (m) {
      const node = { id: m[2], label: m[1], body: [] };
      for (const [, key, value] of m[3].matchAll(/(\w+)=([\w-]+)/g)) node[key] = value;
      nodes.push(node);
    } else if (nodes.length) {
      nodes[nodes.length - 1].body.push(line);
    }
  }
  for (const n of nodes) n.body = n.body.join('\n').trim();
  tree.nodes = nodes;
  tree.figures = figurePages(tree.figures || '');
  tree.refs = refLinks(tree.refs || '');
  return tree;
}

// 图表所在页。元信息写成 figures: Fig. 1=993, Fig. 2=995, Tab. 1=994 → { 'Fig 1': 993, 'Fig 2': 995, 'Tab 1': 994 }
function figurePages(line) {
  const map = {};
  for (const [, kind, num, page] of line.matchAll(/(Fig|Tab)\w*\.?\s*([A-Z]?\d+)\s*=\s*(\d+)/g)) map[kind + ' ' + num] = +page;
  return map;
}

// 外部论文的链接。每篇写成 名字=DOI 或网址，本机有 PDF 时再用“|”接 PDF 路径（相对 Twig 文件）和该 PDF 第 1 页的期刊页码：
// refs: Fletcher 1962=10.1007/xxx, KC00=https://…, Khain 2015=10.1002/xxx | ../pdf/Khain.pdf | 247
// → { 'Fletcher 1962': { url: 'https://doi.org/10.1007/xxx' }, …, 'Khain 2015': { url: …, pdf: '../pdf/Khain.pdf', firstPage: 247 } }
function refLinks(line) {
  const map = {};
  for (const item of line.split(/,\s*(?=[^,=|]+=)/)) {
    const i = item.indexOf('=');
    if (i <= 0) continue;
    const [link, pdf, first] = item.slice(i + 1).split('|').map(s => s.trim());
    const ref = { url: !link ? '' : /^https?:/.test(link) ? link : 'https://doi.org/' + link };
    if (pdf) ref.pdf = pdf;
    if (+first) ref.firstPage = +first;
    map[item.slice(0, i).trim()] = ref;
  }
  return map;
}

// 来源标签【论文 · Fletcher 1962 p.12「…」；KC00】里的论文名字：按“；”分开，去掉页码部分。标签写法与 viewer.html 中的 SRC 相同
function paperNames(body) {
  const names = [];
  for (const [, where] of body.matchAll(/^【论文\s*·\s*(.+)】\s*$/gm)) {
    for (const part of where.split(/[；;]/)) names.push(part.replace(/\s*p\.\d.*$/, '').trim());
  }
  return names.filter(Boolean);
}

// 正文里的图表引用，如 Fig. 8、Figs. 8 and 9、Tab. 1、Table 2；与 viewer.html 中的 REF 相同
const REF = /\b(Fig|Tab)(?:s|ures?|les?)?\.?\s*([A-Z]?\d+[a-z]?(?:\s*(?:,|，|、|–|-|and)\s*[A-Z]?\d+[a-z]?)*)/g;
function figureRefs(text) {
  const keys = [];
  for (const [, kind, nums] of text.matchAll(REF)) {
    for (const [, num] of nums.matchAll(/([A-Z]?\d+)[a-z]?/g)) keys.push(kind + ' ' + num);
  }
  return keys;
}

// 找出写错的节点标题、父节点、连线、状态、卡片链接、元信息 current，以及写了 pdf 后没登记页码的图表
function check(tree) {
  const ids = new Set(tree.nodes.map(n => n.id));
  const problems = [];
  const missing = new Set();
  for (const line of tree.bad) problems.push(`“${line}”不是合法的节点标题（id 只能用英文字母、数字、_、-；卡片里的小标题用 ###）`);
  if (tree.current && !ids.has(tree.current)) problems.push(`元信息 current 指向不存在的节点 ${tree.current}`);
  for (const n of tree.nodes) {
    if (n.parent && !ids.has(n.parent)) problems.push(`节点 ${n.id} 的父节点 ${n.parent} 不存在`);
    if (n.rel && !RELS.includes(n.rel)) problems.push(`节点 ${n.id} 的 rel=${n.rel} 无效（只能是 next 或 assoc，指向父节点的箭头不用写）`);
    if (n.rel && !n.parent) problems.push(`节点 ${n.id} 没有父节点，rel 不起作用`);
    if (n.status && !STATUSES.includes(n.status)) problems.push(`节点 ${n.id} 的 status=${n.status} 无效（只能是 pending 或 extra）`);
    for (const [, target] of n.body.matchAll(/\]\(#([\w-]+)\)/g)) {
      if (!ids.has(target)) problems.push(`节点 ${n.id} 链接到不存在的 ${target}`);
    }
    if (tree.pdf) figureRefs(n.body).forEach(k => { if (!tree.figures[k]) missing.add(k.replace(' ', '. ')); });
    for (const name of paperNames(n.body)) {
      if (!tree.refs[name]) problems.push(`节点 ${n.id} 引用的论文“${name}”没有登记在元信息 refs`);
    }
  }
  for (const [name, ref] of Object.entries(tree.refs)) {
    if (ref.pdf && !ref.firstPage) problems.push(`元信息 refs 中“${name}”写了 PDF 路径，缺少第 1 页的期刊页码，标签里该文的页码点不到原文`);
  }
  if (missing.size) problems.push(`元信息 figures 缺少这些图表的页码，点不到原文：${[...missing].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).join('、')}`);
  return problems;
}

// 整理前后比对：旧文件有、新文件没有的节点，以及出现次数变少的页码引文（p.994「…」），供 AI 对照删除清单逐条解释
// 按次数比：同一引文在别处还有时，某张卡片里丢掉的那次也能查出来
function compare(before, after) {
  const problems = [];
  const ids = new Set(after.nodes.map(n => n.id));
  for (const n of before.nodes) if (!ids.has(n.id)) problems.push(`节点 ${n.id}（${n.label}）不在新文件中`);
  const count = tree => {
    const map = new Map();
    for (const n of tree.nodes) for (const q of n.body.match(/p\.\d+(?:[–-]\d+)?「[^」]+」/g) || []) {
      if (!map.has(q)) map.set(q, []);
      map.get(q).push(n.id);
    }
    return map;
  };
  const kept = count(after);
  for (const [q, where] of count(before)) {
    const now = (kept.get(q) || []).length;
    if (now < where.length) problems.push(`引文 ${q} 由 ${where.length} 次减到 ${now} 次（原在 ${where.join('、')}）`);
  }
  return problems;
}

function toHtml(tree) {
  const template = fs.readFileSync(path.join(__dirname, 'viewer.html'), 'utf8');
  const data = JSON.stringify(tree).replace(/</g, '\\u003c');
  return template.replace('__DATA__', () => data);
}

module.exports = { parse, check, compare, toHtml };

if (require.main === module && process.argv[2] === '--compare') {
  const [before, after] = process.argv.slice(3).map(f => parse(fs.readFileSync(f, 'utf8')));
  const problems = compare(before, after).concat(check(after));
  problems.forEach(p => console.log('  ! ' + p));
  console.log(problems.length ? `共 ${problems.length} 条，逐条对照删除清单` : '没有丢失的节点和引文，格式无误');
} else if (require.main === module) {
  for (const file of process.argv.slice(2)) {
    const tree = parse(fs.readFileSync(file, 'utf8'));
    check(tree).forEach(p => console.log('  ! ' + p));
    const output = file.replace(/\.md$/, '.html');
    fs.writeFileSync(output, toHtml(tree));
    console.log(`已生成 ${output}（${tree.nodes.length} 个节点）`);
  }
}
