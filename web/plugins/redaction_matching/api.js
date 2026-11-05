/* redaction_matching — candidate names against redaction bars, by measured
   width in the bar's own face.

   Which names fit a bar, the reading each bar is labelled with, and the panel
   that lists the selected bar's fits and holds its formats (the pill editor),
   its filter and the name lists. What fits and why: guide/plugins/redaction-matching/README.md.

   A `scripts_before_viewer` entry: it runs after the core (state.js defines
   `state` and `els`) and before pdf-viewer.js, with the panel's markup
   already parsed — so at load it sees only the core and its own markup, and
   every other plugin is reached at call time, behind a guard. No IIFE: its
   top-level functions are globals, and Recto calls some of them by name
   (createNewRedaction, calculateWidthsForRedaction, calculateAllWidths,
   selectRedaction, updateAllMatchesView, renderCandidates,
   syncNameSettingsUI): keep those names and signatures. Every other plugin's
   globals share the page, hence the distinctive names (`rm…` for the panel). */

// ── Name lists ──────────────────────────────────────────────
//
// A shipped list is a JSON file in this folder, fetched through assetURL (its
// URL carries the file's hash). It holds entries { first: [...], middle,
// last: [...], prefix, suffix, nickname, gender, email: [...], note, links }
// — names.json's shape: a person's first spelling is their own, the others
// are aliases; `middle` is a middle name or initial, `gender` 'f' or 'm',
// `email` their addresses, `links` where the entry was read and where to read
// more (nameEntryLinks), each null or empty where the list does not know it
// — or plain strings, which every format writes as they stand (an e-mail
// address). Adding a list is a file and a line here; `on` is whether bars
// are matched against it from the start. The lists are the whole document's;
// Your names are typed or pasted.
const NAME_LISTS = [
  { id: 'people',     label: 'People',     file: 'names.json',               on: true },
  { id: 'businesses', label: 'Businesses', file: 'contacts-businesses.json', on: false },
];
const YOUR_NAMES = 'yours';

// ── Formats ─────────────────────────────────────────────────
//
// How a bar writes a name: a pattern of the name's parts and the characters
// between them — `{First} {Last}`, `{LAST}, {First}`, `{F}. {Last}`,
// `{first}.{last}`. A part is written the way it comes out: {LAST} in
// capitals, {last} in lowercase, {Last} as the list spells it; {F}, {M} and
// {L} are the initials. A part only some entries have — {Middle}, {Title},
// {Suffix}, {Nick}, an e-mail address, {Mr} for a man or {Ms} for a woman —
// writes nothing for an entry without it, and so neither does the format. A
// missing first or last name drops out with the characters before it, so an
// entry with one name — a business, "Abby" — reads the same under every
// format (though never as a lone initial).
//
// Two signs make one pattern several: [ … ] is optional — names are made
// with it and without it, `{First}[ {M}.] {Last}` — and {A|B} is either part,
// each with text of its own: `{First|F.} {Last}`, `{Mr|Ms}. {Last}`. A \
// writes the sign after it as it stands. A bar can have several formats on;
// its names are all of theirs. Each bar has its own; with no bar selected the
// panel edits the formats a new bar starts with.

// Every part: the word it is written with (in braces, in any case), what it
// writes for one spelling of an entry, and how the editor offers it. `own`:
// a part only some entries have; `from`: the field it is taken from.
const NAME_PART_DEFS = {
  first:         { word: 'First',  label: 'First name',     kind: 'name',  value: v => v.first },
  firstInitial:  { word: 'F',      label: 'First initial',  kind: 'name',  value: v => nameInitial(v.first), from: 'first' },
  middle:        { word: 'Middle', label: 'Middle name',    kind: 'name',  value: v => v.middle, own: true },
  middleInitial: { word: 'M',      label: 'Middle initial', kind: 'name',  value: v => nameInitial(v.middle), own: true, from: 'middle' },
  last:          { word: 'Last',   label: 'Last name',      kind: 'name',  value: v => v.last },
  lastInitial:   { word: 'L',      label: 'Last initial',   kind: 'name',  value: v => nameInitial(v.last), from: 'last' },
  nickname:      { word: 'Nick',   label: 'Nickname',       kind: 'name',  value: v => v.nickname, own: true },
  prefix:        { word: 'Title',  label: 'Title',          kind: 'title', value: v => v.prefix, own: true },
  suffix:        { word: 'Suffix', label: 'Suffix',         kind: 'title', value: v => v.suffix, own: true },
  mr:            { word: 'Mr',     label: 'Mr — a man',     kind: 'title', value: v => (v.gender === 'm' ? 'Mr' : ''), own: true, from: 'gender' },
  ms:            { word: 'Ms',     label: 'Ms — a woman',   kind: 'title', value: v => (v.gender === 'f' ? 'Ms' : ''), own: true, from: 'gender' },
  mrs:           { word: 'Mrs',    label: 'Mrs — a woman',  kind: 'title', value: v => (v.gender === 'f' ? 'Mrs' : ''), own: true, from: 'gender' },
  miss:          { word: 'Miss',   label: 'Miss — a woman', kind: 'title', value: v => (v.gender === 'f' ? 'Miss' : ''), own: true, from: 'gender' },
  email:         { word: 'Email',  label: 'E-mail address', kind: 'email', value: v => v.email, own: true },
  emailUser:     { word: 'User',   label: 'E-mail, before the @', kind: 'email', value: v => emailSide(v.email, 0), own: true, from: 'email' },
  emailDomain:   { word: 'Domain', label: 'E-mail, after the @',  kind: 'email', value: v => emailSide(v.email, 1), own: true, from: 'email' },
};
// The words a part answers to, lowercased → its field.
const NAME_PARTS = {
  ...Object.fromEntries(Object.entries(NAME_PART_DEFS).map(([field, d]) => [d.word.toLowerCase(), field])),
  prefix: 'prefix', nickname: 'nickname',
};
const NAME_PART_OPTIONAL = new Set(Object.keys(NAME_PART_DEFS).filter(f => NAME_PART_DEFS[f].own));
const NAME_PART_FIRST = new Set(['first', 'firstInitial']);
const NAME_PART_LAST = new Set(['last', 'lastInitial']);
const DEFAULT_NAME_FORMAT = '{First} {Last}';
const NAME_FORMAT_PRESETS = [
  '{First} {Last}', '{Last} {First}', '{Last}, {First}', '{LAST}, {First}', '{First} {LAST}',
  '{FIRST} {LAST}', '{First}', '{Last}', '{F}. {Last}', '{Last}, {F}.', '{Title} {Last}',
  '{Title} {First} {Last}', '{First} {Last} {Suffix}', '{Nick}', '{first}.{last}', '{f}{last}',
  '{First}[ {M}.] {Last}', '[{Title} ]{First} {Last}', '{First|Nick} {Last}', '{First|F.} {Last}',
  '{Mr|Ms}. {Last}', '{Email}', '{User}',
];
// A gender filter's three kinds of entry: recorded as a woman, as a man, or
// neither (most: the lists record few).
const NAME_GENDERS = [['f', 'Women'], ['m', 'Men'], ['x', 'Not recorded']];

// ── Plugin state ────────────────────────────────────────────
// The core declares nothing plugin-specific: this plugin adds its own fields
// to `state` and `els` here, at load, and they go with its folder.
Object.assign(state, {
  nameLists: [
    ...NAME_LISTS.map(l => ({ ...l, raw: [], entries: [], status: 'loading', error: '' })),
    { id: YOUR_NAMES, label: 'Your names', on: true, raw: [], entries: [], status: 'ready', error: '' },
  ],
  namesData: [],             // every entry of the shipped lists, as the files have them (a refiner's vocabulary)
  customCandidates: [],      // Your names, as typed (a refiner reads them too)
  hiddenEntries: new Set(),  // `${list}:${index}` of the entries hidden from every bar
  candidates: [],            // the names a new bar starts with (embedded_text_viewer's capitals test)
  nameSettings: defaultNameSettings(),   // the formats, spellings and filter a new bar starts with
  namesVersion: 0,           // bumped whenever a list changes: every bar's names are made again
});

Object.assign(els, {
  // text_tool's matching controls, in its Text panel (absent without text_tool)
  tol:   document.getElementById('tolerance'),
  kern:  document.getElementById('kerning'),
  upper: document.getElementById('tt-name-case'),   // '' | 'all' | 'first' | 'last' (text_tool's utbCaseMode)
  // this plugin's panel (sidebar_tools.html)
  namesPanel: document.getElementById('tools-sidebar'),
  nameInput:  document.getElementById('name-input'),
});

// The panel's own state: what is open, what is being measured or typed.
// `pill` is the path ("2.1") of the pill whose controls are open; `info` the
// ℹ card's: the fitting name it is about (its key), the ℹ it hangs from,
// whether a click pinned it, and what it shows.
const rmUi = {
  openFormat: null, pill: null, patternOpen: false, nearOpen: false, allFits: false,
  measuring: new Set(), trySeq: 0, timers: {}, dragged: false,
  info: { key: null, anchor: null, pinned: false, html: '' },
};

// ── Helpers ─────────────────────────────────────────────────

// A name as the bar writes it: the Text panel's Letter case (box.uppercase: false,
// true, 'first' or 'last' — text_tool's utbApplyCase) on top of the format's
// own case. Left at "As typed", the format decides.
const caseName = (box, s) => (typeof utbApplyCase === 'function' ? utbApplyCase(String(s), box?.uppercase)
  : box?.uppercase ? String(s).toUpperCase() : String(s));
const caseMode = value => (typeof utbCaseMode === 'function' ? utbCaseMode(value) : value === 'all');
const caseValue = mode => (typeof utbCaseValue === 'function' ? utbCaseValue(mode) : mode ? 'all' : '');
const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const rmNumber = n => Number(n).toLocaleString('en-US');
const rmSigned = d => `${d > 0.004 ? '+' : d < -0.004 ? '−' : '±'}${Math.abs(d).toFixed(2)}`;

/** Every redaction bar (text_tool's boxes of type 'redaction'). */
function getRedactionBoxes() {
  return typeof utbState !== 'undefined' ? utbState.boxes.filter(b => b.type === 'redaction') : [];
}

/** The selected redaction bar, or null. */
function getSelectedRedaction() {
  if (typeof utbState === 'undefined' || !utbState.selectedId) return null;
  const box = utbState.getBox(utbState.selectedId);
  return box && box.type === 'redaction' ? box : null;
}

/** Median of an array of numbers (robust to a stray double space). */
function _median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ── Formats: patterns ───────────────────────────────────────
// A pattern is read into a tree — text, parts with their choices, optional
// groups — and the tree is spelt out into its variants: plain runs of parts
// and the text between them, each of which writes one name per spelling.
// `{First}[ {M}.] {Last}` is `{First} {Last}` and `{First} {M}. {Last}`.
// The editor's pills are the tree, and patternOfNameTree writes it back.

// A pattern that spells out into more variants than this is refused: every
// name is measured, and a few choices multiply quickly.
const NAME_PATTERN_MAX_VARIANTS = 32;

/** A pattern as a tree — [{ t: 'text', s } | { t: 'part', alts: [{ pre,
 *  word, post, field, kase }] } | { t: 'opt', body: [...] }] — or { error }
 *  in words. */
function parseNameTree(src) {
  let i = 0;
  const run = inGroup => {
    const nodes = [];
    const text = s => {
      const last = nodes[nodes.length - 1];
      if (last?.t === 'text') last.s += s;
      else nodes.push({ t: 'text', s });
    };
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') {
        if (i + 1 >= src.length) throw new Error('A \\ at the end stands before nothing');
        text(src[i + 1]);
        i += 2;
      } else if (c === '{') {
        const end = src.indexOf('}', i + 1);
        const next = src.indexOf('{', i + 1);
        if (end < 0 || (next >= 0 && next < end)) throw new Error('A { is missing its partner');
        nodes.push({ t: 'part', alts: src.slice(i + 1, end).split('|').map(nameAlt) });
        i = end + 1;
      } else if (c === '[') {
        i++;
        const body = run(true);
        if (src[i] !== ']') throw new Error('A [ is missing its partner');
        i++;
        if (body.length) nodes.push({ t: 'opt', body });
      } else if (c === ']') {
        if (inGroup) return nodes;
        throw new Error('A ] is missing its partner');
      } else if (c === '}') {
        throw new Error('A } is missing its partner');
      } else if (c === '|') {
        throw new Error('A | goes between two parts in braces: {First|Nick}');
      } else {
        text(c);
        i++;
      }
    }
    return nodes;
  };
  try {
    return { tree: run(false) };
  } catch (e) {
    return { error: e.message };
  }
}

// One choice in braces: a part's word, and any text that goes with it alone
// — {F.} is the initial and its full stop, {(Nick)} the nickname in brackets.
function nameAlt(src) {
  const s = src.trim();
  if (!s) throw new Error('{} names no part');
  const m = /^([^\p{L}\p{N}]*)(\p{L}+)([^\p{L}\p{N}]*)$/u.exec(s);
  const field = m && NAME_PARTS[m[2].toLowerCase()];
  if (!field) throw new Error(`{${s}} is not a part of a name`);
  return { pre: m[1], word: m[2], post: m[3], field, kase: namePartCase(m[2]) };
}

// How many variants a tree spells out, counted before any is made.
function nameTreeCount(nodes) {
  return nodes.reduce((n, x) => n * (x.t === 'part' ? x.alts.length : x.t === 'opt' ? 1 + nameTreeCount(x.body) : 1), 1);
}

// The runs a tree spells out: text, and parts as { field, kase }.
function nameTreeRuns(nodes) {
  let runs = [[]];
  for (const x of nodes) {
    const ways = x.t === 'text' ? [[x.s]]
      : x.t === 'part' ? x.alts.map(a => [a.pre, { field: a.field, kase: a.kase }, a.post])
      : [[], ...nameTreeRuns(x.body)];
    runs = runs.flatMap(r => ways.map(w => [...r, ...w]));
  }
  return runs;
}

// A run as a variant — { parts, lits }, lits[i] standing before parts[i] and
// the last one after the last part — or null when it holds no part.
function nameVariantOf(run) {
  const parts = [], lits = [''];
  for (const x of run) {
    if (typeof x === 'string') lits[lits.length - 1] += x;
    else { parts.push(x); lits.push(''); }
  }
  return parts.length ? { parts, lits } : null;
}

const _namePatterns = new Map();
/** A pattern read: { tree, variants: [{ parts: [{ field, kase }], lits }] },
 *  with { error } in words when it writes nothing — and no tree when it
 *  cannot be read at all. Cached: the tree is shared, so an edit works on a
 *  copy. */
