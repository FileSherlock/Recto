// ocr-tool.js — Auto OCR plugin adapter (Recto-owned, NOT synced from tol0;
// the others are ocr-worker.js, law-worker.js, ocr-result.js, box-rules.js and pixel-view.js). Runs the
// blind reader (engine/blindocr.js) on the page rasters the viewer already
// holds — inside a Worker (ocr-worker.js), so the page stays live while a
// read runs — and feeds the results into the unified text box system exactly
// like embedded_text_viewer feeds embedded spans: one UnifiedTextBox per read
// line (type 'ocr'), with baseCharPositions at the reader's measured ¼-px
// pens, plus type 'redaction' boxes for detected redaction rectangles.
//
// The engine reads the SAME pixels the user is looking at (Doc.pageImageURL —
// the embedded, ratio-cropped page raster), so box coordinates line
// up with the viewer by construction. Coordinates are scaled from raster
// pixels into the 816×1056 viewBox space (sx = state.pageWidth / naturalWidth
// — 1.0 for the proven 96-dpi document family).

const ocrToolState = {
  engine: null,     // PageEngine (engine/ocr.js)
  sets: null,       // parsed glyph sets — MAIN-thread copy: the pixel view and the inline fallback
  setUrls: null,    // glyph bundle urls from index.json (what both threads load)
  worker: null,     // the reader's Worker (ocr-worker.js), once ready
  workerReady: null,  // promise of that worker; rejected = no Worker, read inline
  workerJob: null,  // the page read in flight: { id, resolve, reject, progress }
  workerSeq: 0,
  readVia: null,    // 'worker' | 'inline' — where the last page read ran (the smoke test asserts 'worker')
  running: false,
  cancel: false,
  passHint: null,   // winning pass of the previous page (producer is stable)
  autoSeq: 0,       // auto-read generation — a new document supersedes the old cycle
  autoDone: false,  // true once the auto read + layer choice for this document settled
  isDefault: false, // current doc is the auto-loaded startup PDF
};

const OCR_GLYPHS_BASE = 'plugins/ocr_tool/glyphs/';
const OCR_WORKER_URL = assetURL('plugins/ocr_tool/ocr-worker.js');
const OCR_UNCLEAN_COLOR = 'rgba(230, 124, 0, 0.85)';   // non-byte-clean lines
const OCR_UNREAD_COLOR = 'rgba(217, 48, 37, 0.85)';    // □ marker boxes
const OCR_CACHE_DIR = 'plugins/ocr_tool/cache/';       // shipped caches: <document sha256>.json
const OCR_CACHE_DB = 'recto-ocr-cache';                // IndexedDB: this browser's own reads
const OCR_CACHE_KEEP = 8;                              // documents kept there, most recent first
const OCR_CACHE_VERSION = 3;   // bump when the slim payload shape changes (2: spaceAdv + entry src; 3: only black boxes are kept)

function setOcrStatus(msg) {
  const el = document.getElementById('ocr-status');
  if (el) { el.textContent = msg; el.title = msg; }  // title: full text survives the ellipsis
}

// the glyph bundle urls index.json lists (a bare glyphs.bin = every set) —
// what the worker loads for reading and the main thread for the pixel view
async function ocrSetUrls() {
  if (ocrToolState.setUrls) return ocrToolState.setUrls;
  let names = [];
  try {
    const r = await fetch(assetURL(OCR_GLYPHS_BASE + 'index.json'));
    if (r.ok) names = await r.json();
  } catch { /* fall through to the error below */ }
  if (!names.length) throw new Error('no glyph sets — run "npm run sync:recto" in tol0');
  // absolute: the Worker resolves a relative url against its own script, not the page
  ocrToolState.setUrls = names.map(n => new URL(assetURL(OCR_GLYPHS_BASE + n), document.baseURI).href);
  return ocrToolState.setUrls;
}

// main-thread sets: the MuPDF pixel view draws from them, and a browser
// without Workers reads with them; a worker read never needs them here
async function ocrLoadSets() {
  if (ocrToolState.sets) return ocrToolState.sets;
  const sets = await BlindOCR.loadSets(await ocrSetUrls());
  if (!sets.length) throw new Error('glyph sets failed to load');
  ocrToolState.sets = sets;
  return sets;
}

// ── The reader's Worker ───────────────────────────────────────
// The engine is synchronous and yields to the event loop only between bands;
// a page in an unmodelled face runs the whole tolerance ladder (tens of
// seconds with the full bundle) and used to freeze zooming and page changes
// for that long. ocr-worker.js runs the same engine files off the main
// thread; what comes back is the slim result (ocr-result.js), the shape the
// precomputed cache already replays through ocrAddBoxes.

// the engine scripts exactly as this page loaded them (the build's content-hashed
// urls), so the worker runs the synced bytes and never a stale copy
function ocrWorkerScripts() {
  return [...document.querySelectorAll('script[src]')].map(el => el.src)
    .filter(src => /\/ocr_tool\/(engine\/(core|ocr-engine|blindocr)\.js|ocr-result\.js)/.test(src));
}

