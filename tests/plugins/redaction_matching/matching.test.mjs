// matching.test.mjs — the matcher under Node with the viewer's globals
// stubbed: which names fit a bar (pixel tolerance vs the pen-exact lattice a
// refiner can vouch for), the loose fallback, how page-pixel verdicts from an
// optional hypothesis tester rank the list, two bars read as one name, the
// formats (their parts, optional groups and choices, and what the pill
// editor does to them), the lists and filters the names come from, and what
// the ℹ card says of the entries behind a name. Run directly
// (`node tests/plugins/redaction_matching/matching.test.mjs`) or with the
// whole suite (`node --test "tests/**/*.test.mjs"`).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', 'web', 'plugins', 'redaction_matching');   // the plugin's folder
// Skipped when the plugin is not installed (its folder dragged out of Recto), like every plugin's suite.
if (!fs.existsSync(path.join(root, 'api.js'))) { console.log('# skip: redaction_matching is not installed'); process.exit(0); }

// ── Viewer globals (api.js touches these at load) ──────────
globalThis.window = globalThis;
globalThis.document = {
  getElementById: () => null,          // no panel: every render bails out
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  fonts: { ready: Promise.resolve() },
};
globalThis.state = {};
globalThis.els = {};
globalThis.utbState = {
  boxes: [], selectedId: null, editingId: null,
  getBox(id) { return this.boxes.find((b) => b.id === id); },
};
// the bus records its handlers, so a test can announce another document
const hooks = {};
globalThis.PDFHooks = { on(ev, fn) { (hooks[ev] ||= []).push(fn); }, emit(ev, d) { for (const fn of hooks[ev] || []) fn(d); } };
globalThis.GEO = { docScale: () => 100 * 96 / 72, docPxPerPt: () => 96 / 72, docPtToPx: (pt) => pt * 96 / 72 };
// The shaper (text_tool's Shaping.widths): a fixed width per string.
const HB = { Ada: 30.0, Bob: 40.0, 'Cy Dee': 50.0 };
globalThis.assetURL = (p) => p;
globalThis.Shaping = { widths: async (body) => ({ results: body.strings.map((s) => ({ width: HB[s] ?? 0 })) }) };
globalThis.fetch = async () => ({ ok: false, status: 404 });

vm.runInThisContext(fs.readFileSync(path.join(root, 'api.js'), 'utf8'));
for (const fn of ['getBoxMatchInfo', 'getBoxMatches', 'effectiveTolerance', 'scoreMatches', 'shownMatch', 'matchesLetterFilter',
                  'linkFor', 'halfStrings', 'setBoxMatch', 'cycleBoxMatch', 'fitRange', 'parseNamePattern', 'nameFromPattern',
                  'namesOfPattern', 'patternOfNameTree', 'makeNames', 'setNameList', 'calculateWidthsForRedaction']) {
  assert.equal(typeof globalThis[fn], 'function', `${fn} is a global`);
}

const person = (first, last, extra = {}) => ({
  first: [first].flat().filter(Boolean), last: [last].flat().filter(Boolean),
  prefix: null, nickname: null, suffix: null, ...extra,
});
// Fill the lists with no bar on the page, so nothing is measured behind a test's back.
function useNames(people, yours = []) {
  utbState.boxes = [];
  state.hiddenEntries.clear();
  state.customCandidates = [...yours];
  setNameList('people', people);
  setNameList('yours');
}

// A bar whose measured width is 120.5 px, with a candidate pool measured by
// the shaper: two names tie to the font unit, one is 0.8 px off, one is far.
const WIDTHS = { 'Sarah Kellen': 120.4375, 'Justin Nelson': 120.4453, 'Nicki Haskell': 121.32, 'Woody Allen': 117.0 };
const WIDTH_PEOPLE = Object.keys(WIDTHS).map(n => person(...n.split(' ')));
let n = 0;
const bar = (over = {}) => ({
  id: `r${++n}`, type: 'redaction', page: 1, x: 319.5, w: 120.5, y: 0, h: 20, tolerance: 3,
  widths: { ...WIDTHS }, ...over,
});
const exactInfo = (box) => ({ exact: true, source: 'ocr', x: box.x, w: box.w, left: {}, right: {}, remnants: [] });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('pixel tolerance: everything within the field, closest first', () => {
  useNames(WIDTH_PEOPLE);
  const box = bar();
  box.refineInfo = { ...exactInfo(box), exact: false, source: 'embedded', left: { kind: 'word' }, right: { kind: 'word' } };
  const info = getBoxMatchInfo(box);
  assert.deepEqual(info.matches, ['Justin Nelson', 'Sarah Kellen', 'Nicki Haskell']);
  assert.equal(info.tol, 3);
  assert.equal(info.loose, false);
  assert.equal(effectiveTolerance(bar({ tolerance: undefined })), 3, 'default field');
  // With no refiner every edge is the detector's: a name up to the redactor's
  // padding narrower than the bar fits too (Woody Allen, 3.5 px under).
  assert.deepEqual(getBoxMatches(bar()), ['Justin Nelson', 'Sarah Kellen', 'Nicki Haskell', 'Woody Allen']);
});

test('pen-exact bar: the lattice decides, the 0.8 px name is out', () => {
  const box = bar();
  box.refineInfo = exactInfo(box);
  const info = getBoxMatchInfo(box);
  assert.deepEqual(info.matches, ['Justin Nelson', 'Sarah Kellen']);
  assert.equal(info.tol, 0.3);
  assert.equal(info.loose, false);
});

test('a tighter user field still wins over the lattice', () => {
  const box = bar({ tolerance: 0.055 });
  box.refineInfo = exactInfo(box);
  assert.deepEqual(getBoxMatches(box), ['Justin Nelson']);
  assert.equal(effectiveTolerance(box), 0.055);
});

test('a bar moved after refinement is no longer exact', () => {
  const box = bar();
  box.refineInfo = exactInfo(box);
  box.x += 1;
  assert.equal(effectiveTolerance(box), 3);
  assert.equal(getBoxMatches(box).length, 3);
});

test('embedded-derived edges are not exact', () => {
  const box = bar();
  box.refineInfo = { ...exactInfo(box), exact: false, source: 'embedded' };
  assert.equal(effectiveTolerance(box), 3);
});

test('nothing fits the exact width → nearest names within the field, flagged loose', () => {
  const box = bar({ w: 122.0 });
  box.refineInfo = exactInfo(box);
  const info = getBoxMatchInfo(box);
  assert.equal(info.loose, true);
  assert.equal(info.tol, 3);
  assert.deepEqual(info.matches, ['Nicki Haskell', 'Justin Nelson', 'Sarah Kellen']);
});

test('without a hypothesis tester, verdicts stay empty and order is by width', async () => {
  const box = bar();
  await scoreMatches(box);
  assert.equal(box.verdicts, null);
  assert.equal(getBoxMatches(box)[0], 'Justin Nelson');
});

