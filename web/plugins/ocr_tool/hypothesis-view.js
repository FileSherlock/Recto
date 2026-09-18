// hypothesis-view.js — the string-hypothesis seam: window.ocrTestHypothesis
// (box, name) → Promise<verdict | null>, consumed by redaction_matching's
// scoreMatches after every width recompute (guide/plugins/redaction-refiner/
// pixel-evidence-plan.md) — and, at the end of the file, the width seam
// window.ocrMeasureWidths(box, strings), which measures candidates in the
// page's own face. It draws a candidate name where the refiner put
// the bar — the line's own glyph set, baseline, y-phase and ¼-px pens —
// composites the bar over it as the redactor did, and lets the page bytes
// outside the bar's black body judge it (tol0 engine/hypothesis.js, synced
// verbatim; certified there by test/hypothesis.test.js and
// tools/hypothesis-bench.mjs). Nothing here identifies a sliver: a name is
// contradicted, consistent, or without evidence, and two consistent names
// are a tie.
//
// Inputs, all already on the page:
//   the neighbour words        RedactionRefiner.neighboursFor(box) — the OCR
//                              segments left/right of the bar with their
//                              baseCharPositions (the reader's pens)
//   the line's terms           span.ocr: font (set), baseline, phy, tol,
//                              top/bot, quant, spaceAdv; the row space from
//                              box.refineInfo (the refiner's rowSpaceWidth)
//   the page bytes + bar model pixel-view.js pvPageInfo: the whitened page,
//                              detectObjects (objects + edge model), quant
//   the sets                   pvSetsForBox / pvEnsureSets
// null, with the reason in OCRHypothesisView.reasons, when the row has no
// OCR segments, no set is loaded for the face, the raster is not 1:1, or no
// detected box overlaps the bar.
'use strict';

const hypothesisView = { reasons: new Map(), last: null };

function hvReason(box, why) {
  hypothesisView.reasons.set(box.id, why);
  hypothesisView.last = why;
  return null;
}

// a span's glyphs at their measured pens (page px), as render.js wants them
function hvSpanGlyphs(span, sx, setInfo) {
  const out = [];
  for (const cp of span.baseCharPositions || []) {
    if (cp.ligTail) continue;
    const ch = cp.lig || cp.c;
    if (ch === ' ' || ch === '□') continue;
    out.push({ ch, pen: (span.x + cp.x) / sx, set: (cp.src && setInfo.byName.get(cp.src)) || setInfo.primary });
  }
  return out;
}

// the neighbour word's char positions within its span: [{cp, x0, x1}] in
// viewBox px, glyph chars only
function hvWordChars(word) {
  const span = word.span, cps = span.baseCharPositions || [];
  const chars = [];
  for (const cp of cps) {
    if (cp.ligTail || !cp.c || !cp.c.trim()) continue;
    const x0 = span.x + cp.x, x1 = x0 + (cp.w || 0);
    if (x1 > word.x0 - 1e-6 && x0 < word.x1 + 1e-6) chars.push({ cp, x0, x1 });
  }
  return chars;
}

// the producer's metrics on this page — advances and kern pairs — measured
// from the OCR boxes' pens (render.js pageMetrics): a document set in
// another build of the face draws the same glyphs at other advances, and a
// kerned pair sits 1–2 px off the plain advance. Cached per document page.
const hvKern = new Map();
function hvKernTable(pageNum, spaceAdv) {
  const key = `${state.docHash}|${pageNum}`;
  if (hvKern.has(key)) return hvKern.get(key);
  const lines = [];
  for (const b of utbState.boxes) {
    if (b.type !== 'ocr' || b.page !== pageNum || !b.baseCharPositions) continue;
    const glyphs = [];
    for (const cp of b.baseCharPositions) {
      if (cp.ligTail) continue;
      const ch = cp.lig || cp.c;
      if (ch === ' ' || ch === '□' || !ch) { glyphs.push({ ch: ' ', pen: b.x + cp.x, adv: cp.w || 0 }); continue; }
      glyphs.push({ ch, pen: b.x + cp.x, adv: cp.w || 0 });
    }
    lines.push({ glyphs: glyphs.filter(g => g.ch !== ' ') });
  }
  const k = OCRRender.pageMetrics(lines, spaceAdv);
  hvKern.set(key, k);
  return k;
}
window.PDFHooks?.on('document:loaded', () => hvKern.clear());

