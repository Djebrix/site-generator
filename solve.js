// Fast makefun-site drop-in: run(input) returns byte-for-byte what makefun-site
// 1.0.0's build returns for the same input, faster.
//
// My own implementation of the same spec (front matter, template dialect,
// Markdown subset, slug rule, report). Same pipeline order, same error strings,
// same output tree. The speed comes from doing less work, not different work:
//   - inline Markdown scans plain runs in bulk instead of escaping one
//     character at a time (the reference spends ~a third of its CPU there);
//   - the Markdown lexer and renderer are fused into one pass over the
//     body's lines, with hand-rolled character checks instead of a regex
//     per line per block kind, and no intermediate token objects;
//   - slugify takes an ASCII fast path (no NFKD normalisation, no mark
//     stripping) and memoises repeated strings (tag names, headings) per case;
//   - word counting scans code units instead of building a match array, and
//     each source's reading time is computed once, not once per card;
//   - template rendering appends to one array and joins once, reuses one
//     scope frame per loop instead of one per item, and tags are slugified
//     once per name instead of two or three times.
// No state is kept between cases: every run() builds its own caches.

/** Code-unit order (never the locale's). */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const hasOwn = Object.hasOwn;

/** Whether a UTF-16 code unit is JavaScript whitespace (\s). */
function isWS(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 ||
    c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

// ---------------------------------------------------------------- text

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function esc(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESC_MAP[c]) : text;
}

/** The slug of `text`, memoised in `cache` (fresh per case). */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  // Pure ASCII needs no NFKD normalisation and has no combining marks.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  const out = slugCore(ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, ''));
  cache.set(text, out);
  return out;
}

/** The slug core: A-Z lowered, every run of non [a-z0-9] one "-", none at
 *  either end, at most 64 characters, "untitled" when nothing is left. */
function slugCore(s) {
  let out = '';
  let gap = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let k = -1;
    if (c >= 65 && c <= 90) k = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) k = c;
    if (k < 0) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) { out += '-'; gap = false; }
    out += String.fromCharCode(k);
  }
  if (out.length > 64) out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = 2;
  for (;;) {
    const out = slug + '-' + n;
    if (!taken.has(out)) { taken.add(out); return out; }
    n++;
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let w = false;
  for (let i = 0; i < text.length; i++) {
    if (isWS(text.charCodeAt(i))) w = false;
    else if (!w) { n++; w = true; }
  }
  return n;
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28;
  return (m === 4 || m === 6 || m === 9 || m === 11) ? 30 : 31;
}