test('page-pixel verdicts rank the list: consistent, no-evidence, contradicted', async () => {
  const box = bar();
  box.refineInfo = exactInfo(box);
  const calls = [];
  globalThis.ocrTestHypothesis = async (b, name) => {
    calls.push(name);
    if (name === 'Sarah Kellen') return { verdict: 'consistent', open: { ink: 40, match: 40, differ: 0 }, unexplained: 0 };
    if (name === 'Justin Nelson') return { verdict: 'contradicted', open: { ink: 40, match: 12, differ: 28 }, unexplained: 3 };
    return null;
  };
  await scoreMatches(box);
  assert.deepEqual(calls.sort(), ['Justin Nelson', 'Nicki Haskell', 'Sarah Kellen'], 'the fits and the near misses are tested, not the far ones');
  assert.deepEqual(getBoxMatches(box), ['Sarah Kellen', 'Justin Nelson'], 'a near miss without a consistent verdict stays out');
  assert.equal(shownMatch(box, getBoxMatches(box)).name, 'Sarah Kellen');
  // The user's own pick still wins while it fits.
  box.matchPick = 'Justin Nelson';
  assert.equal(shownMatch(box, getBoxMatches(box)).name, 'Justin Nelson');
  // A provider that throws is a null verdict, not a broken list.
  globalThis.ocrTestHypothesis = async () => { throw new Error('boom'); };
  await scoreMatches(box);
  assert.deepEqual(box.verdicts, { 'Justin Nelson': null, 'Nicki Haskell': null, 'Sarah Kellen': null });
  assert.equal(getBoxMatches(box).length, 2);
  delete globalThis.ocrTestHypothesis;
});

test('a near miss the page vouches for joins a pen-exact list', async () => {
  const box = bar();
  box.refineInfo = exactInfo(box);
  globalThis.ocrTestHypothesis = async (b, name) => ({ verdict: name === 'Nicki Haskell' ? 'consistent' : name === 'Justin Nelson' ? 'contradicted' : 'no-evidence' });
  await scoreMatches(box);
  const { entries, near, loose } = getBoxMatchInfo(box);
  assert.deepEqual(entries.map(e => e.name), ['Nicki Haskell', 'Sarah Kellen', 'Justin Nelson']);
  assert.equal(entries[0].near, true);
  assert.equal(loose, false);
  assert.deepEqual(near.map(e => e.name), ['Nicki Haskell']);
  // Between two consistent names the pen-exact one leads.
  globalThis.ocrTestHypothesis = async () => ({ verdict: 'consistent' });
  await scoreMatches(box);
  assert.deepEqual(getBoxMatches(box), ['Justin Nelson', 'Sarah Kellen', 'Nicki Haskell']);
  delete globalThis.ocrTestHypothesis;
});

test('a detector edge admits names narrower than the bar by the redactor\'s padding', () => {
  // "[Bledsoe] [is a]": the right edge is the black box's, 4.4 px past the name.
  useNames([person(null, 'Bledsoe'), person(null, 'Wide'), person(null, 'Far')]);
  const box = bar({ w: 55.84, widths: { Bledsoe: 51.4, Wide: 59.5, Far: 48.0 } });
  box.refineInfo = { ...exactInfo(box), exact: false, left: { kind: 'punct' }, right: null };
  const r = fitRange(box);
  assert.equal(r.over, 3);
  assert.ok(Math.abs(r.under - 0.4 * 16) < 1e-9, `under = 0.4 em: ${r.under}`);
  assert.equal(fitRange({ ...box, sizePt: 72 }).under, 10, 'the padding is capped — a 72 pt bar does not get 38 px');
  assert.deepEqual(getBoxMatches(box), ['Bledsoe']);
  // With reader pens on both sides the range is the tolerance both ways.
  box.refineInfo.right = { kind: 'word' };
  assert.deepEqual(fitRange(box), { over: 3, under: 3 });
  assert.deepEqual(getBoxMatches(box), []);
  // No refiner at all: every edge is the detector's.
  delete box.refineInfo;
  assert.deepEqual(getBoxMatches(box), ['Bledsoe']);
});

test('widths come from the page\'s own face when a reader offers them, else from HarfBuzz', async () => {
  useNames([person(null, 'Ada'), person(null, 'Bob'), person('Cy', 'Dee')]);
  const mk = () => {
    const box = bar({ widths: {} });
    utbState.boxes = [box];
    return box;
  };
  let box = mk();
  await calculateWidthsForRedaction(box.id);
  assert.deepEqual(box.widths, { Ada: 30.0, Bob: 40.0, 'Cy Dee': 50.0 }, 'HarfBuzz alone');
  assert.equal(box.widthFace, null);
  // A reader's set measures the row's face: it wins where it can draw the
  // string; a string with a glyph the set lacks keeps the HarfBuzz width.
  const asked = [];
  globalThis.ocrMeasureWidths = async (b, strings) => { asked.push(strings); return { widths: strings.map(s => s === 'Bob' ? null : HB[s] + 0.5), face: 'calibri102' }; };
  box = mk();
  await calculateWidthsForRedaction(box.id);
  assert.deepEqual(asked, [['Ada', 'Bob', 'Cy Dee']]);
  assert.deepEqual(box.widths, { Ada: 30.5, Bob: 40.0, 'Cy Dee': 50.5 });
  assert.equal(box.widthFace, 'calibri102');
  // No reader row → null → HarfBuzz stands. A throwing provider too.
  globalThis.ocrMeasureWidths = async () => null;
  box = mk();
  await calculateWidthsForRedaction(box.id);
  assert.deepEqual(box.widths, { Ada: 30.0, Bob: 40.0, 'Cy Dee': 50.0 });
  globalThis.ocrMeasureWidths = async () => { throw new Error('boom'); };
  box = mk();
  await calculateWidthsForRedaction(box.id);
  assert.equal(box.widths.Ada, 30.0);
  delete globalThis.ocrMeasureWidths;
  utbState.boxes = [];
});

// ── Two bars, one name ─────────────────────────────────────
// Bars carry a refiner's verdict (refineInfo): what stood on each side and
// whether a sibling bar bounded the search there. Widths are set directly,
// as a measurement would leave them.
const PERSONS = [
  person(['Nadia', 'Nada'], 'Marcinkova'),
  person('Sarah', 'Kellen'),
  person('Gregory', 'Bledsoe', { prefix: 'Dr.' }),
];
const info = (over) => ({ source: 'ocr', left: null, right: null, blocked: { left: false, right: false }, remnants: [], exact: false, ...over });
const word = (token) => ({ kind: 'word', token });
const firstOnly = { first: false, last: false };
function pairFixture(kind = 'row') {
  useNames(PERSONS);
  // "[Nadia] [Marcinkova]" a space apart, or "[Nadia]" ending a row and
  // "[Marcinkova]" opening the next.
  const A = bar({ id: 'A', x: 100, w: 40, y: 0, h: 20, widths: { Nadia: 40.1, Sarah: 36.0, Gregory: 52.0, Marcinkova: 76.2 } });
  const B = bar({ id: 'B', widths: { Marcinkova: 76.2, Kellen: 45.0, Bledsoe: 50.0, Nadia: 40.1 } });
  if (kind === 'row') {
    Object.assign(B, { x: 144, w: 76, y: 0, h: 20 });
    A.refineInfo = info({ left: word(','), right: null, blocked: { left: false, right: true } });
    B.refineInfo = info({ left: null, right: word(','), blocked: { left: true, right: false } });
  } else {
    Object.assign(B, { x: 120, w: 76, y: 21, h: 20 });
    A.refineInfo = info({ left: word(','), right: null });
    B.refineInfo = info({ left: null, right: word(',') });
  }
  A.refineInfo.x = A.x; A.refineInfo.w = A.w;
  B.refineInfo.x = B.x; B.refineInfo.w = B.w;
  // The fixture's halves are first[0] / last[0]; the aliases test turns them on.
  A.nameSettings = { ...defaultNameSettings(), aliases: { ...firstOnly } };
  B.nameSettings = { ...defaultNameSettings(), aliases: { ...firstOnly } };
  utbState.boxes.push(A, B);
  return { A, B };
}
const pairKeys = (box) => getBoxMatchInfo(box).entries.filter(e => e.kind === 'pair').map(e => e.key);

