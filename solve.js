// A fast, dependency-free build for one site, written from scratch in this
// session: it returns exactly the output tree the reference generator
// produces for the same input, but renders each source in a single pass
// with index-based scanning and array-joined output, so no token lists,
// no per-line regular expressions and no repeated string concatenation
// sit on the hot path. Pure function of its input: no clock, no file,
// no network, no state kept between cases.

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RESERVED = ['posts', 'tags', 'page'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

// ---------------------------------------------------------------- text

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

function escapeHtml(s) {
  return s.replace(ESC_RE, (c) => ESC_MAP[c]);
}

// The slug of a text: NFKD, combining marks dropped, A-Z lowered, every
// run of other characters one "-", none at either end, at most 64 chars,
// "untitled" when nothing is left. Pure ASCII text skips normalisation:
// NFKD is the identity there. `cache` lives for one case only.
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

function longDate(date) {
  return Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 5760 ||
      (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const LINE_RE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function parseStringValue(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

function parseKeyValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = parseStringValue(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    const m = DATE_RE.exec(raw);
    const y = m ? Number(m[1]) : 0;
    const mo = m ? Number(m[2]) : 0;
    const d = m ? Number(m[3]) : 0;
    if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    for (const t of tags) {
      if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  // slug
  return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
}

// A source's front matter and body, or { error } with the first reason it
// is refused. Scans lines from the front only; the body stays one slice.
function parseFrontMatter(text) {
  let pos = 0;
  const nextLine = () => {
    if (pos > text.length) return null;
    const nl = text.indexOf('\n', pos);
    if (nl === -1) {
      const l = text.slice(pos);
      pos = text.length + 1;
      return l;
    }
    const l = text.slice(pos, nl);
    pos = nl + 1;
    return l;
  };
  if (nextLine() !== '---') return { error: 'no front matter' };
  const fmLines = [];
  let closed = false;
  for (;;) {
    const l = nextLine();
    if (l === null) break;
    if (l === '---') { closed = true; break; }
    fmLines.push(l);
  }
  if (!closed) return { error: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < fmLines.length; k++) {
    const line = fmLines[k];
    if (isBlank(line) || line[0] === '#') continue;
    const m = LINE_RE.exec(line);
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] === undefined ? '' : m[2]).replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = parseKeyValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(pos) };
}

// ---------------------------------------------------------------- Markdown

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function isWsCh(ch) {
  const c = ch.charCodeAt(0);
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

function isLangCh(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

// A fence opener's language, or null when the line opens no fence.
function fenceLang(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let j = 3;
  while (j < line.length && isLangCh(line.charCodeAt(j))) j++;
  const lang = line.slice(3, j);
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length ? lang : null;
}

function fenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingOf(line) {
  let j = 0;
  while (j < line.length && line[j] === '#') j++;
  if (j === 0 || j > 6 || j >= line.length) return null;
  const c = line.charCodeAt(j);
  if (c !== 32 && c !== 9) return null;
  let k = j;
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  if (k >= line.length) return null;
  let e = line.length;
  while (e > k && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === k) return null;
  return { depth: j, text: line.slice(k, e) };
}

function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A list item's marker, or null: { ordered, start, text }.
function listMarker(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: line.slice(2) };
  let j = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c < 48 || c > 57) break;
    j++;
  }
  if (j >= 1 && j <= 9 && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
    return { ordered: true, start: Number(line.slice(0, j)), text: line.slice(j + 2) };
  }
  return null;
}

function isContinued(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  if (k < 2 || k >= line.length) return false;
  return !isWsCh(line[k]);
}

function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

// The first index from `from` (below `to`) where `s` holds `what` outside
// a backslash escape, or -1.
function findUnescaped(s, what, from, to) {
  for (let j = from; j <= to - what.length; j++) {
    if (s[j] === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

// The first single * from `from` (below `to`, one whose run is not **),
// outside an escape, or -1.
function findSingleStar(s, from, to) {
  for (let j = from; j < to; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

// `s[from..to)` rendered inline into `out`; `env.link(target)` resolves
// a link. Nested markup renders in place over the same range, so no
// substring is built for it. The next markup character is found with one
// native scan, not a loop.
const SPECIAL_RE = /[\\`*[]/g;

function inlineInto(s, env, out, from, to) {
  let i = from;
  while (i < to) {
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(s);
    const j = m === null || m.index >= to ? to : m.index;
    if (j > i) {
      out.push(escapeHtml(s.slice(i, j)));
      i = j;
      if (i >= to) break;
    }
    const c = s[i];
    if (c === '\\' && i + 1 < to && ESCAPABLE.has(s[i + 1])) {
      const nx = s[i + 1];
      out.push(nx === '>' ? '&gt;' : nx);
      i += 2;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < to && k > i + 1) {
        out.push('<code>');
        out.push(escapeHtml(s.slice(i + 1, k)));
        out.push('</code>');
        i = k + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2, to);
        if (k > i + 2) {
          out.push('<strong>');
          inlineInto(s, env, out, i + 2, k);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1, to);
      if (k > i + 1) {
        out.push('<em>');
        inlineInto(s, env, out, i + 1, k);
        out.push('</em>');
        i = k + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, to);
      const m2 = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 || m2 >= to ? '' : s.slice(k + 2, m2);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="');
        out.push(escapeHtml(env.link(target)));
        out.push('">');
        inlineInto(s, env, out, i + 1, k);
        out.push('</a>');
        i = m2 + 1;
        continue;
      }
      out.push('[');
      i++;
      continue;
    }
    out.push(escapeHtml(c));
    i++;
  }
}

function inlineStr(s, env) {
  const out = [];
  inlineInto(s, env, out, 0, s.length);
  return out.join('');
}

// A body rendered: its HTML, its table of contents and its excerpt.
function renderMarkdown(src, env, slugCache) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      out.push('<pre><code' + (lang === '' ? '' : ' class="language-' + escapeHtml(lang) + '"') + '>');
      while (i < n && !fenceClose(lines[i])) {
        out.push(escapeHtml(lines[i]));
        out.push('\n');
        i++;
      }
      i++;
      out.push('</code></pre>\n');
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text, slugCache), ids);
      const html = inlineStr(hd.text, env);
      out.push('<h' + hd.depth + ' id="' + id + '">' + html + '</h' + hd.depth + '>\n');
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { out.push('<hr>\n'); i++; continue; }
    if (line[0] === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') {
        const l = lines[i];
        body.push(trimLine(l.startsWith('> ') ? l.slice(2) : l.slice(1)));
        i++;
      }
      const kept = body.filter((l) => l !== '');
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push('<blockquote>\n<p>' + inlineStr(kept.join('\n'), env) + '</p>\n</blockquote>\n');
      continue;
    }
    const lm = listMarker(line);
    if (lm !== null) {
      const ordered = lm.ordered;
      const items = [];
      while (i < n) {
        const m = listMarker(lines[i]);
        if (m !== null && m.ordered === ordered) {
          items.push([trimLine(m.text)]);
          i++;
        } else if (items.length > 0 && isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      if (ordered) out.push(lm.start !== 1 ? '<ol start="' + lm.start + '">\n' : '<ol>\n');
      else out.push('<ul>\n');
      for (const parts of items) out.push('<li>' + inlineStr(parts.join('\n'), env) + '</li>\n');
      out.push(ordered ? '</ol>\n' : '</ul>\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const text = body.join('\n');
    if (excerpt === null) {
      const html = inlineStr(text, env);
      excerpt = html;
      out.push('<p>' + html + '</p>\n');
    } else {
      out.push('<p>');
      inlineInto(text, env, out, 0, text.length);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function onlySpaces(src, a, b) {
  for (let k = a; k < b; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A template's tokens: text (0), escaped value (1), raw value (2), tag (3).
// A {% %} tag alone on its line takes the whole line with it.
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const nx = src[open + 1];
    if (nx !== '{' && nx !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (nx === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 0, text });
      text = '';
      tokens.push({ t: raw ? 2 : 1, path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaces(src, lineStart, open) && onlySpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 0, text });
    text = '';
    tokens.push({ t: 3, tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 0, text });
  return tokens;
}

// Nodes: [0, text], [1, path, raw], [2, path, not, then, else|null],
// [3, varName, path, body], [4, templateName].
function parseTemplate(name, src) {
  const root = [];
  const stack = [{ kind: 0, node: null, body: root }];
  let body = root;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 0) { body.push([0, tok.text]); continue; }
    if (tok.t === 1 || tok.t === 2) { body.push([1, tok.path, tok.t === 2]); continue; }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = [3, m[1], pathOf(name, m[2]), []];
      body.push(node);
      stack.push({ kind: 1, node, body: node[3] });
      body = node[3];
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = [2, pathOf(name, m[2]), m[1] !== undefined, [], null];
      body.push(node);
      stack.push({ kind: 2, node, body: node[3] });
      body = node[3];
    } else if (tag === 'else') {
      if (top.kind !== 2 || top.node[4] !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.node[4] = [];
      top.body = top.node[4];
      body = top.node[4];
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 1 : 2)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      body = stack[stack.length - 1].body;
    } else if ((m = INC_RE.exec(tag)) !== null) {
      body.push([4, m[1]]);
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) {
    throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind === 1 ? 'for' : 'if'} is not closed`);
  }
  return root;
}

// Which names a template can read, transitively, and how deep its includes
// nest. A template that only reads site, tags and recent renders the same
// for every page of a case, so its output is rendered once and reused.
function analyzeTemplates(templates) {
  const own = new Map();
  const allLoopVars = new Set();
  for (const [name, nodes] of templates) {
    const deps = new Set();
    const includes = [];
    const walk = (ns, bound) => {
      for (const node of ns) {
        if (node[0] === 1) {
          if (!bound.has(node[1][0])) deps.add(node[1][0]);
        } else if (node[0] === 2) {
          if (!bound.has(node[1][0])) deps.add(node[1][0]);
          walk(node[3], bound);
          if (node[4] !== null) walk(node[4], bound);
        } else if (node[0] === 3) {
          if (!bound.has(node[2][0])) deps.add(node[2][0]);
          allLoopVars.add(node[1]);
          const b2 = new Set(bound);
          b2.add(node[1]);
          b2.add('loop');
          walk(node[3], b2);
        } else if (node[0] === 4) {
          includes.push(node[1]);
        }
      }
    };
    walk(nodes, new Set());
    own.set(name, { deps, includes });
  }
  const shadowed = allLoopVars.has('site') || allLoopVars.has('tags') || allLoopVars.has('recent');
  const memoDeps = new Map();
  const memoDepth = new Map();
  const collectDeps = (name, visiting) => {
    if (memoDeps.has(name)) return memoDeps.get(name);
    if (visiting.has(name)) return new Set();
    const o = own.get(name);
    if (o === undefined) return new Set();
    visiting.add(name);
    const d = new Set(o.deps);
    for (const inc of o.includes) for (const x of collectDeps(inc, visiting)) d.add(x);
    visiting.delete(name);
    memoDeps.set(name, d);
    return d;
  };
  const depthOf = (name, visiting) => {
    if (memoDepth.has(name)) return memoDepth.get(name);
    if (visiting.has(name)) return Infinity;
    const o = own.get(name);
    if (o === undefined || o.includes.length === 0) {
      memoDepth.set(name, 0);
      return 0;
    }
    visiting.add(name);
    let m = 0;
    for (const inc of o.includes) m = Math.max(m, 1 + depthOf(inc, visiting));
    visiting.delete(name);
    memoDepth.set(name, m);
    return m;
  };
  const info = new Map();
  for (const name of templates.keys()) {
    const d = collectDeps(name, new Set());
    let statik = !shadowed;
    if (statik) {
      for (const x of d) {
        if (x !== 'site' && x !== 'tags' && x !== 'recent') { statik = false; break; }
      }
    }
    info.set(name, { statik, depth: depthOf(name, new Set()) });
  }
  return info;
}

// The value at `path` in the scope chain: its first name from the nearest
// scope holding it, then own properties of the value so far.
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, out, depth, ctx) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    const kind = node[0];
    if (kind === 0) {
      out.push(node[1]);
      continue;
    }
    if (kind === 1) {
      const v = textOf(lookup(scope, node[1]));
      out.push(node[2] ? v : escapeHtml(v));
      continue;
    }
    if (kind === 2) {
      const v = truthy(lookup(scope, node[1]));
      const branch = v !== node[2] ? node[3] : node[4];
      if (branch !== null) renderNodes(branch, scope, out, depth, ctx);
      continue;
    }
    if (kind === 3) {
      const xs = lookup(scope, node[2]);
      if (!Array.isArray(xs)) continue;
      const len = xs.length;
      for (let k = 0; k < len; k++) {
        const vars = { [node[1]]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
        renderNodes(node[3], { vars, parent: scope }, out, depth, ctx);
      }
      continue;
    }
    const t = ctx.templates.get(node[1]);
    if (t === undefined || depth >= INCLUDE_DEPTH) continue;
    const inf = ctx.info.get(node[1]);
    if (inf !== undefined && inf.statik && depth + inf.depth < INCLUDE_DEPTH) {
      if (ctx.cache.has(node[1])) {
        out.push(ctx.cache.get(node[1]));
      } else {
        const tmp = [];
        renderNodes(t, scope, tmp, depth + 1, ctx);
        const s = tmp.join('');
        ctx.cache.set(node[1], s);
        out.push(s);
      }
    } else {
      renderNodes(t, scope, out, depth + 1, ctx);
    }
  }
}

// ---------------------------------------------------------------- the build

function linkOf(s) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date === undefined ? '' : s.data.date,
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

export function run(input) {
  const slugCache = new Map();
  const base = input.site.base_url.replace(/\/+$/, '');
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const tctx = { templates, info: analyzeTemplates(templates), cache: new Map() };

  const files = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(d + '/')) { own = d; break; }
    }
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target[0] === '/' || target[0] === '#') return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
        if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  const ownTags = (s) => {
    const seen = new Set();
    const names = s.data.tags ?? [];
    const out = [];
    for (const name of names) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, out, 0, tctx);
    return out.join('');
  };
  for (const s of kept) output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
