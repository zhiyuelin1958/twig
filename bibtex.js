// BibTeX 文献库：读一个 .bib 文件，条目即论文，JabRef 的分组即分类，file 字段即 PDF；接口见 library.js
// .bib 可以由 JabRef 维护，也可以由 Zotero（Better BibTeX）、EndNote、Mendeley 等导出；只读，不改 .bib
const fs = require('fs');
const path = require('path');
const library = require('./library.js');

// 各种出错原因的说明，显示在选论文的列表顶部和整理文件夹的提示里
const help = {
  nofile: { label: '没有设置 .bib 文件', detail: '在设置里搜索 twig.bibFile，填上 .bib 文件的路径' },
  missing: { label: '找不到 .bib 文件', detail: '检查设置 twig.bibFile 里的路径' }
};

const cache = new Map();                           // .bib 路径 → { mtime, lib }，文件改动后重新解析

// 打开一个 .bib 文件，返回 library.js 规定的文献库对象；文件在每次调用时检查，改动后重新读
function open(bibFile) {
  const load = async () => {
    if (!bibFile) throw Object.assign(new Error(help.nofile.label), { reason: 'nofile' });
    let stat;
    try { stat = fs.statSync(bibFile); } catch (e) { throw Object.assign(new Error(help.missing.label + '：' + bibFile), { reason: 'missing' }); }
    const hit = cache.get(bibFile);
    if (hit && hit.mtime === stat.mtimeMs) return hit.lib;
    const lib = build(fs.readFileSync(bibFile, 'utf8').replace(/^﻿/, ''), bibFile);
    cache.set(bibFile, { mtime: stat.mtimeMs, lib });
    return lib;
  };

  return {
    name: 'BibTeX', field: 'citekey', help,
    async search(q) {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      return (await load()).papers.filter(p => words.every(w => p.text.includes(w))).slice(0, 20);
    },
    async recent(n) { return (await load()).byRecent.slice(0, n); },
    async item(key) { return (await load()).byKey.get(key) || null; },
    async folders(parent) {
      const lib = await load();
      return lib.groups.filter(g => g.parent === (parent ?? null))
        .map(g => ({ key: g.id, name: g.name, folders: lib.groups.filter(c => c.parent === g.id).length,
          papers: lib.papers.filter(p => p.groups.includes(g.id)).length }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    },
    async folderPapers(key) {
      return (await load()).papers.filter(p => p.groups.includes(key)).sort((a, b) => a.title.localeCompare(b.title));
    },
    async collections() { return load(); },
    async folderPaths(p, lib) {
      lib = lib || await load();
      return p.groups.map(id => {
        const names = [];
        for (let g = lib.groupById.get(id); g; g = lib.groupById.get(g.parent)) names.unshift(g.name);
        return names;
      });
    },
    async home() { return bibFile ? path.dirname(bibFile) : null; },
    // 元信息 citekey；没写时按 pdf 指向的文件找 file 字段里有它的条目
    async paperKey(meta, twigFile) {
      if (meta.citekey) return meta.citekey;
      if (!meta.pdf) return null;
      const pdf = path.resolve(path.dirname(twigFile), meta.pdf);
      const p = (await load()).papers.find(p => p.files.some(f => samePath(f.file, pdf)));
      return p ? p.key : null;
    },
    async pdfs(key) {
      const p = (await load()).byKey.get(key);
      return p ? p.files : [];
    }
  };
}

// ---------- 解析 .bib ----------

// 解析整个文件：{ papers, byKey, byRecent, groups, groupById }
function build(text, bibFile) {
  const entries = [], comments = [];
  for (const e of scan(text)) {
    if (e.type === 'comment') comments.push(e.body);
    else if (e.type !== 'string' && e.type !== 'preamble') entries.push(e);
  }
  const meta = jabrefMeta(comments);
  const { groups, explicit } = parseGroups(meta.grouping || meta.groupstree || '');   // groupstree 为旧版 JabRef 的写法
  const fileDir = resolveDir(path.dirname(bibFile), meta.fileDirectory);

  const papers = entries.map((e, order) => paper(e, order, groups, explicit, fileDir));
  const stamp = p => p.modified || '';
  const byRecent = [...papers].sort((a, b) => stamp(b).localeCompare(stamp(a)) || b.order - a.order);   // 没有时间的按文件里的先后，后加的在前
  return { papers, byKey: new Map(papers.map(p => [p.key, p])), byRecent, groups, groupById: new Map(groups.map(g => [g.id, g])) };
}

// 逐个切出 @类型{…}：普通条目为 { type, key, fields }，@comment 为 { type, body }
// @string 定义的宏（如 mwr = "Monthly Weather Review"）在之后的字段值里展开
function* scan(text) {
  const at = /@\s*([a-zA-Z]+)\s*([{(])/g;
  const strings = {};
  let m;
  while ((m = at.exec(text))) {
    const type = m[1].toLowerCase();
    const close = m[2] === '{' ? '}' : ')';
    const start = at.lastIndex;
    let depth = 1, i = start;
    for (; i < text.length && depth; i++) {
      if (text[i] === '{' || (close === ')' && text[i] === '(')) depth++;
      else if (text[i] === '}' || (close === ')' && text[i] === ')')) depth--;
    }
    const body = text.slice(start, i - 1);
    at.lastIndex = i;
    if (type === 'comment') { yield { type, body }; continue; }
    if (type === 'string') { Object.assign(strings, fields(body, strings)); yield { type }; continue; }
    if (type === 'preamble') { yield { type }; continue; }
    const comma = body.indexOf(',');
    if (comma < 0) continue;
    yield { type, key: body.slice(0, comma).trim(), fields: fields(body.slice(comma + 1), strings) };
  }
}

// 字段列表：name = {值} | "值" | 数字或宏（按 strings 展开），可用 # 连接；返回 { 小写字段名: 原始值（去掉最外层括号或引号） }
function fields(s, strings = {}) {
  const out = {};
  let i = 0;
  while (i < s.length) {
    const m = /^[\s,]*([^\s=,{}]+)\s*=\s*/.exec(s.slice(i));
    if (!m) break;
    i += m[0].length;
    const parts = [];
    for (;;) {
      while (/\s/.test(s[i])) i++;
      if (s[i] === '{') {
        let depth = 1, j = i + 1;
        for (; j < s.length && depth; j++) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; }
        parts.push(s.slice(i + 1, j - 1)); i = j;
      } else if (s[i] === '"') {
        let depth = 0, j = i + 1;
        for (; j < s.length && !(s[j] === '"' && depth === 0 && s[j - 1] !== '\\'); j++) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; }
        parts.push(s.slice(i + 1, j)); i = j + 1;
      } else {
        const w = /^[^\s,#}]+/.exec(s.slice(i));
        if (!w) break;
        parts.push(strings[w[0].toLowerCase()] ?? w[0]); i += w[0].length;
      }
      while (/\s/.test(s[i])) i++;
      if (s[i] === '#') { i++; continue; }
      break;
    }
    out[m[1].toLowerCase()] = parts.join('');
  }
  return out;
}

// ---------- 论文 ----------

// 一个条目 → 统一的论文对象（见 library.js），另带 groups（所在分组编号）、files（PDF）、text（搜索用）、modified、order
function paper(e, order, groups, explicit, fileDir) {
  const f = e.fields;
  const all = splitAuthors(f.author || f.editor || '');
  const etal = all.some(a => a.toLowerCase() === 'others');                     // 作者写成 … and others
  const names = all.filter(a => a.toLowerCase() !== 'others').map(lastName);
  const year = ((f.year || f.date || '').match(/\d{4}/) || [''])[0];
  const title = clean(f.title || '');
  const groupNames = (f.groups || '').split(',').map(s => s.trim()).filter(Boolean);
  const ids = groups.filter(g => groupNames.includes(g.name) || (explicit.get(g.id) || []).includes(e.key)).map(g => g.id);
  const authors = names.length > 2 || etal ? names[0] + ' 等' : names.join('和') || '作者';   // 与 Zotero 中文界面的作者简称一致
  return {
    key: e.key, authors, year, title,
    citation: library.citation({ names, etal, year, title, venue: clean(f.journal || f.journaltitle || f.booktitle || ''), volume: f.volume, pages: f.pages }),
    firstPage: library.firstPage(f.pages),
    groups: ids,
    files: files(f.file || '', fileDir),
    text: [e.key, title, names.join(' '), year].join(' ').toLowerCase(),
    modified: f.modificationdate || f.creationdate || f.timestamp || '',
    order
  };
}

// 按最外层的 and 拆开作者；花括号里的整体（如机构名）不拆
function splitAuthors(s) {
  const out = [];
  let depth = 0, from = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
    else if (depth === 0 && /^\sand\s/i.test(s.slice(i, i + 5))) { out.push(s.slice(from, i)); from = i + 5; i += 4; }
  }
  out.push(s.slice(from));
  return out.map(x => x.trim()).filter(Boolean);
}

// 作者的姓：“姓, 名”取逗号前；“名 姓”取最后一个词；整个在花括号里的（机构名）原样
function lastName(a) {
  if (/^\{.*\}$/.test(a)) return clean(a);
  const comma = a.split(',');
  if (comma.length > 1) return clean(comma[0]);
  const words = a.split(/\s+/);
  return clean(words[words.length - 1]);
}

// 去掉 LaTeX 记号：重音转成带附加符号的字母，常见转义还原，花括号去掉
function clean(s) {
  const marks = { '`': '̀', "'": '́', '^': '̂', '~': '̃', '=': '̄', '.': '̇', '"': '̈', 'c': '̧', 'v': '̌', 'u': '̆', 'H': '̋' };
  return s
    .replace(/\\([`'^~=."])\s*\{?\s*([a-zA-Z])\}?/g, (_, m, c) => c + marks[m])
    .replace(/\\([cvuH])\s*\{\s*([a-zA-Z])\s*\}/g, (_, m, c) => c + marks[m])
    .replace(/\\([&%$#_])/g, '$1')
    .replace(/--/g, '–')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC');
}

// ---------- PDF ----------

// file 字段里的 PDF：多个文件用 ; 隔开，每个写成 说明:路径:类型 或只写路径
// 兼容 JabRef（:papers/x.pdf:PDF）、Zotero 导出（Full Text PDF:C\:\\…\\x.pdf:application/pdf）、Mendeley（:C$\backslash$:…:pdf）、
// Better BibTeX（只写路径 C:\…\x.pdf，没有转义）；前三种里 \: \; \\ 为转义
function files(s, fileDir) {
  s = s.replace(/\$\\backslash\$/g, '\\\\');
  const out = [];
  for (const one of split(s, ';')) {
    let parts = split(one, ':');
    if (parts.length >= 4 && /^[a-zA-Z]$/.test(parts[1])) parts = [parts[0], parts[1] + ':' + parts[2], ...parts.slice(3)];   // 没转义的盘符
    let file, type = '';
    if (parts.length >= 3) { parts = parts.map(unescape); file = parts[1]; type = parts[parts.length - 1]; }
    else file = one;                               // 只写了路径：原样用，反斜杠是路径分隔符
    parts = parts.length >= 3 ? parts : [];
    if (!file || !(/\.pdf$/i.test(file) || /pdf/i.test(type))) continue;
    out.push({ title: parts[0] || path.basename(file), file: path.resolve(fileDir, file) });
  }
  return out;
}

// 按没转义的分隔符拆开，转义保留到 unescape 再处理
// 只有 \: \; \\ 算转义，其余反斜杠是 Windows 路径分隔符（有的软件导出时不转义，如 C\:\Users\x.pdf）
function split(s, sep) {
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && /[\\:;]/.test(s[i + 1] || '')) { cur += s[i] + s[i + 1]; i++; }
    else if (s[i] === sep) { out.push(cur); cur = ''; }
    else cur += s[i];
  }
  out.push(cur);
  return out.map(x => x.trim());
}

function unescape(s) { return s.replace(/\\([\\:;])/g, '$1'); }

// ---------- JabRef 元信息与分组 ----------

// @Comment{jabref-meta: 名称:值} → { 名称: 值 }；fileDirectory-用户名 这类按用户区分的也归到 fileDirectory
function jabrefMeta(comments) {
  const out = {};
  for (const c of comments) {
    const m = /^\s*jabref-meta:\s*([\w-]+):([\s\S]*)$/.exec(c);
    if (!m) continue;
    const name = m[1].startsWith('fileDirectory') ? 'fileDirectory' : m[1];
    if (!(name in out)) out[name] = m[2].trim();
  }
  return out;
}

// 附件文件夹：JabRef 设了 fileDirectory 时相对路径按它解析（它本身可以相对 .bib 所在文件夹），否则按 .bib 所在文件夹
function resolveDir(bibDir, dir) {
  dir = dir && unescape(dir.replace(/;$/, ''));
  return dir ? path.resolve(bibDir, dir) : bibDir;
}

// 分组树：每行“层级 类型:名称\;…;”，层级 0 为全部条目，不算分组
// 新版 JabRef 的 StaticGroup 由条目的 groups 字段记成员；旧版的 ExplicitGroup 把成员的 citekey 写在定义里
// 返回 { groups: [{ id, name, parent }], explicit: Map(分组编号 → [citekey]) }；编号取它在文件里的序号
function parseGroups(s) {
  const groups = [], explicit = new Map(), stack = [];
  for (const line of s.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\w+):(.*?);?\s*$/.exec(line);
    if (!m || m[1] === '0') continue;
    const level = +m[1];
    const parts = m[3].split('\\;').map(x => unescape(x.trim()));
    const g = { id: 'g' + groups.length, name: parts[0], parent: level > 1 ? stack[level - 1] || null : null };
    stack[level] = g.id;
    stack.length = level + 1;
    groups.push(g);
    if (m[2] === 'ExplicitGroup') explicit.set(g.id, parts.slice(2).filter(Boolean));
  }
  return { groups, explicit };
}

// 两个路径是否同一位置（Windows 上不分大小写）
function samePath(a, b) {
  return path.relative(a, b) === '';
}

module.exports = { open };