test('two bars a space apart are one person: first name on the left bar, last name on the right', () => {
  const { A, B } = pairFixture('row');
  assert.deepEqual(linkFor(A) && { other: linkFor(A).other.id, role: linkFor(A).role, kind: linkFor(A).kind }, { other: 'B', role: 'first', kind: 'row' });
  assert.deepEqual(linkFor(B) && { other: linkFor(B).other.id, role: linkFor(B).role, kind: linkFor(B).kind }, { other: 'A', role: 'last', kind: 'row' });
  // Nadia fits A and Marcinkova fits B — the same person. Sarah fits A too
  // (36.0 vs 40, within 3 px) but no Kellen fits B, and Bledsoe fits B but no
  // Gregory fits A: those never become readings.
  assert.deepEqual(pairKeys(A), ['pair:Nadia|Marcinkova']);
  assert.deepEqual(pairKeys(B), ['pair:Nadia|Marcinkova']);
  const a = getBoxMatchInfo(A).entries[0], b = getBoxMatchInfo(B).entries[0];
  assert.equal(a.name, 'Nadia'); assert.equal(a.partnerName, 'Marcinkova'); assert.equal(a.full, 'Nadia Marcinkova');
  assert.equal(b.name, 'Marcinkova'); assert.equal(b.partnerName, 'Nadia');
  assert.deepEqual(getBoxMatches(A), ['Nadia']);
  assert.deepEqual(getBoxMatches(B), ['Marcinkova']);
  // A single reading that fits B alone ranks after the pair: the pair
  // explains both bars with one person.
  const keep = utbState.boxes; utbState.boxes = [];
  setNameList('people', [...PERSONS, person('Clare', 'Hazell')]);
  utbState.boxes = keep;
  B.widths['Clare Hazell'] = 76.22;
  assert.deepEqual(getBoxMatches(B), ['Marcinkova', 'Clare Hazell']);
  assert.equal(getBoxMatchInfo(B).entries[0].kind, 'pair');
  // The bar's own strings to measure: its half of every person.
  assert.deepEqual(halfStrings(A, linkFor(A)).sort(), ['Clare', 'Gregory', 'Nadia', 'Sarah']);
  assert.deepEqual(halfStrings(B, linkFor(B)).sort(), ['Bledsoe', 'Hazell', 'Kellen', 'Marcinkova']);
});

test('a word between two bars keeps them apart; so does a wide gap', () => {
  const { A, B } = pairFixture('row');
  A.refineInfo.right = word('and');
  assert.equal(linkFor(A), null);
  assert.equal(linkFor(B), null, 'B sees no partner either — A has a word on its side');
  const f = pairFixture('row');
  f.B.x = 100 + 40 + 20;             // 20 px apart at 12 pt — more than a space
  assert.equal(linkFor(f.A), null);
});

test('a name split over a line break: last bar of one row, first bar of the next', () => {
  const { A, B } = pairFixture('line');
  assert.equal(linkFor(A).kind, 'line'); assert.equal(linkFor(A).role, 'first'); assert.equal(linkFor(A).other.id, 'B');
  assert.equal(linkFor(B).kind, 'line'); assert.equal(linkFor(B).role, 'last');
  assert.deepEqual(pairKeys(A), ['pair:Nadia|Marcinkova']);
  assert.equal(getBoxMatchInfo(B).entries[0].name, 'Marcinkova');
  // Not the next row → not linked; a word before B → not linked.
  B.y = 60; assert.equal(linkFor(A), null); B.y = 21;
  B.refineInfo.left = word('the'); assert.equal(linkFor(A), null);
});

test('settings shape the halves: spellings, letter filters, a title, typed names', () => {
  const { A, B } = pairFixture('row');
  A.widths.Nada = 40.0;
  A.nameSettings.aliases.first = true;
  assert.deepEqual(pairKeys(A).sort(), ['pair:Nada|Marcinkova', 'pair:Nadia|Marcinkova']);
  A.nameSettings.aliases.first = false;
  A.nameSettings.startsWith = 'S';   // a remnant on A says the first name starts with S
  assert.deepEqual(pairKeys(A), [], 'Nadia is filtered out; Sarah fits A but Kellen does not fit B');
  A.nameSettings.startsWith = '';
  A.nameSettings.formats = [{ id: 'f1', pattern: '{Title} {First} {Last}', on: true }];
  B.nameSettings.formats = [{ id: 'f1', pattern: '{Title} {First} {Last}', on: true }];
  A.widths['Dr. Gregory'] = 40.0; B.widths.Bledsoe = 76.0;
  assert.deepEqual(pairKeys(A), ['pair:Dr. Gregory|Bledsoe'], 'a title goes with the first half, and only people with one');
  A.nameSettings.formats = [{ id: 'f1', pattern: '{First} {Last}', on: true }];
  B.nameSettings.formats = [{ id: 'f1', pattern: '{First} {Last}', on: true }];
  const keep = utbState.boxes; utbState.boxes = [];
  addCustomNames(['Lex Wexner']);
  utbState.boxes = keep;
  A.widths.Lex = 40.2; B.widths.Wexner = 76.3;
  assert.ok(pairKeys(B).includes('pair:Lex|Wexner'), 'a typed name splits at its last space');
});

test('the halves follow the format: order and case; a comma between the names makes none', () => {
  const { A, B } = pairFixture('row');
  for (const box of [A, B]) box.nameSettings.formats = [{ id: 'f1', pattern: '{LAST} {First}', on: true }];
  A.widths.MARCINKOVA = 40.0; B.widths.Nadia = 76.0;
  assert.deepEqual(pairKeys(A), ['pair:MARCINKOVA|Nadia'], 'the last name in capitals on the first bar');
  assert.deepEqual(halfStrings(A, linkFor(A)).sort(), ['BLEDSOE', 'KELLEN', 'MARCINKOVA']);
  for (const box of [A, B]) box.nameSettings.formats = [{ id: 'f1', pattern: '{Last}, {First}', on: true }];
  assert.deepEqual(pairKeys(A), [], 'the comma would stand on the page between the bars');
  for (const box of [A, B]) box.nameSettings.formats = [{ id: 'f1', pattern: '{First}', on: true }];
  assert.deepEqual(pairKeys(A), [], 'a pair is a whole name');
});

test('picking a pair reading labels both bars; the partner follows a pair pick', () => {
  const { A, B } = pairFixture('row');
  A.widths.Sarah = 40.0; B.widths.Kellen = 76.1;      // a second person fits both bars
  assert.deepEqual(pairKeys(A).sort(), ['pair:Nadia|Marcinkova', 'pair:Sarah|Kellen']);
  setBoxMatch('B', 'pair:Sarah|Kellen');
  assert.equal(B.matchPick, 'pair:Sarah|Kellen');
  assert.equal(A.matchPick, 'pair:Sarah|Kellen', 'one person, both halves');
  assert.equal(shownMatch(A, getBoxMatchInfo(A).entries).name, 'Sarah');
  assert.equal(shownMatch(B, getBoxMatchInfo(B).entries).name, 'Kellen');
  assert.equal(A.labelText, 'Sarah', 'both bars are labelled');
  // Unpinning one bar unpins the pair.
  setBoxMatch('A', null);
  assert.equal(A.matchPick, null); assert.equal(B.matchPick, null);
  // A pick on one bar alone (no pick on the other) still couples them.
  B.matchPick = 'pair:Nadia|Marcinkova';
  assert.equal(shownMatch(A, getBoxMatchInfo(A).entries).name, 'Nadia');
  // Cycling steps through the readings by key.
  A.matchPick = null; B.matchPick = null;
  const first = shownMatch(A, getBoxMatchInfo(A).entries).name;
  cycleBoxMatch(1, 'A');
  assert.notEqual(shownMatch(A, getBoxMatchInfo(A).entries).name, first);
  assert.equal(A.matchPick, B.matchPick);
});

