// ocr-result.js — the SLIM shape of a page read (Recto-owned, like ocr-tool.js).
//
// The engine's live result references whole glyph sets (L.set) and the scan
// canvases; ocrAddBoxes reads only a few fields. This file holds the one
// slimming function both consumers share: the precomputed cache
// (ocr_tool/cache/<sha256>.json, payload version 2) stores exactly this, and
// the OCR worker (ocr-worker.js) posts exactly this back to the main thread —
// so a live read, a worker read and a cache replay all go through the same
// ocrAddBoxes path with the same data. Slimming is idempotent: a slim result
// slims to itself.
//
// Loaded as a plain script on the main thread (plugin.json) and by the worker
// through importScripts; defines two globals, no side effects.

function srcAt(L) {
  const m = new Map();
  for (const g of L.glyphs || []) if (g.src) m.set(g.pen, g.src);
  return m;
}

// eslint-disable-next-line no-unused-vars
function ocrSlimResult(res) {
  return {
    lines: (res.lines || []).map(L => { const src = srcAt(L); return {
      text: L.text, font: L.font, baseline: L.baseline, top: L.top, bot: L.bot,
      phy: L.phy ?? 0, clean: !!L.clean, residual: L.residual ?? 0,
      // the space this line was shaped with — its set's calibration on the
      // page (blindocr readPage), since a Times header and a Courier body
      // on one page have different spaces; absent in older caches
      ...(L.spaceAdv != null ? { spaceAdv: L.spaceAdv } : {}),
      fails: Array.from(L.fails || []),
      boxes: (L.boxes || []).map(b => Array.from(b)),
      set: L.set ? { maxAsc: L.set.maxAsc, maxDesc: L.set.maxDesc, sizePx: L.set.sizePx } : null,
      // src: which set of a union pool drew the glyph. The engine records it on
      // L.glyphs[].src (entries are the glyphs in pen order, keyed by pen);
      // a slim result carries it on the entry already. Resolved HERE so the
      // slim is complete wherever it is taken — the worker slims before
      // ocrAddBoxes ever sees the line, and a union line whose entries lost
      // their src draws every glyph from the pool's first set (measured:
      // 303 of 1253 px wrong on an email header).
      entries: (L.entries || []).map(e => {
        const s = e.src ?? src.get(e.pen);
        return { i: e.i, pen: e.pen, adv: e.adv, ch: e.ch, ...(s ? { src: s } : {}) };
      }),
    }; }),
    spaceAdv: res.spaceAdv ?? null,                    // page-calibrated space (the fallback for a line without its own)
    ...(res.spaceAdvBySet ? { spaceAdvBySet: res.spaceAdvBySet } : {}),
    objects: (res.objects || []).filter(o => o.type === 'box')
      .map(o => ({ type: o.type, x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1 })),
  };
}

// eslint-disable-next-line no-unused-vars
function ocrSlimPass(pass) {
  return { tol: pass?.tol || 0, quant: !!pass?.quant, union: !!pass?.union };
}
