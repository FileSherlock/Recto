// ocr-worker.js — the tol0 blind reader OFF the main thread (Recto-owned
// adapter, like ocr-tool.js; the engine files it loads are still verbatim
// tol0 copies).
//
// Why: the engine is synchronous JavaScript that yields to the event loop
// only every six bands, and a page in a face the sets do not carry sends it
// through the whole tolerance ladder — tens of seconds with the full bundle,
// during which zooming and page changes froze. Here the engine runs inside a
// dedicated Worker. The adapter builds the page buffer from the viewer's
// raster (that needs a canvas, so it stays on the main thread), posts it
// here, and gets back the SLIM result (ocr-result.js — the same shape the
// precomputed cache stores and ocrAddBoxes consumes), so nothing crossing
// the thread boundary references a glyph set.
//
// A read is cancellable between bands: the engine yields there when it has a
// progress callback, which is when a 'cancel' message is seen; the callback
// then throws and the read stops (a 'cancelled' reply, no result).
//
// In:  { type: 'init', scripts: [url…] }         load engine + ocr-result.js
//      { type: 'read', id, w, h, gray: Float32Array, converted?: Uint8Array,
//        setUrls: [url…], passHint, carry: 'none' | 'new' | 'keep' }
//      { type: 'cancel' }
// Out: { type: 'ready' }
//      { type: 'progress', id, pass, done, total }
//      { type: 'result', id, res, pass }         res = ocrSlimResult(...)
//      { type: 'cancelled', id }
//      { type: 'error', id, message }
'use strict';

let sets = null;        // materialized glyph sets, loaded once per worker
let carry = null;       // cross-page hints of a whole-document read (readPageAuto opts.carry)
let cancelled = false;
class Cancelled extends Error {}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      importScripts(...m.scripts);
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', id: null, message: 'engine scripts: ' + (err?.message || err) });
    }
    return;
  }
  if (m.type === 'cancel') { cancelled = true; return; }
  if (m.type !== 'read') return;
  cancelled = false;
  try {
    if (!sets) {
      sets = await BlindOCR.loadSets(m.setUrls);
      if (!sets.length) throw new Error('glyph sets failed to load');
    }
    if (m.carry === 'none') carry = null;
    else if (m.carry === 'new' || !carry) carry = {};
    const page = { w: m.w, h: m.h, gray: m.gray };
    if (m.converted) page.converted = m.converted;
    const { res, pass } = await BlindOCR.readPageAuto(page, sets, {
      passHint: m.passHint,
      carry,
      progress: (p, d, t) => {
        if (cancelled) throw new Cancelled();
        self.postMessage({ type: 'progress', id: m.id, pass: ocrSlimPass(p), done: d, total: t });
      },
    });
    if (cancelled) throw new Cancelled();
    self.postMessage({ type: 'result', id: m.id, res: ocrSlimResult(res), pass: ocrSlimPass(pass) });
  } catch (err) {
    if (cancelled || err instanceof Cancelled) self.postMessage({ type: 'cancelled', id: m.id });
    else self.postMessage({ type: 'error', id: m.id, message: String(err?.message || err) });
  }
};
