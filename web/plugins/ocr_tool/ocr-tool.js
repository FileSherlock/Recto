// ocr-tool.js — Auto OCR plugin adapter (Recto-owned, NOT synced from tol0;
// the others are ocr-worker.js, law-worker.js, ocr-result.js, box-rules.js,
// line-boxes.js and pixel-view.js). Runs the
// blind reader (engine/blindocr.js) on the page rasters the viewer already
// holds — inside a Worker (ocr-worker.js), so the page stays live while a
// read runs — and feeds the results into the unified text box system exactly
// like embedded_text_viewer feeds embedded spans: one UnifiedTextBox per read
// line (type 'ocr'), with baseCharPositions at the reader's measured ¼-px
// pens, plus type 'redaction' boxes for detected redaction rectangles. Which
// boxes a read makes is line-boxes.js (OCRLineBoxes, DOM-free); this file
// puts them into utbState.
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
  workerHandle: null, // that Worker from its creation on (ocrStopWorker ends it, ready or not)
  workerAbort: null,  // rejects workerReady while the worker still starts (ocrStopWorker)
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
const OCR_CACHE_DIR = 'plugins/ocr_tool/cache/';       // shipped caches: <document sha256>.json
const OCR_CACHE_DB = 'recto-ocr-cache';                // IndexedDB: this browser's own reads
const OCR_CACHE_KEEP = 8;                              // documents kept there, most recent first
const OCR_CACHE_VERSION = 4;   // bump when the slim payload shape changes (2: spaceAdv + entry src; 3: only black boxes are kept; 4: rules kept, entry ink)
const OCR_READ_STAMP = ocrReadStamp(window.RECTO_ASSETS);  // the engine, bundle and worker a read made now is read with (ocr-result.js)

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
    ocrToolState.workerHandle = w;
    ocrToolState.workerAbort = () => reject(Object.assign(new Error('OCR worker stopped'), { stopped: true }));
    const fail = (err) => {
      reject(err);
      const job = ocrToolState.workerJob;
      if (job) { ocrToolState.workerJob = null; job.reject(err); }
    };
    w.onerror = (e) => fail(e.error || new Error(e.message || 'OCR worker error'));
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') { ocrToolState.worker = w; ocrToolState.workerAbort = null; resolve(w); return; }
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
// (PageEngine caches it and the pixel view reads the same buffer). The page
// is whitenColored's whole product — the colour law's acceptance band
// (bandLo/bandHi), the whitened map detectObjects reads, the lost ink
// scanLine will not certify over — not just the grays: until 2026-10-11 only
// `converted` went, and on the corpus's colour pages the worker left 203 □
// where the same engine on the whole page leaves 114 (an e-mail's blue
// links: 47 on one page, 0 with the band).
function ocrWorkerRead(w, page, opts) {
  // Stopped while the page was being prepared: it never goes out. (The worker
  // takes a 'cancel' only for the read in flight — the next read starts
  // afresh — so a page posted after a Stop was read through to its end.)
  if (ocrToolState.cancel) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const id = ++ocrToolState.workerSeq;
    ocrToolState.workerJob = { id, resolve, reject, progress: opts.progress };
    w.postMessage({ type: 'read', id, w: page.w, h: page.h, gray: page.gray,
      converted: page.converted || null, bandLo: page.bandLo || null, bandHi: page.bandHi || null,
      whitened: page.whitened || null, lost: page.lost || null, setUrls: opts.setUrls,
      passHint: opts.passHint, carry: opts.carry });
  });
}

// stop the current run: no further page starts, and the page in flight is
// abandoned at its next band (the worker replies 'cancelled', no boxes). A
// page that does not reach its next band soon — a dark page yields only every
// sixth band, for minutes — ends with its worker; `now`: at once (another
// document is opening, the read is the old one's).
const OCR_CANCEL_GRACE_MS = 3000;
function ocrCancel({ now = false } = {}) {
  ocrToolState.cancel = true;
  const job = ocrToolState.workerJob;
  ocrToolState.worker?.postMessage({ type: 'cancel' });
  if (now) ocrStopWorker();
  else if (job) setTimeout(() => { if (ocrToolState.workerJob === job) ocrStopWorker(); }, OCR_CANCEL_GRACE_MS);
}

