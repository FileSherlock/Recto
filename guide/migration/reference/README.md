# Reference files for the client-side rewrite

Working code from the 2026-09-18 benchmark that measured MuPDF as WebAssembly
in the browser. They are starting points, not finished modules.

- `mupdf-worker-reference.js` — a module worker that owns MuPDF: opens a PDF
  from an `ArrayBuffer`, decodes a page's embedded raster (the scan) or renders
  the page at 96 dpi, walks the structured text, reports the wasm heap size,
  and `destroy()`s every wrapper. It imports `./mupdf/mupdf.js`: copy
  `mupdf.js`, `mupdf-wasm.js` and `mupdf-wasm.wasm` from the npm package
  `mupdf@1.28.0` (`dist/`; also at `../tol0/node_modules/mupdf/dist`).
  Handing `globalThis.$libmupdf_wasm_Module = cfg` in before the import is what
  makes `cfg.HEAPU8.buffer.byteLength` (the heap size) readable.
- `bench-reference.js` — the driver: request → pixels on a canvas, per
  document, plus an every-page sweep. Its `docs/*.pdf` were symlinks to local
  test files.
- `static-server-reference.py` — the whole "server" a static Recto needs:
  files, `application/wasm`, and the COOP/COEP headers (optional; they enable
  `performance.measureUserAgentSpecificMemory`).

Results are in `../client-side-rewrite.md`.