test('a pair is judged on both bars: contradicted anywhere is contradicted', async () => {
  const { A, B } = pairFixture('row');
  A.widths.Sarah = 40.0; B.widths.Kellen = 76.1;
  const tested = [];
  globalThis.ocrTestHypothesis = async (box, name) => {
    tested.push(`${box.id}:${name}`);
    if (box.id === 'A') return { verdict: 'consistent' };
    return { verdict: name === 'Kellen' ? 'contradicted' : 'consistent' };
  };
  await scoreMatches(A);
  await scoreMatches(B);
  assert.deepEqual(tested.sort(), ['A:Nadia', 'A:Sarah', 'B:Kellen', 'B:Marcinkova'], 'each half on its own bar, never the summed name');
  const entries = getBoxMatchInfo(A).entries;
  assert.deepEqual(entries.map(e => e.key), ['pair:Nadia|Marcinkova', 'pair:Sarah|Kellen'], 'the contradicted pair ranks last');
  assert.equal(getBoxMatchInfo(B).entries[0].name, 'Marcinkova');
  delete globalThis.ocrTestHypothesis;
});

test('without a refiner verdict no bar is linked', () => {
  const { A, B } = pairFixture('row');
  delete A.refineInfo;
  assert.equal(linkFor(A), null);
  assert.equal(linkFor(B), null);
  assert.deepEqual(getBoxMatchInfo(B).entries, []);
});

// ── Formats and lists ──────────────────────────────────────

// One spelling of an entry, as nameSpellings makes them.
const spelling = (v) => ({ first: null, middle: null, last: null, prefix: null, suffix: null, nickname: null, email: null, gender: null, ...v });
// What a pattern writes for one spelling: its variants' names, ' / ' between them.
const write = (pattern, v) => namesOfPattern(parseNamePattern(pattern), spelling(v)).join(' / ') || null;
const sarah = { first: 'Sarah', last: 'Kellen' };
const jeffrey = { first: 'Jeffrey', middle: 'E', last: 'Epstein' };

test('a format writes each part as its token is written; a missing name drops out with its separator', () => {
  assert.equal(write('{First} {Last}', sarah), 'Sarah Kellen');
  assert.equal(write('{LAST}, {First}', sarah), 'KELLEN, Sarah');
  assert.equal(write('{F}. {Last}', sarah), 'S. Kellen');
  assert.equal(write('{first}.{last}', sarah), 'sarah.kellen');
  assert.equal(write('{f}{last}', sarah), 'skellen');
  // one name of two (a business, a mononym): the same under every format, never a lone initial
  const club = { last: 'Aspen Club' };
  assert.equal(write('{First} {Last}', club), 'Aspen Club');
  assert.equal(write('{LAST}, {First}', club), 'ASPEN CLUB');
  assert.equal(write('{Last}, {F}.', club), 'Aspen Club');
  assert.equal(write('{First}', club), null);
  assert.equal(write('{F}. {Last}', { first: 'Abby' }), null);
  // a title, suffix or nickname is only written for an entry that has one
  assert.equal(write('{Title} {Last}', sarah), null);
  assert.equal(write('{Title} {Last}', { ...sarah, prefix: 'Ms.' }), 'Ms. Kellen');
  assert.match(parseNamePattern('{First} {Muddle}').error, /Muddle/);
  assert.ok(parseNamePattern('Kellen').error, 'a pattern needs a part');
  assert.equal(nameFormatLabel('{LAST}, {First}'), 'LAST, First');
});

test('the new parts: a middle name, an address and its halves, Mr or Ms by a recorded gender', () => {
  assert.equal(write('{First} {Middle} {Last}', { ...jeffrey, middle: 'Edward' }), 'Jeffrey Edward Epstein');
  assert.equal(write('{F}. {M}. {Last}', jeffrey), 'J. E. Epstein');
  assert.equal(write('{First} {M}. {Last}', sarah), null, 'no middle name, nothing written');
  const mail = { ...jeffrey, email: 'jeevacation@gmail.com' };
  assert.equal(write('{Email}', mail), 'jeevacation@gmail.com');
  assert.equal(write('{User}', mail), 'jeevacation');
  assert.equal(write('{first}.{last}@{Domain}', mail), 'jeffrey.epstein@gmail.com');
  assert.equal(write('{EMAIL}', mail), 'JEEVACATION@GMAIL.COM');
  assert.equal(write('{Email}', jeffrey), null);
  assert.equal(write('{Mr|Ms}. {Last}', { ...jeffrey, gender: 'm' }), 'Mr. Epstein');
  assert.equal(write('{Mr|Ms}. {Last}', { ...sarah, gender: 'f' }), 'Ms. Kellen');
  assert.equal(write('{Mr|Ms}. {Last}', sarah), null, 'no gender recorded, no Mr or Ms');
  assert.equal(write('{MRS} {LAST}', { ...sarah, gender: 'f' }), 'MRS KELLEN');
});

test('optional groups and choices spell one pattern out into several', () => {
  assert.equal(parseNamePattern('{First}[ {M}.] {Last}').variants.length, 2);
  assert.equal(write('{First}[ {M}.] {Last}', jeffrey), 'Jeffrey Epstein / Jeffrey E. Epstein');
  assert.equal(write('{First}[ {M}.] {Last}', sarah), 'Sarah Kellen', 'the variant without the middle name writes everyone else');
  assert.equal(write('[{Title} ]{First} {Last}', { ...sarah, prefix: 'Ms.' }), 'Sarah Kellen / Ms. Sarah Kellen');
  assert.equal(write('{First|Nick} {Last}', { ...sarah, nickname: 'Sissy' }), 'Sarah Kellen / Sissy Kellen');
  assert.equal(write('{First|F.} {Last}', sarah), 'Sarah Kellen / S. Kellen', 'a choice carries its own text');
  assert.equal(write('{F}[.] {Last}', sarah), 'S Kellen / S. Kellen', 'text alone can be optional');
  assert.equal(parseNamePattern('{First}[ {M}.[ ({Nick})]] {Last}').variants.length, 3, 'groups nest');
  assert.equal(parseNamePattern('{First|First} {Last}').variants.length, 1, 'the same variant twice is one');
  assert.equal(write('{Last} \\[{First}\\]', sarah), 'Kellen [Sarah]', 'a \\ writes a sign as it stands');
  for (const [pattern, error] of [
    ['{First} [{Last}', /\[/], ['{First}] {Last}', /\]/], ['{First {Last}', /\{/], ['{First} {Last}}', /\}/],
    ['{First|}', /no part/], ['{First}|{Last}', /\|/], ['{Frist} {Last}', /Frist/], ['{Last}\\', /\\/],
    ['{First|Nick|F}{Last|L}[a][b][c][d]', /96 variants/],
  ]) assert.match(parseNamePattern(pattern).error || '', error, pattern);
  assert.ok(parseNamePattern('{First|Nick|F}{Last|L}[a][b][c][d]').tree, 'too many variants is still a tree the pills can show');
});

test('the pills write a pattern back as it was', () => {
  for (const p of [...NAME_FORMAT_PRESETS, '{Last} \\[{First}\\]', '{First}[ {M}.[ ({Nick})]] {Last}', '{(Nick)|F.} {Last}']) {
    assert.equal(patternOfNameTree(parseNamePattern(p).tree), p);
  }
  assert.equal(patternOfNameTree(parseNamePattern('{ Last }').tree), '{Last}', 'spaces in braces are not kept');
});

