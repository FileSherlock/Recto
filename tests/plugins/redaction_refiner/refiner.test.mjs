// refiner.test.mjs — the refiner's geometry under Node, with the viewer's
// globals stubbed. Run directly (`node tests/plugins/redaction_refiner/
// refiner.test.mjs`) or with the whole suite (`node --test "tests/**/*.test.mjs"`).
//
// The shaper stub uses Times-Roman advance widths (Times New Roman is
// metric-compatible), so widths match what HarfBuzz reports for the real
// font to within rounding. Fixture rows are real embedded spans of a scanned
// page (fixtures/efta_rows.json) with the bars measured from its raster.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', 'web', 'plugins', 'redaction_refiner');   // the plugin's folder
const PX_PER_PT = 96 / 72;

// Times-Roman AFM advance widths, 1/1000 em.
const AFM = {
  ' ': 250, '.': 250, ',': 250, '(': 333, ')': 333, "'": 333, '-': 333,
  a: 444, b: 500, c: 444, d: 500, e: 444, f: 333, g: 500, h: 500, i: 278, j: 278, k: 500, l: 278, m: 778,
  n: 500, o: 500, p: 500, q: 500, r: 333, s: 389, t: 278, u: 500, v: 500, w: 722, x: 500, y: 500, z: 444,
  A: 722, B: 667, C: 667, D: 722, E: 611, F: 556, G: 722, H: 722, I: 333, J: 389, K: 722, L: 611, M: 889,
  N: 722, O: 722, P: 556, Q: 722, R: 667, S: 556, T: 611, U: 722, V: 722, W: 944, X: 722, Y: 722, Z: 611,
};
const widthPx = (text, sizePt) =>
  [...text].reduce((s, ch) => s + (AFM[ch] ?? 500), 0) / 1000 * sizePt * PX_PER_PT;

// ── Viewer globals ─────────────────────────────────────────
globalThis.window = globalThis;
const hooks = {};
globalThis.PDFHooks = {
  on(ev, fn) { (hooks[ev] ||= []).push(fn); },
  emit(ev, d) { (hooks[ev] || []).forEach((f) => f(d)); },
};
globalThis.GEO = {
  docPxPerPt: () => PX_PER_PT,
  docScale: () => PX_PER_PT * 100,
  docPtToPx: (pt) => pt * PX_PER_PT,
};
globalThis.utbState = {
  boxes: [], selectedId: null, editingId: null,
  getBox(id) { return this.boxes.find((b) => b.id === id); },
};
globalThis.state = { namesData: [], customCandidates: [] };
const rendered = [];
globalThis.renderBox = (b) => rendered.push(b.id);
let widthsRecalcs = 0;
globalThis.calculateAllWidths = () => { widthsRecalcs++; };
globalThis.getNaturalSpaceWidth = async ({ sizePt }) => widthPx(' ', sizePt);
globalThis.assetURL = (p) => p;
globalThis.Shaping = { widths: async (body) => ({ results: body.strings.map((s) => ({ width: widthPx(s, body.size) })) }) };
globalThis.fetch = async (url) => {
  if (String(url).endsWith('words.txt')) {
    const text = fs.readFileSync(path.join(root, 'words.txt'), 'utf8');
    return { ok: true, text: async () => text };
  }
  return { ok: false, status: 404 };
};

vm.runInThisContext(fs.readFileSync(path.join(root, 'redaction-refiner.js'), 'utf8'));
const R = globalThis.RedactionRefiner;
assert.ok(R, 'refiner did not export RedactionRefiner');

const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'efta_rows.json'), 'utf8'));

// ── Box factories ──────────────────────────────────────────
let nextId = 1;
const span = (f) => ({
  id: `s${nextId++}`, type: 'embedded', page: 1, fontFamily: 'Times New Roman', sizePt: 12,
  kerning: false, lineId: null, baseCharPositions: null, text: '', x: 0, y: 0, w: 0, h: 20, ...f,
});
const redaction = (x, x1, y = 0, h = 20) => ({
  id: `r${nextId++}`, type: 'redaction', page: 1, x, w: x1 - x, y, h, lineId: null,
});
// The viewer's etvNormalize snaps a span's size to the document body size (12pt here).
const fromFixture = (s, lineId) =>
  span({ text: s.text, x: s.x, y: s.y, w: s.w, h: s.h, sizePt: 12, lineId, baseCharPositions: s.chars });