// the Worker, created on first use — resolves once its engine scripts are
// in; rejects when Workers are unavailable (the read then runs inline)
function ocrWorker() {
  if (ocrToolState.workerReady) return ocrToolState.workerReady;
  ocrToolState.workerReady = new Promise((resolve, reject) => {
    if (typeof Worker === 'undefined') return reject(new Error('no Worker support'));
    const scripts = ocrWorkerScripts();
    if (scripts.length < 4) return reject(new Error('engine scripts not found on the page'));
    let w;
    try { w = new Worker(OCR_WORKER_URL); } catch (e) { return reject(e); }
    const fail = (err) => {
      reject(err);
      const job = ocrToolState.workerJob;
      if (job) { ocrToolState.workerJob = null; job.reject(err); }
    };
    w.onerror = (e) => fail(e.error || new Error(e.message || 'OCR worker error'));
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') { ocrToolState.worker = w; resolve(w); return; }
      if (m.type === 'error' && m.id === null) { fail(new Error(m.message)); return; }
      const job = ocrToolState.workerJob;
      if (!job || m.id !== job.id) return;             // a reply to a job nobody waits for
      if (m.type === 'progress') { job.progress?.(m.pass, m.done, m.total); return; }
      ocrToolState.workerJob = null;
      if (m.type === 'result') job.resolve({ res: m.res, pass: m.pass });
      else if (m.type === 'cancelled') job.resolve(null);
      else job.reject(new Error(m.message));
    };
    w.postMessage({ type: 'init', scripts });
  });
  return ocrToolState.workerReady;
}

// one page through the worker → { res, pass } (slim), or null when cancelled.
// The page buffer goes by structured clone: the main thread keeps its copy
// (PageEngine caches it and the pixel view reads the same buffer).
function ocrWorkerRead(w, page, opts) {
  return new Promise((resolve, reject) => {
    const id = ++ocrToolState.workerSeq;
    ocrToolState.workerJob = { id, resolve, reject, progress: opts.progress };
    w.postMessage({ type: 'read', id, w: page.w, h: page.h, gray: page.gray,
      converted: page.converted || null, setUrls: opts.setUrls,
      passHint: opts.passHint, carry: opts.carry });
  });
}

// stop the current run: no further page starts, and the page in flight is
// abandoned at its next band (the worker replies 'cancelled', no boxes)
function ocrCancel() {
  ocrToolState.cancel = true;
  ocrToolState.worker?.postMessage({ type: 'cancel' });
}

// page raster (a blob: URL from the document service) -> loaded <img>
// (null when the page has no raster)
async function ocrLoadPageImage(pageNum) {
  let src = null;
  try { src = await Doc.pageImageURL(pageNum); } catch { /* no such page, or no document */ }
  if (!src) return null;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`page ${pageNum} raster failed to load`));
    img.src = src;
  });
}

// Set name ('timesbdlin16', 'nimbus791', union 'a+b') -> the face it was
// rendered from, from the generated engine/set-fonts.js (glyph-registry
// PROVENANCE). A union name resolves through its first member; callers with
// per-glyph src pass the majority set instead.
function ocrFontFromSetName(name) {
  const first = (name || '').split('+')[0];
  const f = typeof OCR_SET_FONTS !== 'undefined' ? OCR_SET_FONTS[first] : null;
  return f ? { family: f.family, bold: !!f.bold, italic: !!f.italic }
           : { family: 'Times New Roman', bold: false, italic: false };
}

// The set that drew most of a segment's glyphs (union lines mix faces —
// a bold label, a regular value): per-glyph src, else the line's font label.
function ocrMajoritySet(seg, fallback) {
  const votes = new Map();
  for (const e of seg) if (e.src) votes.set(e.src, (votes.get(e.src) || 0) + 1);
  let best = null, n = 0;
  for (const [s, c] of votes) if (c > n) { best = s; n = c; }
  return best || fallback;
}

// After a read: the dominant face and size of the certified lines, told to
// the text tool through the generic typography:detected event (fonts.js
// selects it as the default for new boxes). Weighted by glyph count.
function ocrEmitTypography() {
  const tally = new Map();
  for (const b of utbState.boxes) {
    if (b.type !== 'ocr' || !b.ocr?.clean || !b.text) continue;
    const k = `${b.fontFamily}|${Math.round(b.sizePt * 100) / 100}`;
    tally.set(k, (tally.get(k) || 0) + b.text.replace(/\s+/g, '').length);
  }
  if (!tally.size) return;
  const [key] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  const [fontFamily, sizePt] = key.split('|');
  PDFHooks.emit('typography:detected', { fontFamily, sizePt: +sizePt, source: 'ocr' });
}

// Rebuild per-char positions from a line's entries + transcription, walking
// the text so inserted spaces and ligature expansions ('ﬁ'->"fi") line up
// exactly with lineEntries' construction. x values are relative to x0
// (raster px — caller applies the viewBox scale).
function ocrCharPositions(L, x0) {
  const byOffset = new Map();
  for (const e of L.entries) byOffset.set(e.i, e);
  const chars = [];
  let ti = 0, prevEnd = null, spaceStart = null;
  while (ti < L.text.length) {
    const e = byOffset.get(ti);
    if (!e) {                                  // inserted space run
      if (spaceStart === null) spaceStart = ti;
      ti++;
      continue;
    }
    if (spaceStart !== null) {
      const n = ti - spaceStart, gapStart = prevEnd ?? e.pen;
      const w = (e.pen - gapStart) / n;
      for (let s = 0; s < n; s++) chars.push({ c: ' ', x: gapStart + s * w - x0, w });
      spaceStart = null;
    }
    const two = L.text.slice(ti, ti + 2);
    const isLig = (e.ch === 'ﬁ' && two === 'fi') || (e.ch === 'ﬂ' && two === 'fl');
    if (isLig) {
      // the page holds ONE ligature glyph: mark the pair so a pixel renderer
      // draws e.ch at the first pen and skips the tail (SVG text is unaffected)
      chars.push({ c: two[0], x: e.pen - x0, w: e.adv / 2, lig: e.ch, src: e.src });
      chars.push({ c: two[1], x: e.pen + e.adv / 2 - x0, w: e.adv / 2, ligTail: true });
      ti += 2;
    } else {
      chars.push({ c: L.text[ti], x: e.pen - x0, w: e.adv, src: e.src });
      ti += 1;
    }
    prevEnd = e.pen + e.adv;
  }
  return chars;
}

