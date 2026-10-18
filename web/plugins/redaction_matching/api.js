/* redaction_matching — candidate names against redaction bars, by measured
   width in the bar's own face.

   Which names fit a bar, the reading each bar is labelled with, and the panel
   that lists the selected bar's fits and holds its format, its letter filter
   and the name lists. What fits and why: guide/plugins/redaction-matching/README.md.

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
// URL carries the file's hash). It holds entries { first: [...], last: [...],
// prefix, suffix, nickname, note } — names.json's shape: a person's first
// spelling is their own, the others are aliases — or plain strings, which
// every format writes as they stand (an e-mail address). Adding a list is a
// file and a line here; `on` is whether bars are matched against it from the
// start. The lists are the whole document's; Your names are typed or pasted.
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
// capitals, {last} in lowercase, {Last} as the list spells it; {F} and {L}
// are the initials. {Title}, {Suffix} and {Nick} exist for some entries only,
// and a format that asks for one writes nothing for an entry without it. A
// missing first or last name drops out with the characters before it, so an
// entry with one name — a business, "Abby" — reads the same under every
// format (though never as a lone initial). A bar can have several formats on;
// its names are all of theirs. Each bar has its own; with no bar selected the
// panel edits the formats a new bar starts with.
const NAME_PARTS = {
  first: 'first', last: 'last', f: 'firstInitial', l: 'lastInitial',
  title: 'prefix', prefix: 'prefix', suffix: 'suffix', nick: 'nickname', nickname: 'nickname',
};
const NAME_PART_OPTIONAL = new Set(['prefix', 'suffix', 'nickname']);
const NAME_PART_FIRST = new Set(['first', 'firstInitial']);
const NAME_PART_LAST = new Set(['last', 'lastInitial']);
const DEFAULT_NAME_FORMAT = '{First} {Last}';
const NAME_FORMAT_PRESETS = [
  '{First} {Last}', '{Last} {First}', '{Last}, {First}', '{LAST}, {First}', '{First} {LAST}',
  '{FIRST} {LAST}', '{First}', '{Last}', '{F}. {Last}', '{Last}, {F}.', '{Title} {Last}',
  '{Title} {First} {Last}', '{First} {Last} {Suffix}', '{Nick}', '{first}.{last}', '{f}{last}',
];
// What the format editor offers between the two names — [characters, label,
// in words]; anything else is typed into the pattern.
const NAME_SEPARATORS = [
  [' ', '␣', 'a space'], [', ', ',␣', 'a comma and a space'], [',', ',', 'a comma'],
  ['.', '.', 'a full stop'], ['_', '_', 'an underscore'], ['-', '-', 'a hyphen'], ['', 'none', 'nothing'],
];

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
const rmUi = {
  openFormat: null, patternOpen: false, nearOpen: false, allFits: false,
  measuring: new Set(), trySeq: 0, timers: {},
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

const _namePatterns = new Map();
/** A pattern's parts and the literal text around them — { parts: [{ field,
 *  kase }], lits }, lits[i] standing before parts[i] and the last one after
 *  the last part — or { error } in words. */