function parseNamePattern(pattern) {
  const src = String(pattern ?? '');
  let parsed = _namePatterns.get(src);
  if (parsed) return parsed;
  const { tree, error } = parseNameTree(src);
  const n = tree ? nameTreeCount(tree) : 0;
  if (!tree) {
    parsed = { error };
  } else if (n > NAME_PATTERN_MAX_VARIANTS) {
    parsed = { tree, variants: [], error: `It makes ${n} variants, at most ${NAME_PATTERN_MAX_VARIANTS}: make it two formats` };
  } else {
    const seen = new Set();
    const variants = nameTreeRuns(tree).map(nameVariantOf).filter(v => {
      const key = v && JSON.stringify(v);
      if (!v || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    parsed = variants.length ? { tree, variants } : { tree, variants, error: 'Add a part, like {Last}' };
  }
  _namePatterns.set(src, parsed);
  return parsed;
}

/** A tree written as a pattern — what the pills write back. */
function patternOfNameTree(nodes) {
  return nodes.map(x => (x.t === 'text' ? x.s.replace(/[\\{}[\]|]/g, '\\$&')
    : x.t === 'part' ? `{${x.alts.map(a => `${a.pre}${a.word}${a.post}`).join('|')}}`
    : `[${patternOfNameTree(x.body)}]`)).join('');
}

// {LAST} in capitals, {last} in lowercase, {Last} as spelt; an initial is a
// capital unless it is written {f}.
function namePartCase(word) {
  if (word.length === 1) return word === word.toLowerCase() ? 'lower' : 'upper';
  if (word === word.toUpperCase()) return 'upper';
  if (word === word.toLowerCase()) return 'lower';
  return 'as';
}

const nameInitial = s => (s ? (/[\p{L}\p{N}]/u.exec(s)?.[0] ?? '') : '');

// An address's user (0) or domain (1): either side of its last @.
function emailSide(s, side) {
  const at = s ? s.lastIndexOf('@') : -1;
  if (at < 0) return '';
  return side ? s.slice(at + 1) : s.slice(0, at);
}

function namePartValue(part, v) {
  const s = NAME_PART_DEFS[part.field].value(v);
  if (!s) return '';
  return part.kase === 'upper' ? s.toUpperCase() : part.kase === 'lower' ? s.toLowerCase() : s;
}

/** One spelling of an entry — { first, middle, last, prefix, suffix,
 *  nickname, email, gender }, strings or null — written in one variant of a
 *  pattern; null when the variant has nothing to write for it. */
function nameFromPattern(p, v) {
  if (!p?.parts) return null;
  const { parts, lits } = p;
  const vals = parts.map(x => namePartValue(x, v));
  if (parts.some((x, i) => NAME_PART_OPTIONAL.has(x.field) && !vals[i])) return null;
  const names = parts.map((x, i) => (NAME_PART_FIRST.has(x.field) || NAME_PART_LAST.has(x.field) ? i : -1)).filter(i => i >= 0);
  const shown = names.filter(i => vals[i]);
  if (names.length && !shown.length) return null;
  // one name of two left, and that one an initial: "Abby" under {F}. {Last}
  if (shown.length < names.length && shown.every(i => parts[i].field.endsWith('Initial'))) return null;
  const at = vals.map((s, i) => (s ? i : -1)).filter(i => i >= 0);
  if (!at.length) return null;
  // the text before a part goes with it; the text before the first part and
  // after the last only while those parts are there
  let s = at[0] === 0 ? lits[0] : '';
  at.forEach((i, k) => { s += (k ? lits[i] : '') + vals[i]; });
  if (at[at.length - 1] === parts.length - 1) s += lits[parts.length];
  return s.trim() || null;
}

/** Every name a pattern writes for one spelling of an entry: one for each
 *  variant that writes something. */
function namesOfPattern(parsed, v) {
  const out = [];
  for (const p of parsed?.variants || []) {
    const s = nameFromPattern(p, v);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// The fields a pattern's variants read ({M} reads `middle`, {Mr} `gender`).
const nameUses = variants => new Set(variants.flatMap(p => p.parts.map(x => NAME_PART_DEFS[x.field].from || x.field)));

/** A format as the panel names it: its pattern without the braces ("LAST, First"). */
function nameFormatLabel(pattern) {
  return String(pattern).replace(/\{([^{}]*)\}/g, '$1').trim() || String(pattern);
}

// ── Formats: editing the tree ───────────────────────────────
// What the pills do to a format, on a copy of its tree. A path is a list of
// indices: [2, 1] is the second node of the group that is the third. The
// panel writes the result back as the pattern (patternOfNameTree).

/** The node at a path and the run that holds it — { seq, i, node } — or null. */
function nameTreeAt(tree, path) {
  let seq = tree;
  for (const j of path.slice(0, -1)) {
    if (seq[j]?.t !== 'opt') return null;
    seq = seq[j].body;
  }
  const i = path[path.length - 1];
  return seq[i] ? { seq, i, node: seq[i] } : null;
}

/** One choice of a part: its word written for a field in a case. */
function nameAltOf(field, kase = 'as', pre = '', post = '') {
  const w = NAME_PART_DEFS[field].word;
  const word = kase === 'upper' ? w.toUpperCase() : kase === 'lower' ? w.toLowerCase() : w;
  return { pre, word, post, field, kase: namePartCase(word) };
}

// A choice's case as the editor offers it: an initial in capitals is as written.
const nameAltKase = a => (a.word.length === 1 && a.kase === 'upper' ? 'as' : a.kase);

// What "or" offers beside a part's last choice.
const NAME_ALT_NEXT = {
  first: 'nickname', nickname: 'firstInitial', firstInitial: 'first', middle: 'middleInitial', middleInitial: 'middle',
  last: 'lastInitial', lastInitial: 'last', prefix: 'mr', suffix: 'prefix', mr: 'ms', ms: 'mrs', mrs: 'miss', miss: 'mr',
  email: 'emailUser', emailUser: 'emailDomain', emailDomain: 'email',
};
function nameAltNext(node) {
  const have = new Set(node.alts.map(a => a.field));
  let f = node.alts[node.alts.length - 1].field;
  for (let n = 0; n < 4; n++) {
    f = NAME_ALT_NEXT[f];
    if (!have.has(f)) return f;
  }
  return Object.keys(NAME_PART_DEFS).find(x => !have.has(x));
}

/** Put a node into a run at i, a space between it and a part beside it;
 *  returns where it went. */
function nameTreeInsert(seq, i, node) {
  const add = [node];
  if (node.t !== 'text') {
    if (seq[i - 1] && seq[i - 1].t !== 'text') add.unshift({ t: 'text', s: ' ' });
    if (seq[i] && seq[i].t !== 'text') add.push({ t: 'text', s: ' ' });
  }
  seq.splice(i, 0, ...add);
  return i + add.indexOf(node);
}

/** Take a node out. A part goes with the text after it — or, last in its
 *  run, the text before it — so what stood around it still reads; a group
 *  left without a part goes too. */
function nameTreeRemove(tree, path) {
  const at = nameTreeAt(tree, path);
  if (!at) return;
  const { seq, i, node } = at;
  if (node.t === 'text') seq.splice(i, 1);
  else if (seq[i + 1]?.t === 'text') seq.splice(i, 2);
  else if (seq[i - 1]?.t === 'text') seq.splice(i - 1, 2);
  else seq.splice(i, 1);
  if (path.length > 1 && !seq.some(x => x.t !== 'text')) {
    const group = path.slice(0, -1);
    nameTreeAt(tree, group).seq.splice(group[group.length - 1], 1);
  }
}

/** Make a node optional: a group around it and the text that goes with it.
 *  A part takes the text before it and the punctuation that clings to its
 *  end (`{First} {M}. {Last}` → `{First}[ {M}.] {Last}`) — or, first in its
 *  run, the text after it (`[{Title} ]{First} {Last}`). Returns its path. */
function nameTreeWrap(tree, path) {
  const at = nameTreeAt(tree, path);
  if (!at) return path;
  const { seq, i, node } = at;
  let from = i, to = i + 1;
  const next = seq[i + 1];
  if (node.t !== 'text' && seq[i - 1]?.t === 'text') {
    from = i - 1;
    const cling = next?.t === 'text' ? /^[^\s\p{L}\p{N}]+(?=\s|$)/u.exec(next.s)?.[0] : null;
    if (cling && cling.length < next.s.length) {
      next.s = next.s.slice(cling.length);
      seq.splice(i + 1, 0, { t: 'text', s: cling });
    }
    if (cling) to = i + 2;
  } else if (node.t !== 'text' && next?.t === 'text') {
    to = i + 2;
  }
  seq.splice(from, to - from, { t: 'opt', body: seq.slice(from, to) });
  return [...path.slice(0, -1), from, i - from];
}

/** Make a group required again: its nodes take its place. */
function nameTreeUnwrap(tree, path) {
  const at = nameTreeAt(tree, path);
  if (at?.node.t === 'opt') at.seq.splice(at.i, 1, ...at.node.body);
}

/** Move a node one place along its run: a part changes places with the
 *  nearest part that way (the text between stays), text with its
 *  neighbour. Returns its new path. */
function nameTreeStep(tree, path, dir) {
  const at = nameTreeAt(tree, path);
  if (!at) return path;
  const { seq, i, node } = at;
  let j = i + dir;
  if (node.t !== 'text') while (seq[j]?.t === 'text') j += dir;
  if (!seq[j]) return path;
  [seq[i], seq[j]] = [seq[j], seq[i]];
  return [...path.slice(0, -1), j];
}

/** Move a node of a run to a place between two others (0 … length);
 *  returns where it went. */
function nameTreeMove(seq, from, to) {
  const [x] = seq.splice(from, 1);
  const i = to > from ? to - 1 : to;
  seq.splice(i, 0, x);
  return i;
}

/** Add what a palette button stands for — a part (`first`), a choice of
 *  parts (`mr|ms`) or `text` — at `at` (where it was dropped), else where it
 *  usually goes: a title first, a middle initial after the first name, the
 *  rest last. A part only some entries have comes optional, with its
 *  separator, so the format still writes everyone else. Returns its path. */
function nameTreeAdd(tree, key, at = null) {
  if (key === 'text') {
    if (at == null && tree[tree.length - 1]?.t === 'text') return [tree.length - 1];
    return [nameTreeInsert(tree, at ?? tree.length, { t: 'text', s: ' ' })];
  }
  const fields = key.split('|');
  const node = { t: 'part', alts: fields.map(f => nameAltOf(f, 'as', '', f === 'middleInitial' ? '.' : '')) };
  if (at == null) {
    const given = tree.findIndex(x => x.t === 'part' && x.alts.some(a => NAME_PART_FIRST.has(a.field) || a.field === 'nickname'));
    const head = fields[0];
    at = NAME_PART_DEFS[head].kind === 'title' && head !== 'suffix' ? 0
      : head === 'middleInitial' && given >= 0 ? given + 1
      : tree.length;
  }
  const i = nameTreeInsert(tree, at, node);
  const own = fields.every(f => NAME_PART_OPTIONAL.has(f));
  return own && tree.some((x, j) => j !== i && x.t !== 'text') ? nameTreeWrap(tree, [i]) : [i];
}

// ── Name settings: one set per bar ──────────────────────────
// A bar's settings (box.nameSettings) — its formats, whether every spelling
// counts, and its filter — start as a copy of the template
// (state.nameSettings), which the panel edits while no bar is selected.

function defaultNameSettings() {
  return {
    formats: [{ id: 'f1', pattern: DEFAULT_NAME_FORMAT, on: true }],
    // Every spelling a person has, by default: the memos write "Lex Wexner"
    // and "Adriana Mucinska", second aliases in the list, and a name the
    // list holds but never generates is a bar the page pixels are never
    // asked about.
    aliases: { first: true, last: true },
    startsWith: '', endsWith: '',
    gender: { f: true, m: true, x: true },
  };
}

/** The settings with every field present (filled in place). */
function completeNameSettings(s) {
  if (!s || typeof s !== 'object') return defaultNameSettings();
  const d = defaultNameSettings();
  if (!Array.isArray(s.formats)) s.formats = d.formats;
  if (!s.aliases || typeof s.aliases !== 'object') s.aliases = d.aliases;
  if (typeof s.startsWith !== 'string') s.startsWith = '';
  if (typeof s.endsWith !== 'string') s.endsWith = '';
  if (!s.gender || typeof s.gender !== 'object') s.gender = d.gender;
  return s;
}

// A copy of the formats and spellings — not the filter, which is the bar's own.
const nameFormatCopy = s => ({ formats: s.formats.map(f => ({ ...f })), aliases: { ...s.aliases } });

/** A bar's settings, a copy of the template's on first use. */
function ensureBoxNameSettings(box) {
  const s = box.nameSettings;
  if (!s || !Array.isArray(s.formats)) {
    box.nameSettings = {
      ...nameFormatCopy(completeNameSettings(state.nameSettings)),
      startsWith: s?.startsWith || '', endsWith: s?.endsWith || '',
      gender: s?.gender ? { ...s.gender } : defaultNameSettings().gender,
    };
  }
  return completeNameSettings(box.nameSettings);
}

/** The settings the panel edits: the selected bar's, else the template. */
function getActiveNameSettings() {
  const box = getSelectedRedaction();
  return box ? ensureBoxNameSettings(box) : completeNameSettings(state.nameSettings);
}

// Starts-with / ends-with filter: one or more letters each, case-insensitive,
// on the name as written — so for a format that leads with the last name the
// start comes from the last name. Empty fields impose nothing.
function matchesLetterFilter(str, settings) {
  const pre = (settings?.startsWith || '').trim().toLowerCase();
  const suf = (settings?.endsWith || '').trim().toLowerCase();
  if (!pre && !suf) return true;
  const s = (str || '').trim().toLowerCase();
  if (!s) return false;
  if (pre && !s.startsWith(pre)) return false;
  if (suf && !s.endsWith(suf)) return false;
  return true;
}

// Gender filter: which entries a bar's names come from — those recorded as
// women, as men, and those with no gender recorded (a typed name, an
// address, most of a list). All three on imposes nothing.
function matchesGenderFilter(e, settings) {
  const g = settings?.gender;
  if (!g) return true;
  return !!g[e?.gender === 'f' || e?.gender === 'm' ? e.gender : 'x'];
}

// ── Name lists: entries ─────────────────────────────────────

/** A list file's entry as the matcher reads it, or null for what is not a name. */
function nameEntry(raw) {
  if (typeof raw === 'string') return raw.trim() ? { text: raw.trim() } : null;
  if (!raw || typeof raw !== 'object') return null;
  // a heading of the book the list was read from ("BRAZIL", "MEDICAL")
  if (/^section heading/i.test(raw.note || '')) return null;
  const spellings = v => (Array.isArray(v) ? v : v ? [v] : []).map(s => String(s).trim()).filter(Boolean);
  const e = {
    first: spellings(raw.first), middle: spellings(raw.middle), last: spellings(raw.last),
    prefix: raw.prefix || null, suffix: raw.suffix || null, nickname: raw.nickname || null,
    email: spellings(raw.email).filter(nameEmailWhole), emailCut: spellings(raw.email).filter(a => !nameEmailWhole(a)),
    gender: nameGender(raw.gender), note: raw.note || '',
    links: nameLinks(raw.links),
  };
  return e.first.length || e.last.length || e.nickname || e.email.length ? e : null;
}

// A whole e-mail address: something, an @, a domain with a dot and an ending.
// A list read off a page has addresses cut off at the edge (`jcayne@`,
// `katieford@fordmanagement.`, `mzuckerman@bostonproperti`): those are kept
// apart (`emailCut`), shown in the ℹ card, and written by no format — a cut
// address would be measured short and could fit a bar the real one would not.
const nameEmailWhole = a => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(a);

// An entry's links as its file has them, string values only:
// { "adress-book": "p75" } (sic) is the page of the address book it was read
// from, { "wiki": "" } its section of Wikipedia's list (nameEntryLinks).
function nameLinks(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' || typeof v === 'number') out[k] = String(v).trim();
  return out;
}

// A recorded gender: 'f' (f, female, w, woman), 'm' (m, male, man), 'x'
// for anything else recorded, null for none.
function nameGender(g) {
  const s = String(g ?? '').trim().toLowerCase();
  if (!s) return null;
  return /^(f|w)/.test(s) ? 'f' : /^m/.test(s) ? 'm' : 'x';
}

/** A typed name as an entry: the last word is the last name and the words
 *  before it the first ("Lex Wexner"); one word is a name of its own; an
 *  address with an @ is written as typed. */
function typedNameEntry(s) {
  const t = String(s).trim().replace(/\s+/g, ' ');
  if (!t) return null;
  if (t.includes('@')) return { text: t };
  const m = /^(.+) (\S+)$/.exec(t);
  return {
    first: m ? [m[1]] : [], middle: [], last: [m ? m[2] : t], prefix: null, suffix: null, nickname: null,
    email: [], emailCut: [], gender: null, note: '', links: {},
  };
}

// ── Name lists: what an entry says about its person ─────────
// The ℹ card beside a fitting name shows these (rmInfoHtml).

// Wikipedia's list: an entry with a `wiki` link has a section there, its id
// the link's fragment or, when that is empty, the entry's last name.
const NAME_WIKI_LIST = 'https://en.wikipedia.org/wiki/List_of_people_named_in_the_Epstein_files';
// The address book an `adress-book` page is of, opened at that page (#page=N).
const NAME_ADDRESS_BOOK = 'https://archive.unbarpdf.com/other/Jeffrey%20Epstein%27s%20Little%20Black%20Book.pdf';

/** An entry's name as its list records it — title, first, middle, last,
 *  suffix ("Dr Abdul Alianizi", "Jeffrey E. Epstein"); a plain string as it
 *  stands. */
function nameEntryFull(e) {
  if (!e) return '';
  if (e.text != null) return e.text;
  const first = e.first?.[0] || '';
  const middle = e.middle?.[0] && !writesMiddle(first, e.middle[0]) ? e.middle[0] : '';
  return [e.prefix, first, middle.length === 1 ? `${middle}.` : middle, e.last?.[0], e.suffix]
    .filter(Boolean).join(' ') || e.nickname || e.email?.[0] || '';
}

/** The entry's other spellings — each other first name with its last name,
 *  the first name with each other last name — then its nickname, quoted. */
function nameEntryAlso(e) {
  if (!e || e.text != null) return [];
  const first = e.first?.[0] || '', last = e.last?.[0] || '';
  const same = new Set([nameEntryFull(e), [first, last].filter(Boolean).join(' ')]);
  const out = [
    ...(e.first || []).slice(1).map(f => [f, last].filter(Boolean).join(' ')),
    ...(e.last || []).slice(1).map(l => [first, l].filter(Boolean).join(' ')),
  ].filter(s => !same.has(s));
  if (e.nickname && !e.first?.includes(e.nickname)) out.push(`“${e.nickname}”`);
  return [...new Set(out)];
}

/** An entry's links to show: { kind, text, href? } — the address-book page
 *  (a link to that page of the book's PDF),
 *  the Wikipedia section, and any other link key: an http(s) address as a
 *  link, anything else as text. */
function nameEntryLinks(e) {
  const out = [];
  for (const [key, v] of Object.entries(e?.links || {})) {
    if (key === 'adress-book' || key === 'address-book') {
      if (!v) continue;
      const page = /^(?:p\.?\s*)?(\d+)$/i.exec(v)?.[1];
      out.push(page
        ? { kind: 'book', text: `Address book, page ${page}`, href: `${NAME_ADDRESS_BOOK}#page=${page}` }
        : { kind: 'book', text: `Address book, ${v}` });
    } else if (key === 'wiki') {
      const fragment = (v || e.last?.[0] || '').trim().replace(/\s+/g, '_');
      out.push({ kind: 'wiki', text: 'Wikipedia: named in the Epstein files', href: fragment ? `${NAME_WIKI_LIST}#${encodeURIComponent(fragment)}` : NAME_WIKI_LIST });
    } else if (/^https?:\/\/\S+$/i.test(v)) {
      out.push({ kind: 'web', text: key, href: v });
    } else if (v) {
      out.push({ kind: 'text', text: `${key}: ${v}` });
    }
  }
  return out;
}

function nameList(id) {
  return state.nameLists.find(l => l.id === id) || null;
}

/** Fill a shipped list from its file's entries; Your names are filled from
 *  state.customCandidates. Entries keep their file positions (null where an
 *  entry is not a name), so `${list}:${index}` names one for good. */
function setNameList(id, raw) {
  const list = nameList(id);
  if (!list) return;
  if (id === YOUR_NAMES) {
    list.raw = state.customCandidates;
    list.entries = state.customCandidates.map(typedNameEntry);
  } else {
    list.raw = Array.isArray(raw) ? raw : [];
    list.entries = list.raw.map(nameEntry);
    list.status = 'ready';
    list.error = '';
    state.namesData = state.nameLists.filter(l => l.id !== YOUR_NAMES)
      .flatMap(l => l.raw.filter(e => e && typeof e === 'object'));
  }
  if (list.on) namesChanged();
  else rmRenderNames();
}

/** A list was filled, switched, or an entry hidden: every bar's names are
 *  made again and measured. */
function namesChanged() {
  state.namesVersion++;
  rebuildTemplateUnion();
  rmRenderNames();
  calculateAllWidths();
}

/** The names count of a list: its entries, less the hidden. */
function nameListCount(list) {
  let n = 0;
  list.entries.forEach((e, i) => { if (e && !state.hiddenEntries.has(`${list.id}:${i}`)) n++; });
  return n;
}

// Names come one per line or comma-separated, typed or pasted: a comma is
// always a separator, never part of a name.
const splitNames = text => String(text).split(/[\n,]/).map(s => s.trim()).filter(Boolean);

/** Add names to Your names (shared by every bar); returns how many were new. */
function addCustomNames(names) {
  let added = 0;
  // (a set, not a search of the list per name: 60,000 pasted names took 50 s)
  const have = new Set(state.customCandidates);
  for (const n of names) {
    if (have.has(n)) continue;
    have.add(n);
    state.customCandidates.push(n);
    added++;
  }
  if (added) {
    nameList(YOUR_NAMES).on = true;   // a name just typed is meant to be matched
    setNameList(YOUR_NAMES);
  }
  return added;
}

/** Hide entries from every bar — a whole person, with all their spellings;
 *  a typed name leaves Your names. */
function hideNameEntries(origins) {
  const typed = new Set();
  for (const o of origins || []) {
    if (o.list === YOUR_NAMES) typed.add(o.index);
    else state.hiddenEntries.add(`${o.list}:${o.index}`);
  }
  if (typed.size) {
    state.customCandidates = state.customCandidates.filter((_, i) => !typed.has(i));
    nameList(YOUR_NAMES).raw = state.customCandidates;
    nameList(YOUR_NAMES).entries = state.customCandidates.map(typedNameEntry);
  }
  namesChanged();
}

/** Hide the entries behind one of a bar's readings (a name, or a pair). */
function hideMatch(boxId, key) {
  const box = typeof utbState !== 'undefined' ? utbState.getBox(boxId) : null;
  if (!box) return;
  const info = getBoxMatchInfo(box);
  const e = [...info.entries, ...info.near].find(x => x.key === key);
  hideNameEntries(e?.kind === 'pair' ? (e.origins || [e.origin]) : barNames(box).names.get(key));
}

async function fetchNameList(file) {
  const resp = await fetch(assetURL(`plugins/redaction_matching/${file}`));
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  const raw = await resp.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (parseErr) {
    // Pinpoint the offending spot. Chrome reports "...position N...",
    // Firefox "line N column N"; else the raw message.
    let where = '';
    const posM = /position (\d+)/.exec(parseErr.message);
    const lcM = /line (\d+) column (\d+)/.exec(parseErr.message);
    if (posM) {
      const pos = +posM[1];
      const before = raw.slice(0, pos);
      where = ` (line ${before.split('\n').length}, column ${pos - before.lastIndexOf('\n')})`;
    } else if (lcM) {
      where = ` (line ${lcM[1]}, column ${lcM[2]})`;
    }
    throw new Error(`not valid JSON${where}: ${parseErr.message}`);
  }
  if (!Array.isArray(data)) throw new Error('not an array of entries');
  return data;
}

/** A list that fails to load says so, loudly, rather than matching nothing. */
function showNamesLoadError(msg) {
  let banner = document.getElementById('names-load-error');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'names-load-error';
    banner.title = 'Click to dismiss';
    banner.addEventListener('click', () => banner.remove());
    document.body.appendChild(banner);
  }
  banner.textContent = `A name list failed to load — ${msg}`;
}

async function loadNameLists() {
  await Promise.all(NAME_LISTS.map(async ({ id, file }) => {
    try {
      setNameList(id, await fetchNameList(file));
    } catch (e) {
      const list = nameList(id);
      list.status = 'error';
      list.error = e.message;
      console.error(`[redaction_matching] ${file} failed to load:`, e);
      showNamesLoadError(`${file}: ${e.message}`);
      rmRenderNames();
    }
  }));
}

// ── A bar's names ───────────────────────────────────────────

/** An entry's spellings as values for a pattern: every first × last
 *  spelling (or only the first of each), with each middle name and address
 *  the entry has — when the formats write one (`uses`, the fields they
 *  read; null: all). A first-name spelling that writes the middle name
 *  already ("Jeffrey E." beside "Jeffrey", middle E) is not given it again. */
function nameSpellings(e, aliases, uses = null) {
  const each = (list, every = true) => (list?.length ? (every ? list : list.slice(0, 1)) : [null]);
  const firsts = each(e.first, aliases.first), lasts = each(e.last, aliases.last);
  const middles = uses && !uses.has('middle') ? [null] : each(e.middle);
  const emails = uses && !uses.has('email') ? [null] : each(e.email);
  const out = [];
  for (const first of firsts) for (const middle of middles) for (const last of lasts) for (const email of emails) {
    out.push({
      first, middle: middle && !writesMiddle(first, middle) ? middle : null, last, email,
      prefix: e.prefix, suffix: e.suffix, nickname: e.nickname, gender: e.gender,
    });
  }
  return out;
}

// Does a first-name spelling end with the middle name, or its initial?
function writesMiddle(first, middle) {
  const words = String(first || '').trim().split(/\s+/);
  if (words.length < 2) return false;
  const w = words.pop().replace(/\.$/, '').toLowerCase();
  const m = String(middle).replace(/\.$/, '').toLowerCase();
  return w === m || (w.length === 1 && w === nameInitial(m));
}

/** Every name the settings make: each enabled list's entries (but the
 *  hidden, and those the gender filter leaves out) in each variant of each
 *  format that is on, through the letter filter → Map name → [{ list,
 *  index }], the entries that wrote it. */
function makeNames(settings) {
  const s = completeNameSettings(settings);
  const variants = s.formats.filter(f => f.on).flatMap(f => parseNamePattern(f.pattern).variants || []);
  const names = new Map();
  if (!variants.length) return names;
  const uses = nameUses(variants);
  const add = (name, list, index) => {
    if (!name || !matchesLetterFilter(name, s)) return;
    let who = names.get(name);
    if (!who) names.set(name, who = []);
    if (!who.some(o => o.list === list && o.index === index)) who.push({ list, index });
  };
  for (const list of state.nameLists) {
    if (!list.on) continue;
    list.entries.forEach((e, i) => {
      if (!e || state.hiddenEntries.has(`${list.id}:${i}`) || !matchesGenderFilter(e, s)) return;
      if (e.text != null) { add(e.text, list.id, i); return; }
      for (const v of nameSpellings(e, s.aliases, uses)) for (const p of variants) add(nameFromPattern(p, v), list.id, i);
    });
  }
  return names;
}

// A bar's names, made again when its settings or a list change.
const _barNames = new WeakMap();
function barNames(box) {
  const s = ensureBoxNameSettings(box);
  const key = `${state.namesVersion}|${JSON.stringify(s.formats)}|${!!s.aliases.first}${!!s.aliases.last}|${s.startsWith}|${s.endsWith}|${NAME_GENDERS.map(([k]) => +!!s.gender[k]).join('')}`;
  let c = _barNames.get(box);
  if (!c || c.key !== key) {
    const names = makeNames(s);
    c = { key, names, list: [...names.keys()] };
    _barNames.set(box, c);
    box.candidates = c.list;
  }
  return c;
}

/** A bar's candidate names. */
function getBoxCandidates(box) {
  return box ? barNames(box).list : [];
}

/** The names a new bar starts with — embedded_text_viewer's capitals test reads them. */
function rebuildTemplateUnion() {
  state.candidates = [...makeNames(state.nameSettings).keys()];
}

/** The active settings changed: the selected bar's names are made again and
 *  measured — or, with no bar selected, the template's. */
function nameSettingsChanged() {
  const box = getSelectedRedaction();
  if (box) calculateWidthsForRedaction(box.id);
  else rebuildTemplateUnion();
  rmRenderFilterSummary();
  rmRenderFormatSummary();
  rmRenderFormatCounts();
  rmRenderBar();
}

// While typing (a pattern, a letter filter) the measuring waits for a pause.
function nameSettingsChangedSoon() {
  clearTimeout(rmUi.timers.settings);
  rmUi.timers.settings = setTimeout(nameSettingsChanged, 250);
}

/** The active formats and spellings go to every bar, and to new ones. */
function applyNameFormatToAll() {
  const src = getActiveNameSettings();
  Object.assign(completeNameSettings(state.nameSettings), nameFormatCopy(src));
  for (const box of getRedactionBoxes()) Object.assign(ensureBoxNameSettings(box), nameFormatCopy(src));
  rebuildTemplateUnion();
  rmRenderFormat();
  calculateAllWidths();
}

// A refiner (when installed) announces, per bar, the letters it found
// sticking out of the bar — slivers of the hidden name itself (the exposed
// "S" of "SARAH"). They are the name's own first / last letters, so they
// become that bar's starts-with / ends-with filter, unless the user typed
// one. Generic hook, no plugin named; nothing fires without a refiner.
window.PDFHooks?.on('redaction:refined', ({ boxId, remnants } = {}) => {
  if (!remnants?.length || typeof utbState === 'undefined') return;
  const box = utbState.getBox(boxId);
  if (!box || box.type !== 'redaction') return;
  const s = ensureBoxNameSettings(box);
  const pre = remnants.filter(r => r.side === 'left').map(r => r.text).join('');
  const suf = remnants.filter(r => r.side === 'right').map(r => r.text).join('');
  let changed = false;
  if (pre && !s.startsWith) { s.startsWith = pre; s.startsWithAuto = true; changed = true; }
  if (suf && !s.endsWith) { s.endsWith = suf; s.endsWithAuto = true; changed = true; }
  if (!changed) return;
  if (utbState.selectedId === box.id) rmRenderFilter();
  calculateWidthsForRedaction(box.id);
});

// ── Width calculation ───────────────────────────────────────

// A task of its own for each piece of a long job — a bar, a batch of names —
// so the page answers while every bar of a document is measured (200 bars
// with 2,320 names were 11.7 s without a pause).
const rmYield = () => new Promise(resolve => setTimeout(resolve, 0));

async function calculateAllWidths() {
  // a newer pass over every bar takes over from an older one; the shown
  // page's bars go first
  const run = calculateAllWidths.run = (calculateAllWidths.run || 0) + 1;
  const page = state.currentPage;
  const boxes = getRedactionBoxes().sort((a, b) => (a.page === page ? 0 : 1) - (b.page === page ? 0 : 1));
  for (const box of boxes) {
    await calculateWidthsForRedaction(box.id, { label: false });
    await rmYield();
    if (run !== calculateAllWidths.run) return;
  }
  updateAllMatchesView(null);
}

// A line counts as "not justified" when its median detected space is within
// this much of the font's natural HarfBuzz advance — then the precise natural
// value is used instead of the measured one. Relative, with an absolute
// floor; doubles as the largest error that substitution accepts.
const JUSTIFY_SPACE_TOL_FRAC = 0.12;
const JUSTIFY_SPACE_TOL_FLOOR_PX = 0.5;

// The inter-word space of the bar's line, settled once. The font's natural
// space advance (HarfBuzz) is the truth for a line that is not justified —
// exact, where the page's measured spaces carry rounding and coverage noise —
// and justification only ever stretches spaces above it. So: drop measured
// spaces clearly below natural (a space half under the bar reads small: the
// lone 2.7 among ~4.0s), and look at the median of the rest — around natural
// the line is not justified and takes the exact advance; clearly above, it
// is justified and takes the measured median. The natural advance is taken
// at the line's own face and size (from its embedded spans), so a size
// mismatch cannot skew the comparison.
//
// It is settled again when the bar's face, size or line changes (a space set
// here for a 12 pt regular bar stayed after the bar became 14 pt bold); a
// space the user set by hand stays. And the space between a name's words is
// the bar's face's: a bold bar on a regular line takes the bold face's own
// advance, plus whatever justification added to the line's (Verdana's bold
// space is 5.469 px where the regular is 5.625).
const _settledSpace = new WeakMap();   // bar → { key, w }: the space this plugin set, and for what
const spaceKey = box => `${box.lineId}|${box.fontFamily}|${!!box.bold}|${!!box.italic}|${box.sizePt}|${!!box.kerning}`;
// `stale`: the caller's "this measurement is no longer wanted" — another
// document opened meanwhile: nothing is written, nothing drawn.
async function settleSpaceWidth(box, stale = () => !rmLive(box)) {
  if (!box.lineId) return;
  if (box.spaceWidth != null && box.defaultSpaceWidth === false) {
    const mine = _settledSpace.get(box);
    if (!mine || mine.w !== box.spaceWidth || mine.key === spaceKey(box)) return;   // the user's, or still right
  }
  const lineSpans = utbState.boxes.filter(b => b.lineId === box.lineId && b.type === 'embedded' && b.baseCharPositions);
  const detected = lineSpans
    .flatMap(b => b.baseCharPositions.filter(cp => cp.c === ' '))
    .map(cp => cp.w || 0)
    .filter(w => w > 0);
  if (!detected.length) return;
  // Source sizes are whole points (12 pt); per-span extraction adds
  // sub-point noise (11.8 on one line, 12.0 on the next) that would leak into
  // the natural space and make same-size lines disagree (3.9 vs 4.0) — so the
  // line's size snaps to the nearest point, per line (a heading keeps its
  // own). sizePt stays in POINTS: the shaper applies the DPI scale itself.
  const lineSizePt = _median(lineSpans.map(b => b.sizePt).filter(s => s > 0));
  const rawSizePt = lineSizePt || box.sizePt;
  const sizePt = rawSizePt ? Math.round(rawSizePt) : rawSizePt;
  const lineFont = lineSpans[0]?.fontFamily || box.fontFamily;
  const natural = typeof getNaturalSpaceWidth === 'function'
    ? await getNaturalSpaceWidth({ fontFamily: lineFont, sizePt, kerning: box.kerning })
    : null;
  // the bar's own face, where it is not the line's: its space, at its size
  const span0 = lineSpans[0];
  const sameFace = !span0 || (span0.fontFamily === box.fontFamily && !!span0.bold === !!box.bold && !!span0.italic === !!box.italic);
  const sameSize = !(box.sizePt > 0) || !(rawSizePt > 0) || Math.abs(box.sizePt - rawSizePt) < 0.5;
  const own = natural == null || (sameFace && sameSize) ? natural
    : await getNaturalSpaceWidth({ fontFamily: box.fontFamily, bold: !!box.bold, italic: !!box.italic,
        sizePt: Math.round(box.sizePt), kerning: box.kerning });
  let spaceW;
  if (natural != null) {
    const tol = Math.max(JUSTIFY_SPACE_TOL_FLOOR_PX, natural * JUSTIFY_SPACE_TOL_FRAC);
    const real = detected.filter(w => w >= natural - tol);
    const typical = real.length ? _median(real) : natural;
    const stretch = typical > natural + tol ? typical - natural : 0;   // what justification added
    spaceW = (own ?? natural) + stretch;
  } else {
    spaceW = _median(detected);   // no HarfBuzz reference: the robust raw median
  }
  if (stale()) return;
  box.spaceWidth = spaceW;
  box.defaultSpaceWidth = false;
  box.nativeSpaceWidth = natural != null ? (own ?? natural) : _median(detected);
  _settledSpace.set(box, { key: spaceKey(box), w: spaceW });
  if (typeof renderBox === 'function') renderBox(box);
  if (typeof syncToolbarToBox === 'function' && utbState.selectedId === box.id) syncToolbarToBox(box);
}

// Names are measured by HarfBuzz (text_tool's Shaping.widths) in the bar's
// face, size and style, in image px like box.w — the deterministic shaper
// text_tool draws with (the browser's getBBox() reports fallback-font
// metrics until the page font has laid out). Without ligatures: a producer
// that set none (Word, by default) laid "Groff" at f + f, and HarfBuzz's
// ff / tt ligatures would put such a name half a pixel short of its bar.
// Then, where a reader has read the row, the optional ocrMeasureWidths lays
// the names out in the face that drew the page, and its widths win (a name
// its glyph set cannot draw keeps the HarfBuzz width). A name gets no width
// rather than a wrong one: the shaper's 0 for a name it could not measure
// fitted every bar narrower than the redactor's padding (a 5.5 px bar fitted
// all 2,885 names), and a font that failed to load said "No name fits" on
// every bar. The shaper says which face measured (`shaped`: a substitute
// when the bar's family or style is not installed — Garamond measured in
// Times New Roman said nothing) and which characters it has no glyph for: a
// name it cannot draw gets no width ("王小明" in Times "fitted" at the
// placeholder's 37.34 px). → { widths, face, error, shaped, unshaped }
const RM_SHAPE_BATCH = 1500;   // names per shaping call: a task of ~40 ms
async function measureNames(box, strings) {
  const widths = {};
  let face = null, error = null, shaped = null, unshaped = 0;
  if (!strings.length) return { widths, face, error, shaped, unshaped };
  // letter-spacing (rare on redactions) adds a fixed advance between every
  // pair of glyphs; the shaper does not model it, so it is folded in
  const lsPx = box.letterSpacing ? box.letterSpacing * GEO.docPtToPx(box.sizePt) : 0;
  const spaced = (c, w) => (lsPx ? w + lsPx * Math.max(0, caseName(box, c).length - 1) : w);
  // a manual Space W. replaces the font's own space advance between words
  const manualSpace = box.spaceWidth != null && box.defaultSpaceWidth === false;
  try {
    if (typeof Shaping === 'undefined') error = 'no shaper on the page';
    for (let k = 0; !error && k < strings.length; k += RM_SHAPE_BATCH) {
      if (k) await rmYield();
      const part = strings.slice(k, k + RM_SHAPE_BATCH);
      const data = await Shaping.widths({
        strings: part.map(c => caseName(box, c)),   // as the bar writes them
        family: box.fontFamily,
        bold: !!box.bold,
        italic: !!box.italic,
        size: box.sizePt,          // POINTS — the shaper applies the DPI scale
        scale: GEO.docScale(),     // px-per-pt × 100 for this document
        kerning: box.kerning,
        ligatures: false,
        space_width: manualSpace ? box.spaceWidth : null,
        report: true,
      });
      shaped ||= data?.face || null;
      part.forEach((c, i) => {
        const r = data?.results?.[i], w = r?.width;
        if (r?.error) error ||= String(r.error);
        else if (r?.missing?.length) unshaped++;
        else if (Number.isFinite(w) && w > 0) widths[c] = spaced(c, w);
      });
    }
  } catch (e) {
    console.warn('[redaction_matching] candidate widths failed', e);
    error = String(e?.message || e);
  }
  if (typeof ocrMeasureWidths === 'function') {
    try {
      const r = await ocrMeasureWidths(box, strings);
      if (r && Array.isArray(r.widths)) {
        strings.forEach((c, i) => { if (r.widths[i] != null) widths[c] = spaced(c, r.widths[i]); });
        face = r.face || null;
      }
    } catch (e) {
      console.warn('[redaction_matching] page-face widths failed', e);
    }
  }
  if (Object.keys(widths).length) error = null;   // what was measured counts; a failure is the case of none
  return { widths, face, error, shaped, unshaped };
}

// The open document's generation: work still running for another document's
// bars (a measurement, a scoring) stops when it finds a newer one, and draws
// nothing — its bar was labelled onto the next document's page 1.
let rmDocGen = 0;
window.PDFHooks?.on('document:opening', () => {
  rmDocGen++;
  rmUi.measuring.clear();
  _measureSoon.clear();
  clearTimeout(rmUi.timers.settings);
});
// a bar still in the model (not another document's, not deleted)
const rmLive = box => typeof utbState === 'undefined' || utbState.getBox(box.id) === box;

const _measureSeq = new WeakMap();    // bar → its latest measurement; an older one finishing later is dropped
const _measuredKey = new WeakMap();   // bar → the names its widths were measured for

/** Measure a bar's names (and its half of every pair it may form), judge
 *  them against the page, and label the bar. */
async function calculateWidthsForRedaction(boxId, { label = true } = {}) {
  await document.fonts.ready;
  const box = typeof utbState !== 'undefined' ? utbState.getBox(boxId) : null;
  if (!box || box.type !== 'redaction') return;
  const seq = (_measureSeq.get(box) || 0) + 1;
  _measureSeq.set(box, seq);
  const gen = rmDocGen;
  const stale = () => _measureSeq.get(box) !== seq || gen !== rmDocGen || !rmLive(box);
  rmUi.measuring.add(box.id);
  try {
    try { await settleSpaceWidth(box, stale); }
    catch (e) { console.warn('[redaction_matching] space width failed', e); }
    if (stale()) return;
    const { key, list } = barNames(box);
    // A bar that forms a name with another (linkFor) also needs its half of
    // every person measured, so the pair readings can be judged bar by bar.
    const link = linkFor(box);
    const strings = [...new Set([...list, ...(link ? halfStrings(box, link) : [])])];
    const { widths, face, error, shaped, unshaped } = await measureNames(box, strings);
    if (stale()) return;
    box.widths = widths;
    box.widthFace = face;
    box.widthError = error;
    box.shapedFace = shaped;
    box.unshaped = unshaped;
    _measuredKey.set(box, key);
    await scoreMatches(box);
    if (stale()) return;
    // the partner's pair readings depend on these widths: judge them now
    if (link && link.other.widths && Object.keys(link.other.widths).length) await scoreMatches(link.other);
    if (label) {
      labelBar(box);
      if (link) labelBar(link.other);
    }
  } finally {
    if (!stale()) rmUi.measuring.delete(box.id);
  }
  const sel = utbState.selectedId;
  if (sel === box.id || linkFor(box)?.other.id === sel) rmRenderBar();
}

// Names made since a bar's widths were measured (an undo that restored other
// settings) are measured once the current call is done.
const _measureSoon = new Set();
function rmMeasureSoon(id) {
  if (_measureSoon.has(id)) return;
  _measureSoon.add(id);
  setTimeout(() => { _measureSoon.delete(id); calculateWidthsForRedaction(id); }, 0);
}

// ── Matches: which names fit a bar ──────────────────────────

// When a refiner has rebuilt the bar from the reader's OCR pens on both
// sides, its width is exact to mupdf's ¼-px pen lattice — a pen cannot land
// anywhere else — so a name either fits to a quarter pixel or it does not.
// Two ⅛-px snaps of slack. The pixel tolerance field is for bars whose
// edges are only as good as a raster (guide/plugins/redaction-refiner/
// pixel-evidence-plan.md §0). On the reference page this turns 62 names
// within 3 px into the 5 that tie to the font unit.
const PEN_TOL_PX = 0.3;

/** Is the bar's width pen-exact? Set by an optional refiner on
 *  box.refineInfo; a bar moved or resized since is no longer exact. */
function penExact(box) {
  const i = box.refineInfo;
  return !!(i && i.exact && i.x === box.x && i.w === box.w);
}

/** The tolerance in force: the pen lattice when the width is pen-exact
 *  (a tighter user field still wins), else the user's pixel field. */
function effectiveTolerance(box) {
  const t = box.tolerance ?? 3;
  return penExact(box) ? Math.min(t, PEN_TOL_PX) : t;
}

// How much narrower (`under`) and wider (`over`) than the bar a name may
// measure and still fit. `over` is the tolerance in force. `under` grows to
// the redactor's padding when an edge is the detector's: with no reader pen
// on that side the bar ends where the black box ends, and the box was drawn
// with room to spare (4.4 px past BLEDSOE on the reference page). The
// padding is the redaction tool's, a few pixels, so it is taken as a
// fraction of the size with a cap. Without a refiner every edge is the
// detector's.
const DETECTOR_PAD_EM = 0.4;
const DETECTOR_PAD_MAX_PX = 10;
// A side whose ink reaches the text column's edge (refineInfo.margin) runs to
// the margin: the name may end anywhere before it, so no narrower name is too
// narrow (the padding cap used to apply, against the chip's own tooltip).
function fitRange(box) {
  const over = effectiveTolerance(box);
  const i = box.refineInfo;
  if (i?.margin?.left || i?.margin?.right) return { over, under: Infinity };
  const detectorEdge = !i || !i.left || !i.right || i.left.kind === 'ink' || i.right.kind === 'ink';
  const pad = Math.min(DETECTOR_PAD_MAX_PX, DETECTOR_PAD_EM * emPx(box));
  return { over, under: detectorEdge ? Math.max(over, pad) : over };
}
const fitsRange = (r, d) => d <= r.over && -d <= r.under;   // d = measured − bar

// Page-pixel verdicts, ranked: a name the page could not contradict first,
// one the bar left no evidence for next, a contradicted one last.
const VERDICT_RANK = { consistent: 0, 'no-evidence': 1, contradicted: 2 };
const verdictOf = (box, name) => box.verdicts?.[name]?.verdict || null;

// ── Two bars, one name ──────────────────────────────────────
// A name can be redacted as two bars: its halves a space apart on one row
// ("[Nadia] [Marcinkova]"), or split by a line break ("…, [Nadia]" ending
// one row and "[Marcinkova], …" opening the next). A refiner's verdict on
// each bar (box.refineInfo) tells the two cases apart without new geometry:
// `blocked` says a sibling bar bounded the neighbour search on that side, and
// no neighbour there means nothing but the sibling — the row case; the line
// case is the last bar of a row (no word and no bar after it) followed by the
// first bar of the next row (nothing before it). Either way the two bars are
// read as ONE entry, each half within its own bar's fit range; the gap
// between them is detector ink, not a measured pen, so the halves are never
// summed across it. Pair readings sit beside the single readings, and
// picking one pins both bars. Without a refiner no bar is ever linked.
const LINK_ROW_GAP_EM = 0.75;          // a same-row pair is at most this far apart
const LINK_LINE_PITCH = [0.5, 1.8];    // the next row starts this many bar heights down

function emPx(box) {
  const pxPerPt = (typeof GEO !== 'undefined' && typeof GEO.docPxPerPt === 'function') ? GEO.docPxPerPt() : 96 / 72;
  return (box.sizePt || 12) * pxPerPt;
}
function sameRow(a, b) {
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlap >= Math.min(a.h, b.h) * 0.5;
}
// Is b on the row right after a's, starting further left than a ends?
function nextRow(a, b) {
  const dy = b.y - a.y;
  return dy >= LINK_LINE_PITCH[0] * a.h && dy <= LINK_LINE_PITCH[1] * a.h && b.x < a.x + a.w;
}
// A bar with nothing readable on `side`: no word and no sibling bar.
const openSide = (b, side) => !!b.refineInfo && !b.refineInfo[side] && !b.refineInfo.blocked?.[side];
// A bar whose only company on `side` is a sibling bar.
const barSide = (b, side) => !!b.refineInfo && !b.refineInfo[side] && !!b.refineInfo.blocked?.[side];

/** The bar this one forms a name with — { other, role, kind } or null.
 *  `role` is this bar's place in reading order ('first' | 'last'); `kind` is
 *  'row' (a space apart) or 'line' (split over a line break). */
function linkFor(box) {
  if (!box.refineInfo) return null;
  const bars = getRedactionBoxes().filter(b => b.id !== box.id && b.page === box.page && b.refineInfo);
  const maxGap = LINK_ROW_GAP_EM * emPx(box);
  if (barSide(box, 'right')) {
    const right = bars.filter(b => sameRow(box, b) && b.x >= box.x + box.w - 2.5).sort((p, q) => p.x - q.x)[0];
    if (right && right.x - (box.x + box.w) <= maxGap && barSide(right, 'left')) return { other: right, role: 'first', kind: 'row' };
  }
  if (barSide(box, 'left')) {
    const left = bars.filter(b => sameRow(box, b) && b.x + b.w <= box.x + 2.5).sort((p, q) => q.x - p.x)[0];
    if (left && box.x - (left.x + left.w) <= maxGap && barSide(left, 'right')) return { other: left, role: 'last', kind: 'row' };
  }
  if (openSide(box, 'right')) {
    const next = bars.filter(b => nextRow(box, b) && openSide(b, 'left')).sort((p, q) => p.x - q.x)[0];
    if (next) return { other: next, role: 'first', kind: 'line' };
  }
  if (openSide(box, 'left')) {
    const prev = bars.filter(b => nextRow(b, box) && openSide(b, 'right')).sort((p, q) => q.x - p.x)[0];
    if (prev) return { other: prev, role: 'last', kind: 'line' };
  }
  return null;
}

// The halves a format's variant writes on two bars: everything before and
// after the space between the given names and the last name — `{First}
// {LAST}` puts "Sarah" on the first bar and "KELLEN" on the second, `{LAST}
// {First}` the other way round, `{Title} {First} {Last}` "Dr. Gregory" and
// "Bledsoe", `{First} {M}. {Last}` "Jeffrey E." and "Epstein" (an initial's
// full stop goes with it). A variant whose names are joined by anything else
// has no halves: the comma of `{Last}, {First}` would stand on the page
// between the bars, and a word between two bars keeps them apart.
const NAME_HALF_GIVEN = new Set(['first', 'firstInitial', 'middle', 'middleInitial', 'nickname']);
const _nameHalves = new WeakMap();
function nameVariantHalves(p) {
  if (_nameHalves.has(p)) return _nameHalves.get(p);
  let halves = null;
  for (let i = 0; i + 1 < p.parts.length; i++) {
    const a = p.parts[i].field, b = p.parts[i + 1].field;
    const across = (NAME_HALF_GIVEN.has(a) && NAME_PART_LAST.has(b)) || (NAME_PART_LAST.has(a) && NAME_HALF_GIVEN.has(b));
    const gap = /^(\.?)\s+$/.exec(p.lits[i + 1]);
    if (!across || !gap || (gap[1] && !a.endsWith('Initial'))) continue;
    halves = [
      { parts: p.parts.slice(0, i + 1), lits: [...p.lits.slice(0, i + 1), gap[1]] },
      { parts: p.parts.slice(i + 1), lits: ['', ...p.lits.slice(i + 2)] },
    ];
    break;
  }
  _nameHalves.set(p, halves);
  return halves;
}

// Every entry as the two halves the bars could show: under the formats on
// either bar, every spelling either bar asks for, each half through its own
// bar's letter filter — and only an entry both bars' gender filters let
// through, as it is one person. A typed name splits at its last space; an
// entry written as it stands (an address) has no halves.
const _pairPersons = new WeakMap();
function pairPersons(A, B) {
  const key = `${B.id}|${barNames(A).key}|${barNames(B).key}`;
  const hit = _pairPersons.get(A);
  if (hit && hit.key === key) return hit.out;
  const sA = ensureBoxNameSettings(A), sB = ensureBoxNameSettings(B);
  const patterns = [...new Set([...sA.formats, ...sB.formats].filter(f => f.on).map(f => f.pattern))];
  const variants = patterns.flatMap(p => parseNamePattern(p).variants || []);
  const splits = variants.map(nameVariantHalves).filter(Boolean);
  const uses = nameUses(variants);
  const aliases = { first: sA.aliases.first || sB.aliases.first, last: sA.aliases.last || sB.aliases.last };
  const out = [], seen = new Map();
  for (const list of splits.length ? state.nameLists : []) {
    if (!list.on) continue;
    list.entries.forEach((e, i) => {
      if (!e || e.text != null || !e.first.length || !e.last.length || state.hiddenEntries.has(`${list.id}:${i}`)) return;
      if (!matchesGenderFilter(e, sA) || !matchesGenderFilter(e, sB)) return;
      for (const v of nameSpellings(e, aliases, uses)) for (const [l, r] of splits) {
        const first = nameFromPattern(l, v), last = nameFromPattern(r, v);
        if (!first || !last || !matchesLetterFilter(first, sA) || !matchesLetterFilter(last, sB)) continue;
        const origin = { list: list.id, index: i };
        // one reading per spelling; a list that holds the person twice
        // (names.json does) gives it every entry, so hiding it hides them all
        const had = seen.get(`${first}|${last}`);
        if (had) { if (!had.origins.some(o => o.list === origin.list && o.index === origin.index)) had.origins.push(origin); continue; }
        const p = { first, last, origin, origins: [origin] };
        seen.set(`${first}|${last}`, p);
        out.push(p);
      }
    });
  }
  _pairPersons.set(A, { key, out });
  return out;
}

/** The strings this bar has to have measured for its pair readings: its
 *  own half of every entry. */
function halfStrings(box, link) {
  const A = link.role === 'first' ? box : link.other;
  const B = link.role === 'first' ? link.other : box;
  return [...new Set(pairPersons(A, B).map(p => link.role === 'first' ? p.first : p.last))];
}

/** This bar's pair readings — entries whose first half fits the first bar
 *  and whose second half fits the second — as entries showing this bar's
 *  half. Empty until both bars have measured their halves. */
function pairReadings(box, link = linkFor(box)) {
  if (!link) return [];
  const A = link.role === 'first' ? box : link.other;
  const B = link.role === 'first' ? link.other : box;
  const rA = fitRange(A), rB = fitRange(B);
  const mine = link.role === 'first';
  const out = [];
  for (const p of pairPersons(A, B)) {
    const wa = A.widths?.[p.first], wb = B.widths?.[p.last];
    if (wa === undefined || wb === undefined) continue;
    if (!fitsRange(rA, wa - A.w) || !fitsRange(rB, wb - B.w)) continue;
    out.push({
      key: `pair:${p.first}|${p.last}`, kind: 'pair', full: `${p.first} ${p.last}`, first: p.first, last: p.last,
      name: mine ? p.first : p.last, partnerName: mine ? p.last : p.first,
      partnerId: link.other.id, link: link.kind, diff: Math.max(Math.abs(wa - A.w), Math.abs(wb - B.w)),
      origin: p.origin, origins: p.origins,
    });
  }
  return out;
}

/** A reading's page verdict. A pair is judged on both bars: contradicted
 *  anywhere is contradicted, consistent on both is consistent, otherwise
 *  no evidence — null while neither half has been scored. */
function entryVerdict(box, e) {
  if (e.kind !== 'pair') return verdictOf(box, e.name);
  const other = typeof utbState !== 'undefined' ? utbState.getBox(e.partnerId) : null;
  const a = verdictOf(box, e.name), b = other ? verdictOf(other, e.partnerName) : null;
  if (a === 'contradicted' || b === 'contradicted') return 'contradicted';
  if (a === 'consistent' && b === 'consistent') return 'consistent';
  if (!a && !b) return null;
  return 'no-evidence';
}

/** Readings that fit the bar, best first: by page verdict when a hypothesis
 *  tester scored them, then a pair before a single name, then a fit before a
 *  near miss, then closeness. In Times many names share a width to the font
 *  unit ("SARAH KELLEN" 15416/2048 em, "JUSTIN NELSON" 15417), so this is a
 *  list, not a winner. Returns { entries, matches, near, tol, loose, link }:
 *  `entries` are the readings ({ key, kind: 'single' | 'pair', name, full,
 *  diff, … }), `matches` the names they show on this bar. When nothing fits
 *  the pen-exact width, the nearest single names within the user's pixel
 *  tolerance are returned with loose = true — as near misses, never fits. */
function getBoxMatchInfo(box) {
  const widths = box.widths || {};
  const d = c => widths[c] - box.w;
  const entry = (c, near) => ({ key: c, kind: 'single', name: c, full: c, diff: Math.abs(d(c)), near });
  const measured = getBoxCandidates(box).filter(c => widths[c] !== undefined);
  const range = fitRange(box);
  const link = linkFor(box);
  const fits = [...measured.filter(c => fitsRange(range, d(c))).map(c => entry(c, false)), ...pairReadings(box, link)];
  // Names the pen lattice excludes but the pixel tolerance admits. With a
  // hypothesis tester they are scored too, and one the page could not
  // contradict joins the list — width ranks, the page decides (a bar's pens
  // can slip a lattice step, or a width be off by a shaping choice: while
  // HarfBuzz still formed the tt ligature, RICHARD BARNETT measured 0.51 px
  // short of its bar and only this kept it in view). Without a tester they
  // are the loose fallback when nothing fits.
  const field = { over: box.tolerance ?? 3, under: Math.max(box.tolerance ?? 3, range.under) };
  const near = range.over < field.over
    ? measured.filter(c => !fitsRange(range, d(c)) && fitsRange(field, d(c))).map(c => entry(c, true))
    : [];
  const rank = e => VERDICT_RANK[entryVerdict(box, e)] ?? 1;
  const best = (x, y) => (rank(x) - rank(y))
    || ((x.kind === 'pair' ? 0 : 1) - (y.kind === 'pair' ? 0 : 1))
    || ((x.near ? 1 : 0) - (y.near ? 1 : 0))
    || (x.diff - y.diff);
  let entries = [...fits, ...near.filter(e => entryVerdict(box, e) === 'consistent')].sort(best);
  let tol = range.over;
  let loose = false;
  if (!entries.length && near.length) {
    entries = near.sort(best);
    tol = field.over;
    loose = true;
  }
  return { entries, matches: entries.map(e => e.name), near, tol, loose, link };
}

function getBoxMatches(box) {
  return getBoxMatchInfo(box).matches;
}

// ── Page-pixel verdicts (optional seam) ─────────────────────
// A hypothesis tester may define window.ocrTestHypothesis(box, name) →
// { verdict: 'consistent' | 'contradicted' | 'no-evidence', open, edge,
//   unexplained, … } | null   (ocr_tool over tol0's engine/hypothesis.js —
// guide/plugins/redaction-refiner/pixel-evidence-plan.md). It draws the name
// where the refiner put the bar and lets the page bytes outside the bar's
// body contradict it. Every name a reading shows on this bar is tested — a
// pair's half on its own bar, so the halves are judged independently and
// never summed across the gap. Verdicts live on box.verdicts and are made
// again with the widths; without a provider nothing runs.
// Only the newest scoring of a bar writes its verdicts: an older one that
// finishes later (the bar moved and was measured again meanwhile) used to
// leave the old geometry's verdicts on it. `keep`: the bar is where it was —
// only the names not judged yet are tested (a wider tolerance let them in).
const _scoreSeq = new WeakMap();
async function scoreMatches(box, { keep = false } = {}) {
  const seq = (_scoreSeq.get(box) || 0) + 1;
  _scoreSeq.set(box, seq);
  const gen = rmDocGen;
  const current = () => _scoreSeq.get(box) === seq && gen === rmDocGen;
  if (!keep) box.verdicts = null;
  if (typeof ocrTestHypothesis !== 'function') return;
  const { entries, near } = getBoxMatchInfo(box);
  const verdicts = keep ? { ...(box.verdicts || {}) } : {};
  for (const name of new Set([...entries, ...near].map(e => e.name))) {
    if (keep && name in verdicts) continue;
    try { verdicts[name] = await ocrTestHypothesis(box, name); }
    catch (e) { console.warn('[redaction_matching] hypothesis test failed for', name, e); verdicts[name] = null; }
    if (!current()) return;
  }
  if (current()) box.verdicts = verdicts;
}

const asEntry = e => (typeof e === 'string' ? { key: e, kind: 'single', name: e, full: e } : e);

/** The reading a bar labels itself with: the one the user pinned (by
 *  clicking it or cycling with [ / ]) while it still fits; else the partner
 *  bar's pin when that is a pair reading — one entry, both halves; else the
 *  best-ranked. */
function shownMatch(box, entries) {
  const list = entries.map(asEntry);
  if (!list.length) return { name: null, index: -1, entry: null };
  let i = box.matchPick ? list.findIndex(e => e.key === box.matchPick) : -1;
  if (i < 0) {
    const pick = linkFor(box)?.other.matchPick;
    if (pick && pick.startsWith('pair:')) i = list.findIndex(e => e.key === pick);
  }
  if (i < 0) i = 0;
  return { name: list[i].name, index: i, entry: list[i] };
}

/** Pin a reading as the bar's label, by key — a name, or a pair's
 *  `pair:first|last` — or unpin with null. A pair pins (and unpins) both bars. */
function setBoxMatch(boxId, key) {
  const box = typeof utbState !== 'undefined' ? utbState.getBox(boxId) : null;
  if (!box || box.type !== 'redaction') return;
  const was = box.matchPick;
  box.matchPick = key || null;
  const entry = key ? getBoxMatchInfo(box).entries.find(e => e.key === key) : null;
  let other = entry?.kind === 'pair' ? utbState.getBox(entry.partnerId) : null;
  if (other) other.matchPick = key;
  else if (!key) {
    // a pair pinned on either bar comes off both
    const o = linkFor(box)?.other;
    const pick = was || o?.matchPick;
    if (o && pick?.startsWith('pair:') && o.matchPick === pick) { o.matchPick = null; other = o; }
  }
  labelBar(box);
  if (other) labelBar(other);
  rmRenderBar();
}

/** Step the shown label through the bar's readings (wraps around). */
function cycleBoxMatch(delta, boxId = typeof utbState !== 'undefined' ? utbState.selectedId : null) {
  const box = boxId ? utbState.getBox(boxId) : null;
  if (!box || box.type !== 'redaction') return;
  const { entries } = getBoxMatchInfo(box);
  if (entries.length < 2) return;
  const { index } = shownMatch(box, entries);
  setBoxMatch(boxId, entries[(index + delta + entries.length) % entries.length].key);
}

// [ / ] cycle the selected bar's label — never while typing in a field or
// editing a box inline (there the keys are characters).
document.addEventListener('keydown', e => {
  if (e.key !== '[' && e.key !== ']') return;
  if (typeof utbState === 'undefined' || utbState.editingId || !utbState.selectedId) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
  const box = utbState.getBox(utbState.selectedId);
  if (!box || box.type !== 'redaction') return;
  e.preventDefault();
  cycleBoxMatch(e.key === ']' ? 1 : -1);
});

// ── Labels on the bars ──────────────────────────────────────

const VERDICT_MARK = { consistent: '✓', contradicted: '✗', 'no-evidence': '–' };
// The label's colour on the page (text_tool's box.labelColor): the page
// pixels vouched for the name, left no evidence, or contradicted it. A bar
// without a verdict keeps the type's colour.
const VERDICT_COLOR = { consistent: '#3ddc84', 'no-evidence': '#fdd663', contradicted: '#f28b82' };
// A label the tester has not judged (yet), with a tester on the page: grey —
// the type's own colour is a green too close to "the page vouched".
const UNJUDGED_COLOR = '#dadce0';

/** Label a bar with its shown reading, as the bar writes it, in the colour of
 *  its verdict, on the edge the refiner knows exactly: a name that ends at a
 *  comma or a word's pen but starts somewhere after a tab stop is drawn
 *  ending at the bar's right edge (text_tool's labelAlign). */
function labelBar(box) {
  if (!rmLive(box)) return;
  const { entries, loose } = getBoxMatchInfo(box);
  const { name: shown, index, entry } = shownMatch(box, entries);
  // a near miss is no fit: a loose list writes nothing on the page, unless
  // the user pinned one of its names
  const label = shown && (!loose || box.matchPick === entry.key) ? caseName(box, shown) : '';
  box.text = label;
  box.labelText = label;
  const v = label && index >= 0 && entries[index] ? entryVerdict(box, entries[index]) : null;
  box.labelColor = (v && VERDICT_COLOR[v]) || (label && typeof ocrTestHypothesis === 'function' ? UNJUDGED_COLOR : null);
  const ri = box.refineInfo;
  const pen = s => !!s && s.kind !== 'ink' && s.kind !== 'margin';
  box.labelAlign = ri && pen(ri.right) && !pen(ri.left) ? 'right' : 'left';
  if (typeof renderBox === 'function') renderBox(box);
}

/** Relabel every bar — or one, and the bar it forms a name with — and redraw
 *  the selected bar's fits. Recto calls this after a bar moves, resizes, or
 *  comes back from undo. */
// Names a bar shows that the page has not judged — a wider tolerance let them
// in, and only a relabel followed — are judged, and the bar labelled again.
function unjudged(box) {
  if (typeof ocrTestHypothesis !== 'function' || rmUi.measuring.has(box.id) || _measuredKey.get(box) !== barNames(box).key) return false;
  const { entries, near } = getBoxMatchInfo(box), v = box.verdicts || {};
  return [...entries, ...near].some(e => !(e.name in v));
}
const _scoreSoon = new Set();
function rmScoreSoon(id) {
  if (_scoreSoon.has(id)) return;
  _scoreSoon.add(id);
  setTimeout(async () => {
    _scoreSoon.delete(id);
    const box = typeof utbState !== 'undefined' ? utbState.getBox(id) : null;
    if (!box || rmUi.measuring.has(id)) return;
    await scoreMatches(box, { keep: true });
    if (!rmLive(box)) return;
    labelBar(box);
    const other = linkFor(box)?.other;
    if (other) labelBar(other);
    if (utbState.selectedId === id || other?.id === utbState.selectedId) rmRenderBar();
  }, 0);
}

function updateAllMatchesView(onlyId = null) {
  for (const box of getRedactionBoxes()) {
    if (onlyId !== null && onlyId !== box.id) continue;
    labelBar(box);
    if (unjudged(box)) rmScoreSoon(box.id);
    if (onlyId !== null) {
      const link = linkFor(box);
      if (link) labelBar(link.other);
    }
    if (_measuredKey.has(box) && _measuredKey.get(box) !== barNames(box).key) rmMeasureSoon(box.id);
  }
  rmRenderBar();
}

// ── Selection and new bars ──────────────────────────────────

async function selectRedaction(boxId) {
  const box = typeof utbState !== 'undefined' ? utbState.getBox(boxId) : null;
  if (!box || box.type !== 'redaction') return;
  if (state.currentPage !== box.page && typeof goToPage === 'function') await goToPage(box.page);
  utbState.selectedId = box.id;
  // text_tool's matching controls show this bar's values; each write is
  // guarded (they are absent without text_tool)
  if (els.tol) els.tol.value = box.tolerance;
  if (els.kern) els.kern.checked = !!box.kerning;
  if (els.upper) els.upper.value = caseValue(box.uppercase);
  if (typeof selectBoxInSVG === 'function') selectBoxInSVG(box.id);
  if (typeof syncToolbarToBox === 'function') syncToolbarToBox(box);
  // bring the bar into view within the viewer
  const svgGroup = document.querySelector(`.utb-group[data-id="${box.id}"]`);
  const viewer = els.viewerContainer;
  if (svgGroup && viewer) {
    const parentRect = viewer.getBoundingClientRect();
    const targetRect = svgGroup.getBoundingClientRect();
    if (targetRect.top < parentRect.top || targetRect.bottom > parentRect.bottom) {
      viewer.scrollTo({ top: viewer.scrollTop + (targetRect.top - parentRect.top) - parentRect.height / 2, behavior: 'smooth' });
    }
  }
  rmUi.allFits = false;
  rmUi.pill = null;   // another bar's formats: the pill selected was one of the last bar's
  labelBar(box);
  rmRenderPanel();
}

function createNewRedaction(pageNum, x, y, width, height, lineId = null, lineFont = null, lineSizePt = null) {
  const normFn = typeof normUtbFont === 'function' ? normUtbFont : (n => n);
  const fontFamily = (lineFont ? normFn(lineFont) : null)
    || document.getElementById('fabric-font-family')?.value
    || 'Times New Roman';
  // the font-size field is in POINTS — no DPI conversion
  const sizePt = lineSizePt || parseFloat(document.getElementById('fabric-font-size')?.value) || 12;
  const newBox = utbState.addBox(new UnifiedTextBox({
    type: 'redaction',
    page: pageNum,
    text: '',
    lineId,
    x, y, w: width, h: height,
    fontFamily,
    sizePt,
    kerning: els.kern?.checked ?? true,
    uppercase: caseMode(els.upper?.value),
    tolerance: parseFloat(els.tol?.value) || 0,
    widths: {},
    labelText: '',
    manualLabel: false,
    nameSettings: {
      ...nameFormatCopy(completeNameSettings(state.nameSettings)), startsWith: '', endsWith: '', gender: defaultNameSettings().gender,
    },
  }));
  if (typeof renderBox === 'function') renderBox(newBox);
  selectRedaction(newBox.id);
  calculateWidthsForRedaction(newBox.id);
}

// ── The panel ───────────────────────────────────────────────
// sidebar_tools.html holds the frame; these fill it. Every control is wired
// once, by delegation on the panel (rmWirePanel), so nothing a list holds
// ever has to survive an inline handler.

function rmRenderPanel() {
  rmRenderBar();
  rmRenderTry();
  rmRenderFormat();
  rmRenderFilter();
  rmRenderNames();
}

// Recto's text_tool calls these by name — after a drag, a deselect, an undo.
function renderCandidates() {
  rmRenderBar();
  rmRenderTry();
}
function syncNameSettingsUI() {
  rmUi.pill = null;   // the settings may be another bar's, or the template
  rmRenderFormat();
  rmRenderFilter();
}

const rmIcon = (name, cls = '') => `<span class="material-symbols-outlined${cls ? ` ${cls}` : ''}" aria-hidden="true">${name}</span>`;
// (the name is the page's: control characters go with the quotes and
// backslashes — a newline ended the CSS string, and what followed it in a
// PDF's font name became a declaration of its own, a background fetched from
// anywhere)
const rmFamily = box => `font-family:&quot;${escAttr(String(box.fontFamily || 'inherit').replace(/[\u0000-\u001f\u007f"\\]/g, ''))}&quot;`;

const LINK_NOTE = {
  'row-first': 'The bar to the right may hold the rest of this name',
  'row-last': 'The bar to the left may hold the start of this name',
  'line-first': 'This name may go on in the first bar of the next line',
  'line-last': 'This bar may go on from the last bar of the line before',
};

// What the width chip says when hovered: how the bar was measured.
function rmBarTitle(box) {
  const style = [box.bold && 'bold', box.italic && 'italic'].filter(Boolean).join(' ');
  return [
    `${box.fontFamily || 'Times New Roman'} ${+(box.sizePt || 12).toFixed(2)} pt${style ? ` ${style}` : ''}`,
    `kerning ${box.kerning ? 'on' : 'off'}`,
    box.widthFace ? `measured in the page's own face (${box.widthFace})`
      : rmSubstitute(box) ? `measured with HarfBuzz in ${rmShapedName(box)} — ${rmSubstitute(box)}` : 'measured with HarfBuzz',
  ].join(' · ');
}
// The face HarfBuzz measured with, where it stands in for the bar's own
// (and no page face measured instead): why, or null.
const rmShapedName = box => `${box.shapedFace.family}${box.shapedFace.style !== 'regular' ? ` ${box.shapedFace.style.replace('bolditalic', 'bold italic')}` : ''}`;
function rmSubstitute(box) {
  const f = box.shapedFace;
  if (!f?.substitute || box.widthFace) return null;
  const asked = box.fontFamily || 'the bar\'s face';
  return f.family && f.family.toLowerCase() === String(asked).toLowerCase()
    ? `${asked} has no ${[box.bold && 'bold', box.italic && 'italic'].filter(Boolean).join(' ') || 'such'} face installed`
    : `${asked} is not installed`;
}

// The tolerance in force — not the wider field a loose list falls back to,
// which its own note gives.
function rmTolChip(box) {
  const range = fitRange(box);
  const tol = range.over;
  if (penExact(box)) {
    return `<span class="rm-chip is-pens" title="Both edges come from the reader's ¼-px pens: the width is exact to the lattice.">±${+tol.toFixed(2)} px · pens</span>`;
  }
  const ri = box.refineInfo;
  const ink = ['left', 'right'].filter(s => ri?.[s]?.kind === 'ink');
  const margin = ['left', 'right'].filter(s => ri?.margin?.[s]);
  const why = ['Edges from the raster: the Tolerance in Settings applies.'];
  if (range.under > range.over && Number.isFinite(range.under)) why.push(`A name may be up to ${+range.under.toFixed(1)} px narrower: an edge is the detector's, and a redactor draws the box with room to spare.`);
  if (ink.length) why.push(`The bar ends at its black ink on the ${ink.join(' and ')}: the nearest word there is further off than a space.`);
  if (margin.length) why.push(`The ink reaches the text column's ${margin.join(' and ')} edge: the name may end anywhere before it.`);
  const note = [ink.length ? `ink ${ink.join(' + ')}` : '', margin.length ? `${margin.join(' + ')} margin` : ''].filter(Boolean).join(' · ');
  return `<span class="rm-chip" title="${escAttr(why.join(' '))}">±${+tol.toFixed(2)} px${note ? ` · ${escAttr(note)}` : ''}</span>`;
}

function rmVerdictText(box, name) {
  const vd = box.verdicts?.[name];
  if (!vd) return '';
  return `${vd.verdict}${vd.open ? ` · open ${vd.open.match ?? 0}/${vd.open.ink ?? 0} match` : ''}${vd.unexplained ? ` · ${vd.unexplained} unexplained` : ''}`;
}

// Where a reading's name came from, for its list tag.
function rmOrigin(box, e) {
  const o = e.kind === 'pair' ? e.origin : barNames(box).names.get(e.name)?.[0];
  if (!o) return null;
  const list = nameList(o.list);
  return { list, entry: list?.entries[o.index] || null };
}

// The ℹ card's head: how the reading fits — its width against the bar, the
// page's verdict, why a near miss is kept, and a pair's other half.
function rmInfoFitHtml(box, e, loose) {
  const w = box.widths?.[e.name];
  const verdict = rmVerdictText(box, e.name);
  const lines = [];
  if (e.kind === 'pair') {
    const other = typeof utbState !== 'undefined' ? utbState.getBox(e.partnerId) : null;
    const where = e.link === 'row'
      ? (e.name === e.first ? 'the bar to the right' : 'the bar to the left')
      : (e.name === e.first ? 'the first bar of the next line' : 'the last bar of the line before');
    const ov = other ? rmVerdictText(other, e.partnerName) : '';
    lines.push(`One name over two bars: ${escAttr(e.full)}`);
    lines.push(`${where[0].toUpperCase()}${where.slice(1)} holds ${escAttr(e.partnerName)}${ov ? ` (${escAttr(ov)})` : ''}`);
  }
  if (w != null) lines.push(`${e.kind === 'pair' ? `${escAttr(e.name)}: ` : ''}${w.toFixed(2)} px, <b>${rmSigned(w - box.w)}</b> against the bar`);
  if (verdict) lines.push(`Page: ${escAttr(verdict)}`);
  if (e.near && !loose) lines.push('Outside the pen lattice, kept because the page does not contradict it');
  return lines.length ? `<div class="rm-info-fit">${lines.map(l => `<div>${l}</div>`).join('')}</div>` : '';
}

function rmFitRow(box, e, { shown, pickable, tagged, loose }) {
  const v = entryVerdict(box, e);
  const pinned = pickable && (box.matchPick === e.key || (e.kind === 'pair' && utbState.getBox(e.partnerId)?.matchPick === e.key));
  const w = box.widths?.[e.name];
  const name = escAttr(caseName(box, e.name));
  const partner = e.kind === 'pair' ? escAttr(caseName(box, e.partnerName)) : '';
  const shownName = e.kind !== 'pair' ? name
    : e.name === e.first ? `${name}<span class="rm-partner"> ${partner}</span>`
    : `<span class="rm-partner">${partner} </span>${name}`;
  const origin = tagged ? rmOrigin(box, e) : null;
  const cls = ['rm-fit', shown && 'is-shown', pinned && 'is-pinned', v && `v-${v}`, e.kind === 'pair' && 'is-pair',
    e.near && 'is-near', pickable && 'is-pickable'].filter(Boolean).join(' ');
  // the ℹ: everything about the reading is in its card
  const about = `<button type="button" class="rm-info" data-act="info" aria-label="About ${escAttr(e.full)}" aria-controls="rm-info-card" aria-expanded="${rmUi.info.key === e.key}">${rmIcon('info')}</button>`;
  return `<li class="${cls}" data-key="${escAttr(e.key)}">
      <span class="rm-mark">${v ? VERDICT_MARK[v] : ''}</span>
      <span class="rm-fit-who"><span class="rm-fit-name" style="${rmFamily(box)}">${shownName}</span>${about}</span>
      <span class="rm-fit-meta">${origin?.list && origin.list.id !== 'people' ? `<span class="rm-tag">${escAttr(origin.list.label)}</span>` : ''}${pinned ? rmIcon('push_pin', 'rm-pin') : ''}<span class="rm-px">${w != null ? rmSigned(w - box.w) : ''}</span></span>
      <button type="button" class="rm-icon-btn rm-fit-hide" data-act="hide" title="Hide this name from every bar" aria-label="Hide ${escAttr(e.full)} from every bar">${rmIcon('visibility_off')}</button>
    </li>`;
}

const RM_FITS_SHOWN = 12;
const RM_CASE_CHIP = { all: 'ALL CAPS', first: 'CAPS first word', last: 'CAPS last word' };

/** The selected bar: its width and tolerance, then the names that fit it. */
function rmRenderBar() {
  const host = document.getElementById('rm-bar');
  if (!host) return;
  const box = getSelectedRedaction();
  if (els.nameInput) els.nameInput.placeholder = box ? 'Try or add a name' : 'Add a name';
  if (!box) {
    host.innerHTML = '<p class="rm-empty">Select a bar on the page to see the names that fit it.</p>';
    rmHideInfo();
    return;
  }
  const { entries, near, tol, loose, link } = getBoxMatchInfo(box);
  const { index } = shownMatch(box, entries);
  const names = barNames(box);
  const head = `<div class="rm-bar-head">
      <span class="rm-bar-w" title="${escAttr(rmBarTitle(box))}">${box.w.toFixed(2)} px</span>
      ${rmTolChip(box)}
      ${rmSubstitute(box) ? `<span class="rm-chip is-warn" title="${escAttr(`${rmSubstitute(box)}: the names are measured in ${rmShapedName(box)}, which may be wider or narrower.`)}">≈ ${escAttr(rmShapedName(box))}</span>` : ''}
      ${box.uppercase ? `<span class="rm-chip is-warn" title="Settings → Letter case applies on top of the format. Set it to “As typed” to let the format decide.">${RM_CASE_CHIP[caseValue(box.uppercase)] || 'Letter case'}</span>` : ''}
      ${entries.length > 1 ? `<span class="rm-bar-n" title="Several names can share one width. Click one to show it on the bar, or press [ / ] with the bar selected.">${entries.length} ${loose ? 'near' : 'fit'}</span>` : ''}
    </div>`;
  const linkNote = link ? `<p class="rm-note rm-link">${rmIcon(link.kind === 'row' ? 'swap_horiz' : 'keyboard_return')}${LINK_NOTE[`${link.kind}-${link.role}`]}</p>` : '';

  let body;
  if (!names.list.length && !(link && pairReadings(box, link).length)) {
    body = '<p class="rm-note">No names to compare. Turn on a list under Names, or a format under Format.</p>';
  } else if (_measuredKey.get(box) !== names.key) {
    // not measured yet, or its names changed since the widths were taken:
    // they are on their way ("No name fits" was said of a bar never measured)
    if (!rmUi.measuring.has(box.id)) rmMeasureSoon(box.id);
    body = '<p class="rm-note">Measuring…</p>';
  } else if (box.widthError && !Object.keys(box.widths || {}).length) {
    body = `<p class="rm-note is-warn">No name could be measured (${escAttr(box.widthError)}): the names are not compared.</p>`;
  } else if (!entries.length) {
    body = `<p class="rm-note">No name fits ±${+tol.toFixed(2)} px.</p>`;
  } else {
    const tagged = new Set(entries.map(e => rmOrigin(box, e)?.list?.id)).size > 1;
    const all = rmUi.allFits || entries.length <= RM_FITS_SHOWN + 2;
    const rows = (all ? entries : entries.slice(0, RM_FITS_SHOWN))
      .map((e, i) => rmFitRow(box, e, { shown: i === index, pickable: true, tagged, loose })).join('');
    body = `${loose ? `<p class="rm-note is-warn">No name fits the pen-exact width (±${PEN_TOL_PX} px). The nearest within ±${+tol.toFixed(2)} px:</p>` : ''}
      <ol class="rm-fits">${rows}</ol>
      ${all ? '' : `<button type="button" class="rm-more" data-act="more">Show all ${entries.length}</button>`}`;
  }
  // near misses the list does not already hold (outside the pen lattice,
  // within the Tolerance field) — out of the way unless asked for
  const shownKeys = new Set(entries.map(e => e.key));
  const misses = loose ? [] : near.filter(e => !shownKeys.has(e.key));
  const nearHtml = misses.length ? `<details class="rm-near"${rmUi.nearOpen ? ' open' : ''} data-ui="nearOpen">
      <summary>${misses.length} near ${misses.length === 1 ? 'miss' : 'misses'}</summary>
      <ol class="rm-fits">${misses.map(e => rmFitRow(box, e, { shown: false, pickable: false, tagged: false, loose })).join('')}</ol>
    </details>` : '';
  const lacking = box.unshaped ? `<p class="rm-note">${rmNumber(box.unshaped)} ${box.unshaped === 1 ? 'name has' : 'names have'} characters ${escAttr(box.shapedFace?.family || 'the face')} cannot draw: not compared.</p>` : '';
  host.innerHTML = `${head}${linkNote}${body}${lacking}${nearHtml}`;
  rmInfoReanchor();
}

// The name field measures what is typed against the selected bar.
async function rmRenderTry() {
  const out = document.getElementById('rm-try');
  if (!out) return;
  const names = splitNames(els.nameInput?.value || '');
  const seq = ++rmUi.trySeq;
  if (!names.length) { out.innerHTML = ''; return; }
  if (names.length > 1) { out.textContent = `Enter adds ${names.length} names to Your names`; return; }
  const box = getSelectedRedaction();
  if (!box) { out.textContent = 'Enter adds it to Your names'; return; }
  const { widths } = await measureNames(box, names);
  if (seq !== rmUi.trySeq) return;
  const w = widths[names[0]];
  if (w == null) { out.textContent = 'Enter adds it to Your names'; return; }
  const d = w - box.w;
  const fits = fitsRange(fitRange(box), d);
  out.innerHTML = `<span class="rm-try-w">${w.toFixed(2)} px</span>
    <span class="rm-px ${fits ? 'is-ok' : 'is-off'}">${rmSigned(d)}</span>
    <span class="${fits ? 'is-ok' : 'is-off'}">${fits ? 'fits' : d > 0 ? 'too wide' : 'too narrow'}</span>
    <span class="rm-try-hint">· Enter adds it</span>`;
}

// ── The panel: the ℹ card ───────────────────────────────────
// The ℹ behind a fitting name opens a card with everything about it: how it
// fits (rmInfoFitHtml — the row has no tooltip), then who it is: every entry that
// writes the name (a pair's one), as its list records it — the full name,
// other spellings, a gender, e-mail addresses, a note, the address-book page,
// the Wikipedia section. Hovering the ℹ shows it, and it stays while the
// pointer is on it, so its links can be followed; a click (a tap, Enter)
// pins it until Escape or a click elsewhere, and from the keyboard the focus
// goes into it. It hangs in the panel (#rm-info-card, outside the scrolling
// body), under the ℹ or, with more room there, above it.

const RM_INFO_ENTRIES = 3;
const RM_INFO_OPEN_MS = 120;    // a pointer passing over an ℹ does not open it
const RM_INFO_CLOSE_MS = 200;   // time to cross from the ℹ to the card
const RM_LINK_ICONS = { book: 'menu_book', wiki: 'public', web: 'link', text: 'label' };

// The entries behind a reading: a pair's one, or each that writes the name.
function rmInfoEntries(box, e) {
  const origins = e.kind === 'pair' ? [e.origin] : barNames(box).names.get(e.name) || [];
  return origins.map(o => ({ list: nameList(o.list), entry: nameList(o.list)?.entries[o.index] }))
    .filter(x => x.list && x.entry);
}

function rmInfoEntryHtml(list, x) {
  const also = nameEntryAlso(x);
  const tags = [x.gender === 'f' ? 'Woman' : x.gender === 'm' ? 'Man' : '', list.label].filter(Boolean);
  const row = (icon, html) => `<li>${rmIcon(icon)}<span>${html}</span></li>`;
  const rows = [
    ...(x.email || []).map(a => row('mail', escAttr(a))),
    ...(x.emailCut || []).map(a => row('mail', `${escAttr(a)} <span class="rm-info-cut" title="Cut off in the list: no format writes it">cut off</span>`)),
    x.note ? row('sticky_note_2', escAttr(x.note)) : '',
    ...nameEntryLinks(x).map(l => row(RM_LINK_ICONS[l.kind], l.href
      ? `<a href="${escAttr(l.href)}" target="_blank" rel="noopener noreferrer">${escAttr(l.text)}${rmIcon('open_in_new', 'rm-info-ext')}</a>`
      : escAttr(l.text))),
  ].join('');
  return `<div class="rm-info-entry">
      <div class="rm-info-name">${escAttr(nameEntryFull(x))}</div>
      ${also.length ? `<div class="rm-info-also">also ${also.map(escAttr).join(' · ')}</div>` : ''}
      <div class="rm-info-tags">${tags.map(t => `<span class="rm-info-tag">${escAttr(t)}</span>`).join('')}</div>
      ${rows ? `<ul class="rm-info-rows">${rows}</ul>` : ''}
    </div>`;
}

/** The ℹ card of one of a bar's readings: how it fits, then who it is. */
function rmInfoHtml(box, e, loose = false) {
  const who = rmInfoEntries(box, e);
  const fit = rmInfoFitHtml(box, e, loose);
  if (!who.length) return `${fit}<p class="rm-info-more">No list holds this name any more.</p>`;
  const more = who.length - RM_INFO_ENTRIES;
  return `${fit}${who.slice(0, RM_INFO_ENTRIES).map(({ list, entry }) => rmInfoEntryHtml(list, entry)).join('')}
    ${more > 0 ? `<p class="rm-info-more">and ${more} more ${more === 1 ? 'entry writes' : 'entries write'} this name</p>` : ''}`;
}

/** Open the card of the fitting name an ℹ belongs to — pinned or not, with
 *  the focus moved into it or not. */
function rmShowInfo(btn, { pin = false, focus = false } = {}) {
  const card = document.getElementById('rm-info-card');
  const box = getSelectedRedaction();
  const key = btn?.closest('.rm-fit')?.dataset.key;
  if (!card || !box || key == null) return;
  const { entries, near, loose } = getBoxMatchInfo(box);
  const e = [...entries, ...near].find(x => x.key === key);
  if (!e) { rmHideInfo(); return; }
  const info = rmUi.info;
  clearTimeout(rmUi.timers.info);
  if (info.anchor !== btn) info.anchor?.setAttribute('aria-expanded', 'false');
  Object.assign(info, { key, anchor: btn, pinned: pin });
  btn.setAttribute('aria-expanded', 'true');
  const html = rmInfoHtml(box, e, loose);
  if (html !== info.html) { card.innerHTML = html; info.html = html; }
  card.classList.remove('hidden');
  rmPlaceInfo();
  if (focus) (card.querySelector('a') || card).focus();
}

function rmHideInfo() {
  const info = rmUi.info;
  clearTimeout(rmUi.timers.info);
  if (info.key == null) return;
  info.anchor?.setAttribute('aria-expanded', 'false');
  Object.assign(info, { key: null, anchor: null, pinned: false, html: '' });
  document.getElementById('rm-info-card')?.classList.add('hidden');
}

// Under the ℹ, or above it when there is more room there — within the panel
// (desktop: positioned; the narrow-screen sheet: fixed), as wide as it allows.
function rmPlaceInfo() {
  const card = document.getElementById('rm-info-card');
  const panel = els.namesPanel;
  const btn = rmUi.info.anchor;
  if (!card || !panel || !btn?.isConnected) { rmHideInfo(); return; }
  const b = btn.getBoundingClientRect();
  const view = panel.querySelector('.rm-body')?.getBoundingClientRect();
  if (view && (b.bottom <= view.top || b.top >= view.bottom)) { rmHideInfo(); return; }   // scrolled away
  const p = panel.getBoundingClientRect();
  const ox = p.left + panel.clientLeft, oy = p.top + panel.clientTop;
  const width = Math.min(300, panel.clientWidth - 16);
  card.style.width = `${width}px`;
  card.style.maxHeight = '';
  const below = b.bottom - oy + 4;
  const roomBelow = panel.clientHeight - 8 - below;
  const roomAbove = b.top - oy - 4 - 8;
  const h = card.offsetHeight;
  const under = h <= roomBelow || roomBelow >= roomAbove;
  const room = under ? roomBelow : roomAbove;
  if (h > room) card.style.maxHeight = `${Math.max(80, room)}px`;
  card.style.left = `${Math.round(Math.max(8, Math.min(b.left - ox - 12, panel.clientWidth - width - 8)))}px`;
  card.style.top = `${Math.round(under ? below : b.top - oy - 4 - Math.min(h, room))}px`;
}

// The fits were drawn again (a measurement, a verdict, a pin): the card
// follows its name to the new ℹ, or closes when the name is gone.
function rmInfoReanchor() {
  const info = rmUi.info;
  if (info.key == null) return;
  const row = [...document.querySelectorAll('#rm-bar .rm-fit')].find(li => li.dataset.key === info.key);
  const btn = row?.querySelector('.rm-info');
  if (btn) rmShowInfo(btn, { pin: info.pinned });
  else rmHideInfo();
}

// A mouse over an ℹ opens its card after a moment (at once while another is
// open); the card closes a moment after the pointer has left both. A pinned
// card stays.
function rmInfoPointer(e) {
  if (e.pointerType !== 'mouse') return;
  const info = rmUi.info;
  const at = el => el?.closest?.('.rm-info, #rm-info-card');
  if (e.type === 'pointerover') {
    const t = at(e.target);
    if (!t) return;
    clearTimeout(rmUi.timers.info);
    if (!t.matches('.rm-info') || t === info.anchor || info.pinned) return;
    if (info.key != null) rmShowInfo(t);
    else rmUi.timers.info = setTimeout(() => rmShowInfo(t), RM_INFO_OPEN_MS);
  } else if (!info.pinned && at(e.target) && !at(e.relatedTarget)) {
    clearTimeout(rmUi.timers.info);
    rmUi.timers.info = setTimeout(rmHideInfo, RM_INFO_CLOSE_MS);
  }
}

// ── The panel: format ───────────────────────────────────────
// A format opens in the pill editor: its tree as pills on a track — a part
// (its choices, its case, a full stop after it), the text between parts, a
// dashed group around what is optional — the selected pill's controls, a
// palette that adds parts, and the names the format makes. A pill is clicked
// to change it and dragged to move it; *Type a pattern* is the same format
// as text, and either follows the other.

// A format's examples: the first person of the enabled lists each variant
// can write, the richest variant first — the same people every time, so
// formats compare at a glance.
function rmSampleNames(parsed, n = 1) {
  const out = [];
  const variants = [...(parsed.variants || [])].sort((a, b) => b.parts.length - a.parts.length);
  for (const p of variants) {
    const s = rmSampleOf(p);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= n) break;
  }
  return out;
}

// A whole name if there is one (first and last), else whatever it writes.
function rmSampleOf(p) {
  for (const whole of [true, false]) {
    for (const list of state.nameLists) {
      if (!list.on) continue;
      for (const e of list.entries) {
        if (!e || e.text != null || (whole && (!e.first.length || !e.last.length))) continue;
        const s = nameFromPattern(p, nameSpellings(e, { first: false, last: false })[0]);
        if (s) return s;
      }
    }
  }
  return '';
}

function rmRenderFormatSummary() {
  const sum = document.getElementById('rm-format-sum');
  if (!sum) return;
  const on = getActiveNameSettings().formats.filter(f => f.on);
  const scope = getSelectedRedaction() ? '' : ' · new bars';
  sum.textContent = `${on.length ? on.map(f => nameFormatLabel(f.pattern)).join(' · ') : 'none on'}${scope}`;
}

// A part's case, as compact buttons — [case, label, in words].
const RM_KASES = [['as', 'Aa', 'As the list writes it'], ['upper', 'AA', 'In capitals'], ['lower', 'aa', 'In lowercase']];
const RM_INITIAL_KASES = [['as', 'A', 'A capital'], ['lower', 'a', 'In lowercase']];
const RM_PART_KINDS = [['name', 'Name'], ['title', 'Title'], ['email', 'E-mail']];
// What a text pill offers at a click — [characters, label, in words];
// anything else is typed.
const RM_TEXT_PRESETS = [
  [' ', '␣', 'a space'], [', ', ',␣', 'a comma and a space'], [',', ',', 'a comma'], ['.', '.', 'a full stop'],
  ['. ', '.␣', 'a full stop and a space'], ['_', '_', 'an underscore'], ['-', '-', 'a hyphen'], ['@', '@', 'an at sign'],
];
// What the palette adds — [what (nameTreeAdd), label, colour].
const RM_PALETTE = [
  ['first', 'First', 'name'], ['middleInitial', 'Middle', 'name'], ['last', 'Last', 'name'],
  ['prefix', 'Title', 'title'], ['suffix', 'Suffix', 'title'], ['mr|ms', 'Mr / Ms', 'title'],
  ['email', 'E-mail', 'email'], ['text', 'Text', 'text'],
];
// One format making more names than this is told it will take a while to measure.
const RM_MANY_NAMES = 20000;

const rmPath = s => String(s).split('.').map(Number);

function rmPillLabel(x) {
  return x.t === 'text' ? x.s.replace(/ /g, '␣') : x.alts.map(a => `${a.pre}${a.word}${a.post}`).join(' | ');
}

function rmPillTitle(x) {
  if (x.t === 'text') return `“${x.s}” stands as typed`;
  return x.alts.map(a => {
    const kase = a.kase === 'lower' ? ' in lowercase' : a.kase === 'upper' && a.word.length > 1 ? ' in capitals' : '';
    const around = [a.pre && `“${a.pre}” before it`, a.post && `“${a.post}” after it`].filter(Boolean).join(' and ');
    return `${NAME_PART_DEFS[a.field].label}${kase}${around ? `, ${around}` : ''}`;
  }).join('; or ');
}

/** A run of the tree as pills — an optional group around its own. Only the
 *  track's own pills and groups are dragged. */
function rmPillsHtml(nodes, at = []) {
  return nodes.map((x, i) => {
    const path = [...at, i], p = path.join('.'), top = !at.length;
    const drag = top ? ' data-drag' : '';
    if (x.t === 'opt') {
      return `<span class="rm-opt" data-path="${p}"${drag} title="Optional: names are made with it and without it">
          <button type="button" class="rm-opt-tag" data-act="opt-unwrap" title="Optional — click to make it required" aria-label="Optional: make it required">?</button>${rmPillsHtml(x.body, path)}</span>`;
    }
    const sel = rmUi.pill === p;
    const kind = x.t === 'text' ? 'text' : NAME_PART_DEFS[x.alts[0].field].kind;
    const title = `${rmPillTitle(x)} · click to change it${top ? ', drag to move it' : ''}`;
    return `<button type="button" class="rm-pill is-${kind}${sel ? ' is-sel' : ''}" data-act="pill" data-path="${p}"${drag} aria-expanded="${sel}" title="${escAttr(title)}">${escAttr(rmPillLabel(x))}</button>`;
  }).join('');
}

/** The selected pill's controls: a part's choices (each its part, case and
 *  full stop), or a text's characters; optional or not; move and remove. */
function rmPillPop(tree) {
  if (rmUi.pill == null) return '';
  const path = rmPath(rmUi.pill);
  const at = nameTreeAt(tree, path);
  const x = at?.node;
  if (!x || x.t === 'opt') return '';
  const btn = (act, icon, title, extra = '', off = false) => `<button type="button" class="rm-icon-btn" data-act="${act}"${extra} title="${title}" aria-label="${title}"${off ? ' disabled' : ''}>${rmIcon(icon)}</button>`;
  // a part steps over text to the next part; text steps one place
  const can = dir => {
    for (let j = at.i + dir; at.seq[j]; j += dir) if (x.t === 'text' || at.seq[j].t !== 'text') return true;
    return false;
  };
  const foot = `<div class="rm-pop-foot">
      <label class="rm-check" title="Names are made with it and without it"><input type="checkbox" data-act="pill-opt"${path.length > 1 ? ' checked' : ''}> Optional</label>
      <span class="rm-pop-acts">${btn('pill-move', 'arrow_back', 'Move it left', ' data-dir="-1"', !can(-1))}${btn('pill-move', 'arrow_forward', 'Move it right', ' data-dir="1"', !can(1))}${btn('pill-remove', 'delete', 'Remove it')}</span>
    </div>`;
  if (x.t === 'text') {
    return `<div class="rm-pop" data-path="${rmUi.pill}">
        <div class="rm-seg">${RM_TEXT_PRESETS.map(([v, l, t]) => `<button type="button" class="rm-seg-btn${x.s === v ? ' on' : ''}" data-act="text-set" data-v="${escAttr(v)}" title="${escAttr(t)}" aria-pressed="${x.s === v}">${escAttr(l)}</button>`).join('')}</div>
        <input type="text" class="rm-input rm-mono" data-act="text-input" value="${escAttr(x.s)}" spellcheck="false" autocomplete="off" aria-label="The text, as it stands">
        ${foot}
      </div>`;
  }
  const parts = a => RM_PART_KINDS.map(([kind, label]) => `<optgroup label="${label}">${Object.entries(NAME_PART_DEFS)
    .filter(([, d]) => d.kind === kind)
    .map(([f, d]) => `<option value="${f}"${f === a.field ? ' selected' : ''}>${escAttr(d.label)}</option>`).join('')}</optgroup>`).join('');
  const seg = (on, attrs, title, label) => `<button type="button" class="rm-seg-btn${on ? ' on' : ''}" ${attrs} aria-pressed="${on}" title="${title}">${label}</button>`;
  const kases = (a, k) => (a.word.length === 1 ? RM_INITIAL_KASES : RM_KASES)
    .map(([v, l, t]) => seg(v === nameAltKase(a), `data-act="alt-kase" data-k="${k}" data-v="${v}"`, t, l)).join('');
  const alt = (a, k) => `<div class="rm-alt">
      ${k ? '<span class="rm-alt-or">or</span>' : ''}
      <select class="rm-select" data-act="alt-field" data-k="${k}" aria-label="Part">${parts(a)}</select>
      <span class="rm-seg" role="group" aria-label="Case">${kases(a, k)}</span>
      ${seg(a.post.endsWith('.'), `data-act="alt-dot" data-k="${k}"`, 'A full stop after it', '.')}
      ${x.alts.length > 1 ? btn('alt-remove', 'close', 'Remove this choice', ` data-k="${k}"`) : ''}
    </div>`;
  return `<div class="rm-pop" data-path="${rmUi.pill}">
      ${x.alts.map(alt).join('')}
      <button type="button" class="rm-link-btn" data-act="alt-add" title="Names are made with either part">+ or another part</button>
      ${foot}
    </div>`;
}

function rmPaletteHtml() {
  return `<div class="rm-palette" role="group" aria-label="Add to the format">${RM_PALETTE.map(([what, label, kind]) => `<button type="button" class="rm-pal is-${kind}" data-act="pal-add" data-add="${what}" data-paldrag title="Add ${escAttr(what === 'text' ? 'text' : label)} — click, or drag it into place">${rmIcon('add')}${escAttr(label)}</button>`).join('')}</div>`;
}

// The names a format makes for the active settings (its filter too), and
// some of them.
function rmFormatEg(f, parsed, s) {
  if (parsed.error) return `<span class="is-warn">${escAttr(parsed.error)}</span>`;
  const n = makeNames({ ...s, formats: [{ ...f, on: true }] }).size;
  const eg = rmSampleNames(parsed, 3);
  const count = n
    ? `<span${n > RM_MANY_NAMES ? ' class="is-warn" title="Every name is measured against the bar: this many takes a while"' : ''}>${rmNumber(n)} ${n === 1 ? 'name' : 'names'}</span>`
    : '<span class="is-warn">No names: nobody in the lists that are on has every part it asks for, or the filter leaves them out</span>';
  return `${eg.length ? `e.g. ${eg.map(escAttr).join(' · ')} · ` : ''}${count}`;
}

/** An open format's pills, the selected one's controls, the palette, and
 *  the names it makes. */
function rmPillEditor(f, s = getActiveNameSettings()) {
  const parsed = parseNamePattern(f.pattern);
  if (!parsed.tree) return `<p class="rm-note is-warn">${escAttr(parsed.error)} — change it under Type a pattern.</p>`;
  return `<div class="rm-pills" aria-label="The format, part by part">${parsed.tree.length ? rmPillsHtml(parsed.tree) : '<span class="rm-pills-empty">Add parts from below</span>'}</div>
    ${rmPillPop(parsed.tree)}
    ${rmPaletteHtml()}
    <p class="rm-eg">${rmFormatEg(f, parsed, s)}</p>`;
}

function rmFormatRow(f, s) {
  const open = rmUi.openFormat === f.id;
  const parsed = parseNamePattern(f.pattern);
  const label = nameFormatLabel(f.pattern);
  return `<li class="rm-format${open ? ' is-open' : ''}${f.on ? '' : ' is-off'}" data-fid="${escAttr(f.id)}">
      <div class="rm-format-row">
        <input type="checkbox" data-act="fmt-on"${f.on ? ' checked' : ''} aria-label="Use ${escAttr(label)}">
        <button type="button" class="rm-format-label" data-act="fmt-edit" aria-expanded="${open}" title="Change this format">${escAttr(label)}${rmIcon(open ? 'expand_less' : 'expand_more')}</button>
        <span class="rm-format-eg">${escAttr(rmSampleNames(parsed)[0] || '')}</span>
        <button type="button" class="rm-icon-btn" data-act="fmt-remove" title="Remove this format" aria-label="Remove ${escAttr(label)}">${rmIcon('close')}</button>
      </div>
      ${open ? `<div class="rm-editor">
        <div class="rm-pilled">${rmPillEditor(f, s)}</div>
        <details class="rm-pattern"${!parsed.tree || rmUi.patternOpen ? ' open' : ''} data-ui="patternOpen">
          <summary>Type a pattern</summary>
          <input type="text" class="rm-input rm-mono" data-act="ed-pattern" value="${escAttr(f.pattern)}" spellcheck="false" autocomplete="off" aria-label="Pattern">
          <p class="rm-err" role="alert"></p>
          <p class="rm-hint">Parts: {First} {Middle} {Last} {F} {M} {L} {Nick} {Title} {Suffix} {Mr} {Ms} {Mrs} {Miss} {Email} {User} {Domain} — in capitals for capitals, in lowercase for lowercase. [ … ] is optional and {First|Nick} either part; a \\ writes the sign after it as it stands. Every other character stands as typed.</p>
        </details>
      </div>` : ''}
    </li>`;
}

/** The Format section: the active settings' formats, one open in the editor. */
function rmRenderFormat() {
  rmRenderFormatSummary();
  const host = document.getElementById('rm-format');
  if (!host) return;
  const s = getActiveNameSettings();
  // the control that had the focus has it again in the new markup
  const a = document.activeElement;
  const refocus = a && host.contains(a) && a.dataset.act ? rmControlSelector(a) : null;
  host.innerHTML = `<div class="rm-scope">
      <span>${rmScopeText()}</span>
      <button type="button" class="rm-link-btn" data-act="apply-all" title="Give every bar — and every new one — these formats and spellings">Apply to all bars</button>
    </div>
    <ul class="rm-formats">${s.formats.map(f => rmFormatRow(f, s)).join('')}</ul>
    <div class="rm-format-foot">
      <select class="rm-select" data-act="fmt-add" aria-label="Add a format">
        <option value="">Add a format</option>
        ${NAME_FORMAT_PRESETS.map(p => `<option value="${escAttr(p)}">${escAttr(nameFormatLabel(p))}</option>`).join('')}
      </select>
      <span class="rm-aliases" title="A person can have several spellings in a list (Abraham / Abe); off, only the first counts">
        Every spelling of
        <label class="rm-check"><input type="checkbox" data-act="alias-first"${s.aliases.first ? ' checked' : ''}> first</label>
        <label class="rm-check"><input type="checkbox" data-act="alias-last"${s.aliases.last ? ' checked' : ''}> last names</label>
      </span>
    </div>`;
  if (refocus) host.querySelector(refocus)?.focus();
}

// Whose formats the section edits, and how many names they make there.
function rmScopeText() {
  const box = getSelectedRedaction();
  const n = box ? getBoxCandidates(box).length : makeNames(getActiveNameSettings()).size;
  return `${box ? 'For this bar' : 'For new bars'} · ${rmNumber(n)} ${n === 1 ? 'name' : 'names'}`;
}

// The counts follow the settings — a filter changed, a pattern typed —
// without the section's fields being drawn again.
function rmRenderFormatCounts() {
  const host = document.getElementById('rm-format');
  if (!host) return;
  const scope = host.querySelector('.rm-scope span');
  if (scope) scope.textContent = rmScopeText();
  const s = getActiveNameSettings();
  for (const li of host.querySelectorAll('.rm-format.is-open')) {
    const f = rmFormatOf(li);
    const eg = li.querySelector('.rm-eg');
    if (f && eg) eg.innerHTML = rmFormatEg(f, parseNamePattern(f.pattern), s);
  }
}

// A control found again by what it does, in its format, after the markup
// around it was drawn anew (the selected pill's controls are one at a time).
function rmControlSelector(el) {
  const q = v => `"${String(v).replace(/["\\]/g, '\\$&')}"`;
  const d = el.dataset;
  const fid = el.closest('[data-fid]')?.dataset.fid;
  const by = ['path', 'k', 'dir', 'v', 'add'].map(k => (d[k] != null ? `[data-${k}=${q(d[k])}]` : '')).join('');
  return `${fid != null ? `[data-fid=${q(fid)}] ` : ''}${el.closest('.rm-pop') ? '.rm-pop ' : ''}[data-act=${q(d.act)}]${by}`;
}

const rmFormatOf = el => {
  const fid = el.closest('[data-fid]')?.dataset.fid;
  return getActiveNameSettings().formats.find(f => f.id === fid) || null;
};

// A change made with the pills, on a copy of the format's tree, written
// back as its pattern. `edit` returns the path to select after it — null
// for none, nothing to keep the selection.
function rmEditTree(el, edit) {
  const f = rmFormatOf(el);
  const tree = f && parseNamePattern(f.pattern).tree;
  if (!tree) return;
  const copy = structuredClone(tree);
  const sel = edit(copy);
  f.pattern = patternOfNameTree(copy);
  if (sel !== undefined) rmUi.pill = sel ? sel.join('.') : null;
  rmRenderFormat();
  nameSettingsChanged();
}

// A change to the selected pill: change(node, tree, path), as rmEditTree's edit.
function rmEditPill(el, change) {
  const path = rmPath(el.closest('.rm-pop')?.dataset.path ?? '');
  rmEditTree(el, tree => {
    const x = nameTreeAt(tree, path)?.node;
    return x ? change(x, tree, path) : undefined;
  });
}

// While a field of the editor has the focus, what follows its format's
// pattern is drawn again around it: the row's label and example, the pills,
// the names it makes, and the typed pattern unless that is the field.
function rmRefreshFormat(li, f) {
  const parsed = parseNamePattern(f.pattern);
  const label = li.querySelector('.rm-format-label');
  if (label) label.innerHTML = `${escAttr(nameFormatLabel(f.pattern))}${rmIcon('expand_less')}`;
  const eg = li.querySelector('.rm-format-eg');
  if (eg) eg.textContent = rmSampleNames(parsed)[0] || '';
  const pills = li.querySelector('.rm-pills');
  if (pills && parsed.tree) pills.innerHTML = rmPillsHtml(parsed.tree);
  const names = li.querySelector('.rm-eg');
  if (names) names.innerHTML = rmFormatEg(f, parsed, getActiveNameSettings());
  const typed = li.querySelector('[data-act="ed-pattern"]');
  if (typed && document.activeElement !== typed) typed.value = f.pattern;
}

// Typing a pattern: the format follows each keystroke that leaves it
// readable, its pills drawn afresh; the field keeps the focus.
function rmTypePattern(input) {
  const f = rmFormatOf(input);
  const li = input.closest('[data-fid]');
  if (!f || !li) return;
  const parsed = parseNamePattern(input.value);
  const err = li.querySelector('.rm-err');
  if (err) err.textContent = parsed.error || '';
  if (parsed.error) return;
  f.pattern = input.value;
  rmUi.pill = null;   // the pills are other nodes now
  const pilled = li.querySelector('.rm-pilled');
  if (pilled) pilled.innerHTML = rmPillEditor(f);
  rmRefreshFormat(li, f);
  nameSettingsChangedSoon();
}

// Typing a text pill's characters: the pattern follows each keystroke, the
// field keeps the focus. Emptied, the text goes when the field is left.
function rmTypeText(input) {
  const f = rmFormatOf(input);
  const li = input.closest('[data-fid]');
  const tree = f && parseNamePattern(f.pattern).tree;
  if (!input.value || !tree || !li) return;
  const copy = structuredClone(tree);
  const x = nameTreeAt(copy, rmPath(input.closest('.rm-pop')?.dataset.path ?? ''))?.node;
  if (x?.t !== 'text') return;
  x.s = input.value;
  f.pattern = patternOfNameTree(copy);
  rmRefreshFormat(li, f);
  nameSettingsChangedSoon();
}

function rmNextFormatId(s) {
  const n = Math.max(0, ...s.formats.map(f => parseInt(String(f.id).replace(/\D/g, ''), 10) || 0));
  return `f${n + 1}`;
}

// ── The panel: dragging pills ───────────────────────────────
// A pill of the track — or an optional group, as one — is dragged to a place
// between two others, or onto the middle of another part to swap the two; a
// palette button is dragged to where its part goes. Pointer events, so a
// finger drags too; a press that does not move is a click.
const RM_DRAG_START_PX = 5;

function rmOnPointerDown(e) {
  if (e.button !== 0) return;
  const src = e.target.closest('[data-drag], [data-paldrag]');
  const track = src?.closest('.rm-editor')?.querySelector('.rm-pills');
  if (!track) return;
  const x0 = e.clientX, y0 = e.clientY;
  let drag = null;
  const move = ev => {
    if (!drag && Math.hypot(ev.clientX - x0, ev.clientY - y0) < RM_DRAG_START_PX) return;
    drag ||= rmDragStart(src, track, ev);
    rmDragOver(drag, ev);
  };
  const end = ev => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', end);
    document.removeEventListener('pointercancel', end);
    if (!drag) return;
    // the click that ends a drag is not a click
    rmUi.dragged = true;
    setTimeout(() => { rmUi.dragged = false; }, 0);
    rmDragEnd(drag, ev.type === 'pointerup');
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
}

function rmDragStart(src, track, ev) {
  const r = src.getBoundingClientRect();
  const ghost = src.cloneNode(true);
  ghost.classList.add('rm-ghost');
  ghost.style.width = `${r.width}px`;
  document.body.appendChild(ghost);
  const caret = document.createElement('span');
  caret.className = 'rm-caret';
  caret.hidden = true;
  track.appendChild(caret);
  src.classList.add('is-dragged');
  els.namesPanel?.classList.add('is-dragging');
  return {
    src, track, ghost, caret, dx: ev.clientX - r.left, dy: ev.clientY - r.top, target: null,
    from: src.hasAttribute('data-drag') ? +src.dataset.path : null,   // a pill of the track
    add: src.dataset.add || null,                                     // a palette button
  };
}

// Where a drop would land: { swap: i } onto the middle of another part, or
// { at: i } between two units, by the nearest edge — rows weigh more than
// columns, as the track wraps. Null well off the track.
function rmDropTarget(drag, x, y) {
  const tr = drag.track.getBoundingClientRect();
  const PAD = 24;
  if (x < tr.left - PAD || x > tr.right + PAD || y < tr.top - PAD || y > tr.bottom + PAD) return null;
  const units = [...drag.track.children].filter(c => c.hasAttribute('data-drag'));
  if (!units.length) return { at: 0, x: tr.left + 8, y: tr.top + 6, h: tr.height - 12 };
  const part = drag.from != null && !drag.src.classList.contains('is-text');
  let best = null;
  units.forEach((u, i) => {
    const r = u.getBoundingClientRect();
    if (part && i !== drag.from && !u.classList.contains('is-text')
      && x > r.left + r.width / 4 && x < r.right - r.width / 4 && y >= r.top && y <= r.bottom) {
      best = { swap: i };
    }
    for (const [edge, at] of [[r.left, i], [r.right, i + 1]]) {
      const d = Math.abs(x - edge) + 3 * Math.max(0, Math.abs(y - (r.top + r.height / 2)) - r.height / 2);
      if (!best || (best.swap == null && d < best.d)) best = { at, d, x: edge, y: r.top, h: r.height };
    }
  });
  return best;
}

function rmDragOver(drag, ev) {
  drag.ghost.style.transform = `translate(${ev.clientX - drag.dx}px, ${ev.clientY - drag.dy}px)`;
  const t = drag.target = rmDropTarget(drag, ev.clientX, ev.clientY);
  const units = [...drag.track.children].filter(c => c.hasAttribute('data-drag'));
  units.forEach((u, i) => u.classList.toggle('is-swap', t?.swap === i));
  drag.caret.hidden = !t || t.swap != null;
  if (drag.caret.hidden) return;
  const tr = drag.track.getBoundingClientRect();
  drag.caret.style.left = `${t.x - tr.left - 2}px`;
  drag.caret.style.top = `${t.y - tr.top}px`;
  drag.caret.style.height = `${t.h}px`;
}

function rmDragEnd(drag, drop) {
  drag.ghost.remove();
  drag.caret.remove();
  drag.src.classList.remove('is-dragged');
  els.namesPanel?.classList.remove('is-dragging');
  const t = drop ? drag.target : null;
  if (!t) { rmRenderFormat(); return; }
  rmEditTree(drag.track, tree => {
    if (drag.add) {
      const path = nameTreeAdd(tree, drag.add, t.at);
      return drag.add === 'text' ? path : null;
    }
    if (t.swap != null) [tree[drag.from], tree[t.swap]] = [tree[t.swap], tree[drag.from]];
    else nameTreeMove(tree, drag.from, t.at);
    return null;
  });
}

// ── The panel: filter ───────────────────────────────────────

function rmRenderFilterSummary() {
  const sum = document.getElementById('rm-filter-sum');
  if (!sum) return;
  const s = getActiveNameSettings();
  const parts = [];
  if (s.startsWith) parts.push(`starts “${s.startsWith}”${s.startsWithAuto ? ' (seen)' : ''}`);
  if (s.endsWith) parts.push(`ends “${s.endsWith}”${s.endsWithAuto ? ' (seen)' : ''}`);
  const kept = NAME_GENDERS.filter(([k]) => s.gender[k]);
  if (kept.length < NAME_GENDERS.length) parts.push(kept.map(([, l]) => l.toLowerCase()).join(' + ') || 'nobody');
  sum.textContent = parts.join(' · ') || 'none';
}

/** The Filter section: the selected bar's starts-with / ends-with and
 *  gender (a bar's own; hidden with none selected). */
function rmRenderFilter() {
  const box = getSelectedRedaction();
  document.getElementById('rm-filter-sec')?.classList.toggle('hidden', !box);
  if (!box) return;
  const s = ensureBoxNameSettings(box);
  for (const [id, v] of [['ns-starts-with', s.startsWith], ['ns-ends-with', s.endsWith]]) {
    const input = document.getElementById(id);
    if (input && document.activeElement !== input) input.value = v || '';
  }
  for (const [k] of NAME_GENDERS) {
    const check = document.getElementById(`ns-gender-${k}`);
    if (check) check.checked = !!s.gender[k];
  }
  rmRenderFilterSummary();
}

// ── The panel: name lists ───────────────────────────────────

const RM_YOURS_SHOWN = 40;

// How much a list of people records beyond the names — what a gender
// filter, a middle initial or an e-mail part has to go on.
function rmListFields(l) {
  if (!l.entries.some(e => e?.first?.length)) return '';
  const n = test => rmNumber(l.entries.filter(e => e && e.text == null && test(e)).length);
  return `<span class="rm-list-fields">${n(e => e.gender === 'f' || e.gender === 'm')} with a gender · ${n(e => e.middle.length)} a middle name · ${n(e => e.email.length)} an e-mail</span>`;
}

/** The Names section: which lists bars are matched against, Your names, the hidden. */
function rmRenderNames() {
  const on = state.nameLists.filter(l => l.on);
  const sum = document.getElementById('rm-names-sum');
  if (sum) {
    const total = on.reduce((n, l) => n + nameListCount(l), 0);
    const loading = on.some(l => l.status === 'loading');
    sum.textContent = on.length ? `${on.map(l => l.label).join(' + ')} · ${loading ? 'loading' : rmNumber(total)}` : 'no list on';
    sum.classList.toggle('is-warn', !on.length || on.some(l => l.status === 'error'));
  }
  const host = document.getElementById('rm-names');
  if (!host) return;
  const status = l => (l.status === 'loading' ? 'loading' : l.status === 'error' ? 'failed to load' : rmNumber(nameListCount(l)));
  const yours = state.customCandidates;
  host.innerHTML = `<ul class="rm-lists">${state.nameLists.map(l => `<li class="rm-list${l.status === 'error' ? ' is-error' : ''}">
        <label class="rm-check" title="${escAttr(l.file || 'The names typed or pasted into the field above')}">
          <input type="checkbox" data-act="list-on" data-list="${escAttr(l.id)}"${l.on ? ' checked' : ''}> ${escAttr(l.label)}</label>
        <span class="rm-count"${l.error ? ` title="${escAttr(l.error)}"` : ''}>${status(l)}</span>
        ${l.id !== YOUR_NAMES ? rmListFields(l) : ''}
      </li>`).join('')}</ul>
    ${yours.length ? `<div class="rm-yours">${yours.slice(0, RM_YOURS_SHOWN).map((n, i) => `<span class="rm-token">${escAttr(n)}<button type="button" class="rm-token-x" data-act="yours-remove" data-i="${i}" aria-label="Remove ${escAttr(n)}">${rmIcon('close')}</button></span>`).join('')}
        ${yours.length > RM_YOURS_SHOWN ? `<span class="rm-more-note">and ${rmNumber(yours.length - RM_YOURS_SHOWN)} more</span>` : ''}
        <button type="button" class="rm-link-btn" data-act="yours-clear">Clear</button></div>` : ''}
    ${state.hiddenEntries.size ? `<p class="rm-hidden">${rmNumber(state.hiddenEntries.size)} hidden from every bar · <button type="button" class="rm-link-btn" data-act="unhide">Show again</button></p>` : ''}`;
}

// ── The panel: wiring ───────────────────────────────────────

// The right side is shared with the host's other side panels (Recto's Text
// panel, another plugin's), one at a time: a panel shown says so on the bus
// ('sidepanel:shown', { id }) and every other one hides — so this panel's tool
// switches to it from whichever panel was showing, and that panel's tool back.
// Whether it is shown is kept in this browser; the first time, it is.
const RM_PANEL_KEY = 'recto.nameMatching.open';
function rmSetPanelOpen(open, { announce = true } = {}) {
  const panel = els.namesPanel;
  if (!panel) return;
  panel.classList.toggle('hidden', !open);
  if (!open) rmHideInfo();
  document.getElementById('toggle-tools')?.classList.toggle('active', open);
  try { localStorage.setItem(RM_PANEL_KEY, open ? '1' : '0'); } catch { /* this session only */ }
  if (open && announce) window.PDFHooks?.emit('sidepanel:shown', { id: panel.id });
}
window.PDFHooks?.on('sidepanel:shown', ({ id } = {}) => {
  const panel = els.namesPanel;
  if (panel && id !== panel.id && !panel.classList.contains('hidden')) rmSetPanelOpen(false, { announce: false });
});
// As the user left it — at load, so a panel of a later plugin sees whether
// this one is showing when it decides whether to show itself.
(function rmRestorePanel() {
  let kept = null;
  try { kept = localStorage.getItem(RM_PANEL_KEY); } catch { /* the default: shown */ }
  if (kept === '0') {
    els.namesPanel?.classList.add('hidden');
    document.getElementById('toggle-tools')?.classList.remove('active');
  }
})();

function rmAddTypedNames() {
  const input = els.nameInput;
  const names = splitNames(input?.value || '');
  if (!names.length) return;
  addCustomNames(names);
  input.value = '';
  rmGrow(input);
  rmRenderTry();
}

// The name field grows with a pasted list, up to a few lines.
function rmGrow(input) {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight + 2, 140)}px`;
}

function rmOnClick(e) {
  if (rmUi.dragged) return;   // the end of a drag
  const t = e.target.closest('[data-act]');
  const act = t?.dataset.act;
  const box = getSelectedRedaction();
  if (!t) {
    // a fitting name: pin it on the bar — or, pinned already, unpin it
    const row = e.target.closest('.rm-fit.is-pickable');
    if (row && box) setBoxMatch(box.id, row.classList.contains('is-pinned') ? null : row.dataset.key);
    return;
  }
  const s = getActiveNameSettings();
  switch (act) {
    case 'close': rmSetPanelOpen(false); break;
    case 'add-names': rmAddTypedNames(); break;
    case 'more': rmUi.allFits = true; rmRenderBar(); break;
    case 'info':   // pins the card (a hover only shows it); from the keyboard, the focus goes in
      if (rmUi.info.anchor === t && rmUi.info.pinned) rmHideInfo();
      else rmShowInfo(t, { pin: true, focus: e.detail === 0 });
      break;
    case 'hide': {
      const row = t.closest('.rm-fit');
      if (row && box) hideMatch(box.id, row.dataset.key);
      break;
    }
    case 'apply-all': applyNameFormatToAll(); break;
    case 'fmt-edit': {
      const f = rmFormatOf(t);
      rmUi.openFormat = f && rmUi.openFormat !== f.id ? f.id : null;
      rmUi.pill = null;
      rmRenderFormat();
      break;
    }
    case 'fmt-remove': {
      const f = rmFormatOf(t);
      if (!f) break;
      s.formats = s.formats.filter(x => x !== f);
      rmRenderFormat();
      nameSettingsChanged();
      break;
    }
    // the pill editor
    case 'pill':
      rmUi.pill = rmUi.pill === t.dataset.path ? null : t.dataset.path;
      rmRenderFormat();
      break;
    case 'opt-unwrap': {
      const path = rmPath(t.closest('[data-path]').dataset.path);
      rmEditTree(t, tree => { nameTreeUnwrap(tree, path); return null; });
      break;
    }
    case 'pal-add':
      rmEditTree(t, tree => {
        const path = nameTreeAdd(tree, t.dataset.add);
        return t.dataset.add === 'text' ? path : null;
      });
      break;
    case 'pill-move': rmEditPill(t, (x, tree, path) => nameTreeStep(tree, path, +t.dataset.dir)); break;
    case 'pill-remove': rmEditPill(t, (x, tree, path) => { nameTreeRemove(tree, path); return null; }); break;
    case 'alt-add': rmEditPill(t, x => { x.alts.push(nameAltOf(nameAltNext(x), nameAltKase(x.alts[x.alts.length - 1]))); }); break;
    case 'alt-remove': rmEditPill(t, x => { x.alts.splice(+t.dataset.k, 1); }); break;
    case 'alt-kase':
      rmEditPill(t, x => {
        const k = +t.dataset.k, a = x.alts[k];
        x.alts[k] = nameAltOf(a.field, t.dataset.v, a.pre, a.post);
      });
      break;
    case 'alt-dot':
      rmEditPill(t, x => {
        const a = x.alts[+t.dataset.k];
        a.post = a.post.endsWith('.') ? a.post.slice(0, -1) : `${a.post}.`;
      });
      break;
    case 'text-set': rmEditPill(t, x => { x.s = t.dataset.v; }); break;
    case 'yours-remove': {
      const i = +t.dataset.i;
      hideNameEntries([{ list: YOUR_NAMES, index: i }]);
      break;
    }
    case 'yours-clear':
      if (confirm(`Remove all ${state.customCandidates.length} of Your names?`)) {
        state.customCandidates = [];
        setNameList(YOUR_NAMES);
      }
      break;
    case 'unhide': state.hiddenEntries.clear(); namesChanged(); break;
  }
}

function rmOnChange(e) {
  const t = e.target;
  const act = t.dataset?.act;
  if (!act) return;
  const s = getActiveNameSettings();
  switch (act) {
    case 'fmt-on': {
      const f = rmFormatOf(t);
      if (f) f.on = t.checked;
      t.closest('.rm-format')?.classList.toggle('is-off', !t.checked);
      nameSettingsChanged();
      break;
    }
    case 'fmt-add': {
      if (!t.value) break;
      const f = { id: rmNextFormatId(s), pattern: t.value, on: true };
      s.formats.push(f);
      rmUi.openFormat = f.id;
      rmUi.pill = null;
      rmRenderFormat();
      nameSettingsChanged();
      break;
    }
    case 'alias-first': s.aliases.first = t.checked; nameSettingsChanged(); break;
    case 'alias-last': s.aliases.last = t.checked; nameSettingsChanged(); break;
    // the pill editor
    case 'alt-field':
      rmEditPill(t, x => {
        const k = +t.dataset.k, a = x.alts[k];
        x.alts[k] = nameAltOf(t.value, nameAltKase(a), a.pre, a.post);
      });
      break;
    case 'pill-opt':
      rmEditPill(t, (x, tree, path) => {
        if (t.checked) return nameTreeWrap(tree, path);
        // required again: the group around it opens, and it stands where the group stood
        const group = path.slice(0, -1);
        nameTreeUnwrap(tree, group);
        return [...group.slice(0, -1), group[group.length - 1] + path[path.length - 1]];
      });
      break;
    case 'text-input':   // left empty: the text goes
      if (!t.value) rmEditPill(t, (x, tree, path) => { nameTreeRemove(tree, path); return null; });
      break;
    case 'gender': {
      const box = getSelectedRedaction();
      if (!box) break;
      ensureBoxNameSettings(box).gender[t.dataset.g] = t.checked;
      rmRenderFilterSummary();
      nameSettingsChanged();
      break;
    }
    case 'list-on': {
      const list = nameList(t.dataset.list);
      if (list) { list.on = t.checked; namesChanged(); }
      break;
    }
  }
}

function rmOnInput(e) {
  const t = e.target;
  if (t.dataset?.act === 'ed-pattern') { rmTypePattern(t); return; }
  if (t.dataset?.act === 'text-input') { rmTypeText(t); return; }
  if (t.id === 'ns-starts-with' || t.id === 'ns-ends-with') {
    const box = getSelectedRedaction();
    if (!box) return;
    const s = ensureBoxNameSettings(box);
    const which = t.id === 'ns-starts-with' ? 'startsWith' : 'endsWith';
    s[which] = t.value.trim();
    s[`${which}Auto`] = false;
    rmRenderFilterSummary();
    nameSettingsChangedSoon();
    return;
  }
  if (t === els.nameInput) {
    rmGrow(t);
    clearTimeout(rmUi.timers.try);
    rmUi.timers.try = setTimeout(rmRenderTry, 120);
  }
}

// Drag the panel's edge to make it wider (or, docked at the bottom on a
// narrow screen, taller); a double click goes back to the default size.
function rmWireResize(panel) {
  const grip = panel.querySelector('.rm-resize');
  if (!grip) return;
  grip.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    rmHideInfo();
    const bottom = matchMedia('(max-width: 768px)').matches;
    const start = bottom ? e.clientY : e.clientX;
    const size0 = bottom ? panel.offsetHeight : panel.offsetWidth;
    grip.setPointerCapture(e.pointerId);
    panel.classList.add('is-resizing');
    const move = ev => {
      const size = size0 - ((bottom ? ev.clientY : ev.clientX) - start);
      if (bottom) panel.style.setProperty('--rm-height', `${Math.round(Math.min(Math.max(size, 160), innerHeight * 0.9))}px`);
      else panel.style.setProperty('--rm-width', `${Math.round(Math.min(Math.max(size, 260), Math.min(760, innerWidth * 0.7)))}px`);
    };
    const end = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      panel.classList.remove('is-resizing');
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  });
  grip.addEventListener('dblclick', () => {
    panel.style.removeProperty('--rm-width');
    panel.style.removeProperty('--rm-height');
  });
}

function rmWirePanel() {
  const panel = els.namesPanel;
  const toggle = document.getElementById('toggle-tools');
  // The panel starts open the first time (its toolbar button carries `active`),
  // then as it was left (rmRestorePanel); its tool shows or hides it.
  toggle?.addEventListener('click', () => rmSetPanelOpen(!!panel?.classList.contains('hidden')));
  if (!panel) return;
  panel.addEventListener('click', rmOnClick);
  panel.addEventListener('change', rmOnChange);
  panel.addEventListener('input', rmOnInput);
  panel.addEventListener('pointerdown', rmOnPointerDown);
  // the ℹ card: a mouse over an ℹ, a press anywhere else, the focus leaving
  // it, the body scrolling or the window resizing
  panel.addEventListener('pointerover', rmInfoPointer);
  panel.addEventListener('pointerout', rmInfoPointer);
  document.addEventListener('pointerdown', e => {
    if (rmUi.info.key != null && !e.target.closest?.('.rm-info, #rm-info-card')) rmHideInfo();
  }, true);
  const card = document.getElementById('rm-info-card');
  card?.addEventListener('focusout', e => {
    const to = e.relatedTarget;
    if (to && !card.contains(to) && to !== rmUi.info.anchor) rmHideInfo();
  });
  panel.querySelector('.rm-body')?.addEventListener('scroll', () => { if (rmUi.info.key != null) rmPlaceInfo(); }, { passive: true });
  window.addEventListener('resize', () => { if (rmUi.info.key != null) rmPlaceInfo(); });
  // Escape closes the ℹ card — the ℹ has the focus again — or a pill's
  // controls, and the pill has the focus again
  panel.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (rmUi.info.key != null) {
      const back = e.target.closest?.('#rm-info-card') ? rmUi.info.anchor : null;
      rmHideInfo();
      back?.focus();
      e.stopPropagation();
      return;
    }
    if (rmUi.pill == null || !e.target.closest?.('.rm-editor')) return;
    const p = rmUi.pill;
    rmUi.pill = null;
    rmRenderFormat();
    panel.querySelector(`.rm-pill[data-path="${p}"]`)?.focus();
  });
  // a <details> the panel draws again keeps its open state (toggle does not bubble)
  panel.addEventListener('toggle', e => {
    const key = e.target.dataset?.ui;
    if (key) rmUi[key] = e.target.open;
  }, true);
  els.nameInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); rmAddTypedNames(); }
    else if (e.key === 'Escape' && els.nameInput.value) { els.nameInput.value = ''; rmGrow(els.nameInput); rmRenderTry(); }
  });
  rmWireResize(panel);
}

document.addEventListener('DOMContentLoaded', () => {
  rmWirePanel();
  rmRenderPanel();
  loadNameLists();
});