// Remove everything a previous OCR run added to this page.
function ocrClearPage(pageNum) {
  utbState.boxes = utbState.boxes.filter(b => !(b.ocrSource && b.page === pageNum));
}

// One page's read result -> UnifiedTextBoxes. Returns per-page tallies.
function ocrAddBoxes(pageNum, img, res, pass) {
  const sx = (state.pageWidth || img.naturalWidth) / img.naturalWidth;
  const sy = (state.pageHeight || img.naturalHeight) / img.naturalHeight;
  const tally = { lines: 0, clean: 0, unread: 0, boxes: 0 };

  let n = 0;
  for (const L of res.lines) {
    n++;
    if (!L.set || !L.entries?.length) {
      // unreadable band — an honest red □ marker at the band's ink start
      const x = (L.fails?.[0] ?? 0) * sx;
      const box = utbState.addBox(new UnifiedTextBox({
        type: 'ocr', page: pageNum, text: '□',
        lineId: `ocr_p${pageNum}_l${n}`,
        x, y: L.top * sy, w: 40 * sx, h: Math.max(8, (L.bot - L.top)) * sy,
        sizePt: 12, color: OCR_UNREAD_COLOR,
      }));
      box.ocrSource = true;
      box.ocr = { clean: false, unread: true };
      tally.unread++;
      continue;
    }

    const set = L.set;

    // Which set drew each glyph: a union pool ('a+b') accepts glyphs from
    // several sets, and the engine records that on L.glyphs[].src. Carry it
    // onto the entries (keyed by pen — entries are the glyphs in pen order)
    // so the pixel view can re-render a mixed-font line with the right
    // bitmaps. A cached result already has entry.src from the slim payload.
    if (L.glyphs?.length) {
      const srcAt = new Map();
      for (const g of L.glyphs) if (g.src) srcAt.set(g.pen, g.src);
      for (const e of L.entries) if (e.src === undefined && srcAt.has(e.pen)) e.src = srcAt.get(e.pen);
    }

    // invert svg-renderer's computeBaseline (y + h·0.85 − 1.3) so the SVG
    // text sits on the MEASURED baseline exactly
    const h = (set.maxAsc + set.maxDesc) * sy;
    const y = L.baseline * sy - (h * 0.85 - 1.3);

    // A redaction box interrupting the line ALWAYS splits it into separate
    // text boxes, one per side, each anchored at its own measured pen and
    // carrying no separator spaces (the segment after a box must not ride as
    // trailing chars of the segment before it). The predicate is the
    // engine's boxBetween — the one that put the single separator space into
    // L.text — so the two views can never disagree about where a bar is.
    const rects = L.boxes ?? [];
    const segs = [[L.entries[0]]];
    for (let i = 1; i < L.entries.length; i++) {
      if (BlindOCR.boxBetween(rects, L.entries[i - 1], L.entries[i])) segs.push([]);
      segs[segs.length - 1].push(L.entries[i]);
    }

    for (const seg of segs) {
      const first = seg[0], last = seg[seg.length - 1];
      const txLen = ch => (ch === 'ﬁ' || ch === 'ﬂ') ? 2 : 1;   // ligatures transcribe as 2 chars
      const startOff = first.i, endOff = last.i + txLen(last.ch);
      const segLine = { text: L.text.slice(startOff, endOff),
        entries: seg.map(e => ({ ...e, i: e.i - startOff })) };
      const x0 = first.pen;
      const { family, bold, italic } = ocrFontFromSetName(ocrMajoritySet(seg, L.font));
      // keep every field ocrCharPositions marks (lig/ligTail, src) — the pixel
      // view needs them; only the geometry is scaled into viewBox space
      const chars = ocrCharPositions(segLine, x0).map(cp => ({ ...cp, x: cp.x * sx, w: cp.w * sx }));

      const box = utbState.addBox(new UnifiedTextBox({
        type: 'ocr', page: pageNum, text: segLine.text,
        lineId: `ocr_p${pageNum}_l${n}`,      // segments share the line — redactions connect to it
        x: x0 * sx, y, w: (last.pen + last.adv - x0) * sx, h,
        fontFamily: family, bold, italic,
        sizePt: set.sizePx * 0.75 * sx,
        baseCharPositions: chars,
        color: L.clean ? null : OCR_UNCLEAN_COLOR,
      }));
      box.ocrSource = true;
      box.ocr = { clean: !!L.clean, tol: pass.tol || 0, quant: !!pass.quant,
        // the reader's entries for this segment (offset, glyph, pen, advance,
        // drawing set) — what the pixel view re-lays an EDITED line from: the
        // unchanged part keeps its pens, the rest follows the producer's law
        entries: segLine.entries,
        union: !!pass.union, font: L.font, baseline: L.baseline, fails: L.fails.length,
        // the y-phase records the reader pinned the line to (0, or 0.5 on a
        // legacy set) — the pixel view re-draws with the same records
        phy: L.phy ?? 0,
        // the band the reader judged (rows) — the pixel view's residual check
        // looks for page ink here that no drawn glyph explains
        top: L.top, bot: L.bot,
        // the reader's own residual: ink pixels in the band it could not explain
        // (clean ⇔ no fails and residual 0)
        residual: L.residual ?? 0,
        // the space this line was shaped with — its set's calibration on the
        // page (a Times header and a Courier body differ), the page's when a
        // cached read predates per-set calibration — what a re-layout of
        // edited text uses for a new break
        spaceAdv: L.spaceAdv ?? res.spaceAdv ?? null };
    }
    tally.lines++;
    if (L.clean) tally.clean++;
  }

  // the law this page's producer laid its text with, per set — learned from
  // the certified pens once they are boxes (async: it waits for the font's
  // kern table; the pixel view redraws when it lands)
  ocrLearnProducer(pageNum, res);

  // detected redaction rectangles -> redaction boxes (the same kind the Add
  // Box tool creates; the matching suite picks them up when installed)
  for (const ob of (res.objects || []).filter(o => o.type === 'box')) {
    const box = utbState.addBox(new UnifiedTextBox({
      type: 'redaction', page: pageNum, text: '',
      x: ob.x0 * sx, y: ob.y0 * sy,
      w: (ob.x1 - ob.x0 + 1) * sx, h: (ob.y1 - ob.y0 + 1) * sy,
    }));
    box.ocrSource = true;
    tally.boxes++;
  }

  return tally;
}