test('what the pills do to a tree: optional, required, remove, move, add', () => {
  const edit = (pattern, fn) => {
    const tree = structuredClone(parseNamePattern(pattern).tree);
    const out = fn(tree);
    return [patternOfNameTree(tree), out];
  };
  // optional: a part with the text before it and the full stop clinging to it — first in its run, the text after it
  assert.deepEqual(edit('{First} {M}. {Last}', t => nameTreeWrap(t, [2])), ['{First}[ {M}.] {Last}', [1, 1]]);
  assert.deepEqual(edit('{Title} {First} {Last}', t => nameTreeWrap(t, [0])), ['[{Title} ]{First} {Last}', [0, 0]]);
  assert.deepEqual(edit('{First} {Last}, {Suffix}', t => nameTreeWrap(t, [4]))[0], '{First} {Last}[, {Suffix}]');
  assert.deepEqual(edit('{F}. {Last}', t => nameTreeWrap(t, [1]))[0], '{F}[. ]{Last}', 'text alone');
  assert.deepEqual(edit('{First}[ {M}.] {Last}', t => nameTreeUnwrap(t, [1]))[0], '{First} {M}. {Last}');
  // remove: a part goes with the text after it, or — last — the text before it; an emptied group goes
  assert.equal(edit('{First} {M}. {Last}', t => nameTreeRemove(t, [2]))[0], '{First} {Last}');
  assert.equal(edit('{Last}, {First}', t => nameTreeRemove(t, [2]))[0], '{Last}');
  assert.equal(edit('{Title} {First} {Last}', t => nameTreeRemove(t, [0]))[0], '{First} {Last}');
  assert.equal(edit('{First}[ {M}.] {Last}', t => nameTreeRemove(t, [1, 1]))[0], '{First} {Last}');
  // a part steps over text to the next part; text steps one place; a drag moves one node
  assert.deepEqual(edit('{Last}, {First}', t => nameTreeStep(t, [2], -1)), ['{First}, {Last}', [0]]);
  assert.deepEqual(edit('{First} {Last}', t => nameTreeStep(t, [1], 1)), ['{First}{Last} ', [2]]);
  assert.deepEqual(edit('{First} {Last}', t => nameTreeStep(t, [0], -1)), ['{First} {Last}', [0]], 'nowhere to go');
  assert.equal(edit('{First} {Last}', t => nameTreeMove(t, 2, 0))[0], '{Last}{First} ');
  // the palette: where a part usually goes, optional when only some entries have it
  assert.deepEqual(edit('{First} {Last}', t => nameTreeAdd(t, 'middleInitial')), ['{First}[ {M.}] {Last}', [1, 1]]);
  assert.equal(edit('{First} {Last}', t => nameTreeAdd(t, 'prefix'))[0], '[{Title} ]{First} {Last}');
  assert.equal(edit('{First} {Last}', t => nameTreeAdd(t, 'mr|ms'))[0], '[{Mr|Ms} ]{First} {Last}');
  assert.equal(edit('{First} {Last}', t => nameTreeAdd(t, 'suffix'))[0], '{First} {Last}[ {Suffix}]');
  assert.equal(edit('', t => nameTreeAdd(t, 'email'))[0], '{Email}', 'alone, nothing to be optional beside');
  assert.equal(edit('{First} {Last}', t => nameTreeAdd(t, 'last', 0))[0], '{Last} {First} {Last}', 'dropped where it was dropped');
  assert.deepEqual(edit('{First}', t => nameTreeAdd(t, 'text')), ['{First} ', [1]]);
  // a choice's word, and what "or" offers next
  assert.equal(nameAltOf('firstInitial', 'lower').word, 'f');
  assert.equal(nameAltOf('last', 'upper').word, 'LAST');
  assert.equal(nameAltKase(nameAltOf('firstInitial', 'upper')), 'as', 'a capital initial is as written');
  assert.equal(nameAltNext({ alts: [nameAltOf('first')] }), 'nickname');
  assert.equal(nameAltNext({ alts: [nameAltOf('mr'), nameAltOf('ms')] }), 'mrs');
});

test('the default format makes the same names from names.json as the old Full name did', () => {
  const people = JSON.parse(fs.readFileSync(path.join(root, 'names.json'), 'utf8'));
  useNames(people);
  const old = new Set();
  for (const p of people) {
    if (p.first.length && p.last.length) for (const f of p.first) for (const l of p.last) old.add(`${f} ${l}`);
    else for (const s of p.first.length ? p.first : p.last) old.add(s);
  }
  const made = new Set(makeNames(defaultNameSettings()).keys());
  assert.equal(made.size, old.size);
  assert.deepEqual([...made].filter(s => !old.has(s)), []);
});

test('lists: businesses are off until switched on; headings and plain strings; typed names; the hidden', () => {
  assert.equal(nameList('businesses').on, false);
  assert.equal(nameEntry({ first: [], last: ['BRAZIL'], note: 'section heading' }), null);
  assert.deepEqual(nameEntry('jeevacation@gmail.com'), { text: 'jeevacation@gmail.com' }, 'a plain string is written as it stands');
  assert.deepEqual(typedNameEntry('Ghislaine de Rothschild').last, ['Rothschild']);
  assert.deepEqual(typedNameEntry('Ghislaine').last, ['Ghislaine']);
  assert.equal(typedNameEntry('a@b.org').text, 'a@b.org');
  useNames([person('Sarah', 'Kellen'), 'x@y.org']);
  const s = { ...defaultNameSettings(), formats: [{ id: 'f1', pattern: '{LAST}, {First}', on: true }] };
  assert.deepEqual([...makeNames(s).keys()], ['KELLEN, Sarah', 'x@y.org']);
  state.hiddenEntries.add('people:0');
  assert.deepEqual([...makeNames(s).keys()], ['x@y.org']);
});

test('entries: a middle name, addresses and a gender are read; a spelling that writes the middle name is not given it again', () => {
  const e = nameEntry({ first: ['Jeffrey', 'Jeffrey E.'], middle: 'E', last: ['Epstein'], gender: 'M', email: 'jeevacation@gmail.com' });
  assert.deepEqual([e.middle, e.gender, e.email], [['E'], 'm', ['jeevacation@gmail.com']]);
  assert.deepEqual(['female', 'Woman', 'male', 'nonbinary', '', null].map(nameGender), ['f', 'f', 'm', 'x', null, null]);
  assert.ok(nameEntry({ first: [], last: [], email: ['a@b.org'] }), 'an address alone is an entry');
  useNames([person(['Jeffrey', 'Jeffrey E.'], 'Epstein', { middle: 'E' })]);
  const names = (...patterns) => [...makeNames({ ...defaultNameSettings(), formats: patterns.map((pattern, i) => ({ id: `f${i}`, pattern, on: true })) }).keys()].sort();
  assert.deepEqual(names('{First} {M}. {Last}'), ['Jeffrey E. Epstein'], 'not "Jeffrey E. E. Epstein"');
  assert.deepEqual(names('{First}[ {M}.] {Last}'), ['Jeffrey E. Epstein', 'Jeffrey Epstein']);
  assert.deepEqual(names('{F}. {M}. {Last}'), ['J. E. Epstein']);
});

test('the gender filter: women, men, and those with none recorded', () => {
  useNames([person('Sarah', 'Kellen', { gender: 'f' }), person('Jeffrey', 'Epstein', { gender: 'm' }), person('Lex', 'Wexner')], ['Ghislaine Maxwell']);
  const names = (gender) => [...makeNames({ ...defaultNameSettings(), gender }).keys()].sort();
  assert.deepEqual(names({ f: true, m: true, x: true }), ['Ghislaine Maxwell', 'Jeffrey Epstein', 'Lex Wexner', 'Sarah Kellen']);
  assert.deepEqual(names({ f: true, m: false, x: false }), ['Sarah Kellen']);
  assert.deepEqual(names({ f: false, m: true, x: true }), ['Ghislaine Maxwell', 'Jeffrey Epstein', 'Lex Wexner'], 'a typed name has no gender recorded');
  assert.equal(matchesGenderFilter({ text: 'a@b.org' }, { gender: { f: true, m: true, x: false } }), false);
  assert.deepEqual(completeNameSettings({ formats: [] }).gender, { f: true, m: true, x: true }, 'old settings let everyone through');
});