async function ocrTestHypothesis(box, name) {
  if (typeof OCRHypothesis === 'undefined' || typeof OCRRender === 'undefined') return hvReason(box, 'engine not loaded');
  if (typeof RedactionRefiner === 'undefined') return hvReason(box, 'no refiner');
  if (!box || box.type !== 'redaction') return hvReason(box, 'not a redaction');
  if (!ocrToolState.sets) { await pvEnsureSets(); if (!ocrToolState.sets) return hvReason(box, 'glyph sets not loaded'); }

  const nb = RedactionRefiner.neighboursFor(box);
  if (nb.source !== 'ocr' || (!nb.left && !nb.right)) return hvReason(box, 'the row has no OCR segments');
  const anchor = nb.left || nb.right;
  const span = anchor.span;
  if (!span.ocr || span.ocr.baseline == null) return hvReason(box, 'the neighbour is not a reader line');
  const setInfo = pvSetsForBox(span);
  if (!setInfo) return hvReason(box, `set ${span.ocr.font} is not loaded`);

  const info = pvPageInfo(box.page);
  if (!info || !info.det) return hvReason(box, 'page raster not ready (or not 1:1 with the viewBox)');
  const sx = (state.pageWidth || info.page.w) / info.page.w;

  // the face that drew the glyph next to the bar decides the hidden name's set
  const leftChars = nb.left ? hvWordChars(nb.left) : [];
  const rightChars = nb.right ? hvWordChars(nb.right) : [];
  const adj = leftChars.length ? leftChars[leftChars.length - 1].cp : rightChars.length ? rightChars[0].cp : null;
  const set = (adj?.src && setInfo.byName.get(adj.src)) || setInfo.primary;

  const ri = box.refineInfo;
  const spaceLine = ri?.left?.space ?? ri?.right?.space ?? span.ocr.spaceAdv ?? pvSpaceAdv(span, set);
  const penLeft = leftChars.length ? leftChars[leftChars.length - 1].x1 / sx : null;
  const penRight = rightChars.length ? rightChars[0].x0 / sx : null;
  if (penLeft == null && penRight == null) return hvReason(box, 'no pen on either side');
  // the gap the name leaves to each neighbour: a space, or none where the
  // neighbour is punctuation that touches it ("Kellen," — the memo's lists)
  const closes = ch => /[,.;:!?'"’”)\]}]/.test(ch), opens = ch => /[('"‘“\[{]/.test(ch);
  const leftCh = leftChars.length ? leftChars[leftChars.length - 1].cp.c : '';
  const rightCh = rightChars.length ? rightChars[0].cp.c : '';
  const gapLeft = leftCh && opens(leftCh) ? 0 : spaceLine / sx;
  const gapRight = rightCh && closes(rightCh) ? 0 : spaceLine / sx;

  // the bar: the detected box object over it
  const bx0 = box.x / sx, bx1 = (box.x + box.w) / sx, by0 = box.y / sx, by1 = (box.y + box.h) / sx;
  const boxObj = info.det.objects.find(o => o.type === 'box' && o.x1 > bx0 && o.x0 < bx1 && o.y1 > by0 && o.y0 < by1) || null;
  if (!boxObj) return hvReason(box, 'no detected redaction box under the bar');

  // ink already accounted for: the neighbour spans, and the other reader
  // lines whose rows reach into this line's window
  const explained = [];
  const drawn = new Set();
  const draw = s => {
    if (!s || drawn.has(s.id) || !s.ocr || s.ocr.baseline == null) return;
    drawn.add(s.id);
    const si = pvSetsForBox(s);
    if (!si) return;
    const glyphs = hvSpanGlyphs(s, sx, si);
    if (!glyphs.length) return;
    const r = OCRRender.renderLine(si.primary, glyphs, s.ocr.baseline, { phy: s.ocr.phy || 0 });
    if (r.glyphs) explained.push(r);
  };
  for (const s of nb.spans) draw(s);
  const reach = set.maxAsc + set.maxDesc;
  for (const b of utbState.boxes)
    if (b.type === 'ocr' && b.page === box.page && b.ocr?.baseline != null &&
        Math.abs(b.ocr.baseline - span.ocr.baseline) < reach && b.ocr.baseline !== span.ocr.baseline) draw(b);

  const line = { baseline: span.ocr.baseline, phy: span.ocr.phy || 0, tol: span.ocr.tol || 0,
    spaceLine: spaceLine / sx, penLeft, penRight, gapLeft, gapRight, top: span.ocr.top, bot: span.ocr.bot,
    metrics: hvKernTable(box.page, span.ocr.spaceAdv || spaceLine / sx) };
  const text = box.uppercase ? name.toUpperCase() : name;
  const v = OCRHypothesis.testHypothesis(info.page, info.det, set, line, boxObj, text,
    { quant: span.ocr.quant ? pvQuant(info) : null, explained });
  hypothesisView.reasons.delete(box.id);
  // plain data for box.verdicts (the render and the mismatch map stay here)
  const { render, mism, window: win, ...plain } = v;
  hypothesisView.last = { box: box.id, name, verdict: plain, window: win, mism };
  return { ...plain, set: set.name, text, adj: `${leftCh}|${rightCh}`, gaps: [gapLeft, gapRight] };
}
window.ocrTestHypothesis = ocrTestHypothesis;
window.OCRHypothesisView = hypothesisView;

// ── The width seam: window.ocrMeasureWidths(box, strings) ──────────────
// → Promise<{ widths: (number|null)[], face } | null>, consumed by
// redaction_matching after its HarfBuzz measurement. The strings are laid
// out in the reader's glyph set for the bar's row — the face that drew the
// page, glyph by glyph at its own advances (the set's, or the producer's
// build's where they differ: LAWS §6). Laid out PLAIN — no page metrics:
// the measured kern table is for placing glyphs on the page and widened
// every name's miss on the memos — with the refiner's row space, the space
// the bar was derived with, so the two are the same measure (the reader's
// calibrated space is 0.07 px tighter and fits the bars worse). On the
// memos this agrees with HarfBuzz to the font unit once HarfBuzz stops
// forming ligatures (RICHARD BARNETT, LESLEY GROFF: 0.5 px short with them).
// Widths are returned in viewBox px like box.w. A string with a glyph the
// set lacks gets null; the whole call is null when the row has no reader
// line or no set is loaded.
async function ocrMeasureWidths(box, strings) {
  if (typeof OCRRender === 'undefined' || typeof RedactionRefiner === 'undefined') return null;
  if (!box || box.type !== 'redaction' || !Array.isArray(strings)) return null;
  if (!ocrToolState.sets) { await pvEnsureSets(); if (!ocrToolState.sets) return null; }
  const nb = RedactionRefiner.neighboursFor(box);
  if (nb.source !== 'ocr' || (!nb.left && !nb.right)) return null;
  const span = (nb.left || nb.right).span;
  if (!span.ocr) return null;
  const setInfo = pvSetsForBox(span);
  if (!setInfo) return null;
  const leftChars = nb.left ? hvWordChars(nb.left) : [];
  const rightChars = nb.right ? hvWordChars(nb.right) : [];
  const adj = leftChars.length ? leftChars[leftChars.length - 1].cp : rightChars.length ? rightChars[0].cp : null;
  const set = (adj?.src && setInfo.byName.get(adj.src)) || setInfo.primary;
  // viewBox px per page px: the OCR boxes were scaled by this when created
  const info = pvPageInfo(box.page);
  const sx = info ? (state.pageWidth || info.page.w) / info.page.w : 1;
  const ri = box.refineInfo;
  const space = ri?.left?.space ?? ri?.right?.space ?? ((span.ocr.spaceAdv ?? pvSpaceAdv(span, set)) * sx);
  const widths = strings.map(s => {
    const text = box.uppercase ? String(s).toUpperCase() : String(s);
    const lay = OCRRender.layoutLine(set, text, 0, { spaceAdv: space / sx });
    return lay.missing.length ? null : lay.advanceW * sx;
  });
  return { widths, face: set.name };
}
window.ocrMeasureWidths = ocrMeasureWidths;