// ── The producer's law ────────────────────────────────────────
// A certified line fixes the face, the size and every pen; how the producer
// ARRIVED at the pens — advances at the PDF's 1/1000 em or the font's hmtx,
// the size it laid at, whether it kerned — is not in the glyph set, and it
// differs between documents in the same face (measured in Recto's lab,
// 2026-09: Courier New at the PDF's 7.8 px where the set says 7.80127;
// Nimbus Mono laid at 12.36 px where the set says 12.359375; one email
// header kerned with the font's table, its body not). It is learned per
// (page, set) from the certified pens by engine/render.js producerMetrics,
// judged against the face's own kern table from text_tool
// (FontCatalog.metrics → Shaping.fontMetrics, HarfBuzz), so a pair the page never
// wrote — "Yo", "Ve" — is still laid the way THIS producer would have. The
// pixel view lays edited and typed text with it (window.ocrProducerFor).
const ocrProducer = new Map();   // `${docHash}|${page}|${set}` -> the law (render.js producerMetrics + set, family, tableKnown)

const ocrProducerKey = (pageNum, setName) => `${state.docHash}|${pageNum}|${setName}`;

// the law learned for a set on a page, or null (not learned yet / nothing certified in it)
window.ocrProducerFor = function (pageNum, setName) {
  return ocrProducer.get(ocrProducerKey(pageNum, setName)) || null;
};
// every law learned on a page (status, tests)
window.ocrProducerList = function (pageNum) {
  const pre = `${state.docHash}|${pageNum}|`;
  return [...ocrProducer.entries()].filter(([k]) => k.startsWith(pre)).map(([, m]) => m);
};

// producerMetrics searches the laid size for every hypothesis that can still
// win — about a second of plain arithmetic per searched hypothesis on a
// Courier page (measured 2026-09 on the startup document), after every page
// of a read and for every page of a cache replay. On the main thread that
// froze the page for that long, page after page; law-worker.js runs the same engine file in a Worker of its own,
// so the reader's worker goes on with the next page meanwhile.
const OCR_LAW_WORKER_URL = assetURL('plugins/ocr_tool/law-worker.js');
const ocrLawJobs = new Map();   // id -> { resolve, reject }
let ocrLawWorkerReady = null;   // promise of the worker; rejected = no Worker, learn inline
let ocrLawSeq = 0;

function ocrLawWorker() {
  if (ocrLawWorkerReady) return ocrLawWorkerReady;
  ocrLawWorkerReady = new Promise((resolve, reject) => {
    if (typeof Worker === 'undefined') return reject(new Error('no Worker support'));
    // the engine script exactly as this page loaded it (the build's content-hashed url)
    const script = [...document.querySelectorAll('script[src]')].map(el => el.src)
      .find(src => /\/ocr_tool\/engine\/render\.js/.test(src));
    if (!script) return reject(new Error('engine/render.js not found on the page'));
    let w;
    try { w = new Worker(OCR_LAW_WORKER_URL); } catch (e) { return reject(e); }
    const fail = (err) => {
      reject(err);
      for (const job of ocrLawJobs.values()) job.reject(err);
      ocrLawJobs.clear();
    };
    w.onerror = (e) => fail(e.error || new Error(e.message || 'law worker error'));
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') { resolve(w); return; }
      if (m.type === 'error' && m.id === null) { fail(new Error(m.message)); return; }
      const job = ocrLawJobs.get(m.id);
      if (!job) return;
      ocrLawJobs.delete(m.id);
      if (m.type === 'law') job.resolve(m.metrics); else job.reject(new Error(m.message));
    };
    w.postMessage({ type: 'init', script });
  });
  return ocrLawWorkerReady;
}