test('names.json: every person has the new fields, filled only where the list says', () => {
  const people = JSON.parse(fs.readFileSync(path.join(root, 'names.json'), 'utf8'));
  for (const p of people) assert.ok('middle' in p && 'gender' in p && Array.isArray(p.email), `${p.first[0]} ${p.last[0]}`);
  // a gender from a title that gives one (Mr, Lady, Prince …) on an entry of one person
  const MEN = /^(mr|sir|lord|prince|sultan|sheikh|senor|viscount|baron|earl|duke|marquess)\.?$/i;
  const WOMEN = /^(ms|mrs|miss|lady|princess|viscountess|duchess|baroness)\.?$/i;
  for (const p of people.filter(x => x.gender)) assert.ok((p.gender === 'm' ? MEN : WOMEN).test(p.prefix || ''), `${p.last[0]}: ${p.gender} beside ${p.prefix}`);
  assert.equal(people.find(p => p.last[0] === 'Bamford').gender, null, 'Sir Anthony and Carole Bamford are two people');
  // a middle initial where a spelling of the first name writes it
  for (const p of people.filter(x => x.middle)) assert.ok(p.first.includes(`${p.first[0]} ${p.middle}.`), `${p.first[0]} ${p.last[0]}`);
});

test('the ℹ card: an entry\'s full name, its other spellings, its links', () => {
  const jeffrey = nameEntry({ first: ['Jeffrey', 'Jeffrey E.'], middle: 'E', last: ['Epstein'], links: { 'adress-book': 'p64' } });
  assert.equal(nameEntryFull(jeffrey), 'Jeffrey E. Epstein');
  assert.deepEqual(nameEntryAlso(jeffrey), [], '"Jeffrey E. Epstein" is the full name already');
  assert.equal(nameEntryFull(nameEntry({ first: ['Abdul'], last: ['Alianizi'], prefix: 'Dr' })), 'Dr Abdul Alianizi');
  assert.equal(nameEntryFull(nameEntry({ first: [], last: ['Aspen Club'] })), 'Aspen Club');
  assert.deepEqual(nameEntryAlso(nameEntry({ first: ['David'], last: ['Howell', 'Evans'], nickname: 'The Edge' })), ['David Evans', '“The Edge”']);
  assert.deepEqual(nameEntryAlso(nameEntry({ first: ['Elizabeth', 'Libit'], last: ['Johnson'], nickname: 'Libit' })), ['Libit Johnson'], 'a nickname that is a spelling already');
  assert.deepEqual(nameEntryLinks(jeffrey), [{ kind: 'book', text: 'Address book, page 64', href: `${NAME_ADDRESS_BOOK}#page=64` }]);
  assert.deepEqual(nameEntryLinks(nameEntry({ last: ['X'], links: { 'adress-book': 'back cover' } })), [{ kind: 'book', text: 'Address book, back cover' }], 'no page: no link');
  // Wikipedia: the link's fragment, or the last name when it is empty; an anchor has no spaces
  const wiki = (last, fragment) => nameEntryLinks(nameEntry({ first: ['A'], last: [last], links: { wiki: fragment } }))[0].href;
  assert.equal(wiki('Dubin', ''), `${NAME_WIKI_LIST}#Dubin`);
  assert.equal(wiki('Andersson', 'Andersson-Dubin'), `${NAME_WIKI_LIST}#Andersson-Dubin`);
  assert.equal(wiki('Perry Lang', ''), `${NAME_WIKI_LIST}#Perry_Lang`);
  // another key: an http(s) address is a link, anything else text — never a script
  assert.deepEqual(nameEntryLinks(nameEntry({ last: ['X'], links: { site: 'https://example.org/x', bad: 'javascript:alert(1)', 'adress-book': '' } })),
    [{ kind: 'web', text: 'site', href: 'https://example.org/x' }, { kind: 'text', text: 'bad: javascript:alert(1)' }]);
  assert.deepEqual(nameEntry({ last: ['X'], links: ['p1'] }).links, {}, 'links are an object or nothing');
});

test('the ℹ card shows each entry that writes a name, a pair\'s one, and what a list holds as text', () => {
  useNames([
    person(['Abraham', 'Abe'], 'Gosman', { links: { 'adress-book': 'p15' } }),
    person('Abe', 'Gosman', { prefix: 'Mr', gender: 'm', email: ['abe@<b>.org'], links: { 'adress-book': 'p70', wiki: '' } }),
  ]);
  const box = bar({ widths: { 'Abe Gosman': 120.5 } });
  const abe = getBoxMatchInfo(box).entries.find(e => e.name === 'Abe Gosman');
  assert.deepEqual(rmInfoEntries(box, abe).map(x => nameEntryFull(x.entry)), ['Abraham Gosman', 'Mr Abe Gosman']);
  const html = rmInfoHtml(box, abe);
  for (const s of ['Abraham Gosman', 'also Abe Gosman', 'Mr Abe Gosman', '>Man<', '>People<', 'abe@&lt;b&gt;.org',
                   'Address book, page 15', 'Address book, page 70', `href="${NAME_WIKI_LIST}#Gosman" target="_blank" rel="noopener noreferrer"`]) {
    assert.ok(html.includes(s), s);
  }
  assert.ok(!html.includes('abe@<b>'), 'a list\'s text is never markup');
  // more than three entries: the rest are counted
  useNames(Array.from({ length: 5 }, () => person('Abe', 'Gosman')));
  assert.match(rmInfoHtml(box, abe), /and 2 more entries write this name/);
  // a pair reading: the one person whose halves fit the two bars
  const { A } = pairFixture('row');
  const pair = getBoxMatchInfo(A).entries[0];
  assert.deepEqual(rmInfoEntries(A, pair).map(x => nameEntryFull(x.entry)), ['Nadia Marcinkova']);
  assert.match(rmInfoHtml(A, pair), /also Nada Marcinkova/);
});

test('a cut-off e-mail address is written by no format, and the ℹ card marks it', () => {
  const e = nameEntry({ first: ['James'], last: ['Cayne'], email: ['jcayne@', 'jc@bear.com', 'katie@fordmanagement.', 'm@bostonproperti'] });
  assert.deepEqual([e.email, e.emailCut], [['jc@bear.com'], ['jcayne@', 'katie@fordmanagement.', 'm@bostonproperti']]);
  useNames([person('James', 'Cayne', { email: ['jcayne@', 'jc@bear.com'] })]);
  const names = (pattern) => [...makeNames({ ...defaultNameSettings(), formats: [{ id: 'f', pattern, on: true }] }).keys()];
  assert.deepEqual(names('{Email}'), ['jc@bear.com']);
  assert.deepEqual(names('{Domain}'), ['bear.com']);
  const box = bar({ widths: { 'James Cayne': 120.5 } });
  const html = rmInfoHtml(box, getBoxMatchInfo(box).entries[0]);
  assert.match(html, /jcayne@ <span class="rm-info-cut"[^>]*>cut off</);
  assert.ok(!/jc@bear\.com <span class="rm-info-cut"/.test(html));
  const people = JSON.parse(fs.readFileSync(path.join(root, 'names.json'), 'utf8')).map(nameEntry).filter(Boolean);
  assert.ok(people.every(p => p.email.every(a => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(a))), 'names.json: only whole addresses are written');
});

