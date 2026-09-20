// law-worker.js — the producer's law OFF the main thread (Recto-owned adapter,
// like ocr-worker.js; the engine file it loads is still a verbatim tol0 copy).
//
// Why: render.js producerMetrics searches the laid size to 5e-6 for every
// hypothesis (advances at 1/1000 em or the set's hmtx, kerned or not) — about
// 130 scorings of every certified word per hypothesis, each quadratic in the
// word's length. Measured 2026-09 on the startup document: about a second
// per searched hypothesis on a Courier page (65 lines, ~4900 glyphs), after
// EVERY page of a read and for every page of a cache replay — on the main
// thread that froze scrolling and zooming for that long, page after page.
// (Since 2026-09-20 the engine skips a search that cannot win, and such a
// page costs ~12 ms; a page laid at another size still searches.) It is pure arithmetic on the
// slim entries and the face's kern table, so it runs here, in a worker of its
// own: the reader's worker stays free for the next page.
//
// In:  { type: 'init', script: url }                  load engine/render.js
//      { type: 'learn', id, lines, opts }             producerMetrics' own arguments
// Out: { type: 'ready' }
//      { type: 'law', id, metrics }                   producerMetrics' result (its Maps survive the clone)
//      { type: 'error', id, message }                 id null: the engine script failed to load
'use strict';

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      importScripts(m.script);
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', id: null, message: 'engine script: ' + (err?.message || err) });
    }
    return;
  }
  if (m.type !== 'learn') return;
  try {
    self.postMessage({ type: 'law', id: m.id, metrics: OCRRender.producerMetrics(m.lines, m.opts) });
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err?.message || err) });
  }
};