// render.js producerMetrics(lines, opts) → the law; in the worker, inline only
// where there is no Worker (or it failed) — the same function either way
async function ocrProducerMetrics(lines, opts) {
  try {
    const w = await ocrLawWorker();
    return await new Promise((resolve, reject) => {
      const id = ++ocrLawSeq;
      ocrLawJobs.set(id, { resolve, reject });
      w.postMessage({ type: 'learn', id, lines, opts });
    });
  } catch (e) {
    if (!ocrProducerMetrics.warned) console.warn('OCR: law worker unavailable, learning on the main thread:', e.message || e);
    ocrProducerMetrics.warned = true;
    return OCRRender.producerMetrics(lines, opts);
  }
}

async function ocrLearnProducer(pageNum, res) {
  if (typeof OCRRender === 'undefined' || typeof OCRRender.producerMetrics !== 'function') return;
  const hash = state.docHash;
  const bySet = new Map();   // set name -> { sizePx, lines: [{entries}] }
  for (const L of res.lines || []) {
    if (!L.clean || !L.font || !L.entries?.length) continue;
    const sizePx = L.set?.sizePx;
    if (!sizePx) continue;
    // a union line reports one font label; each glyph carries the set that drew it
    const names = new Set([L.font.split('+')[0]]);
    for (const e of L.entries) if (e.src) names.add(e.src);
    for (const name of names) {
      const own = L.entries.filter(e => e.ch !== '□' && (e.src || L.font.split('+')[0]) === name);
      if (own.length < 2) continue;
      if (!bySet.has(name)) bySet.set(name, { sizePx, lines: [] });
      bySet.get(name).lines.push({ entries: own });
    }
  }
  let learned = 0;
  for (const [name, { sizePx, lines }] of bySet) {
    const { family, bold, italic } = ocrFontFromSetName(name);
    let table = null;
    try { table = (await window.FontCatalog?.metrics?.(family, bold, italic, sizePx))?.kern || null; } catch { table = null; }
    if (hash !== state.docHash) return;                 // the document changed while the table was fetched
    const m = await ocrProducerMetrics(lines, { sizePx, kernTable: table, spaceAdv: res.spaceAdv ?? null });
    if (hash !== state.docHash) return;                 // … or while the law was learned
    m.set = name; m.family = family; m.tableKnown = !!table;
    ocrProducer.set(ocrProducerKey(pageNum, name), m);
    learned++;
  }
  // boxes laid by the law (edited or typed text) are drawn again with it —
  // and a box whose kerning nobody chose takes the page's now (text_tool asks
  // window.utbAutoKerning at render time), in SVG as well as in pixels
  if (learned) {
    if (window.PixelView?.state?.on) { window.PixelView.invalidate?.(); window.renderAllTextLayers?.(); }
    else if (typeof renderBox === 'function')
      for (const b of utbState.boxes) if (b.page === pageNum && b.kerningAuto) renderBox(b);
    window.syncToolbarToSelection?.();
  }
}

// ── The read cache ─────────────────────────────────────────────
// A finished whole-document read is kept, slimmed, under the document's
// sha256 (state.docHash), and a later open of the same bytes replays the boxes
// through ocrAddBoxes without the engine — or the ~10 MB glyph download.
// Two tiers, the same JSON ({ version, pages }) and the same version check:
//   1. shipped: plugins/ocr_tool/cache/<sha256>.json, committed to the repo —
//      the startup document reads instantly for every visitor. The build's
//      asset map says whether a file exists, so a miss costs no request.
//   2. IndexedDB: what this browser read itself. It never leaves the browser;
//      the last OCR_CACHE_KEEP documents are kept.
// A fresh browser profile has no second tier, so tol0's recto smoke test
// (which uploads its certified document) still exercises the real engine.
// To ship a cache after swapping the startup PDF: open the app, let the read
// finish, run ocrExportCache() in the console and commit the downloaded file
// to web/plugins/ocr_tool/cache/.

// The slimming itself (ocrSlimResult / ocrSlimPass) lives in ocr-result.js:
// the worker posts slim results, the cache stores them, and a live inline
// read is slimmed here — one shape, one code path (ocrAddBoxes).

const ocrCacheValid = data => data?.version === OCR_CACHE_VERSION && Array.isArray(data.pages);

function ocrCacheDb() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(OCR_CACHE_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('documents', { keyPath: 'hash' }).createIndex('savedAt', 'savedAt');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

const ocrIdb = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function ocrFetchCache(hash) {
  if (!hash) return null;
  try {
    const shipped = `${OCR_CACHE_DIR}${hash}.json`;
    if (window.RECTO_ASSETS?.[shipped]) {
      const r = await fetch(assetURL(shipped));
      const data = r.ok ? await r.json() : null;
      if (ocrCacheValid(data)) return data;
    }
  } catch { /* fall through to this browser's own reads */ }
  try {
    const db = await ocrCacheDb();
    try {
      const row = await ocrIdb(db.transaction('documents').objectStore('documents').get(hash));
      return ocrCacheValid(row) ? { version: row.version, pages: row.pages } : null;
    } finally { db.close(); }
  } catch { return null; }
}

// Best-effort: a private window or a full disk just means the next open reads again.
async function ocrStoreCache(hash, payload) {
  try {
    const db = await ocrCacheDb();
    try {
      const tx = db.transaction('documents', 'readwrite'), store = tx.objectStore('documents');
      store.put({ hash, savedAt: Date.now(), ...payload });
      const keys = await ocrIdb(store.index('savedAt').getAllKeys());     // oldest first
      for (const key of keys.slice(0, Math.max(0, keys.length - OCR_CACHE_KEEP))) store.delete(key);
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); });
      console.info('OCR: read cached for', hash.slice(0, 12));
    } finally { db.close(); }
  } catch { /* never surface */ }
}