function parseNamePattern(pattern) {
  const src = String(pattern ?? '');
  let parsed = _namePatterns.get(src);
  if (parsed) return parsed;
  const parts = [], lits = [];
  let at = 0, error = null;
  for (const m of src.matchAll(/\{([^{}]*)\}/g)) {
    const word = m[1].trim();
    const field = NAME_PARTS[word.toLowerCase()];
    if (!field) { error = word ? `{${word}} is not a part of a name` : '{} names no part'; break; }
    lits.push(src.slice(at, m.index));
    parts.push({ field, kase: namePartCase(word) });
    at = m.index + m[0].length;
  }
  lits.push(src.slice(at));
  if (!error && !parts.length) error = 'Add a part, like {Last}';
  else if (!error && /[{}]/.test(lits.join(''))) error = 'A { or } is missing its partner';
  parsed = error ? { error } : { parts, lits };
  _namePatterns.set(src, parsed);
  return parsed;
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

function namePartValue(part, v) {
  const f = part.field;
  const s = f === 'firstInitial' ? nameInitial(v.first) : f === 'lastInitial' ? nameInitial(v.last) : v[f];
  if (!s) return '';
  return part.kase === 'upper' ? s.toUpperCase() : part.kase === 'lower' ? s.toLowerCase() : s;
}

/** One spelling of an entry — { first, last, prefix, suffix, nickname },
 *  strings or null — written in a parsed pattern; null when the format has
 *  nothing to write for it. */
function nameFromPattern(parsed, v) {
  if (!parsed?.parts) return null;
  const { parts, lits } = parsed;
  const vals = parts.map(p => namePartValue(p, v));
  if (parts.some((p, i) => NAME_PART_OPTIONAL.has(p.field) && !vals[i])) return null;
  const names = parts.map((p, i) => (NAME_PART_FIRST.has(p.field) || NAME_PART_LAST.has(p.field) ? i : -1)).filter(i => i >= 0);
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

/** A format as the panel names it: its pattern without the braces ("LAST, First"). */
function nameFormatLabel(pattern) {
  return String(pattern).replace(/\{([^{}]*)\}/g, '$1').trim() || String(pattern);
}

// ── Formats: the editor's controls ──────────────────────────
// The editor sets the order of the two names, what stands between them, each
// name's case and form, a title and a suffix; patternOfNameControls is the
// one way from controls to a pattern, and a pattern shows in the controls
// when some setting of them makes it — anything else is typed.

function patternOfNameControls(c) {
  const part = (which, { kase, form }) => {
    if (form === 'off') return '';
    const word = form === 'full' ? (which === 'first' ? 'First' : 'Last') : (which === 'first' ? 'F' : 'L');
    const w = kase === 'upper' ? word.toUpperCase() : kase === 'lower' ? word.toLowerCase() : word;
    return `{${w}}${form === 'dot' ? '.' : ''}`;
  };
  const a = part('first', c.first), z = part('last', c.last);
  const names = (c.order === 'lf' ? [z, a] : [a, z]).filter(Boolean).join(c.sep);
  return [c.title ? '{Title}' : '', names, c.suffix ? '{Suffix}' : ''].filter(Boolean).join(' ');
}

let _nameControls = null;
/** The controls that make a pattern, or null for a pattern only typing makes. */
function nameControlsOf(pattern) {
  if (!_nameControls) {
    _nameControls = new Map();
    const kases = ['as', 'upper', 'lower'], forms = ['full', 'initial', 'dot', 'off'];
    for (const order of ['fl', 'lf']) for (const [sep] of NAME_SEPARATORS)
      for (const title of [false, true]) for (const suffix of [false, true])
        for (const fk of kases) for (const ff of forms) for (const lk of kases) for (const lf of forms) {
          if (ff === 'off' && lf === 'off') continue;
          const c = { order, sep, first: { kase: fk, form: ff }, last: { kase: lk, form: lf }, title, suffix };
          const p = patternOfNameControls(c);
          if (!_nameControls.has(p)) _nameControls.set(p, c);
        }
  }
  const c = _nameControls.get(String(pattern).trim());
  return c ? JSON.parse(JSON.stringify(c)) : null;
}

// ── Name settings: one set per bar ──────────────────────────
// A bar's settings (box.nameSettings) — its formats, whether every spelling
// counts, and its letter filter — start as a copy of the template
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
  return s;
}

// A copy of the formats and spellings — not the letter filter, which is the bar's own.
const nameFormatCopy = s => ({ formats: s.formats.map(f => ({ ...f })), aliases: { ...s.aliases } });

/** A bar's settings, a copy of the template's on first use. */
function ensureBoxNameSettings(box) {
  const s = box.nameSettings;
  if (!s || !Array.isArray(s.formats)) {
    box.nameSettings = {
      ...nameFormatCopy(completeNameSettings(state.nameSettings)),
      startsWith: s?.startsWith || '', endsWith: s?.endsWith || '',
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

// ── Name lists: entries ─────────────────────────────────────

/** A list file's entry as the matcher reads it, or null for what is not a name. */
function nameEntry(raw) {
  if (typeof raw === 'string') return raw.trim() ? { text: raw.trim() } : null;
  if (!raw || typeof raw !== 'object') return null;
  // a heading of the book the list was read from ("BRAZIL", "MEDICAL")
  if (/^section heading/i.test(raw.note || '')) return null;
  const spellings = v => (Array.isArray(v) ? v : v ? [v] : []).map(s => String(s).trim()).filter(Boolean);
  const e = {
    first: spellings(raw.first), last: spellings(raw.last),
    prefix: raw.prefix || null, suffix: raw.suffix || null, nickname: raw.nickname || null, note: raw.note || '',
  };
  return e.first.length || e.last.length || e.nickname ? e : null;
}

/** A typed name as an entry: the last word is the last name and the words
 *  before it the first ("Lex Wexner"); one word is a name of its own; an
 *  address with an @ is written as typed. */
function typedNameEntry(s) {
  const t = String(s).trim().replace(/\s+/g, ' ');
  if (!t) return null;
  if (t.includes('@')) return { text: t };
  const m = /^(.+) (\S+)$/.exec(t);
  return { first: m ? [m[1]] : [], last: [m ? m[2] : t], prefix: null, suffix: null, nickname: null, note: '' };
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
  for (const n of names) {
    if (state.customCandidates.includes(n)) continue;
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
  hideNameEntries(e?.kind === 'pair' ? [e.origin] : barNames(box).names.get(key));
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
 *  spelling, or only the first of each. */
function nameSpellings(e, aliases) {
  const firsts = e.first.length ? (aliases.first ? e.first : e.first.slice(0, 1)) : [null];
  const lasts = e.last.length ? (aliases.last ? e.last : e.last.slice(0, 1)) : [null];
  const out = [];
  for (const first of firsts) for (const last of lasts) {
    out.push({ first, last, prefix: e.prefix, suffix: e.suffix, nickname: e.nickname });
  }
  return out;
}

/** Every name the settings make: each enabled list's entries (but the
 *  hidden) in each format that is on, through the letter filter →
 *  Map name → [{ list, index }], the entries that wrote it. */
function makeNames(settings) {
  const s = completeNameSettings(settings);
  const formats = s.formats.filter(f => f.on).map(f => parseNamePattern(f.pattern)).filter(p => p.parts);
  const names = new Map();
  if (!formats.length) return names;
  const add = (name, list, index) => {
    if (!name || !matchesLetterFilter(name, s)) return;
    let who = names.get(name);
    if (!who) names.set(name, who = []);
    if (!who.some(o => o.list === list && o.index === index)) who.push({ list, index });
  };
  for (const list of state.nameLists) {
    if (!list.on) continue;
    list.entries.forEach((e, i) => {
      if (!e || state.hiddenEntries.has(`${list.id}:${i}`)) return;
      if (e.text != null) { add(e.text, list.id, i); return; }
      for (const v of nameSpellings(e, s.aliases)) for (const p of formats) add(nameFromPattern(p, v), list.id, i);
    });
  }
  return names;
}

// A bar's names, made again when its settings or a list change.
const _barNames = new WeakMap();
function barNames(box) {
  const s = ensureBoxNameSettings(box);
  const key = `${state.namesVersion}|${JSON.stringify(s.formats)}|${!!s.aliases.first}${!!s.aliases.last}|${s.startsWith}|${s.endsWith}`;
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

async function calculateAllWidths() {
  for (const box of getRedactionBoxes()) await calculateWidthsForRedaction(box.id, { label: false });
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
async function settleSpaceWidth(box) {
  if (!box.lineId || (box.spaceWidth != null && box.defaultSpaceWidth === false)) return;
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
  let spaceW;
  if (natural != null) {
    const tol = Math.max(JUSTIFY_SPACE_TOL_FLOOR_PX, natural * JUSTIFY_SPACE_TOL_FRAC);
    const real = detected.filter(w => w >= natural - tol);
    const typical = real.length ? _median(real) : natural;
    spaceW = typical > natural + tol ? typical : natural;
  } else {
    spaceW = _median(detected);   // no HarfBuzz reference: the robust raw median
  }
  box.spaceWidth = spaceW;
  box.defaultSpaceWidth = false;
  box.nativeSpaceWidth = natural != null ? natural : _median(detected);
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
// its glyph set cannot draw keeps the HarfBuzz width). → { widths, face }
async function measureNames(box, strings) {
  const widths = {};
  let face = null;
  if (!strings.length) return { widths, face };
  // letter-spacing (rare on redactions) adds a fixed advance between every
  // pair of glyphs; the shaper does not model it, so it is folded in
  const lsPx = box.letterSpacing ? box.letterSpacing * GEO.docPtToPx(box.sizePt) : 0;
  const spaced = (c, w) => (lsPx ? w + lsPx * Math.max(0, caseName(box, c).length - 1) : w);
  // a manual Space W. replaces the font's own space advance between words
  const manualSpace = box.spaceWidth != null && box.defaultSpaceWidth === false;
  try {
    const data = typeof Shaping !== 'undefined' ? await Shaping.widths({
      strings: strings.map(c => caseName(box, c)),   // as the bar writes them
      family: box.fontFamily,
      bold: !!box.bold,
      italic: !!box.italic,
      size: box.sizePt,          // POINTS — the shaper applies the DPI scale
      scale: GEO.docScale(),     // px-per-pt × 100 for this document
      kerning: box.kerning,
      ligatures: false,
      space_width: manualSpace ? box.spaceWidth : null,
    }) : null;
    if (data) strings.forEach((c, i) => { widths[c] = spaced(c, data.results?.[i]?.width ?? 0); });
  } catch (e) {
    console.warn('[redaction_matching] candidate widths failed', e);
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
  return { widths, face };
}

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
  const stale = () => _measureSeq.get(box) !== seq;
  rmUi.measuring.add(box.id);
  try {
    try { await settleSpaceWidth(box); }
    catch (e) { console.warn('[redaction_matching] space width failed', e); }
    if (stale()) return;
    const { key, list } = barNames(box);
    // A bar that forms a name with another (linkFor) also needs its half of
    // every person measured, so the pair readings can be judged bar by bar.
    const link = linkFor(box);
    const strings = [...new Set([...list, ...(link ? halfStrings(box, link) : [])])];
    const { widths, face } = await measureNames(box, strings);
    if (stale()) return;
    box.widths = widths;
    box.widthFace = face;
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
function fitRange(box) {
  const over = effectiveTolerance(box);
  const i = box.refineInfo;
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

// The halves a format writes on two bars: everything before and after the
// space between its first and last name — `{First} {LAST}` puts "Sarah" on
// the first bar and "KELLEN" on the second, `{LAST} {First}` the other way
// round, `{Title} {First} {Last}` "Dr. Gregory" and "Bledsoe". A format
// whose two names are joined by anything else has no halves: the comma of
// `{Last}, {First}` would stand on the page between the bars, and a word
// between two bars keeps them apart.
const _nameHalves = new Map();
function nameFormatHalves(pattern) {
  if (_nameHalves.has(pattern)) return _nameHalves.get(pattern);
  const p = parseNamePattern(pattern);
  let halves = null;
  for (let i = 0; p.parts && i + 1 < p.parts.length; i++) {
    const a = p.parts[i].field, b = p.parts[i + 1].field;
    const across = (NAME_PART_FIRST.has(a) && NAME_PART_LAST.has(b)) || (NAME_PART_LAST.has(a) && NAME_PART_FIRST.has(b));
    if (!across || !/^\s+$/.test(p.lits[i + 1])) continue;
    halves = [
      { parts: p.parts.slice(0, i + 1), lits: [...p.lits.slice(0, i + 1), ''] },
      { parts: p.parts.slice(i + 1), lits: ['', ...p.lits.slice(i + 2)] },
    ];
    break;
  }
  _nameHalves.set(pattern, halves);
  return halves;
}

// Every entry as the two halves the bars could show: under the formats on
// either bar, every spelling either bar asks for, each half through its own
// bar's letter filter. A typed name splits at its last space; an entry
// written as it stands (an address) has no halves.
const _pairPersons = new WeakMap();
function pairPersons(A, B) {
  const key = `${B.id}|${barNames(A).key}|${barNames(B).key}`;
  const hit = _pairPersons.get(A);
  if (hit && hit.key === key) return hit.out;
  const sA = ensureBoxNameSettings(A), sB = ensureBoxNameSettings(B);
  const patterns = [...new Set([...sA.formats, ...sB.formats].filter(f => f.on).map(f => f.pattern))];
  const splits = patterns.map(nameFormatHalves).filter(Boolean);
  const aliases = { first: sA.aliases.first || sB.aliases.first, last: sA.aliases.last || sB.aliases.last };
  const out = [], seen = new Set();
  for (const list of splits.length ? state.nameLists : []) {
    if (!list.on) continue;
    list.entries.forEach((e, i) => {
      if (!e || e.text != null || !e.first.length || !e.last.length || state.hiddenEntries.has(`${list.id}:${i}`)) return;
      for (const v of nameSpellings(e, aliases)) for (const [l, r] of splits) {
        const first = nameFromPattern(l, v), last = nameFromPattern(r, v);
        if (!first || !last || !matchesLetterFilter(first, sA) || !matchesLetterFilter(last, sB)) continue;
        if (seen.has(`${first}|${last}`)) continue;
        seen.add(`${first}|${last}`);
        out.push({ first, last, origin: { list: list.id, index: i } });
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
      origin: p.origin,
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
async function scoreMatches(box) {
  box.verdicts = null;
  if (typeof ocrTestHypothesis !== 'function') return;
  const { entries, near } = getBoxMatchInfo(box);
  const verdicts = {};
  for (const name of new Set([...entries, ...near].map(e => e.name))) {
    try { verdicts[name] = await ocrTestHypothesis(box, name); }
    catch (e) { console.warn('[redaction_matching] hypothesis test failed for', name, e); verdicts[name] = null; }
  }
  box.verdicts = verdicts;
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

/** Label a bar with its shown reading, as the bar writes it, in the colour of
 *  its verdict, on the edge the refiner knows exactly: a name that ends at a
 *  comma or a word's pen but starts somewhere after a tab stop is drawn
 *  ending at the bar's right edge (text_tool's labelAlign). */
function labelBar(box) {
  const { entries } = getBoxMatchInfo(box);
  const { name: shown, index } = shownMatch(box, entries);
  const label = shown ? caseName(box, shown) : '';
  box.text = label;
  box.labelText = label;
  const v = index >= 0 && entries[index] ? entryVerdict(box, entries[index]) : null;
  box.labelColor = (v && VERDICT_COLOR[v]) || null;
  const ri = box.refineInfo;
  const pen = s => !!s && s.kind !== 'ink' && s.kind !== 'margin';
  box.labelAlign = ri && pen(ri.right) && !pen(ri.left) ? 'right' : 'left';
  if (typeof renderBox === 'function') renderBox(box);
}

/** Relabel every bar — or one, and the bar it forms a name with — and redraw
 *  the selected bar's fits. Recto calls this after a bar moves, resizes, or
 *  comes back from undo. */
function updateAllMatchesView(onlyId = null) {
  for (const box of getRedactionBoxes()) {
    if (onlyId !== null && onlyId !== box.id) continue;
    labelBar(box);
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
  labelBar(box);
  rmRenderPanel();
}

function handleManualAddBox(pageNum, pxX, pxY) {
  const nearestLine = typeof utbFindNearestLine === 'function' ? utbFindNearestLine(pageNum, pxY, 2.0) : null;
  const finalY = nearestLine ? nearestLine.y : pxY;
  const finalH = nearestLine ? nearestLine.h : 20;
  createNewRedaction(pageNum, pxX - 50, finalY, 100, finalH, nearestLine?.lineId ?? null, nearestLine?.font, nearestLine?.sizePt);
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
    nameSettings: { ...nameFormatCopy(completeNameSettings(state.nameSettings)), startsWith: '', endsWith: '' },
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
  rmRenderFormat();
  rmRenderFilter();
}

const rmIcon = (name, cls = '') => `<span class="material-symbols-outlined${cls ? ` ${cls}` : ''}" aria-hidden="true">${name}</span>`;
const rmFamily = box => `font-family:&quot;${escAttr(String(box.fontFamily || 'inherit').replace(/["\\]/g, ''))}&quot;`;

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
    box.widthFace ? `measured in the page's own face (${box.widthFace})` : 'measured with HarfBuzz',
  ].join(' · ');
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
  if (range.under > range.over) why.push(`A name may be up to ${+range.under.toFixed(1)} px narrower: an edge is the detector's, and a redactor draws the box with room to spare.`);
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

// Where a reading's name came from, for its tooltip and tag.
function rmOrigin(box, e) {
  const o = e.kind === 'pair' ? e.origin : barNames(box).names.get(e.name)?.[0];
  if (!o) return null;
  const list = nameList(o.list);
  return { list, entry: list?.entries[o.index] || null };
}

function rmFitTitle(box, e, loose) {
  const w = box.widths?.[e.name];
  const width = w != null ? `${w.toFixed(2)} px, ${rmSigned(w - box.w)} against the bar` : '';
  const verdict = rmVerdictText(box, e.name);
  const origin = rmOrigin(box, e);
  const from = origin?.list ? ` · from ${origin.list.label}${origin.entry?.note ? ` (${origin.entry.note})` : ''}` : '';
  if (e.kind !== 'pair') {
    const nearNote = e.near && !loose ? ' · outside the pen lattice, kept because the page does not contradict it' : '';
    return `${[verdict, width].filter(Boolean).join(' · ')}${nearNote}${from}`;
  }
  const other = utbState.getBox(e.partnerId);
  const where = e.link === 'row'
    ? (e.name === e.first ? 'the bar to the right' : 'the bar to the left')
    : (e.name === e.first ? 'the first bar of the next line' : 'the last bar of the line before');
  const ov = other ? rmVerdictText(other, e.partnerName) : '';
  return `${e.full} — one name over two bars. This bar: ${e.name} (${verdict || width}); ${where}: ${e.partnerName}${ov ? ` (${ov})` : ''}${from}`;
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
  return `<li class="${cls}" data-key="${escAttr(e.key)}" title="${escAttr(rmFitTitle(box, e, loose))}">
      <span class="rm-mark">${v ? VERDICT_MARK[v] : ''}</span>
      <span class="rm-fit-name" style="${rmFamily(box)}">${shownName}</span>
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
    return;
  }
  const { entries, near, tol, loose, link } = getBoxMatchInfo(box);
  const { index } = shownMatch(box, entries);
  const names = barNames(box);
  const head = `<div class="rm-bar-head">
      <span class="rm-bar-w" title="${escAttr(rmBarTitle(box))}">${box.w.toFixed(2)} px</span>
      ${rmTolChip(box)}
      ${box.uppercase ? `<span class="rm-chip is-warn" title="Settings → Letter case applies on top of the format. Set it to “As typed” to let the format decide.">${RM_CASE_CHIP[caseValue(box.uppercase)] || 'Letter case'}</span>` : ''}
      ${entries.length > 1 ? `<span class="rm-bar-n" title="Several names can share one width. Click one to show it on the bar, or press [ / ] with the bar selected.">${entries.length} ${loose ? 'near' : 'fit'}</span>` : ''}
    </div>`;
  const linkNote = link ? `<p class="rm-note rm-link">${rmIcon(link.kind === 'row' ? 'swap_horiz' : 'keyboard_return')}${LINK_NOTE[`${link.kind}-${link.role}`]}</p>` : '';

  let body;
  if (!names.list.length && !(link && pairReadings(box, link).length)) {
    body = '<p class="rm-note">No names to compare. Turn on a list under Names, or a format under Format.</p>';
  } else if (_measuredKey.get(box) !== names.key && (_measuredKey.has(box) || rmUi.measuring.has(box.id))) {
    // its names changed since the widths were taken: they are on their way
    if (!rmUi.measuring.has(box.id)) rmMeasureSoon(box.id);
    body = '<p class="rm-note">Measuring…</p>';
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
  host.innerHTML = `${head}${linkNote}${body}${nearHtml}`;
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

// ── The panel: format ───────────────────────────────────────

// A format's example: the first person of the enabled lists it can write
// (the same one every time, so formats compare at a glance).
function rmSampleName(parsed) {
  for (const list of state.nameLists) {
    if (!list.on) continue;
    for (const e of list.entries) {
      if (!e?.first?.length || !e.last.length) continue;
      const s = nameFromPattern(parsed, nameSpellings(e, { first: false, last: false })[0]);
      if (s) return s;
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

const RM_KASES = [['as', 'As written'], ['upper', 'UPPER'], ['lower', 'lower']];
const RM_FORMS = [['full', 'Full'], ['initial', 'Initial'], ['dot', 'Initial.'], ['off', 'Leave out']];

function rmFormatControls(f) {
  const c = nameControlsOf(f.pattern);
  if (!c) return '<p class="rm-note rm-ed">This pattern is typed — change it below.</p>';
  const one = c.first.form === 'off' || c.last.form === 'off';
  // order and separator mean nothing while one name is left out
  const seg = (act, v, label, on, title = '') => `<button type="button" class="rm-seg-btn${on ? ' on' : ''}" data-act="${act}" data-v="${escAttr(v)}" aria-pressed="${on}"${title ? ` title="${escAttr(title)}"` : ''}${one ? ' disabled' : ''}>${escAttr(label)}</button>`;
  const select = (act, value, options, label) => `<select class="rm-select" data-act="${act}" aria-label="${escAttr(label)}">${options.map(([v, l]) => `<option value="${v}"${v === value ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  return `<div class="rm-ed">
      <span class="rm-ed-l">Order</span>
      <span class="rm-seg">${seg('ed-order', 'fl', 'First Last', c.order === 'fl')}${seg('ed-order', 'lf', 'Last First', c.order === 'lf')}</span>
      <span class="rm-ed-l">Between</span>
      <span class="rm-seg">${NAME_SEPARATORS.map(([v, l, t]) => seg('ed-sep', v, l, c.sep === v, t)).join('')}</span>
      <span class="rm-ed-l">First name</span>
      <span class="rm-ed-pair">${select('ed-first-kase', c.first.kase, RM_KASES, 'First name case')}${select('ed-first-form', c.first.form, RM_FORMS, 'First name form')}</span>
      <span class="rm-ed-l">Last name</span>
      <span class="rm-ed-pair">${select('ed-last-kase', c.last.kase, RM_KASES, 'Last name case')}${select('ed-last-form', c.last.form, RM_FORMS, 'Last name form')}</span>
      <span class="rm-ed-l">Add</span>
      <span class="rm-ed-pair"><label class="rm-check"><input type="checkbox" data-act="ed-title"${c.title ? ' checked' : ''}> Title</label><label class="rm-check"><input type="checkbox" data-act="ed-suffix"${c.suffix ? ' checked' : ''}> Suffix</label></span>
    </div>`;
}

function rmFormatRow(f) {
  const open = rmUi.openFormat === f.id;
  const parsed = parseNamePattern(f.pattern);
  const label = nameFormatLabel(f.pattern);
  const typed = !nameControlsOf(f.pattern);
  return `<li class="rm-format${open ? ' is-open' : ''}${f.on ? '' : ' is-off'}" data-fid="${escAttr(f.id)}">
      <div class="rm-format-row">
        <input type="checkbox" data-act="fmt-on"${f.on ? ' checked' : ''} aria-label="Use ${escAttr(label)}">
        <button type="button" class="rm-format-label" data-act="fmt-edit" aria-expanded="${open}" title="Change this format">${escAttr(label)}${rmIcon(open ? 'expand_less' : 'expand_more')}</button>
        <span class="rm-format-eg">${escAttr(parsed.parts ? rmSampleName(parsed) : '')}</span>
        <button type="button" class="rm-icon-btn" data-act="fmt-remove" title="Remove this format" aria-label="Remove ${escAttr(label)}">${rmIcon('close')}</button>
      </div>
      ${open ? `<div class="rm-editor">
        ${rmFormatControls(f)}
        <details class="rm-pattern"${typed || rmUi.patternOpen ? ' open' : ''} data-ui="patternOpen">
          <summary>Type a pattern</summary>
          <input type="text" class="rm-input rm-mono" data-act="ed-pattern" value="${escAttr(f.pattern)}" spellcheck="false" autocomplete="off" aria-label="Pattern">
          <p class="rm-err" role="alert"></p>
          <p class="rm-hint">Parts: {First} {Last} {F} {L} {Title} {Suffix} {Nick}. A part written in capitals comes out in capitals, in lowercase in lowercase; every other character stands as typed.</p>
        </details>
      </div>` : ''}
    </li>`;
}

/** The Format section: the active settings' formats, one open in the editor. */
function rmRenderFormat() {
  rmRenderFormatSummary();
  const host = document.getElementById('rm-format');
  if (!host) return;
  const box = getSelectedRedaction();
  const s = getActiveNameSettings();
  host.innerHTML = `<div class="rm-scope">
      <span>${box ? 'For this bar' : 'For new bars'}</span>
      <button type="button" class="rm-link-btn" data-act="apply-all" title="Give every bar — and every new one — these formats and spellings">Apply to all bars</button>
    </div>
    <ul class="rm-formats">${s.formats.map(f => rmFormatRow(f)).join('')}</ul>
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
}

const rmFormatOf = el => {
  const fid = el.closest('[data-fid]')?.dataset.fid;
  return getActiveNameSettings().formats.find(f => f.id === fid) || null;
};

// A change in the editor's controls: the format takes the pattern they make.
function rmEditFormat(el, change) {
  const f = rmFormatOf(el);
  const c = f && nameControlsOf(f.pattern);
  if (!c) return;
  change(c);
  if (c.first.form === 'off' && c.last.form === 'off') c[el.dataset.act.startsWith('ed-first') ? 'last' : 'first'].form = 'full';
  f.pattern = patternOfNameControls(c);
  rmRenderFormat();
  nameSettingsChanged();
}

// Typing a pattern: the row follows each keystroke; the editor around the
// field is left alone while it has the focus.
function rmTypePattern(input) {
  const f = rmFormatOf(input);
  const li = input.closest('[data-fid]');
  if (!f || !li) return;
  const parsed = parseNamePattern(input.value);
  const err = li.querySelector('.rm-err');
  if (parsed.error) { if (err) err.textContent = parsed.error; return; }
  if (err) err.textContent = '';
  f.pattern = input.value;
  const label = li.querySelector('.rm-format-label');
  if (label) label.innerHTML = `${escAttr(nameFormatLabel(f.pattern))}${rmIcon('expand_less')}`;
  const eg = li.querySelector('.rm-format-eg');
  if (eg) eg.textContent = rmSampleName(parsed);
  const ed = li.querySelector('.rm-ed');
  if (ed) ed.outerHTML = rmFormatControls(f);
  nameSettingsChangedSoon();
}

function rmNextFormatId(s) {
  const n = Math.max(0, ...s.formats.map(f => parseInt(String(f.id).replace(/\D/g, ''), 10) || 0));
  return `f${n + 1}`;
}

// ── The panel: letter filter ────────────────────────────────

function rmRenderFilterSummary() {
  const sum = document.getElementById('rm-filter-sum');
  if (!sum) return;
  const s = getActiveNameSettings();
  const parts = [];
  if (s.startsWith) parts.push(`starts “${s.startsWith}”${s.startsWithAuto ? ' (seen)' : ''}`);
  if (s.endsWith) parts.push(`ends “${s.endsWith}”${s.endsWithAuto ? ' (seen)' : ''}`);
  sum.textContent = parts.join(' · ') || 'none';
}

/** The Filter section: the selected bar's starts-with / ends-with (a bar's own; hidden with none selected). */
function rmRenderFilter() {
  const box = getSelectedRedaction();
  document.getElementById('rm-filter-sec')?.classList.toggle('hidden', !box);
  if (!box) return;
  const s = ensureBoxNameSettings(box);
  for (const [id, v] of [['ns-starts-with', s.startsWith], ['ns-ends-with', s.endsWith]]) {
    const input = document.getElementById(id);
    if (input && document.activeElement !== input) input.value = v || '';
  }
  rmRenderFilterSummary();
}

// ── The panel: name lists ───────────────────────────────────

const RM_YOURS_SHOWN = 40;

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
    case 'hide': {
      const row = t.closest('.rm-fit');
      if (row && box) hideMatch(box.id, row.dataset.key);
      break;
    }
    case 'apply-all': applyNameFormatToAll(); break;
    case 'fmt-edit': {
      const f = rmFormatOf(t);
      rmUi.openFormat = f && rmUi.openFormat !== f.id ? f.id : null;
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
    case 'ed-order': rmEditFormat(t, c => { c.order = t.dataset.v; }); break;
    case 'ed-sep': rmEditFormat(t, c => { c.sep = t.dataset.v; }); break;
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
      rmRenderFormat();
      nameSettingsChanged();
      break;
    }
    case 'alias-first': s.aliases.first = t.checked; nameSettingsChanged(); break;
    case 'alias-last': s.aliases.last = t.checked; nameSettingsChanged(); break;
    case 'ed-first-kase': rmEditFormat(t, c => { c.first.kase = t.value; }); break;
    case 'ed-first-form': rmEditFormat(t, c => { c.first.form = t.value; }); break;
    case 'ed-last-kase': rmEditFormat(t, c => { c.last.kase = t.value; }); break;
    case 'ed-last-form': rmEditFormat(t, c => { c.last.form = t.value; }); break;
    case 'ed-title': rmEditFormat(t, c => { c.title = t.checked; }); break;
    case 'ed-suffix': rmEditFormat(t, c => { c.suffix = t.checked; }); break;
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