function validDate(raw) {
  if (raw.length !== 10) return false;
  if (raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 +
    (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
  const mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
  const d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
  if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysIn(y, mo);
}

function validName(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** /^[a-z0-9]+(?:-[a-z0-9]+)*$/ and at most 64 characters. */
function validSlug(raw) {
  if (raw.length === 0 || raw.length > 64) return false;
  let i = 0;
  const n = raw.length;
  for (;;) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) return false;
    while (i < n) {
      const d = raw.charCodeAt(i);
      if ((d >= 97 && d <= 122) || (d >= 48 && d <= 57)) i++;
      else break;
    }
    if (i === n) return true;
    if (raw.charCodeAt(i) !== 45) return false;
    i++;
    if (i === n) return false;
  }
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function fmString(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: 'a quoted string is not closed' };
    }
    let out = '';
    let seg = 1;
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        const n = raw.charCodeAt(i + 1);
        if ((n !== 34 && n !== 92) || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += raw.slice(seg, i) + raw[i + 1];
        i++;
        seg = i + 1;
      } else if (c === 34) {
        return { error: 'a quoted string holds a stray quote' };
      }
    }
    out += raw.slice(seg, raw.length - 1);
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return s.error !== undefined ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date':
      return validDate(raw)
        ? { value: raw }
        : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags': {
      if (raw.length < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i];
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout':
      return validName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return validSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFM(text) {
  const nl = text.indexOf('\n');
  if ((nl === -1 ? text : text.slice(0, nl)) !== '---') return { error: 'no front matter' };
  // Find the closing line first: a malformed line still reports "not closed"
  // when there is no closing line at all.
  let pos = nl === -1 ? text.length : nl + 1;
  let lineNo = 2;
  let closeLine = -1;
  let closeEnd = -1;
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    const end = e === -1 ? text.length : e;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 &&
        text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeLine = lineNo;
      closeEnd = end === text.length ? text.length : end + 1;
      break;
    }
    if (end === text.length) break;
    pos = end + 1;
    lineNo++;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = nl === -1 ? text.length : nl + 1;
  for (let ln = 2; ln < closeLine; ln++) {
    const e = text.indexOf('\n', p);
    const end = e === -1 ? text.length : e;
    let blank = true;
    for (let i = p; i < end; i++) {
      const c = text.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (!blank && text.charCodeAt(p) !== 35) {
      // "key: value": key of a-z and _, a colon, one space and the value.
      let k = p;
      while (k < end) {
        const c = text.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === p || text.charCodeAt(k) !== 58) {
        return { error: 'line ' + ln + ' is not "key: value"' };
      }
      const key = text.slice(p, k);
      let raw;
      if (k + 1 === end) raw = '';
      else if (text.charCodeAt(k + 1) === 32) raw = text.slice(k + 2, end);
      else return { error: 'line ' + ln + ' is not "key: value"' };
      let rEnd = raw.length;
      while (rEnd > 0) {
        const c = raw.charCodeAt(rEnd - 1);
        if (c === 32 || c === 9) rEnd--;
        else break;
      }
      raw = raw.slice(0, rEnd);
      if (!FM_KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
      if (hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
      if (raw === '') return { error: 'key "' + key + '" has no value' };
      const v = fmValue(key, raw);
      if (v.error !== undefined) return v;
      data[key] = v.value;
    }
    p = end + 1;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence opener's language, or null (not a fence). */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
        c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  let k = j;
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  if (k !== line.length) return null;
  return line.slice(3, j);
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  let j = n;
  if (j >= line.length || (line.charCodeAt(j) !== 32 && line.charCodeAt(j) !== 9)) return null;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let e = line.length;
  while (e > j && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e <= j) return null;
  return { depth: n, text: line.slice(j, e) };
}

function isHR(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let j = 3; j < line.length; j++) {
    const d = line.charCodeAt(j);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** A bullet item's text, or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and text, or null. */
function orderedOf(line) {
  let j = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c >= 48 && c <= 57) j++;
    else break;
  }
  if (j === 0 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** A list continuation: two or more spaces, then a non-space. */
function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= line.length) return false;
  return !isWS(line.charCodeAt(j));
}

/** Whether `line` ends a paragraph. */
function endsPara(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHR(line);
}

/** A paragraph line as rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return line.slice(s, e);
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

function hasWS(s) {
  for (let i = 0; i < s.length; i++) if (isWS(s.charCodeAt(i))) return true;
  return false;
}

/** `s` rendered inline; `link(target)` is a link's href. */
function inline(s, link) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    // One bulk run of characters that need no escaping and start no markup.
    let j = i;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 92 || c === 96 || c === 42 || c === 91 || c === 38 ||
          c === 60 || c === 62 || c === 34 || c === 39) break;
      j++;
    }
    if (j > i) out += s.slice(i, j);
    if (j >= n) break;
    i = j;
    const c = s.charCodeAt(i);
    if (c === 38) { out += '&amp;'; i++; }
    else if (c === 60) { out += '&lt;'; i++; }
    else if (c === 62) { out += '&gt;'; i++; }
    else if (c === 34) { out += '&quot;'; i++; }
    else if (c === 39) { out += '&#39;'; i++; }
    else if (c === 92) {
      // The escaped character is itself escaped: of the escapable
      // characters, '>' is also in the escape table, so "\>" is "&gt;".
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) { out += s[i + 1] === '>' ? '&gt;' : s[i + 1]; i += 2; }
      else { out += '\\'; i++; }
    } else if (c === 96) {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) { out += '<code>' + esc(s.slice(i + 1, k)) + '</code>'; i = k + 1; }
      else { out += '`'; i++; }
    } else if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) { out += '<strong>' + inline(s.slice(i + 2, k), link) + '</strong>'; i = k + 2; }
        else { out += '**'; i += 2; }
      } else {
        const k = findSingleStar(s, i + 1);
        if (k > i + 1) { out += '<em>' + inline(s.slice(i + 1, k), link) + '</em>'; i = k + 1; }
        else { out += '*'; i++; }
      }
    } else { // '['
      const k = findUnescaped(s, ']', i + 1);
      const m = (k !== -1 && s.charCodeAt(k + 1) === 40) ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasWS(target)) {
        out += '<a href="' + esc(link(target)) + '">' + inline(s.slice(i + 1, k), link) + '</a>';
        i = m + 1;
      } else { out += '['; i++; }
    }
  }
  return out;
}