// Dev helper: download the open document's cached read as <sha256>.json, the
// file to commit under web/plugins/ocr_tool/cache/.
window.ocrExportCache = async function () {
  const data = await ocrFetchCache(state.docHash);
  if (!data) { console.warn('OCR: no finished read of this document to export'); return false; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = `${state.docHash}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return true;
};

// Rebuild boxes from a cache payload — same tail as a live full read.
function ocrApplyCached(cached) {
  const totals = { lines: 0, clean: 0, unread: 0, boxes: 0 };
  const fonts = new Set();
  for (const pg of cached.pages) {
    ocrClearPage(pg.page);
    const t = ocrAddBoxes(pg.page, { naturalWidth: pg.w, naturalHeight: pg.h }, pg.res, pg.pass);
    totals.lines += t.lines; totals.clean += t.clean;
    totals.unread += t.unread; totals.boxes += t.boxes;
    for (const L of pg.res.lines) if (L.font) fonts.add(L.font);
  }
  window.utbConnectRedactionsToLines?.();
  if (typeof renderAllTextLayers === 'function') renderAllTextLayers();
  if (typeof calculateAllWidths === 'function') calculateAllWidths();
  ocrEmitTypography();
  // same status wording as a live run, flagged as precomputed
  const lastPass = cached.pages[cached.pages.length - 1]?.pass || {};
  const cert = lastPass.tol ? `clean@±${lastPass.tol}` : 'byte-clean';
  const shownFonts = [...new Set([...fonts].map(f => f.includes('+') ? 'mixed fonts' : f))];
  setOcrStatus(`${totals.lines} lines, ${totals.clean} ${cert}` +
    (totals.unread ? `, ${totals.unread} unread (□)` : '') +
    (totals.boxes ? ` · ${totals.boxes} redaction boxes` : '') +
    ` · ${shownFonts.join(' ') || '—'}` +
    (lastPass.quant ? ' · palette producer' : '') +
    ' · precomputed');
}

// ── Which boxes are redactions ────────────────────────────────
// The reader's detectObjects calls any long near-solid dark run a box; a grey
// table cell, a logo's plate, a thick rule, a photograph or a page border
// arrive with the redactions. box-rules.js (OCRBoxRules) keeps a box that is
// black and stands where text stands — on a line, or on the page's text grid
// — and drops the rest here, before the read is slimmed, so the cache
// (version 3) holds only what stays. The dropped regions stay inspectable:
// OCRTool.dropped(page) → [{ x0, y0, x1, y1, black, onLine, gap, hPitch, why }]
// (raster px; black = the interior's black fraction; why = what failed).
const ocrDropped = new Map();
function ocrKeepRedactionBoxes(page, pageNum, res) {
  if (!res?.objects?.length || typeof OCRBoxRules === 'undefined') return 0;
  const { kept, dropped } = OCRBoxRules.filter(page, res.lines || [], res.objects);
  res.objects = kept;
  ocrDropped.set(`${state.docHash}|${pageNum}`, dropped);
  return dropped.length;
}

// one page: { img, res, pass } — res slim when it came through the worker
// (ocrAddBoxes reads the same fields either way) — or null when the page has
// no raster or the read was cancelled. carry: null for a single page, the
// run's { fresh } marker for Read-all-pages (cross-page baseline hints live
// in the worker, per run; inline they live on this object).
async function ocrReadOnePage(pageNum, label, carry) {
  const img = await ocrLoadPageImage(pageNum);
  if (!img) return null;
  ocrToolState.engine ??= new PageEngine();
  const page = BlindOCR.whitenColored(ocrToolState.engine._pageFor(img),
    ocrToolState.engine.pageRGBA(img));
  const progress = (p, d, t) => setOcrStatus(`${label}${BlindOCR.passLabel(p)}: ${d}/${t} bands…`);
  const w = await ocrWorker().catch(e => {
    console.warn('OCR: no worker, reading on the main thread —', e?.message || e);
    return null;
  });
  let out;
  ocrToolState.readVia = w ? 'worker' : 'inline';
  if (w) {
    const mode = !carry ? 'none' : carry.fresh ? 'new' : 'keep';
    if (carry) carry.fresh = false;
    out = await ocrWorkerRead(w, page, { setUrls: await ocrSetUrls(),
      passHint: ocrToolState.passHint, carry: mode, progress });
    if (!out) return null;                              // cancelled mid-page
  } else {
    const sets = await ocrLoadSets();
    out = await BlindOCR.readPageAuto(page, sets, { passHint: ocrToolState.passHint, carry, progress });
  }
  ocrToolState.passHint = out.pass;
  const dropped = ocrKeepRedactionBoxes(page, pageNum, out.res);
  if (dropped) console.info(`OCR: page ${pageNum}: ${dropped} dark region(s) are not redactions —`, ocrDropped.get(`${state.docHash}|${pageNum}`).map(d => d.why).join(', '));
  return { img, res: out.res, pass: out.pass, dropped };
}

function ocrSetButtons(running) {
  document.getElementById('ocr-run-page')?.toggleAttribute('disabled', running);
  document.getElementById('ocr-run-all')?.toggleAttribute('disabled', running);
  document.getElementById('ocr-cancel')?.classList.toggle('hidden', !running);
}

async function ocrRun(allPages) {
  if (ocrToolState.running) return;
  if (typeof utbState === 'undefined' || typeof BlindOCR === 'undefined') {
    setOcrStatus('OCR: text_tool and the synced engine are required');
    return;
  }
  if (!state.numPages) {
    setOcrStatus('OCR: no document loaded');
    return;
  }
  ocrToolState.running = true;
  ocrToolState.cancel = false;
  ocrSetButtons(true);
  try {
    const nums = allPages
      ? Array.from({ length: state.numPages }, (_, i) => i + 1)
      : [state.currentPage];
    const totals = { lines: 0, clean: 0, unread: 0, boxes: 0, dropped: 0 };
    // sequential whole-document read: pages share one hint carry (same as
    // char_training's blindOcrDocument); single-page reads stay stateless
    const carry = allPages ? { fresh: true } : null;
    // a full read is cached under the document's hash (see "The read cache")
    const runHash = state.docHash;
    const collected = (allPages && runHash) ? [] : null;
    let lastPass = null, fonts = new Set();
    for (const p of nums) {
      if (ocrToolState.cancel) break;
      const label = allPages ? `OCR ${p}/${state.numPages}` : `OCR p${p}`;
      const out = await ocrReadOnePage(p, label, carry);
      if (!out) continue;
      ocrClearPage(p);
      const t = ocrAddBoxes(p, out.img, out.res, out.pass);
      totals.lines += t.lines; totals.clean += t.clean;
      totals.unread += t.unread; totals.boxes += t.boxes; totals.dropped += out.dropped || 0;
      lastPass = out.pass;
      for (const L of out.res.lines) if (L.font) fonts.add(L.font);
      collected?.push({ page: p, w: out.img.naturalWidth, h: out.img.naturalHeight,
        pass: ocrSlimPass(out.pass), res: ocrSlimResult(out.res) });
    }
    if (collected?.length === nums.length && !ocrToolState.cancel)      // every page read: worth replaying
      ocrStoreCache(runHash, { version: OCR_CACHE_VERSION, pages: collected });
    window.utbConnectRedactionsToLines?.();
    if (typeof renderAllTextLayers === 'function') renderAllTextLayers();
    if (typeof calculateAllWidths === 'function') calculateAllWidths();
    ocrEmitTypography();
    if (lastPass) {
      const cert = lastPass.tol ? `clean@±${lastPass.tol}` : 'byte-clean';
      // a union pool's set name is 'a+b+…' — too noisy for the status line;
      // 'mixed fonts' already conveys what the (mixed-font) pass label would
      const shownFonts = [...new Set([...fonts].map(f => f.includes('+') ? 'mixed fonts' : f))];
      setOcrStatus(`${totals.lines} lines, ${totals.clean} ${cert}` +
        (totals.unread ? `, ${totals.unread} unread (□)` : '') +
        (totals.boxes ? ` · ${totals.boxes} redaction boxes` : '') +
        (totals.dropped ? ` · ${totals.dropped} dark region(s) not redactions` : '') +
        ` · ${shownFonts.join(' ') || '—'}` +
        (lastPass.quant ? ' · palette producer' : '') +
        (ocrToolState.cancel ? ' · cancelled' : ''));
    } else {
      setOcrStatus('OCR: no readable page rasters');
    }
  } catch (e) {
    console.warn('OCR:', e);
    setOcrStatus(`OCR: ${e.message}`);
  } finally {
    ocrToolState.running = false;
    ocrSetButtons(false);
  }
}

// ── Auto OCR on load + layer choice ───────────────────────────
// Every loaded document is read automatically (all pages, fire-and-forget so
// openDocument is not blocked). Afterwards the display shows exactly one text
// layer: when the OCR volume is similar to the embedded layer's — or the
// document has no embedded text at all (scanned pages) — the OCR layer wins
// (its per-glyph measured pens beat PDF extraction); otherwise the OCR
// overlay is hidden so the two layers never draw on top of each other.

const OCR_AUTO_SIMILARITY = 0.8;  // min/max non-whitespace char ratio = "similar"

// Non-whitespace characters currently held by one box type ('□' markers and
// OCR-detected redaction rects carry no text, so they never count).
// Embedded boxes exist only for pages the user visited (the viewer hydrates
// lazily) — the rest of the embedded text is counted from the span cache the
// embedded-text plugin exposes (guarded: it's another plugin and may be absent).
function ocrTextAmount(type) {
  let n = 0;
  for (const b of utbState.boxes)
    if (b.type === type && !b.ocr?.unread) n += (b.text || '').replace(/\s+/g, '').length;
  const cache = window.etvSpanCache;
  if (type === 'embedded' && cache) {
    for (let p = 1; p <= (state.numPages || 1); p++) {
      if (cache.isHydrated?.(p) || !cache.hasPage?.(p)) continue;
      for (const s of cache.spansFor(p) || [])
        n += (s.text || '').replace(/\s+/g, '').length;
    }
  }
  return n;
}

// Flip both overlays + their toolbar toggle buttons in one move, so a later
// manual click on either toggle starts from a state that matches the screen.
function ocrShowOcrLayer(showOcr) {
  document.body.classList.toggle('hide-ocr-text', !showOcr);
  document.body.classList.toggle('hide-embedded-text', showOcr);
  document.getElementById('ocr-toggle-text')?.classList.toggle('active', showOcr);
  document.getElementById('toggle-embedded-text')?.classList.toggle('active', !showOcr);
}

function ocrChooseLayer() {
  const ocr = ocrTextAmount('ocr'), emb = ocrTextAmount('embedded');
  if (!ocr) return;                       // nothing read — leave the display alone
  const ratio = emb ? Math.min(ocr, emb) / Math.max(ocr, emb) : 1;
  const showOcr = ratio >= OCR_AUTO_SIMILARITY;
  ocrShowOcrLayer(showOcr);
  const status = document.getElementById('ocr-status')?.textContent || '';
  setOcrStatus(status + (showOcr
    ? (emb ? ` · showing OCR (${Math.round(ratio * 100)}% of embedded text)` : ' · showing OCR (no embedded text)')
    : ` · embedded text kept (OCR read only ${Math.round(ratio * 100)}%)`));
}

async function ocrAutoRead() {
  const seq = ++ocrToolState.autoSeq;
  const live = () => seq === ocrToolState.autoSeq;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // let a cancelled run on the previous document drain before starting
  while (ocrToolState.running) { await sleep(150); if (!live()) return; }
  // Replay a cached read when one matches these bytes — no engine, instant
  // boxes (shipped for the startup document, else this browser's own).
  let applied = false;
  if (typeof utbState !== 'undefined') {
    const cached = await ocrFetchCache(state.docHash);
    if (!live() || ocrToolState.running) return;
    if (cached) { ocrApplyCached(cached); applied = true; }
  }
  if (!applied) {
    await ocrRun(true);
    // still running here = ocrRun bounced off a manual run that won the race
    if (!live() || ocrToolState.running || ocrToolState.cancel) return;
  }
  // the embedded span fetch races the (much slower) OCR run — normally it
  // finished long ago, but give a long document's scan a moment before comparing
  const deadline = Date.now() + 5000;
  while (typeof _utbFetchState !== 'undefined' && !_utbFetchState.fetched &&
         Date.now() < deadline) { await sleep(150); if (!live()) return; }
  ocrChooseLayer();
  ocrToolState.autoDone = true;
}

// ── Wiring ────────────────────────────────────────────────────
// At module scope, NOT in a 'ui:ready' handler: the core emits 'ui:ready'
// before scripts_after_app parse and the hook bus does not replay, so a
// late subscription never fires. This script loads after app.js, so the DOM
// and window.registerSubtoolbar/openSubtoolbar already exist (same pattern
// as text_tool's toolbar.js).

(function wireOcrToolbar() {
  const btn = document.getElementById('toggle-ocr-tool');
  const bar = document.getElementById('ocr-tool-bar');
  if (!btn || !bar) return;
  window.registerSubtoolbar?.(btn);
  btn.addEventListener('click', () => {
    if (bar.classList.contains('hidden')) window.openSubtoolbar?.(bar, btn);
    else window.openSubtoolbar?.(null, null);
  });
  document.getElementById('ocr-run-page')?.addEventListener('click', () => ocrRun(false));
  document.getElementById('ocr-run-all')?.addEventListener('click', () => ocrRun(true));
  document.getElementById('ocr-cancel')?.addEventListener('click', ocrCancel);
  // Show/hide the OCR text overlay globally — same pattern as text_tool's
  // toggle-embedded-text (body class + data-type CSS rule in styles.css).
  document.getElementById('ocr-toggle-text')?.addEventListener('click', () => {
    const btn = document.getElementById('ocr-toggle-text');
    const active = btn.classList.toggle('active');
    document.body.classList.toggle('hide-ocr-text', !active);
  });
})();

// A document is about to be replaced: whatever was finished or running belongs
// to the old one. (Its pages show before 'document:loaded' arrives, and a
// stale autoDone would read as "this document is done".)
PDFHooks.on('document:opening', () => {
  ocrToolState.autoSeq++;                 // an auto read still waiting for the old document gives up
  if (ocrToolState.running) ocrCancel();
  ocrToolState.autoDone = false;
});

// New document: boxes were already reset by the core; drop page-derived state,
// abandon any run still working on the old document, and start the auto read.
PDFHooks.on('document:loaded', (e) => {
  ocrToolState.passHint = null;
  ocrToolState.engine = null;
  if (ocrToolState.running) ocrCancel();
  ocrToolState.autoDone = false;
  ocrToolState.isDefault = !!e?.isDefault;
  setOcrStatus('idle');
  ocrAutoRead();
});

// Programmatic entry point (used by the headless smoke test).
window.OCRTool = { run: ocrRun, autoRead: ocrAutoRead, chooseLayer: ocrChooseLayer, cancel: ocrCancel, state: ocrToolState,
  dropped: pageNum => ocrDropped.get(`${state.docHash}|${pageNum}`) || [] };