// The reader's worker ends, started or still starting: the read in flight
// resolves as cancelled, a start in progress rejects as stopped, and the next
// read starts a new worker (its glyph sets load again).
function ocrStopWorker() {
  const w = ocrToolState.workerHandle, abort = ocrToolState.workerAbort, job = ocrToolState.workerJob;
  ocrToolState.worker = ocrToolState.workerReady = ocrToolState.workerHandle = ocrToolState.workerAbort = null;
  ocrToolState.workerJob = null;
  w?.terminate();
  abort?.();
  job?.resolve(null);
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

// After a read: the dominant face and size of the certified lines
// (OCRLineBoxes.dominantTypography — not after a weak read), told to the text
// tool through the generic typography:detected event (fonts.js selects it as
// the default for new boxes).
function ocrEmitTypography() {
  const t = OCRLineBoxes.dominantTypography(utbState.boxes);
  if (t) PDFHooks.emit('typography:detected', { fontFamily: t.fontFamily, sizePt: t.sizePt, source: 'ocr' });
}

// Remove everything a previous OCR run added to this page.
function ocrClearPage(pageNum) {
  utbState.boxes = utbState.boxes.filter(b => !(b.ocrSource && b.page === pageNum));
}

// One page's read result -> UnifiedTextBoxes (OCRLineBoxes.pageBoxes decides
// which: a box per line segment, a □ marker per unread band, a redaction box
// per detected bar). Returns per-page tallies.
function ocrAddBoxes(pageNum, img, res, pass) {
  const sx = (state.pageWidth || img.naturalWidth) / img.naturalWidth;
  const sy = (state.pageHeight || img.naturalHeight) / img.naturalHeight;
  const { boxes, tally } = OCRLineBoxes.pageBoxes(pageNum, res, pass, { sx, sy });
  for (const spec of boxes) {
    const box = utbState.addBox(new UnifiedTextBox(spec.data));
    box.ocrSource = true;
    if (spec.ocr) box.ocr = spec.ocr;
    if (spec.ink) box.ink = spec.ink;
  }
  // the law this page's producer laid its text with, per set — learned from
  // the certified pens once they are boxes (async: it waits for the font's
  // kern table; the pixel view redraws when it lands)
  ocrLearnProducer(pageNum, res);
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
  const bySet = OCRLineBoxes.lawInputs(res);   // set name -> { sizePx, lines: [{entries}] }
  let learned = 0;
  for (const [name, { sizePx, lines }] of bySet) {
    const { family, bold, italic } = OCRLineBoxes.fontFromSetName(name);
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
// Two tiers, the same JSON ({ version, readWith, pages }) and the same check:
// the payload's shape, and the engine, bundle and worker it was read with.
//   1. shipped: plugins/ocr_tool/cache/<sha256>.json, committed to the repo —
//      the startup document reads instantly for every visitor. The build's
//      asset map says whether a file exists, so a miss costs no request.
//   2. IndexedDB: what this browser read itself. It never leaves the browser;
//      the last OCR_CACHE_KEEP documents are kept.
// A stored read that fails the check is passed over, and the document is read
// again. So a sync of the engine or the bundle needs a new shipped read, or
// every visitor reads the startup document live (tol0's tools/recto-cache.mjs;
// tests/plugins/ocr_tool/read-stamp.test.mjs holds the file to the site).
// A fresh browser profile has no second tier, so tol0's recto smoke test
// (which uploads its certified document) still exercises the real engine.
// To ship a cache after swapping the startup PDF: open the app, let the read
// finish, run ocrExportCache() in the console and commit the downloaded file
// to web/plugins/ocr_tool/cache/.

// The slimming itself (ocrSlimResult / ocrSlimPass) lives in ocr-result.js:
// the worker posts slim results, the cache stores them, and a live inline
// read is slimmed here — one shape, one code path (ocrAddBoxes).

const ocrCacheValid = data => data?.version === OCR_CACHE_VERSION && data.readWith === OCR_READ_STAMP && Array.isArray(data.pages);

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
      return ocrCacheValid(row) ? { version: row.version, readWith: row.readWith, pages: row.pages } : null;
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
  if (typeof renderAllTextLayers === 'function') renderAllTextLayers();
  Promise.resolve(window.utbConnectRedactionsToLines?.()).then(() => {
    if (typeof calculateAllWidths === 'function') calculateAllWidths();
  });
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
  const rgba = ocrToolState.engine.pageRGBA(img);
  const page = BlindOCR.whitenColored(ocrToolState.engine._pageFor(img), rgba);
  const progress = (p, d, t) => setOcrStatus(`${label}${BlindOCR.passLabel(p)}: ${d}/${t} bands…`);
  const w = await ocrWorker().catch(e => {
    if (e?.stopped) return undefined;                   // stopped while it started: this page is cancelled
    console.warn('OCR: no worker, reading on the main thread —', e?.message || e);
    return null;
  });
  if (w === undefined || ocrToolState.cancel) return null;
  let out;
  ocrToolState.readVia = w ? 'worker' : 'inline';
  if (w) {
    const mode = !carry ? 'none' : carry.fresh ? 'new' : 'keep';
    if (carry) carry.fresh = false;
    out = await ocrWorkerRead(w, page, { setUrls: await ocrSetUrls(),
      passHint: ocrToolState.passHint, carry: mode, progress });
    if (!out) return null;                              // cancelled mid-page
  } else {
    // inline, a Stop is seen between bands as in the worker
    const stop = new Error('cancelled');
    const sets = await ocrLoadSets();
    try {
      out = await BlindOCR.readPageAuto(page, sets, { passHint: ocrToolState.passHint, carry,
        progress: (p, d, t) => { if (ocrToolState.cancel) throw stop; progress(p, d, t); } });
    } catch (e) {
      if (e === stop) return null;
      throw e;
    }
  }
  ocrToolState.passHint = out.pass;
  const dropped = ocrKeepRedactionBoxes(page, pageNum, out.res);
  // the ink of each glyph, from the raster read here (the worker has only the grays)
  OCRLineBoxes.inkColours(out.res, page, rgba);
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
      if (ocrToolState.cancel || runHash !== state.docHash) break;
      const label = allPages ? `OCR ${p}/${state.numPages}` : `OCR p${p}`;
      const out = await ocrReadOnePage(p, label, carry);
      if (runHash !== state.docHash || ocrToolState.cancel) break;
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
    if (runHash !== state.docHash) return;
    if (collected?.length === nums.length && !ocrToolState.cancel)      // every page read: worth replaying
      ocrStoreCache(runHash, { version: OCR_CACHE_VERSION, readWith: OCR_READ_STAMP, pages: collected });
    if (typeof renderAllTextLayers === 'function') renderAllTextLayers();
    await window.utbConnectRedactionsToLines?.();
    if (runHash !== state.docHash) return;
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

// Both layers shown, as a document starts: what the last document's choice
// hid is not hidden on this one (a read stopped before its choice left a
// document's embedded text hidden).
function ocrShowBothLayers() {
  document.body.classList.remove('hide-ocr-text', 'hide-embedded-text');
  document.getElementById('ocr-toggle-text')?.classList.add('active');
  document.getElementById('toggle-embedded-text')?.classList.add('active');
}

function ocrChooseLayer() {
  if (typeof utbState === 'undefined') return;   // no text tool: no boxes to choose between
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
    if (!live()) return;
    if (ocrToolState.running) {
      while (ocrToolState.running) { await sleep(150); if (!live()) return; }
      ocrToolState.autoDone = true;
      return;
    }
    if (cached) { ocrApplyCached(cached); applied = true; }
  }
  if (!applied) {
    await ocrRun(true);
    if (!live()) return;
    // still running here = ocrRun bounced off a manual run that won the race
    while (ocrToolState.running) { await sleep(150); if (!live()) return; }
    if (ocrToolState.cancel) { ocrToolState.autoDone = true; return; }
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
  if (ocrToolState.running) ocrCancel({ now: true });   // its page is the old document's: the worker ends
  ocrToolState.autoDone = false;
  ocrShowBothLayers();
  ocrProducer.clear();
  ocrDropped.clear();
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
