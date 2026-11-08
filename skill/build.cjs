// Twig：解析源文件，生成独立页面。
// 命令行用法：node build.cjs 文件_twig.md [更多文件.md ...] → 在同一文件夹生成同名 .html
const fs = require('fs');
const path = require('path');

// 节点标题：## 标签 {#id parent=父节点id status=pending}；status 可取 pending（暂挂）或 extra（超出本文）
const NODE = /^## (.+?)\s*\{#([\w-]+)([^}]*)\}\s*$/;

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
  return tree;
}

// 找出写错的节点标题、父节点、卡片链接和元信息 current
function check(tree) {
  const ids = new Set(tree.nodes.map(n => n.id));
  const problems = [];
  for (const line of tree.bad) problems.push(`“${line}”不是合法的节点标题（id 只能用英文字母、数字、_、-；卡片里的小标题用 ###）`);
  if (tree.current && !ids.has(tree.current)) problems.push(`元信息 current 指向不存在的节点 ${tree.current}`);
  for (const n of tree.nodes) {
    if (n.parent && !ids.has(n.parent)) problems.push(`节点 ${n.id} 的父节点 ${n.parent} 不存在`);
    for (const [, target] of n.body.matchAll(/\]\(#([\w-]+)\)/g)) {
      if (!ids.has(target)) problems.push(`节点 ${n.id} 链接到不存在的 ${target}`);
    }
  }
  return problems;
}

function toHtml(tree) {
  const template = fs.readFileSync(path.join(__dirname, 'viewer.html'), 'utf8');
  const data = JSON.stringify(tree).replace(/</g, '\\u003c');
  return template.replace('__DATA__', () => data);
}

module.exports = { parse, check, toHtml };

if (require.main === module) {
  for (const file of process.argv.slice(2)) {
    const tree = parse(fs.readFileSync(file, 'utf8'));
    check(tree).forEach(p => console.log('  ! ' + p));
    const output = file.replace(/\.md$/, '.html');
    fs.writeFileSync(output, toHtml(tree));
    console.log(`已生成 ${output}（${tree.nodes.length} 个节点）`);
  }
}
