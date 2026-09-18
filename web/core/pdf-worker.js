// pdf-worker.js — the module worker that owns MuPDF and the open PDF.
//
// Only doc-service.js talks to this file. One worker holds one document; the
// service terminates the worker on Doc.close(), which is the only way a wasm
// heap ever gives memory back (re-init costs ~50 ms).
//
// Protocol — every request carries an `id`, every answer echoes it:
//   { type: 'init', urls: { mupdf, document, wasm } }   → { ok, initMs, heapMB }
//   { type: 'open', buffer }                            → { ok, geometry, timings, heapMB }     pages, page size, scale
//   { type: 'typography' }                              → { ok, typography, timings }           declared fonts, body size
//   { type: 'page', n, thumb }                          → { ok, png: ArrayBuffer }      (transferred)
//   { type: 'pixels', n, gray }                         → { ok, raster }                the page raster's samples (transferred)
//   { type: 'text', n, options, imageRect }             → { ok, text }                  raw structured text
//   { type: 'imageRect', n }                            → { ok, rect | null }
//   { type: 'heap' }                                    → { ok, heapMB }
// A failure answers { ok: false, error }.
//
// The URLs come from the page so they carry the build's content hashes
// (assetURL) — a static import here could not.

let mupdf = null, Module = null, openPdf = null, pdf = null;

const heapMB = () => Module?.HEAPU8 ? Module.HEAPU8.buffer.byteLength / 1048576 : null;

const handlers = {
  async init({ urls }) {
    const t0 = performance.now();
    // Handing the Module object in BEFORE the import is what makes the wasm
    // heap readable afterwards (pdf-document.js reads MuPDF structs from it).
    Module = {
      locateFile: file => file.endsWith('.wasm') ? urls.wasm : file,
      printErr: text => console.warn('mupdf:', text),              // MuPDF's warnings are not errors
    };
    globalThis.$libmupdf_wasm_Module = Module;
    mupdf = await import(urls.mupdf);
    ({ openPdf } = await import(urls.document));
    return { initMs: performance.now() - t0, heapMB: heapMB() };
  },

  open({ buffer }) {
    const t0 = performance.now();
    pdf?.close();
    pdf = openPdf(mupdf, Module, new Uint8Array(buffer));       // MuPDF copies the bytes into its heap
    const t1 = performance.now();
    const geometry = pdf.geometry();
    return { geometry, heapMB: heapMB(), timings: { parseMs: t1 - t0, geometryMs: performance.now() - t1 } };
  },

  typography() {
    const t0 = performance.now();
    return { typography: pdf.typography(), timings: { typographyMs: performance.now() - t0 } };
  },

  page({ n, thumb }) {
    const png = pdf.pagePNG(n, { thumb: !!thumb });
    const buffer = png.buffer.byteLength === png.byteLength ? png.buffer : png.slice().buffer;
    return { png: buffer, transfer: [buffer] };
  },

  pixels({ n, gray }) {
    const raster = pdf.pageRaster(n, { gray: !!gray });
    return { raster, transfer: [raster.samples.buffer] };
  },

  text({ n, options, imageRect }) {
    const text = pdf.structuredText(n, options);
    if (imageRect) text.imageRect = pdf.pageImageRect(n);       // one round trip for a text plugin
    return { text };
  },
  imageRect: ({ n }) => ({ rect: pdf.pageImageRect(n) }),
  heap: () => ({ heapMB: heapMB() }),
};

self.onmessage = async e => {
  const { id, type } = e.data;
  try {
    if (!handlers[type]) throw new Error(`unknown request "${type}"`);
    if (type !== 'init' && !openPdf) throw new Error('worker not initialised');
    if (!['init', 'open', 'heap'].includes(type) && !pdf) throw new Error('no document is open');
    const { transfer, ...answer } = await handlers[type](e.data);
    self.postMessage({ id, ok: true, ...answer }, transfer || []);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