test('the ℹ card says how a reading fits: width against the bar, the page, a near miss, a pair\'s other bar', () => {
  useNames(WIDTH_PEOPLE);
  const box = bar();
  box.verdicts = { 'Sarah Kellen': { verdict: 'consistent' } };
  const info = getBoxMatchInfo(box);
  const sarah = info.entries.find(e => e.name === 'Sarah Kellen');
  const html = rmInfoHtml(box, sarah, info.loose);
  assert.match(html, /120\.44 px, <b>−0\.06<\/b> against the bar/);
  assert.match(html, /Page: consistent/);
  assert.match(rmInfoHtml(box, { ...sarah, near: true }), /Outside the pen lattice/);
  assert.doesNotMatch(rmInfoHtml(box, { ...sarah, near: true }, true), /Outside the pen lattice/, 'not on a loose list: there all are near');
  const { A } = pairFixture('row');
  assert.match(rmInfoHtml(A, getBoxMatchInfo(A).entries[0]), /One name over two bars: Nadia Marcinkova<\/div><div>The bar to the right holds Marcinkova/);
  box.verdicts = null;
});

test('the lists\' links: an address-book page is a page, a Wikipedia link a section of the list', () => {
  const read = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')).map(nameEntry).filter(Boolean);
  const links = [...read('names.json'), ...read('contacts-businesses.json')].flatMap(nameEntryLinks);
  assert.ok(links.some(l => l.kind === 'book') && links.some(l => l.kind === 'wiki'));
  for (const l of links) {
    if (l.kind === 'book') assert.match(`${l.text} ${l.href}`, /^Address book, page (\d+) https:\/\/\S+\.pdf#page=\1$/);
    if (l.kind === 'wiki') assert.match(l.href, /^https:\/\/en\.wikipedia\.org\/wiki\/List_of_people_named_in_the_Epstein_files#[^#\s]+$/);
  }
});

test('two bars: the halves of a middle initial, a choice of parts; a pair needs both bars\' gender filters', () => {
  const { A, B } = pairFixture('row');
  const keep = utbState.boxes; utbState.boxes = [];
  setNameList('people', [...PERSONS, person('Jeffrey', 'Epstein', { middle: 'E', gender: 'm', nickname: 'Jeff' })]);
  utbState.boxes = keep;
  for (const box of [A, B]) box.nameSettings.formats = [{ id: 'f1', pattern: '{First|Nick}[ {M}.] {Last}', on: true }];
  A.widths['Jeffrey E.'] = 40.0; A.widths.Jeff = 39.0; B.widths.Epstein = 76.0;
  // "Jeffrey E." (the middle initial goes with the first half) and "Jeff" (the nickname) fit A
  assert.deepEqual(pairKeys(A).sort(), ['pair:Jeffrey E.|Epstein', 'pair:Jeff|Epstein', 'pair:Nadia|Marcinkova']);
  A.nameSettings.gender = { f: true, m: false, x: true };
  assert.deepEqual(pairKeys(A), ['pair:Nadia|Marcinkova'], 'a man on one bar\'s filter is no pair, whatever the other bar lets through');
  const halves = p => nameVariantHalves(parseNamePattern(p).variants[0])?.map(h => nameFromPattern(h, spelling(sarah)));
  assert.deepEqual(halves('{F}. {Last}'), ['S.', 'Kellen'], 'an initial\'s full stop goes with it');
  assert.equal(halves('{Title}. {Last}'), undefined, 'a title is no name of its own');
});

test('each bar has its own settings, copied from the defaults; Apply to all bars copies one bar\'s', () => {
  useNames(WIDTH_PEOPLE);
  const A = bar({ id: 'pA' }), B = bar({ id: 'pB' });
  utbState.boxes.push(A, B);
  ensureBoxNameSettings(A).formats[0].pattern = '{LAST}, {First}';
  assert.equal(ensureBoxNameSettings(B).formats[0].pattern, '{First} {Last}', 'B keeps its own');
  assert.ok(getBoxCandidates(A).includes('KELLEN, Sarah'));
  utbState.selectedId = 'pA';
  applyNameFormatToAll();
  utbState.selectedId = null;
  assert.equal(B.nameSettings.formats[0].pattern, '{LAST}, {First}');
  assert.equal(state.nameSettings.formats[0].pattern, '{LAST}, {First}', 'and new bars');
  state.nameSettings = defaultNameSettings();
  utbState.boxes = [];
});

test('every spelling counts by default', () => {
  assert.deepEqual(defaultNameSettings().aliases, { first: true, last: true });
});

test('starts-with / ends-with filter takes several letters, case-insensitive', () => {
  assert.equal(matchesLetterFilter('Sarah Kellen', { startsWith: 'sa', endsWith: 'LLEN' }), true);
  assert.equal(matchesLetterFilter('Sarah Kellen', { startsWith: 'j' }), false);
  assert.equal(matchesLetterFilter('Sarah Kellen', {}), true);
  assert.equal(matchesLetterFilter('', { startsWith: 's' }), false);
});

let failed = 0;
test('a font name from the page cannot leave its CSS string (control characters go)', () => {
  // a PDF's font name /A#0a;background:url(//a.co/x); — a newline ended the
  // quoted family, and the rest became a declaration that fetched a.co
  const css = rmFamily({ fontFamily: 'A\n;background:url(//a.co/x);' });
  assert.ok(!/[\u0000-\u001f\u007f]/.test(css), JSON.stringify(css));
  assert.match(css, /^font-family:&quot;[^"]*&quot;$/);
  assert.equal(css.split('&quot;').length, 3, 'one quoted family, nothing after it');
  assert.equal(rmFamily({ fontFamily: 'Times New Roman' }), 'font-family:&quot;Times New Roman&quot;');
});

test('hiding a two-bar reading hides every entry that writes it (a list may hold a person twice)', () => {
  const { A, B } = pairFixture('row');
  const keep = utbState.boxes; utbState.boxes = [];
  setNameList('people', [...PERSONS, person('Nadia', 'Marcinkova')]);   // names.json holds Nadia Marcinkova three times
  utbState.boxes = keep;
  assert.deepEqual(pairKeys(A), ['pair:Nadia|Marcinkova']);
  assert.equal(getBoxMatchInfo(A).entries[0].origins.length, 2, 'both entries write the reading');
  hideMatch(A.id, 'pair:Nadia|Marcinkova');
  assert.deepEqual(pairKeys(A), [], 'no other entry brings it back');
  assert.deepEqual(pairKeys(B), []);
});

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

test('a name the shaper gave no width fits no bar, and a shaper that fails says so', async () => {
  // the shaper's 0 for a name it could not measure fitted every bar under the redactor's padding
  useNames([person('Aaron', 'Kwok'), person(null, 'Ada')]);
  const box = bar({ w: 5.5, widths: {} });
  utbState.boxes = [box];
  await calculateWidthsForRedaction(box.id);
  assert.deepEqual(box.widths, { Ada: 30.0 }, 'Aaron Kwok has no width, not 0');
  assert.deepEqual(getBoxMatches(box), []);
  assert.equal(box.widthError, null);
  const real = Shaping.widths;
  Shaping.widths = async () => { throw new Error('fonts.json 404'); };
  try { await calculateWidthsForRedaction(box.id); } finally { Shaping.widths = real; }
  assert.deepEqual(box.widths, {});
  assert.equal(box.widthError, 'fonts.json 404', 'the panel says why nothing was compared');
});

test('pasting many names is linear, and a name pasted twice is one', () => {
  useNames([]);
  const names = Array.from({ length: 30000 }, (_, i) => `Name${i} Last${i}`);
  const t0 = performance.now();
  assert.equal(addCustomNames([...names, names[5]]), 30000);
  const ms = performance.now() - t0;
  assert.ok(ms < 3000, `${Math.round(ms)} ms`);   // the search per name took ~8 s here at this size
  assert.equal(addCustomNames(names.slice(0, 10)), 0);
  useNames([]);
});

test('only the newest scoring of a bar writes its verdicts', async () => {
  useNames(WIDTH_PEOPLE);
  const box = bar();
  utbState.boxes = [box];
  let slow = true;
  globalThis.ocrTestHypothesis = async () => { const was = slow; if (was) await tick(30); return { verdict: was ? 'consistent' : 'contradicted' }; };
  try {
    const older = scoreMatches(box);     // the old geometry's scoring, still running …
    await tick(5);
    slow = false;
    await scoreMatches(box);             // … when the bar was judged again
    await older;
  } finally { delete globalThis.ocrTestHypothesis; }
  const v = Object.values(box.verdicts).map(x => x.verdict);
  assert.ok(v.length && v.every(x => x === 'contradicted'), JSON.stringify(v));
});

test('another document stops a measurement still running: the old bar gets no widths and no label', async () => {
  useNames(WIDTH_PEOPLE);
  const box = bar({ widths: undefined, text: 'untouched' });
  utbState.boxes = [box];
  const real = Shaping.widths;
  let release;
  const gate = new Promise(r => { release = r; });
  Shaping.widths = async body => { await gate; return real(body); };
  try {
    const run = calculateWidthsForRedaction(box.id);
    await tick();
    PDFHooks.emit('document:opening', {});
    utbState.boxes = [];                  // the core resets the boxes
    release();
    await run;
  } finally { Shaping.widths = real; }
  assert.equal(box.widths, undefined);
  assert.equal(box.text, 'untouched');
});

test('a bar whose ink runs to the text column\'s edge bounds no narrower name', () => {
  useNames(WIDTH_PEOPLE);
  const margin = right => ({ exact: false, source: 'ocr', left: { kind: 'word' }, right: null, margin: { left: false, right } });
  const box = bar({ w: 140, refineInfo: margin(true) });
  assert.equal(fitRange(box).under, Infinity);
  assert.ok(getBoxMatches(box).includes('Woody Allen'), 'a name 23 px short may end anywhere before the margin');
  assert.ok(!getBoxMatches(bar({ w: 140, refineInfo: margin(false) })).includes('Woody Allen'));
});

test('the space is settled in the bar\'s own face, again when the bar changes, never over the user\'s', async () => {
  const span = { id: 's1', type: 'embedded', lineId: 'L1', fontFamily: 'Verdana', bold: false, italic: false, sizePt: 12,
    baseCharPositions: [{ c: 'a', w: 7 }, { c: ' ', w: 5.625 }, { c: 'b', w: 7 }, { c: ' ', w: 5.625 }] };
  const box = bar({ lineId: 'L1', fontFamily: 'Verdana', bold: true, italic: false, sizePt: 12, kerning: false });
  utbState.boxes = [span, box];
  globalThis.getNaturalSpaceWidth = async q => (q.bold ? 5.469 : 5.625) * q.sizePt / 12;
  try {
    await settleSpaceWidth(box);
    assert.equal(box.spaceWidth, 5.469, 'a bold bar on a regular line: the bold face\'s space');
    box.sizePt = 14;
    await settleSpaceWidth(box);
    assert.ok(Math.abs(box.spaceWidth - 5.469 * 14 / 12) < 1e-9, `${box.spaceWidth}`);
    box.spaceWidth = 9;                   // set by hand
    box.bold = false;
    await settleSpaceWidth(box);
    assert.equal(box.spaceWidth, 9);
    // a justified line: the bar's own space plus what justification added to the line's
    const wide = { ...span, id: 's2', lineId: 'L2', baseCharPositions: [{ c: ' ', w: 8.625 }, { c: ' ', w: 8.625 }] };
    const j = bar({ lineId: 'L2', fontFamily: 'Verdana', bold: true, sizePt: 12, kerning: false });
    utbState.boxes = [wide, j];
    await settleSpaceWidth(j);
    assert.ok(Math.abs(j.spaceWidth - (5.469 + 3)) < 1e-9, `${j.spaceWidth}`);
  } finally { delete globalThis.getNaturalSpaceWidth; }
});

test('a near miss is never written on the page unless pinned; an unjudged label is grey, not green', () => {
  useNames(WIDTH_PEOPLE);
  const box = bar({ w: 123 });                       // nothing within the lattice, three near misses within ±3 px
  box.refineInfo = exactInfo(box);
  utbState.boxes = [box];
  assert.equal(getBoxMatchInfo(box).loose, true);
  labelBar(box);
  assert.equal(box.text, '', 'a loose list writes nothing on the bar');
  box.matchPick = 'Nicki Haskell';
  labelBar(box);
  assert.equal(box.text, 'Nicki Haskell', 'the user pinned it');
  // with a tester on the page, a label it has not judged is grey
  const fit = bar();
  utbState.boxes = [fit];
  globalThis.ocrTestHypothesis = async () => ({ verdict: 'consistent' });
  try {
    labelBar(fit);
    assert.equal(fit.labelColor, UNJUDGED_COLOR);
  } finally { delete globalThis.ocrTestHypothesis; }
  labelBar(fit);
  assert.equal(fit.labelColor, null, 'without a tester: the type\'s colour');
});

test('names a wider tolerance lets in are judged before the bar is labelled with them', async () => {
  useNames([person(null, 'Ada'), person(null, 'Bob'), person('Cy', 'Dee')]);
  const box = bar({ w: 40, tolerance: 0.5, widths: {} });
  utbState.boxes = [box];
  const judged = [];
  globalThis.ocrTestHypothesis = async (b, name) => { judged.push(name); return { verdict: 'consistent' }; };
  try {
    await calculateWidthsForRedaction(box.id);
    assert.deepEqual(judged, ['Bob']);
    box.tolerance = 10.5;                 // the Text panel's field: a relabel only
    updateAllMatchesView(box.id);
    await tick(); await tick();
    assert.deepEqual(judged.sort(), ['Ada', 'Bob', 'Cy Dee']);
    assert.equal(box.verdicts['Cy Dee'].verdict, 'consistent');
  } finally { delete globalThis.ocrTestHypothesis; }
});

test('a substitute face is said, and a name the face cannot draw is not compared', async () => {
  useNames([person(null, 'Ada'), person(null, 'Bob')], ['王小明']);
  const box = bar({ fontFamily: 'Garamond', widths: {} });
  utbState.boxes = [box];
  const real = Shaping.widths;
  Shaping.widths = async body => ({
    results: body.strings.map(s => ({ width: HB[s] ?? 37.34, missing: /[^\x00-\x7f]/.test(s) ? [...s] : [] })),
    face: body.report ? { file: 'times.ttf', family: 'Times New Roman', style: 'regular', substitute: true } : undefined,
  });
  try { await calculateWidthsForRedaction(box.id); } finally { Shaping.widths = real; }
  assert.ok(!('王小明' in box.widths), 'no width from the placeholder glyph');
  assert.equal(box.unshaped, 1);
  assert.equal(rmSubstitute(box), 'Garamond is not installed');
  assert.match(rmBarTitle(box), /measured with HarfBuzz in Times New Roman — Garamond is not installed/);
  box.bold = true; box.fontFamily = 'Times New Roman';
  box.shapedFace = { file: 'times.ttf', family: 'Times New Roman', style: 'regular', substitute: true };
  assert.equal(rmSubstitute(box), 'Times New Roman has no bold face installed');
  box.widthFace = 'times12';              // the page's own face measured: no substitute to speak of
  assert.equal(rmSubstitute(box), null);
});

for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ok   ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${t.name}\n       ${e.message.split('\n').join('\n       ')}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