// Synthetic per-char positions laid out from the AFM table, starting at x0.
const charsFor = (text, sizePt = 12) => {
  const cps = [];
  let x = 0;
  for (const c of text) { const w = widthPx(c, sizePt); cps.push({ c, x, w }); x += w; }
  return cps;
};
const inkEnd = (s) => {
  const cps = s.baseCharPositions.filter((cp) => cp.c.trim());
  const last = cps[cps.length - 1];
  return s.x + last.x + last.w;
};
const reset = () => { utbState.boxes = []; utbState.selectedId = null; rendered.length = 0; };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a.toFixed(2)} vs ${b.toFixed(2)} (±${tol})`);

const SPACE = widthPx(' ', 12);           // 4.00 px
const HIDDEN_A = widthPx('a', 12);        // 7.10 px
const NAME_W = widthPx('SARAH KELLEN', 12);

// ── Runner ─────────────────────────────────────────────────
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── Dictionary & tokens ────────────────────────────────────
test('dictionary loads and answers membership', async () => {
  const n = await R.loadDictionary();
  assert.ok(n > 10000, `only ${n} words`);
  for (const w of ['including', 'and', 'the', "device's", "devices'", 'well-known', 'A', 'I']) {
    assert.ok(R.isWord(w), `${w} should be a word`);
  }
  for (const w of ['nd', 'Kellen', 'GHISLAINE', 'inclu', 'xq', '']) {
    assert.ok(!R.isWord(w), `${w} should not be a word`);
  }
});

test('completions are frequency-ranked, per side', () => {
  assert.equal(R.completions('nd', 'right')[0], 'and');
  assert.ok(R.completions('inclu', 'left').includes('including'));
  assert.deepEqual(R.completions('maxwell', 'right'), []);
  assert.deepEqual(R.completions("n'd", 'right'), []);          // only letter runs
  assert.equal(R.hiddenPart('and', 'nd', 'right'), 'a');
  assert.equal(R.hiddenPart('and', 'ND', 'right'), 'A');
  assert.equal(R.hiddenPart('including', 'inclu', 'left'), 'ding');
});

test('facing token is the letter run touching the bar', () => {
  assert.equal(R.facingToken('EPSTEIN, including ', 'left'), 'including');
  assert.equal(R.facingToken('nd GHISLAINE MAXWELL. ', 'right'), 'nd');
  assert.equal(R.facingToken('(and', 'right'), '');
  assert.equal(R.facingToken("Kellen's", 'left'), "Kellen's");
  assert.equal(R.caseOf('nd'), 'lower');
  assert.equal(R.caseOf('ND'), 'upper');
  assert.equal(R.caseOf('Smith'), 'title');
  assert.equal(R.caseOf('McA'), 'mixed');
});

test('classifyToken: words, proper nouns, names, fragments', () => {
  assert.equal(R.classifyToken('including', 'left').reason, 'dictionary');
  assert.equal(R.classifyToken('Wexner', 'right').reason, 'proper-noun');
  assert.equal(R.classifyToken('MAXWELL', 'right').reason, 'no-completion');
  assert.equal(R.classifyToken('McA', 'right').reason, 'mixed-case');
  const frag = R.classifyToken('nd', 'right');
  assert.equal(frag.kind, 'fragment');
  assert.equal(frag.words[0], 'and');
  // A surname from the candidate pool is a whole word even if a dictionary
  // word happens to end with it.
  state.namesData = [{ first: ['Sarah'], last: ['Kellen', 'Ford'] }];
  state.customCandidates = [];
  assert.equal(R.classifyToken('KELLEN', 'right').reason, 'name');
  assert.equal(R.classifyToken('ORD', 'right').kind, 'fragment');     // "…ord" → word, record …
  state.namesData = [];
});

// ── Real page: embedded layer only (the "a" of "and" dropped) ──
for (const [rowIdx, label] of [[1, 'item 3'], [0, 'item 2']]) {
  test(`fixture ${label}: fragment "nd" recovers the dropped "a"; bar = SARAH KELLEN`, async () => {
    reset();
    const bar = fixture.bars[rowIdx];
    const spans = fixture.spans.filter((s) => s.text.includes('including') || s.text.startsWith('nd '));
    // Rows pair by y: the fixture holds the two rows' spans; pick this row's.
    const ys = [...new Set(spans.map((s) => s.y))].sort((a, b) => a - b);
    const y = ys[rowIdx];
    const row = spans.filter((s) => s.y === y).map((s) => fromFixture(s, `L${rowIdx}`));
    const left = row.find((s) => s.text.includes('including'));
    const right = row.find((s) => s.text.startsWith('nd '));
    const box = redaction(bar.x, bar.x1, left.y, left.h);
    box.lineId = `L${rowIdx}`;
    utbState.boxes.push(...row, box);

    assert.equal(await R.refineRedaction(box), true);
    const info = box.refineInfo;
    assert.equal(info.source, 'embedded');
    assert.equal(info.left.kind, 'word');
    assert.equal(info.left.reason, 'dictionary');
    assert.equal(info.right.kind, 'fragment');
    assert.equal(info.right.word, 'and');
    assert.equal(info.right.hidden, 'a');
    assert.equal(info.right.placement, 'unread');
    near(box.x, inkEnd(left) + SPACE, 0.05, 'left edge = including + space');
    near(box.x + box.w, right.x - HIDDEN_A - SPACE, 0.05, 'right edge = nd − a − space');
    near(box.w, NAME_W, 0.5, 'refined width matches SARAH KELLEN');
    assert.ok(rendered.includes(box.id), 'redrawn');
  });
}

// ── OCR lands later and reads "and" in full: same edge, no drift ──
test('OCR layer wins once present and converges on the same edge', async () => {
  reset();
  const bar = fixture.bars[1];
  const emb = fixture.spans.filter((s) => s.y === fixture.spans[2].y).map((s) => fromFixture(s, 'L'));
  const embLeft = emb.find((s) => s.text.includes('including'));
  const embRight = emb.find((s) => s.text.startsWith('nd '));
  const box = redaction(bar.x, bar.x1, embLeft.y, embLeft.h);
  box.lineId = 'L';
  utbState.boxes.push(...emb, box);
  await R.refineRedaction(box);
  const x1Embedded = box.x + box.w;
  assert.equal(box.refineInfo.exact, false, 'embedded pens are not lattice-exact');

  // Same call again: nothing new → untouched.
  assert.equal(await R.refineRedaction(box), false);

  // OCR segments arrive: the right one starts at the visible "a".
  const leftText = 'of JEFFREY EPSTEIN, including';
  const leftChars = charsFor(leftText);
  const leftW = leftChars[leftChars.length - 1].x + leftChars[leftChars.length - 1].w;
  const ocrLeft = span({ type: 'ocr', text: leftText, x: inkEnd(embLeft) - leftW, y: embLeft.y, w: leftW, h: embLeft.h,
    lineId: 'ocr_L', baseCharPositions: leftChars, ocr: { clean: true } });
  const rightText = 'and GHISLAINE MAXWELL.';
  const ocrRight = span({ type: 'ocr', text: rightText, x: embRight.x - HIDDEN_A, y: embRight.y,
    w: widthPx(rightText, 12), h: embRight.h, lineId: 'ocr_L', baseCharPositions: charsFor(rightText), ocr: { clean: true } });
  utbState.boxes.push(ocrLeft, ocrRight);

  await R.refineRedaction(box);
  assert.equal(box.refineInfo.source, 'ocr');
  assert.equal(box.refineInfo.right.kind, 'word');
  assert.equal(box.refineInfo.right.token, 'and');
  near(box.x + box.w, x1Embedded, 0.05, 'OCR-derived right edge equals the embedded-derived one');
  near(box.w, NAME_W, 0.5, 'still SARAH KELLEN');
  assert.equal(box.refineInfo.exact, true, 'both edges from OCR pens → pen-exact');
  assert.equal(box.refineInfo.x, box.x);
  assert.equal(box.refineInfo.w, box.w);
  near(Math.abs(box.w - NAME_W), 0, 0.3, 'the pen equation holds to the lattice');
});

// ── Adjacent bars ──────────────────────────────────────────
test('two bars a space apart do not stretch across each other', async () => {
  // "for [A] [B] traveling" — the shape that used to collapse both bars onto
  // one span, so the same stretch of page was scored twice.
  reset();
  const left = span({ text: 'for', x: 100, w: widthPx('for', 12), baseCharPositions: charsFor('for'), lineId: 'L' });
  const right = span({ text: 'traveling', x: 290, w: widthPx('traveling', 12), baseCharPositions: charsFor('traveling'), lineId: 'L' });
  const A = redaction(130, 200); A.lineId = 'L';
  const B = redaction(210, 280); B.lineId = 'L';
  utbState.boxes.push(left, right, A, B);

  await R.refineRedaction(A);
  await R.refineRedaction(B);

  // Outer edges refine against the real words; inner edges keep the ink.
  assert.equal(A.refineInfo.left.token, 'for');
  assert.equal(A.refineInfo.right, null, 'A must not see past B');
  assert.deepEqual(A.refineInfo.blocked, { left: false, right: true });
  near(A.x, inkEnd(left) + SPACE, 0.01, 'A left edge from "for"');
  near(A.x + A.w, 200, 0.01, 'A right edge unchanged');

  assert.equal(B.refineInfo.left, null, 'B must not see past A');
  assert.equal(B.refineInfo.right.token, 'traveling');
  assert.deepEqual(B.refineInfo.blocked, { left: true, right: false });
  near(B.x, 210, 0.01, 'B left edge unchanged');
  near(B.x + B.w, 290 - SPACE, 0.01, 'B right edge from "traveling"');

  // The two bars stay disjoint — neither covers the other.
  assert.ok(A.x + A.w <= B.x, `bars overlap: A ends ${A.x + A.w}, B starts ${B.x}`);
});

test('a word between the bar and its sibling is still a neighbour', async () => {
  // "[A] and [B] had" — the "and" sits between the two bars and is legitimate
  // evidence for A's right edge and B's left edge.
  reset();
  const mid = span({ text: 'and', x: 210, w: widthPx('and', 12), baseCharPositions: charsFor('and'), lineId: 'L' });
  const tail = span({ text: 'had', x: 330, w: widthPx('had', 12), baseCharPositions: charsFor('had'), lineId: 'L' });
  const A = redaction(130, 200); A.lineId = 'L';
  const B = redaction(260, 320); B.lineId = 'L';
  utbState.boxes.push(mid, tail, A, B);

  await R.refineRedaction(A);
  await R.refineRedaction(B);
  assert.equal(A.refineInfo.right.token, 'and');
  near(A.x + A.w, 210 - SPACE, 0.01, 'A right edge from "and"');
  assert.equal(B.refineInfo.left.token, 'and');
  near(B.x, inkEnd(mid) + SPACE, 0.01, 'B left edge from "and"');
  assert.ok(A.x + A.w <= B.x, 'still disjoint');
});

test('a comma the sibling\'s painted edge runs into is still this bar\'s neighbour', async () => {
  // "[A], [B]" — the detector's box for A ends a pixel into the comma. B,
  // refined first, must still see the comma (its centre stands clear of A).
  reset();
  const comma = span({ text: ',', x: 200, w: widthPx(',', 12), baseCharPositions: charsFor(','), lineId: 'L' });
  const tail = span({ text: 'and', x: 290, w: widthPx('and', 12), baseCharPositions: charsFor('and'), lineId: 'L' });
  const head = span({ text: 'for', x: 60, w: widthPx('for', 12), baseCharPositions: charsFor('for'), lineId: 'L' });
  const A = redaction(100, 201); A.lineId = 'L';
  const B = redaction(208, 280); B.lineId = 'L';
  utbState.boxes.push(head, comma, tail, A, B);

  await R.refineRedaction(B);
  assert.equal(B.refineInfo.left && B.refineInfo.left.token, ',', 'B reads the comma');
  assert.equal(B.refineInfo.left.reason, 'spaced');
  near(B.x, 200 + widthPx(',', 12) + SPACE, 0.01, 'B left edge = comma + space');
  await R.refineRedaction(A);
  assert.equal(A.refineInfo.right.token, ',');
  near(A.x + A.w, 200, 0.01, 'A abuts the comma');
});

test('refineAllRedactions settles siblings in reading order, whatever their creation order', async () => {
  reset();
  const comma = span({ text: ',', x: 200, w: widthPx(',', 12), baseCharPositions: charsFor(','), lineId: 'L' });
  const tail = span({ text: 'and', x: 290, w: widthPx('and', 12), baseCharPositions: charsFor('and'), lineId: 'L' });
  const head = span({ text: 'for', x: 60, w: widthPx('for', 12), baseCharPositions: charsFor('for'), lineId: 'L' });
  const B = redaction(208, 280); B.lineId = 'L';      // created first
  const A = redaction(100, 202); A.lineId = 'L';      // two px into the comma
  utbState.boxes.push(head, comma, tail, B, A);
  const before = widthsRecalcs;
  await R.refineAllRedactions();
  assert.equal(A.refineInfo.right.token, ',');
  assert.equal(B.refineInfo.left && B.refineInfo.left.token, ',');
  assert.ok(A.x + A.w <= B.x, 'disjoint');
  assert.equal(widthsRecalcs, before + 1, 'one re-measure for the whole run');
});

test('a lone bar records what bounds it', async () => {
  reset();
  const head = span({ text: 'for', x: 60, w: widthPx('for', 12), baseCharPositions: charsFor('for'), lineId: 'L' });
  const A = redaction(100, 200); A.lineId = 'L';
  const B = redaction(204, 260); B.lineId = 'L';      // nothing but A on its row
  utbState.boxes.push(head, A, B);
  assert.equal(await R.refineRedaction(B), false);
  assert.deepEqual(B.refineInfo.blocked, { left: true, right: false });
  assert.equal(B.refineInfo.left, null);
  assert.equal(B.refineInfo.right, null);
  assert.equal(B.refineInfo.exact, false);
  const alone = redaction(100, 200, 300);
  utbState.boxes.push(alone);
  assert.equal(await R.refineRedaction(alone), false);
  assert.deepEqual(alone.refineInfo.blocked, { left: false, right: false });
});

test('a comma the bar covers most of is still the neighbour — and the edge is not exact', async () => {
  // "[Lesley Groff,] Jean" — the redactor's box ran 2.75 px over the comma;
  // the reader still certified it. It is the visible text's comma, so the
  // bar ends at its pen; but a pen read from a sliver is not lattice-exact.
  reset();
  const ocr = (f) => span({ type: 'ocr', ocr: { clean: true }, ...f });
  const head = ocr({ text: ',', x: 280.25, w: widthPx(',', 12), baseCharPositions: charsFor(',') });
  const comma = ocr({ text: ',', x: 365.25, w: 4, baseCharPositions: [{ c: ',', x: 0, w: 4 }] });
  const jean = ocr({ text: 'Jean', x: 372.75, w: widthPx('Jean', 12), baseCharPositions: charsFor('Jean') });
  const box = redaction(285, 368);
  utbState.boxes.push(head, comma, jean, box);
  await R.refineRedaction(box);
  assert.equal(box.refineInfo.right.token, ',');
  assert.equal(box.refineInfo.right.reason, 'abuts');
  assert.equal(box.refineInfo.right.partial, true);
  assert.equal(box.refineInfo.left.partial, false);
  near(box.x + box.w, 365.25, 0.01, 'bar ends at the comma\'s pen');
  assert.equal(box.refineInfo.exact, false, 'a sliver pen is not exact');
  // Covered whole, the comma is hidden text and the next word out is the neighbour.
  reset();
  const box2 = redaction(285, 370);
  utbState.boxes.push(head, comma, jean, box2);
  await R.refineRedaction(box2);
  assert.equal(box2.refineInfo.right.token, 'Jean');
  // A comma the bar's edge merely touches (1.5 px, bearing + a detector column) is exact.
  reset();
  const comma3 = ocr({ text: ',', x: 472.5, w: 4, baseCharPositions: [{ c: ',', x: 0, w: 4 }] });
  const head3 = ocr({ text: ',', x: 384.75, w: 4, baseCharPositions: [{ c: ',', x: 0, w: 4 }] });
  const box3 = redaction(392, 474);
  utbState.boxes.push(head3, comma3, box3);
  await R.refineRedaction(box3);
  assert.equal(box3.refineInfo.right.partial, false);
  assert.equal(box3.refineInfo.exact, true);
});

test('a bar opening a sentence starts two spaces in when the page spaces sentences that way', async () => {
  // Rows elsewhere on the page: "incident.  The" and "seized.  There" with
  // two spaces; "Dr. Gregory" with one (an abbreviation, not a sentence end).
  const cpsOf = (text) => {
    const cps = []; let x = 0;
    for (const c of text) { const w = c === ' ' ? SPACE : widthPx(c, 12); cps.push({ c, x, w }); x += w; }
    return cps;
  };
  const ocr = (f) => span({ type: 'ocr', ocr: { clean: true }, ...f });
  const row = (text, y) => ocr({ text, x: 100, y, w: cpsOf(text).reduce((s, cp) => s + cp.w, 0), baseCharPositions: cpsOf(text) });
  const setup = (double) => {
    reset();
    const two = double ? '  ' : ' ';
    utbState.boxes.push(row(`without incident.${two}The same day, a warrant`, 100));
    utbState.boxes.push(row(`items were seized.${two}There was a number`, 200));
    utbState.boxes.push(row('interviewed Dr. Gregory by telephone', 300));
  };
  setup(true);
  assert.equal(R.sentenceSpaces(1, 'ocr'), 2);
  assert.equal(R.isSentenceEnd('plane.'), true);
  assert.equal(R.isSentenceEnd('2002.'), true);
  assert.equal(R.isSentenceEnd('Dr.'), false);
  assert.equal(R.isSentenceEnd('J.'), false);
  assert.equal(R.isSentenceEnd('U.S.'), false);
  assert.equal(R.isSentenceEnd('plane,'), false);
  // "plane. [Bledsoe] said" — the bar opens a sentence: two spaces in.
  const plane = ocr({ text: 'plane.', x: 300, w: widthPx('plane.', 12), baseCharPositions: charsFor('plane.') });
  const said = ocr({ text: 'said', x: 300 + widthPx('plane.', 12) + 2 * SPACE + widthPx('Bledsoe', 12) + SPACE, w: widthPx('said', 12), baseCharPositions: charsFor('said') });
  const bar = redaction(inkEnd(plane) + 4, said.x - 2);
  utbState.boxes.push(plane, said, bar);
  await R.refineRedaction(bar);
  assert.equal(bar.refineInfo.left.spaces, 2);
  near(bar.x, inkEnd(plane) + 2 * SPACE, 0.01, 'two spaces after the sentence');
  near(bar.w, widthPx('Bledsoe', 12), 0.01, 'the bar is exactly the name');
  assert.equal(bar.refineInfo.exact, true);
  // "Dr. [Gregory Bledsoe] by" — an abbreviation: one space.
  const dr = ocr({ text: 'Dr.', x: 300, y: 400, w: widthPx('Dr.', 12), baseCharPositions: charsFor('Dr.') });
  const by = ocr({ text: 'by', x: 420, y: 400, w: widthPx('by', 12), baseCharPositions: charsFor('by') });
  const bar2 = redaction(inkEnd(dr) + 3, 416, 400);
  utbState.boxes.push(dr, by, bar2);
  await R.refineRedaction(bar2);
  assert.equal(bar2.refineInfo.left.spaces, 1);
  near(bar2.x, inkEnd(dr) + SPACE, 0.01, 'one space after "Dr."');
  // A page that single-spaces its sentences: one space.
  setup(false);
  assert.equal(R.sentenceSpaces(1, 'ocr'), 1);
  utbState.boxes.push(plane, said, bar);
  await R.refineRedaction(bar, { force: true });
  assert.equal(bar.refineInfo.left.spaces, 1);
  near(bar.x, inkEnd(plane) + SPACE, 0.01, 'one space when the page single-spaces');
});

test('siblingBars sees only bars sharing the row', () => {
  reset();
  const A = redaction(130, 200, 0);
  const sameRow = redaction(210, 280, 0);
  const otherRow = redaction(210, 280, 100);
  const notABar = span({ text: 'x', x: 210, y: 0, w: 10 });
  utbState.boxes.push(A, sameRow, otherRow, notABar);
  const ids = R.siblingBars(A).map((b) => b.id);
  assert.deepEqual(ids, [sameRow.id]);
});

test('a bar the user moved is kept unless better evidence (OCR) arrives', async () => {
  reset();
  const left = span({ text: 'including', x: 100, w: widthPx('including', 12), baseCharPositions: charsFor('including'), lineId: 'L' });
  const right = span({ text: 'and', x: 260, w: widthPx('and', 12), baseCharPositions: charsFor('and'), lineId: 'L' });
  const box = redaction(150, 258); box.lineId = 'L';
  utbState.boxes.push(left, right, box);
  await R.refineRedaction(box);
  const refinedX = box.x;
  box.x += 3;                       // user nudges it
  assert.equal(await R.refineRedaction(box), false);
  assert.equal(box.x, refinedX + 3);
  const ocr = span({ type: 'ocr', text: 'and', x: 260, w: widthPx('and', 12), baseCharPositions: charsFor('and'), lineId: 'O', ocr: { clean: true } });
  const ocrL = span({ type: 'ocr', text: 'including', x: 100, w: widthPx('including', 12), baseCharPositions: charsFor('including'), lineId: 'O', ocr: { clean: true } });
  utbState.boxes.push(ocr, ocrL);
  assert.equal(await R.refineRedaction(box), true);
  near(box.x, refinedX, 0.01, 'OCR evidence re-derives the edge');
});

// ── Rules on synthetic rows ────────────────────────────────
// ── Punctuation binding ────────────────────────────────────
test('punctBindsToward: closing binds left, opening binds right', () => {
  // A closing mark is flush against a bar on its LEFT, spaced from one on its right.
  for (const ch of ['.', ',', ';', ':', '!', '?', ')', ']', '”', '%']) {
    assert.equal(R.punctBindsToward(`word${ch}`, 'left'), false, `${ch} left`);
    assert.equal(R.punctBindsToward(`${ch}word`, 'right'), true, `${ch} right`);
  }
  // An opening mark is the mirror.
  for (const ch of ['(', '[', '{', '“']) {
    assert.equal(R.punctBindsToward(`${ch}`, 'left'), true, `${ch} left`);
    assert.equal(R.punctBindsToward(`${ch}word`, 'right'), false, `${ch} right`);
  }
});

test('angle brackets delimit like parens: an address bar is flush on both sides', async () => {
  // "Bella Klein <NAME>, Valdson Cotrin" — the bar sits inside the brackets, so
  // neither edge carries a space. < and > are math symbols, not \p{P}, and used
  // to fall through to the word rule and lose a space-width at each edge.
  assert.equal(R.punctBindsToward('<', 'left'), true);
  assert.equal(R.punctBindsToward('>,', 'right'), true);
  reset();
  const open = span({ type: 'ocr', text: '<', x: 100, w: widthPx('-', 12), lineId: 'L', ocr: { clean: true },
    baseCharPositions: [{ c: '<', x: 0, w: widthPx('-', 12) }] });
  const close = span({ type: 'ocr', text: '>,', x: 260, w: widthPx('-,', 12), lineId: 'L', ocr: { clean: true },
    baseCharPositions: [{ c: '>', x: 0, w: widthPx('-', 12) }, { c: ',', x: widthPx('-', 12), w: widthPx(',', 12) }] });
  const box = redaction(inkEnd(open), 260); box.lineId = 'L';
  utbState.boxes.push(open, close, box);
  await R.refineRedaction(box);
  assert.equal(box.refineInfo.left.reason, 'abuts');
  assert.equal(box.refineInfo.right.reason, 'abuts');
  near(box.x, inkEnd(open), 0.01, 'flush after <');
  near(box.x + box.w, 260, 0.01, 'flush before >');
});

test('punctBindsToward: quotes bind to the word they are glued to', () => {
  // Glued to a word — it has closed that word, so the bar is a separate word.
  assert.equal(R.punctBindsToward('example"', 'left'), false);
  assert.equal(R.punctBindsToward('"and', 'right'), false);
  assert.equal(R.punctBindsToward("girls'", 'left'), false);
  // Standing alone — it opens onto the hidden word, flush.
  assert.equal(R.punctBindsToward('"', 'left'), true);
  assert.equal(R.punctBindsToward('"', 'right'), true);
  assert.equal(R.punctBindsToward("'", 'left'), true);
  // Stacked marks: the paren behind the quote is not a word.
  assert.equal(R.punctBindsToward('("', 'left'), true);
});

test('punctBindsToward: a dash glued to a word is a compound, alone it is spaced', () => {
  assert.equal(R.punctBindsToward('co-', 'left'), true);
  assert.equal(R.punctBindsToward('-conspirators', 'right'), true);
  assert.equal(R.punctBindsToward('and/', 'left'), true);
  assert.equal(R.punctBindsToward('—', 'left'), false);
  assert.equal(R.punctBindsToward('—', 'right'), false);
});

test('facingRun takes only the run touching the bar', () => {
  assert.equal(R.facingRun('EPSTEIN, including', 'left'), 'including');
  assert.equal(R.facingRun('Device-58");', 'left'), 'Device-58");');
  assert.equal(R.facingRun('and GHISLAINE', 'right'), 'and');
  assert.equal(R.facingRun('', 'left'), '');
});

test('a comma or semicolon before the bar leaves a space (both sides of the same comma)', async () => {
  for (const mark of [',', ';', '.']) {
    reset();
    const leftText = `EPSTEIN${mark}`;
    const left = span({ text: leftText, x: 100, w: widthPx(leftText, 12), baseCharPositions: charsFor(leftText), lineId: 'L' });
    const rightText = `${mark} and`;
    const right = span({ text: rightText, x: 260, w: widthPx(rightText, 12), baseCharPositions: charsFor(rightText), lineId: 'L' });
    const box = redaction(inkEnd(left) + 2, 258); box.lineId = 'L';
    utbState.boxes.push(left, right, box);
    await R.refineRedaction(box);
    assert.equal(box.refineInfo.left.kind, 'punct');
    assert.equal(box.refineInfo.left.reason, 'spaced', `${mark} left`);
    assert.equal(box.refineInfo.right.reason, 'abuts', `${mark} right`);
    near(box.x, inkEnd(left) + SPACE, 0.01, `${mark}: left edge one space in`);
    near(box.x + box.w, 260, 0.01, `${mark}: right edge flush`);
  }
});

test('an opening bracket is flush on the left and spaced on the right', async () => {
  reset();
  const left = span({ text: '(', x: 100, w: widthPx('(', 12), baseCharPositions: charsFor('('), lineId: 'L' });
  const right = span({ text: '(Subject', x: 260, w: widthPx('(Subject', 12), baseCharPositions: charsFor('(Subject'), lineId: 'L' });
  const box = redaction(inkEnd(left), 258); box.lineId = 'L';
  utbState.boxes.push(left, right, box);
  await R.refineRedaction(box);
  assert.equal(box.refineInfo.left.reason, 'abuts');
  assert.equal(box.refineInfo.right.reason, 'spaced');
  near(box.x, inkEnd(left), 0.01, 'flush after the bracket');
  near(box.x + box.w, 260 - SPACE, 0.01, 'one space before the bracket');
});

test('a quote is flush when it opens the hidden word, spaced when it closed another', async () => {
  // he said "NAME" today — both quotes stand alone, both flush.
  reset();
  const openQ = span({ text: '"', x: 100, w: widthPx('"', 12), baseCharPositions: charsFor('"'), lineId: 'L' });
  const closeQ = span({ text: '"', x: 260, w: widthPx('"', 12), baseCharPositions: charsFor('"'), lineId: 'L' });
  const box = redaction(inkEnd(openQ), 260); box.lineId = 'L';
  utbState.boxes.push(openQ, closeQ, box);
  await R.refineRedaction(box);
  assert.equal(box.refineInfo.left.reason, 'abuts');
  assert.equal(box.refineInfo.right.reason, 'abuts');
  near(box.x, inkEnd(openQ), 0.01, 'flush after the opening quote');
  near(box.x + box.w, 260, 0.01, 'flush before the closing quote');

  // the word "example" NAME "and so on" — both quotes are glued to words, so
  // both sides carry a real space.
  reset();
  const l = span({ text: '"example"', x: 100, w: widthPx('"example"', 12), baseCharPositions: charsFor('"example"'), lineId: 'L' });
  const r = span({ text: '"and', x: 300, w: widthPx('"and', 12), baseCharPositions: charsFor('"and'), lineId: 'L' });
  const box2 = redaction(inkEnd(l) + 2, 298); box2.lineId = 'L';
  utbState.boxes.push(l, r, box2);
  await R.refineRedaction(box2);
  assert.equal(box2.refineInfo.left.reason, 'spaced');
  assert.equal(box2.refineInfo.right.reason, 'spaced');
  near(box2.x, inkEnd(l) + SPACE, 0.01, 'space after the closing quote');
  near(box2.x + box2.w, 300 - SPACE, 0.01, 'space before the opening quote');
});

test('a hyphen compound stays flush, a spaced dash does not', async () => {
  reset();
  const left = span({ text: 'co-', x: 100, w: widthPx('co-', 12), baseCharPositions: charsFor('co-'), lineId: 'L' });
  const right = span({ text: '-and', x: 260, w: widthPx('-and', 12), baseCharPositions: charsFor('-and'), lineId: 'L' });
  const box = redaction(inkEnd(left), 260); box.lineId = 'L';
  utbState.boxes.push(left, right, box);
  await R.refineRedaction(box);
  assert.equal(box.refineInfo.left.reason, 'abuts');
  assert.equal(box.refineInfo.right.reason, 'abuts');
  near(box.x, inkEnd(left), 0.01, 'flush after "co-"');
  near(box.x + box.w, 260, 0.01, 'flush before "-and"');

  reset();
  const dash = span({ text: '\u2014', x: 100, w: widthPx('-', 12), baseCharPositions: charsFor('-'), lineId: 'L' });
  dash.baseCharPositions = [{ c: '\u2014', x: 0, w: widthPx('-', 12) }];
  const word = span({ text: 'and', x: 260, w: widthPx('and', 12), baseCharPositions: charsFor('and'), lineId: 'L' });
  const box2 = redaction(inkEnd(dash) + 2, 256); box2.lineId = 'L';
  utbState.boxes.push(dash, word, box2);
  await R.refineRedaction(box2);
  assert.equal(box2.refineInfo.left.reason, 'spaced');
  near(box2.x, inkEnd(dash) + SPACE, 0.01, 'a spaced dash keeps its space');
});

test('punctuation abuts: edges flush to the neighbour', async () => {
  reset();
  const left = span({ text: '(', x: 100, w: widthPx('(', 12), baseCharPositions: charsFor('('), lineId: 'L' });
  const right = span({ text: ', and', x: 240, w: widthPx(', and', 12), baseCharPositions: charsFor(', and'), lineId: 'L' });
  const box = redaction(106, 236); box.lineId = 'L';
  utbState.boxes.push(left, right, box);
  await R.refineRedaction(box);
  assert.equal(box.refineInfo.left.kind, 'punct');
  assert.equal(box.refineInfo.right.kind, 'punct');
  near(box.x, inkEnd(left), 0.01, 'flush left');
  near(box.x + box.w, 240, 0.01, 'flush right');
});

test('a text-layer span running under the bar yields only its visible words', async () => {
  reset();
  const text = 'including SARAH KELLEN and GHISLAINE';
  const cps = charsFor(text);
  const s = span({ text, x: 100, w: widthPx(text, 12), baseCharPositions: cps, lineId: 'L' });
  const words = R.rowWords([s]);
  const at = (w) => 100 + cps[text.indexOf(w)].x;
  const box = redaction(at('SARAH') - 2, at('and') - 1); box.lineId = 'L';
  utbState.boxes.push(s, box);
  await R.refineRedaction(box);
  assert.deepEqual(words.map((w) => w.text), ['including', 'SARAH', 'KELLEN', 'and', 'GHISLAINE']);
  assert.equal(box.refineInfo.left.token, 'including');
  assert.equal(box.refineInfo.right.token, 'and');
  near(box.x, at('SARAH'), 0.01, 'left');
  near(box.x + box.w, at('and') - SPACE, 0.01, 'right');
  near(box.w, NAME_W, 0.01, 'exactly the name');
});

test('a lone capital letter touching the bar is a sliver of the name: the bar grows over it', async () => {
  reset();
  // OCR reads the exposed "S" of SARAH: "EPSTEIN, including S" ends 1 px inside the bar.
  const leftText = 'EPSTEIN, including S';
  const left = span({ type: 'ocr', text: leftText, x: 96, w: widthPx(leftText, 12), baseCharPositions: charsFor(leftText), lineId: 'L', ocr: { clean: true } });
  const sEnd = inkEnd(left);
  const right = span({ type: 'ocr', text: 'and GHISLAINE', x: sEnd + 120, w: widthPx('and GHISLAINE', 12), baseCharPositions: charsFor('and GHISLAINE'), lineId: 'L', ocr: { clean: true } });
  const box = redaction(sEnd - 1, sEnd + 118); box.lineId = 'L'; box.uppercase = true;
  utbState.boxes.push(left, right, box);
  const events = [];
  PDFHooks.on('redaction:refined', (e) => events.push(e));
  await R.refineRedaction(box);
  assert.deepEqual(box.refineInfo.remnants, [{ text: 'S', side: 'left' }]);
  assert.equal(box.refineInfo.left.token, 'including');
  assert.equal(events.length, 1);
  assert.equal(events[0].boxId, box.id);
  assert.deepEqual(events[0].remnants, [{ text: 'S', side: 'left' }]);
  const includingEnd = left.x + left.baseCharPositions[leftText.indexOf('g')].x + widthPx('g', 12);
  near(box.x, includingEnd + SPACE, 0.01, 'left edge = including + space, i.e. where the S starts');
  near(box.x + box.w, right.x - SPACE, 0.01, 'right edge = and − space');
  // The browser case: OCR's "S" straddles the bar edge, 6 of its 9 px inside.
  reset();
  const box3 = redaction(sEnd - 6, sEnd + 118); box3.lineId = 'L';
  utbState.boxes.push(left, right, box3);
  await R.refineRedaction(box3);
  assert.deepEqual(box3.refineInfo.remnants, [{ text: 'S', side: 'left' }]);
  near(box3.x, includingEnd + SPACE, 0.01, 'straddling sliver: same left edge');
  // A lone capital buried deep inside the bar is under-bar text, not a sliver.
  reset();
  const box4 = redaction(sEnd - 30, sEnd + 118); box4.lineId = 'L';
  utbState.boxes.push(left, right, box4);
  await R.refineRedaction(box4);
  assert.deepEqual(box4.refineInfo.remnants, []);
  // "A" and "I" are words: an article/pronoun touching the bar stays a neighbour.
  reset();
  const art = span({ text: 'A', x: 100, w: widthPx('A', 12), baseCharPositions: charsFor('A'), lineId: 'L' });
  const box2 = redaction(inkEnd(art) + 1, inkEnd(art) + 100); box2.lineId = 'L';
  utbState.boxes.push(art, box2);
  await R.refineRedaction(box2);
  assert.deepEqual(box2.refineInfo.remnants, []);
  assert.equal(box2.refineInfo.left.token, 'A');
});

test('a capitalised token touching the bar is a proper noun, not a fragment', async () => {
  reset();
  const left = span({ text: 'including', x: 100, w: widthPx('including', 12), baseCharPositions: charsFor('including'), lineId: 'L' });
  const right = span({ text: 'Wexner', x: 251, w: widthPx('Wexner', 12), baseCharPositions: charsFor('Wexner'), lineId: 'L' });
  const box = redaction(160, 250); box.lineId = 'L';
  utbState.boxes.push(left, right, box);
  await R.refineRedaction(box);
  assert.equal(box.refineInfo.right.kind, 'word');
  assert.equal(box.refineInfo.right.reason, 'proper-noun');
  near(box.x + box.w, 251 - SPACE, 0.01, 'one space in');
});

test('a whole word a space away is never read as a fragment (FORD → afford)', async () => {
  reset();
  R.setDictionary(['the', 'afford', 'including']);   // "ford" itself absent
  const left = span({ text: 'including', x: 100, w: widthPx('including', 12), baseCharPositions: charsFor('including'), lineId: 'L' });
  const right = span({ text: 'FORD', x: 254, w: widthPx('FORD', 12), baseCharPositions: charsFor('FORD'), lineId: 'L' });
  const box = redaction(160, 250); box.lineId = 'L';   // gap 4 = a space, not ~0 and not w("AF")
  utbState.boxes.push(left, right, box);
  await R.refineRedaction(box);
  assert.equal(box.refineInfo.right.kind, 'word');
  assert.equal(box.refineInfo.right.reason, 'no-fitting-completion');
  await R.loadDictionary();
});

test('left-side fragment: the missing tail sits under the bar', async () => {
  reset();
  await R.setDictionary(fs.readFileSync(path.join(root, 'words.txt'), 'utf8').split('\n'));
  const left = span({ text: 'inclu', x: 100, w: widthPx('inclu', 12), baseCharPositions: charsFor('inclu'), lineId: 'L' });
  const right = span({ text: 'and', x: 400, w: widthPx('and', 12), baseCharPositions: charsFor('and'), lineId: 'L' });
  const box = redaction(inkEnd(left) + 1, 396); box.lineId = 'L';
  utbState.boxes.push(left, right, box);
  await R.refineRedaction(box);
  const L = box.refineInfo.left;
  assert.equal(L.kind, 'fragment');
  assert.equal(L.placement, 'under-bar');
  assert.equal(L.word, R.completions('inclu', 'left')[0]);
  near(box.x, inkEnd(left) + widthPx(L.hidden, 12) + SPACE, 0.01, 'left = fragment + hidden tail + space');
});

test('a fragment reading that would collapse the bar falls back to the word reading', async () => {
  reset();
  const left = span({ text: 'including', x: 100, w: widthPx('including', 12), baseCharPositions: charsFor('including'), lineId: 'L' });
  const x1 = inkEnd(left);
  const box = redaction(x1 - 3, x1 + 13); box.lineId = 'L';       // 16 px bar, left word runs 3 px into it
  const right = span({ text: 'nd', x: x1 + 15, w: widthPx('nd', 12), baseCharPositions: charsFor('nd'), lineId: 'L' });
  utbState.boxes.push(left, right, box);
  await R.refineRedaction(box);
  assert.equal(box.refineInfo.right.kind, 'word');
  assert.equal(box.refineInfo.right.reason, 'collapsed');
  assert.ok(box.w >= 4);
});

test('an unread OCR marker is not a neighbour', async () => {
  reset();
  const left = span({ text: 'including', x: 100, w: widthPx('including', 12), baseCharPositions: charsFor('including'), lineId: 'L' });
  const marker = span({ type: 'ocr', text: '□', x: 260, w: 40, lineId: 'L', ocr: { clean: false, unread: true } });
  const box = redaction(160, 250); box.lineId = 'L';
  utbState.boxes.push(left, marker, box);
  await R.refineRedaction(box);
  assert.equal(box.refineInfo.right, null);
  near(box.x + box.w, 250, 0.01, 'right edge untouched');
});

test('row space width: natural unless the row is clearly justified', () => {
  const mk = (ws) => [{ baseCharPositions: ws.map((w) => ({ c: ' ', x: 0, w })) }];
  assert.equal(R.rowSpaceWidth(mk([3.9, 4.1, 2.7]), 4), 4);      // 2.7 = space under the bar, ignored
  assert.equal(R.rowSpaceWidth(mk([6, 6.2, 5.9]), 4), 6);        // justified → measured
  assert.equal(R.rowSpaceWidth(mk([]), 4), 4);
});

test('refineAllRedactions skips the selected box and re-measures once', async () => {
  reset();
  const mkRow = (y, lineId) => {
    const left = span({ text: 'including', x: 100, y, w: widthPx('including', 12), baseCharPositions: charsFor('including'), lineId });
    const right = span({ text: 'and', x: 260, y, w: widthPx('and', 12), baseCharPositions: charsFor('and'), lineId });
    const box = redaction(150, 258, y); box.lineId = lineId;
    utbState.boxes.push(left, right, box);
    return box;
  };
  const a = mkRow(0, 'A');
  const b = mkRow(100, 'B');
  utbState.selectedId = b.id;
  const before = widthsRecalcs;
  await R.refineAllRedactions();
  assert.ok(a.refined, 'unselected box refined');
  assert.ok(!b.refined, 'selected box untouched');
  assert.equal(widthsRecalcs, before + 1);
  await R.refineAllRedactions();
  assert.equal(widthsRecalcs, before + 1, 'no change → no re-measure');
});

// ── Run ────────────────────────────────────────────────────
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
