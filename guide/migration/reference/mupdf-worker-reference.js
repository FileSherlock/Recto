// worker.js — MuPDF (WebAssembly) off the main thread, the way a static Recto
// would run it. The Module object is handed in so the wasm heap can be read.
const cfg = {};
globalThis.$libmupdf_wasm_Module = cfg;
const t0 = performance.now();
const mupdf = await import('./mupdf/mupdf.js');
const initMs = performance.now() - t0;
const heapMB = () => cfg.HEAPU8 ? cfg.HEAPU8.buffer.byteLength / 1048576 : null;
postMessage({ type: 'ready', initMs, heapMB: heapMB() });

let doc = null;
const PT_TO_PX = 96 / 72;
// largest embedded image on the page — the producer's page raster (tol0 rasterize-mupdf.mjs)
function pageImageRef(page) {
  const xo = page.getObject?.()?.get('Resources')?.get('XObject');
  let best = null, bestPx = -1;
  xo?.forEach?.(val => {
    try {
      const im = val.isIndirect?.() ? val.resolve() : val;
      if (im.get('Subtype')?.asName?.() !== 'Image') return;
      const px = (im.get('Width')?.asNumber?.() ?? 0) * (im.get('Height')?.asNumber?.() ?? 0);
      if (px > bestPx) { bestPx = px; best = val; }
    } catch {}
  });
  return best;
}
const timed = f => { const t = performance.now(); const v = f(); return [v, performance.now() - t]; };

onmessage = e => {
  const m = e.data;
  try {
    if (m.type === 'open') {
      doc?.destroy?.();
      const [d, openMs] = timed(() => mupdf.PDFDocument.openDocument(m.buffer, 'application/pdf'));
      doc = d;
      const [n, countMs] = timed(() => doc.countPages());
      postMessage({ type: 'opened', id: m.id, openMs, countMs, pages: n, heapMB: heapMB() });
    } else if (m.type === 'page') {
      const out = { type: 'page', id: m.id, pno: m.pno };
      const [page, loadMs] = timed(() => doc.loadPage(m.pno - 1));
      out.loadMs = loadMs;
      // (a) what the server does for a scan: the embedded raster, decoded, not rendered
      const ref = pageImageRef(page);
      out.hasImage = !!ref;
      if (ref) {
        const im = doc.loadImage(ref);
        const [pix, decodeMs] = timed(() => im.toPixmap());
        out.decodeMs = decodeMs; out.imgW = pix.getWidth(); out.imgH = pix.getHeight(); out.imgN = pix.getNumberOfComponents();
        pix.destroy?.(); im.destroy?.();
      }
      // (b) a 96-dpi render of the page (what a born-digital page needs; RGB, no alpha)
      const [pix, renderMs] = timed(() => page.toPixmap(mupdf.Matrix.scale(PT_TO_PX, PT_TO_PX), mupdf.ColorSpace.DeviceRGB, false, true));
      out.renderMs = renderMs; out.w = pix.getWidth(); out.h = pix.getHeight();
      // RGB → RGBA for the canvas, and hand the buffer over without copying
      const [rgba, packMs] = timed(() => {
        const src = pix.getPixels(), n = out.w * out.h, dst = new Uint8ClampedArray(n * 4);
        for (let i = 0, j = 0; i < n; i++, j += 3) { dst[i * 4] = src[j]; dst[i * 4 + 1] = src[j + 1]; dst[i * 4 + 2] = src[j + 2]; dst[i * 4 + 3] = 255; }
        return dst;
      });
      out.packMs = packMs;
      pix.destroy?.();
      // (c) the text layer with per-character quads — what /api/extract-spans serves
      const [chars, textMs] = timed(() => {
        const st = page.toStructuredText('preserve-whitespace,preserve-spans');
        let n = 0;
        st.walk({ onChar() { n++; } });
        st.destroy?.();
        return n;
      });
      out.textMs = textMs; out.chars = chars;
      page.destroy?.();
      out.heapMB = heapMB();
      postMessage({ ...out, rgba: m.wantPixels ? rgba : null }, m.wantPixels ? [rgba.buffer] : []);
    } else if (m.type === 'sweep') {
      // every page once, decode-or-render + text: sustained throughput and heap growth
      const t = performance.now(); let chars = 0, decoded = 0, rendered = 0, peak = 0;
      const n = doc.countPages();
      for (let p = 0; p < n; p++) {
        const page = doc.loadPage(p);
        const ref = pageImageRef(page);
        if (ref) { const im = doc.loadImage(ref); const px = im.toPixmap(); px.destroy?.(); im.destroy?.(); decoded++; }   // destroy the Image too: wrappers are only finalized by GC
        else { const px = page.toPixmap(mupdf.Matrix.scale(PT_TO_PX, PT_TO_PX), mupdf.ColorSpace.DeviceRGB, false, true); px.destroy?.(); rendered++; }
        const st = page.toStructuredText('preserve-whitespace'); st.walk({ onChar() { chars++; } }); st.destroy?.();
        page.destroy?.();
        if (m.emptyEvery && p % m.emptyEvery === m.emptyEvery - 1) mupdf.emptyStore();   // cap mupdf's decoded-image store
        const h = heapMB(); if (h > peak) peak = h;
        if (p % 50 === 49) postMessage({ type: 'progress', id: m.id, done: p + 1, of: n });
      }
      postMessage({ type: 'swept', id: m.id, ms: performance.now() - t, pages: n, decoded, rendered, chars, peakHeapMB: peak, heapMB: heapMB() });
    } else if (m.type === 'close') {
      doc?.destroy?.(); doc = null; mupdf.emptyStore?.();
      postMessage({ type: 'closed', id: m.id, heapMB: heapMB() });
    }
  } catch (err) { postMessage({ type: 'error', id: m.id, error: String(err?.stack || err) }); }
};
