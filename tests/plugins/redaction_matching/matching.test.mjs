// matching.test.mjs — the matcher's width logic under Node with the viewer's
// globals stubbed: which names fit a bar (pixel tolerance vs the pen-exact
// lattice a refiner can vouch for), the loose fallback, and how page-pixel
// verdicts from an optional hypothesis tester rank the list. Run directly
// (`node tests/plugins/redaction_matching/matching.test.mjs`) or with the
// whole suite (`node --test "tests/**/*.test.mjs"`).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', 'web', 'plugins', 'redaction_matching');   // the plugin's folder

// ── Viewer globals (api.js touches these at load) ──────────
globalThis.window = globalThis;
const stubEl = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, innerHTML: '', textContent: '' });
globalThis.document = {
  getElementById: (id) => (/^(all-matches|match-progress|names-body|page-info|sort-icon)/.test(id) ? stubEl() : null),
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
globalThis.PDFHooks = { on() {}, emit() {} };
globalThis.GEO = { docScale: () => 100 * 96 / 72, docPxPerPt: () => 96 / 72, docPtToPx: (pt) => pt * 96 / 72 };
// The shaper (text_tool's Shaping.widths): a fixed width per string.
const HB = { Ada: 30.0, Bob: 40.0, 'Cy Dee': 50.0 };
globalThis.assetURL = (p) => p;
globalThis.Shaping = { widths: async (body) => ({ results: body.strings.map((s) => ({ width: HB[s] ?? 0 })) }) };
globalThis.fetch = async () => ({ ok: false, status: 404 });

vm.runInThisContext(fs.readFileSync(path.join(root, 'api.js'), 'utf8'));
for (const fn of ['getBoxMatchInfo', 'getBoxMatches', 'effectiveTolerance', 'scoreMatches', 'shownMatch', 'matchesLetterFilter',
                  'linkFor', 'halfStrings', 'setBoxMatch', 'cycleBoxMatch', 'fitRange']) {
  assert.equal(typeof globalThis[fn], 'function', `${fn} is a global`);
}

// A bar whose measured width is 120.5 px, with a candidate pool measured by
// the shaper: two names tie to the font unit, one is 0.8 px off, one is far.
const WIDTHS = { 'Sarah Kellen': 120.4375, 'Justin Nelson': 120.4453, 'Nicki Haskell': 121.32, 'Woody Allen': 117.0 };
let n = 0;
const bar = (over = {}) => ({
  id: `r${++n}`, type: 'redaction', page: 1, x: 319.5, w: 120.5, y: 0, h: 20, tolerance: 3,
  candidates: Object.keys(WIDTHS), widths: { ...WIDTHS }, ...over,
});
const exactInfo = (box) => ({ exact: true, source: 'ocr', x: box.x, w: box.w, left: {}, right: {}, remnants: [] });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('pixel tolerance: everything within the field, closest first', () => {
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

// ── Two bars, one name ─────────────────────────────────────
// Bars carry a refiner's verdict (refineInfo): what stood on each side and
// whether a sibling bar bounded the search there. Widths are set directly,
// as the /widths call would leave them.
const PERSONS = [
  { first: ['Nadia', 'Nada'], last: ['Marcinkova'], prefix: null, nickname: null, suffix: null },
  { first: ['Sarah'], last: ['Kellen'], prefix: null, nickname: null, suffix: null },
  { first: ['Gregory'], last: ['Bledsoe'], prefix: 'Dr.', nickname: null, suffix: null },
];
const info = (over) => ({ source: 'ocr', left: null, right: null, blocked: { left: false, right: false }, remnants: [], exact: false, ...over });
const word = (token) => ({ kind: 'word', token });
function pairFixture(kind = 'row') {
  utbState.boxes = [];
  state.namesData = PERSONS;
  state.customCandidates = [];
  state.excludedPersons = new Set();
  // "[Nadia] [Marcinkova]" a space apart, or "[Nadia]" ending a row and
  // "[Marcinkova]" opening the next.
  const A = bar({ id: 'A', x: 100, w: 40, y: 0, h: 20, candidates: [], widths: { Nadia: 40.1, Sarah: 36.0, Gregory: 52.0, Marcinkova: 76.2 } });
  const B = bar({ id: 'B', candidates: [], widths: { Marcinkova: 76.2, Kellen: 45.0, Bledsoe: 50.0, Nadia: 40.1 } });
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
  // The fixture's halves are first[0] / last[0]; the aliases test turns expansion on.
  A.nameSettings = { ...state.nameSettings, expandFirstAliases: false, expandLastAliases: false };
  B.nameSettings = { ...state.nameSettings, expandFirstAliases: false, expandLastAliases: false };
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
  B.candidates = ['Clare Hazell']; B.widths['Clare Hazell'] = 76.22;
  assert.deepEqual(getBoxMatches(B), ['Marcinkova', 'Clare Hazell']);
  assert.equal(getBoxMatchInfo(B).entries[0].kind, 'pair');
  // The bar's own strings to measure: its half of every person.
  assert.deepEqual(halfStrings(A, linkFor(A)).sort(), ['Gregory', 'Nadia', 'Sarah']);
  assert.deepEqual(halfStrings(B, linkFor(B)).sort(), ['Bledsoe', 'Kellen', 'Marcinkova']);
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

test('settings shape the halves: aliases, prefix, letter filters, custom names', () => {
  const { A, B } = pairFixture('row');
  A.widths.Nada = 40.0;
  A.nameSettings.expandFirstAliases = true;
  assert.deepEqual(pairKeys(A).sort(), ['pair:Nada|Marcinkova', 'pair:Nadia|Marcinkova']);
  A.nameSettings.expandFirstAliases = false;
  A.nameSettings.startsWith = 'S';   // a remnant on A says the first name starts with S
  assert.deepEqual(pairKeys(A), [], 'Nadia is filtered out; Sarah fits A but Kellen does not fit B');
  A.nameSettings.startsWith = '';
  A.nameSettings.includePrefix = true;
  A.widths['Dr. Gregory'] = 40.0; B.widths.Bledsoe = 76.0;
  assert.ok(pairKeys(A).includes('pair:Dr. Gregory|Bledsoe'));
  A.nameSettings.includePrefix = false;
  state.customCandidates = ['Lex Wexner'];
  A.widths.Lex = 40.2; B.widths.Wexner = 76.3;
  assert.ok(pairKeys(B).includes('pair:Lex|Wexner'), 'a custom name splits at its last space');
  A.nameSettings.generateFull = false;
  assert.deepEqual(pairKeys(A), [], 'a pair is a full name — off with Full name');
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
  // A pick on one bar alone (no pick on the other) still couples them.
  A.matchPick = null; B.matchPick = 'pair:Nadia|Marcinkova';
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
  const box = bar({ w: 55.84, candidates: ['Bledsoe', 'Wide', 'Far'], widths: { Bledsoe: 51.4, Wide: 59.5, Far: 48.0 } });
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
  const mk = () => {
    const box = bar({ candidates: ['Ada', 'Bob', 'Cy Dee'], widths: {} });
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

test('every alias is a candidate by default', () => {
  assert.equal(state.nameSettings.expandFirstAliases, true);
  assert.equal(state.nameSettings.expandLastAliases, true);
});

test('starts-with / ends-with filter takes several letters, case-insensitive', () => {
  assert.equal(matchesLetterFilter('Sarah Kellen', { startsWith: 'sa', endsWith: 'LLEN' }), true);
  assert.equal(matchesLetterFilter('Sarah Kellen', { startsWith: 'j' }), false);
  assert.equal(matchesLetterFilter('Sarah Kellen', {}), true);
  assert.equal(matchesLetterFilter('', { startsWith: 's' }), false);
});

let failed = 0;
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
