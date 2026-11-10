// Twig：解析源文件，生成独立页面。源文件有两种：追问图 *_twig.md（节点组成的树）和灵感笔记 *_idea.md（一篇文档）
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

// 灵感笔记按文件名认：*_idea.md；与 package.json 中预览按钮的 when 条件、extension.js 打开链接时的判断相同
const isIdea = file => /_idea\.md$/i.test(file || '');
const isTwig = file => /_twig\.md$/i.test(file || '');

// file 为源文件路径，用来分辨两种文件；不给时按追问图解析
// 灵感笔记：tree.doc 为全文（去掉开头的 # 标题，它没写元信息 title 时作标题），nodes 为空
function parse(text, file) {
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
  tree.figures = figurePages(tree.figures || '');
  tree.refs = refLinks(tree.refs || '');
  if (isIdea(file)) {
    const title = text.match(/^[ \t]*# (.+)$/m);
    if (title && !tree.title) tree.title = title[1].trim();
    tree.doc = (title ? text.replace(title[0], '') : text).trim();
    tree.nodes = []; tree.bad = [];
    return tree;
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

// 来源标签【论文 · Fletcher 1962 p.12「…」；KC00】里的论文名字：按“；”分开，去掉页码部分
// 标签可以单独一行，也可以写在句末；写法与 viewer.html 中的 SRC、INLINE_SRC 相同
function paperNames(body) {
  const names = [];
  for (const [, where] of body.matchAll(/【论文\s*[·：:]\s*([^】]+)】/g)) {
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

// 卡片里的链接 [文字](地址)，地址含空格或括号时写成 [文字](<地址>)；与 viewer.html 中的 LINK 相同（那边是转义后的 &lt;…&gt;）
const LINK = /\[([^\]]+)\]\((?:<(.+?)>|([^)\s]+))\)/g;
// 本机路径：不是 #节点id，也不是 https:、mailto: 这类网址；E:/… 这样的盘符路径算本机路径。与 viewer.html 中的 isLocal 相同，扩展打开链接时共用
function isLocal(target) {
  return !target.startsWith('#') && (!/^[a-z][\w+.-]*:/i.test(target) || /^[a-z]:[\\/]/i.test(target) || /^file:/i.test(target));
}
// 本机路径 → { file: 绝对路径, anchor: # 后的部分 }；相对路径按 Twig 文件所在文件夹解析，file:/// 和 %20 这类编码照常识别。扩展打开链接时共用
function localLink(target, twigFile) {
  const decode = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };
  const i = target.indexOf('#');
  const p = decode(i < 0 ? target : target.slice(0, i)).replace(/^file:\/*(?=[a-z]:)/i, '').replace(/^file:\/\//i, '');
  return { file: path.resolve(path.dirname(twigFile), p), anchor: i < 0 ? '' : decode(target.slice(i + 1)) };
}

// 文件移到别的文件夹后改写其中的相对路径，使之仍指向原来的文件：元信息 pdf、refs 里的 PDF 路径，以及正文的本机链接 [文字](路径)
// from、to 为移动前后的文件路径；绝对路径、网址和 `代码` 里的不动；moved 把一起移动的文件的旧路径换成新路径，可省略。扩展整理文件夹时用
function relocate(text, from, to, moved = f => f) {
  const absolute = p => /^(file:|[a-z]:[\\/]|[\\/])/i.test(p);
  const rel = file => {                               // 相对新位置的路径，用 / 分隔；不在同一个盘时用绝对路径
    file = moved(file);
    const r = path.relative(path.dirname(to), file);
    return (path.isAbsolute(r) ? file : r).split(path.sep).join('/');
  };
  const pdf = p => absolute(p) ? p : rel(path.resolve(path.dirname(from), p));
  const link = target => {
    const i = target.indexOf('#');
    return absolute(target) ? target : rel(localLink(target, from).file) + (i < 0 ? '' : target.slice(i));
  };
  const close = text.startsWith('---') ? text.indexOf('\n---', 3) : -1;
  const end = close < 0 ? 0 : close + 4;
  const head = text.slice(0, end)
    .replace(/^(pdf:[ \t]*)(\S.*?)[ \t]*$/m, (_, key, p) => key + pdf(p))
    .replace(/^(refs:)(.*)$/m, (_, key, line) => key + line.split(/(,\s*)(?=[^,=|]+=)/).map(item => {
      const parts = item.split('|');                  // 名字=DOI | PDF 路径 | 页码，见 refLinks
      if (parts.length > 1 && parts[1].trim()) parts[1] = parts[1].replace(parts[1].trim(), pdf);
      return parts.join('|');
    }).join(''));
  const body = text.slice(end).replace(new RegExp('`[^`]+`|' + LINK.source, 'g'), (all, label, angled, plain) => {
    const target = angled || plain;
    if (!target || !isLocal(target)) return all;
    const now = link(target);
    return now === target ? all : `[${label}](${angled || /[\s()<>]/.test(now) ? '<' + now + '>' : now})`;
  });
  return head + body;
}

// 链接到另一个 Twig 文件的位置时，# 后的部分对不对：*_twig.md#节点id 要有这个节点，*_idea.md#标题 要有以它开头的标题
// 与 extension.js 的 openLink、viewer.html 的 focus 定位方式相同。没有问题时返回空
function anchorProblem(file, anchor) {
  if (!anchor || !(isTwig(file) || isIdea(file))) return '';
  const target = parse(fs.readFileSync(file, 'utf8'), file);
  if (isTwig(file)) return target.nodes.some(n => n.id === anchor) ? '' : `${path.basename(file)} 里没有节点 ${anchor}`;
  const titles = [...target.doc.matchAll(/^#{2,4}\s+(.+?)\s*$/gm)].map(m => m[1]);
  return titles.some(t => t.startsWith(anchor)) ? '' : `${path.basename(file)} 里没有以“${anchor}”开头的标题`;
}

// 正文里的本机链接：文件不存在，或链接到另一个 Twig 文件的位置不对时，返回问题；where 为出现的位置，如“节点 q1”
function linkProblems(body, file, where) {
  const problems = [];
  for (const [, , angled, plain] of body.replace(/`[^`]+`/g, '').matchAll(LINK)) {
    const target = angled || plain;
    if (!isLocal(target)) continue;
    const { file: linked, anchor } = localLink(target, file);
    if (!fs.existsSync(linked)) problems.push(`${where}链接的本机文件不存在：${linked}`);
    else if (anchorProblem(linked, anchor)) problems.push(`${where}的链接 ${target} 指不到位置：${anchorProblem(linked, anchor)}`);
  }
  return problems;
}

// 找出写错的节点标题、父节点、连线、状态、卡片链接、元信息 current，以及写了 pdf 后没登记页码的图表
// 给出源文件路径时，再检查链接的本机文件是否存在、链接到其他 Twig 文件的位置对不对；灵感笔记只查链接和 refs
function check(tree, twigFile) {
  const problems = [];
  // 名字后可接节号、式号，如“K15 §2 p.253”：以登记过的名字开头就算登记了，与 viewer.html 的 paperTag 认名字的办法相同
  const known = name => Object.keys(tree.refs).some(r => name === r || name.startsWith(r + ' '));
  const unregistered = (body, where) => paperNames(body).filter(name => !known(name))
    .forEach(name => problems.push(`${where}引用的论文“${name}”没有登记在元信息 refs`));
  const refPages = () => Object.entries(tree.refs).forEach(([name, ref]) => {
    if (ref.pdf && !ref.firstPage) problems.push(`元信息 refs 中“${name}”写了 PDF 路径，缺少第 1 页的期刊页码，标签里该文的页码点不到原文`);
  });
  if (tree.doc !== undefined) {
    unregistered(tree.doc, '正文');
    if (twigFile) problems.push(...linkProblems(tree.doc, twigFile, '正文'));
    refPages();
    return problems;
  }
  const ids = new Set(tree.nodes.map(n => n.id));
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
    if (twigFile) problems.push(...linkProblems(n.body, twigFile, `节点 ${n.id} `));
    if (tree.pdf) figureRefs(n.body).forEach(k => { if (!tree.figures[k]) missing.add(k.replace(' ', '. ')); });
    unregistered(n.body, `节点 ${n.id} `);
  }
  refPages();
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

module.exports = { parse, check, compare, toHtml, isLocal, localLink, relocate, isTwig, isIdea };

if (require.main === module && process.argv[2] === '--compare') {
  const files = process.argv.slice(3);
  const [before, after] = files.map(f => parse(fs.readFileSync(f, 'utf8'), f));
  const problems = compare(before, after).concat(check(after, files[1]));
  problems.forEach(p => console.log('  ! ' + p));
  console.log(problems.length ? `共 ${problems.length} 条，逐条对照删除清单` : '没有丢失的节点和引文，格式无误');
} else if (require.main === module) {
  for (const file of process.argv.slice(2)) {
    const tree = parse(fs.readFileSync(file, 'utf8'), file);
    check(tree, file).forEach(p => console.log('  ! ' + p));
    const output = file.replace(/\.md$/, '.html');
    fs.writeFileSync(output, toHtml(tree));
    console.log(`已生成 ${output}` + (tree.doc === undefined ? `（${tree.nodes.length} 个节点）` : '（灵感笔记）'));
  }
}