/**
 * `src` rendered: its HTML, its table of contents and its excerpt (the first
 * paragraph's inline HTML, or ""). `C` carries the per-case slug cache.
 */
function renderMD(src, C, link) {
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
      out.push('<pre><code' + (lang === '' ? '' : ' class="language-' + esc(lang) + '"') + '>');
      while (i < n && !isFenceClose(lines[i])) { out.push(esc(lines[i])); out.push('\n'); i++; }
      if (i < n) i++;
      out.push('</code></pre>');
      out.push('\n');
      continue;
    }
    const h = headingOf(line);
    if (h !== null) {
      const id = uniqueSlug(slugify(h.text, C.slugCache), ids);
      const html = inline(h.text, link);
      out.push('<h' + h.depth + ' id="' + id + '">' + html + '</h' + h.depth + '>');
      out.push('\n');
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) { out.push('<hr>'); out.push('\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        body.push(l.length > 1 && l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        i++;
      }
      const kept = [];
      for (let b = 0; b < body.length; b++) {
        const t = trimLine(body[b]);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>');
      else out.push('<blockquote>\n<p>' + inline(kept.join('\n'), link) + '</p>\n</blockquote>');
      out.push('\n');
      continue;
    }
    const b = bulletOf(line);
    const o = b === null ? orderedOf(line) : null;
    if (b !== null || o !== null) {
      const ordered = o !== null;
      const start = ordered ? o.num : 1;
      const items = [];
      while (i < n) {
        const l = lines[i];
        let m = null;
        if (ordered) {
          const om = orderedOf(l);
          if (om !== null) m = om.text;
        } else m = bulletOf(l);
        if (m !== null) { items.push([trimLine(m)]); i++; }
        else if (isContinued(l)) { items[items.length - 1].push(trimLine(l)); i++; }
        else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(ordered && start !== 1 ? '<ol start="' + start + '">' : '<' + tag + '>');
      out.push('\n');
      for (let it = 0; it < items.length; it++) {
        out.push('<li>' + inline(items[it].join('\n'), link) + '</li>\n');
      }
      out.push('</' + tag + '>');
      out.push('\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsPara(lines[i])) { body.push(trimLine(lines[i])); i++; }
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out.push('<p>' + html + '</p>');
    out.push('\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
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
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let standalone = true;
    for (let p = lineStart; p < open; p++) {
      const c = src.charCodeAt(p);
      if (c !== 32 && c !== 9) { standalone = false; break; }
    }
    if (standalone) {
      for (let p = end; p < lineEnd; p++) {
        const c = src.charCodeAt(p);
        if (c !== 32 && c !== 9) { standalone = false; break; }
      }
    }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Node kinds: 0 text, 1 var, 2 raw, 3 if [not, path, then, else|null],
// 4 for [name, path, body], 5 include [name].

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = [];
  const stack = [{ kind: 'root', body: root, node: null }];
  let body = root;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') { body.push([0, tok.text]); continue; }
    if (tok.t === 'var' || tok.t === 'raw') { body.push([tok.t === 'var' ? 1 : 2, tok.path]); continue; }
    const tag = tok.tag;
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = [4, m[1], pathOf(name, m[2]), []];
      body.push(node);
      stack.push({ kind: 'for', body: node[3], node });
      body = node[3];
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = [3, m[1] !== undefined, pathOf(name, m[2]), [], null];
      body.push(node);
      stack.push({ kind: 'if', body: node[3], node });
      body = node[3];
    } else if (tag === 'else') {
      const top = stack[stack.length - 1];
      if (top.kind !== 'if' || top.node[4] !== null) {
        throw new TemplateError('template "' + name + '": an else outside an if');
      }
      top.node[4] = [];
      top.body = top.node[4];
      body = top.node[4];
    } else if (tag === 'endfor' || tag === 'endif') {
      const top = stack[stack.length - 1];
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
        throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
      }
      stack.pop();
      body = stack[stack.length - 1].body;
    } else if ((m = INC_RE.exec(tag)) !== null) {
      body.push([5, m[1]]);
    } else {
      throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) {
    throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  }
  return root;
}

/** The value at `path` in the scope chain. */
function lookup(scope, path) {
  let s = scope;
  const first = path[0];
  while (s !== null) {
    if (hasOwn(s.vars, first)) break;
    s = s.parent;
  }
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** `nodes` rendered into `out` in `scope` ({ vars, parent }). */
function renderNodes(nodes, scope, C, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const nd = nodes[ni];
    const k = nd[0];
    if (k === 0) out.push(nd[1]);
    else if (k === 1) out.push(esc(textOf(lookup(scope, nd[1]))));
    else if (k === 2) out.push(textOf(lookup(scope, nd[1])));
    else if (k === 3) {
      const v = truthy(lookup(scope, nd[2]));
      const br = v !== nd[1] ? nd[3] : nd[4];
      if (br !== null) renderNodes(br, scope, C, depth, out);
    } else if (k === 4) {
      const xs = lookup(scope, nd[2]);
      if (Array.isArray(xs) && xs.length > 0) {
        // One scope frame per loop, its bindings rewritten per item: the
        // render is synchronous, so no iteration can observe another's.
        const vars = {};
        const loop = { index: 0, first: false, last: false, length: xs.length };
        vars.loop = loop;
        const child = { vars, parent: scope };
        const nm = nd[1];
        const body = nd[3];
        for (let idx = 0; idx < xs.length; idx++) {
          vars[nm] = xs[idx];
          vars.loop = loop;
          loop.index = idx + 1;
          loop.first = idx === 0;
          loop.last = idx === xs.length - 1;
          renderNodes(body, child, C, depth, out);
        }
      }
    } else {
      const t = C.templates.get(nd[1]);
      if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, C, depth + 1, out);
    }
  }
}

// ---------------------------------------------------------------- the build

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
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

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function hasScheme(t) {
  const c = t.charCodeAt(0);
  if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const d = t.charCodeAt(i);
    if (d === 58) return true;
    if (!((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) ||
        d === 43 || d === 45 || d === 46)) return false;
  }
  return false;
}

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary !== undefined ? s.data.summary : '',
    excerpt: s.excerpt,
    reading_minutes: s.reading,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  return {
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.tocView,
    newer: linkOf(s.newer !== undefined && s.newer !== null ? s.newer : null),
    older: linkOf(s.older !== undefined && s.older !== null ? s.older : null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const C = {
    slugCache: new Map(),
    templates: new Map(),
    broken: new Set(),
    bySource: new Map(),
    staticPaths: new Set(),
    base: '',
  };
  const report = [];

  // Templates, parsed in code-unit order of name; one that does not parse
  // is reported and left out.
  const names = Object.keys(input.templates).sort(cmp);
  for (let i = 0; i < names.length; i++) {
    try {
      C.templates.set(names[i], parseTemplate(names[i], input.templates[names[i]]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  C.base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of path; .md is a source, anything else static.
  const files = input.files.slice().sort((x, y) => cmp(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order; the first failing check is reported.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFM(s.text);
    if (fm.error !== undefined) {
      report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout !== undefined ? s.data.layout : (s.post ? 'post' : 'page');
    if (!C.templates.has(layout)) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each slug made unique in its directory, in source order.
  const taken = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(
      s.data.slug !== undefined ? s.data.slug : slugify(s.data.title, C.slugCache), set);
    s.outDir = dir === '' ? s.slug : dir + '/' + s.slug;
    s.url = C.base + '/' + s.outDir + '/';
    C.bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved.
  C.staticPaths = new Set(statics.map((f) => f.path));
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const spath = s.path;
    const link = (target) => {
      if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && C.bySource.has(path)) return C.bySource.get(path).url + frag;
      if (path !== null && C.staticPaths.has(path)) return C.base + '/' + path + frag;
      C.broken.add('broken-link ' + spath + ' -> ' + target);
      return target;
    };
    const md = renderMD(s.body, C, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.reading = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
    s.tocView = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
  }

  // Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by slug, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags !== undefined ? s.data.tags : [];
    for (let i = 0; i < tags.length; i++) {
      const slug = slugify(tags[i], C.slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(tags[i]);
    }
    return out;
  };
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, C.slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: C.base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, C.slugCache);
      const t = bySlug.get(slug);
      return t !== undefined ? t : { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => (y.posts.length - x.posts.length) || cmp(x.slug, y.slug));

  // Layouts: every page, the index pages, the tag pages, then the statics.
  const output = {};
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: C.base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = C.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, C, 0, out);
    return out.join('');
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? C.base + '/' : C.base + '/page/' + k + '/');
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
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // The report: every line reported above and each broken link, sorted,
  // then the counts.
  const lines = [...report, ...C.broken].sort(cmp);
  let pageCount = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) pageCount++;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length +
    ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
