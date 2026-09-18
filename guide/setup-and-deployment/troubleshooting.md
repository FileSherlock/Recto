# Troubleshooting Guide

Recto has no server process, so there is no service to restart and no server log to read.
When something does not load, the evidence is in two places: the **terminal** that ran the
build (or the dev server), and the **browser's developer tools** — the Console for errors,
the Network tab for status codes and `Content-Type` headers. Work through the steps in
order.

## 1. Does the build succeed?

```bash
node tools/build.mjs
```

A good run prints `web/index.html — N plugins: …`. A bad one prints `build failed: …` and
exits with status 1. The dev server runs the same build on every request for the page and
shows the same message in the browser instead of the app.

| Message | Cause |
|---------|-------|
| `plugins/<name>/plugin.json names "<file>", which does not exist` | The manifest lists a script, style or fragment that is not in the plugin's folder — a typo, or a file that was renamed or not copied along with the folder |
| `plugins/<folder>/plugin.json: "name" is "…", the folder is "…"` | `name` in the manifest must equal the folder name |
| `plugins/<name>/plugin.json: "<slot>" must be a list` | `styles`, `scripts_before_viewer` and `scripts_after_app` are arrays, even for one file |
| `web/plugins/<name>/plugin.json: …` followed by a JSON parser message | The manifest is not valid JSON (a trailing comma, usually) |
| `plugins/<name>/<file> still contains a … template tag` | An HTML fragment contains `{%` or `{{`. Fragments are plain HTML, inlined as they are — nothing expands template syntax |
| `index.template.html: marker @plugins:<slot> is missing` / `unknown marker` / `marker @assets is missing` | `web/core/index.template.html` was edited and lost, or gained, an insertion marker |

A folder under `web/plugins/` **without** a `plugin.json` is not an error: it is simply not
a plugin, and is skipped.

## 2. Does the page arrive?

- **`index.html` is 404 on the host.** `web/index.html` and `web/generated/` are gitignored
  and exist only after a build. Run `node tools/build.mjs` before publishing.
- **Opened by double-clicking `web/index.html` (`file://`).** Browsers block `fetch()` and
  workers on `file://` pages. Use `node tools/serve.mjs` or any static file server.
- **The page has no styling or no icons.** The toolbar icons and the UI font come from a
  public font CDN, and Fabric.js from a public script CDN; an offline machine or a filter
  that blocks them shows text labels instead of icons. The local files (`core/styles.css`,
  plugin styles) are separate — check their status codes in the Network tab.

## 3. Visitors see an old version after a deploy

`index.html` is the one file that names every content hash. If it is cached, the browser
keeps asking for the old script URLs. Serve `index.html` and `generated/*.json` with
`Cache-Control: no-cache`; everything else may be cached for a year (see
[Production Deployment](production-deployment.md#2-caching)).

Two things the hash does **not** reach: `vendor/mupdf/mupdf-wasm.js`, and
`vendor/harfbuzz/harfbuzz.js` with its `.wasm` — the vendored modules import them by a
plain relative URL. After upgrading a vendored library, a host that caches forever can keep
serving the old one: give those files a short lifetime, or rename the vendor folder with
the version.

A CDN configured to **ignore query strings** defeats the scheme entirely — `app.js?v=old`
and `app.js?v=new` become one cache entry. The cache key has to include the query string.

## 4. The page loads but no document appears

The viewer shows `Error: <message>` in place of the page, and the Console has
`Error opening document: …`.

- **Plain `http://` on a real host.** The document's SHA-256 is computed with
  `crypto.subtle`, which browsers provide only in a secure context (HTTPS, or
  `http://localhost`). Serve the site over HTTPS.
- **`document worker: failed to load`.** The MuPDF worker (`core/pdf-worker.js`) is a
  *module* worker and imports `vendor/mupdf/mupdf.js` and `core/pdf-document.js` as ES
  modules. Browsers refuse a module whose `Content-Type` is not a JavaScript type — check
  `.js` and `.mjs` in the Network tab. A Content-Security-Policy can block it too: the page
  needs `worker-src 'self' blob:` (the hashing worker is created from a `blob:` URL) and
  `'wasm-unsafe-eval'` in `script-src`.
- **A PDF that MuPDF cannot parse** shows MuPDF's own message. MuPDF's *warnings* about a
  damaged file are logged as `mupdf: …` console warnings and are not errors; the document
  usually opens anyway.
- **The startup document does not open, uploads do.** No PDF sits directly in
  `web/assets/pdfs/` (subfolders are ignored), or it was added after the last build —
  `generated/default-document.json` then says `{ "file": null }`.

## 5. Slow start: `wasm streaming compile failed`

The Console shows `wasm streaming compile failed … falling back to ArrayBuffer
instantiation`. The host serves `.wasm` under the wrong `Content-Type`; it must be
`application/wasm`. The app still works — the loaders fall back to downloading the whole
binary before compiling it — but the first open is slower. The dev server sets the type
itself; on a host, add the MIME mapping.

## 6. Masks or measurements are missing

- **No mask overlay on any page.** Masks are built only for pages whose raster is the
  embedded scan; a born-digital page (shown as a 96-dpi render) has none by design. If a
  scanned page has none either, look for `webgl_mask: mask failed` or `mask worker failed`
  in the Console — the mask worker needs `OffscreenCanvas` (see
  [Browser support](#browser-support)).
- **Text widths look wrong, or a font is marked *(not installed)*.** The face file named
  in `web/assets/fonts/fonts.json` is not in `web/assets/fonts/`. Measurement then falls
  back to another style of the family, and finally to Times New Roman. Add the file and
  rebuild.

## 7. Memory with very large PDFs

MuPDF copies the document's bytes into its WebAssembly heap, and the heap grows as pages
are decoded. Measured: about file size + 22 MB right after opening, bounded near file size
+ 280 MB while browsing (MuPDF's own cache is capped at 256 MB). Two properties matter:

- **A wasm heap never shrinks.** The only way to give the memory back is to end the worker
  that owns it. `Doc.close()` does exactly that, and `Doc.open()` calls it first — so every
  document starts in a fresh worker, and opening a small file after a huge one returns the
  memory. Re-initialising MuPDF costs about 50 ms.
- **The heap limit of this MuPDF build is 2 GB.** A file approaching that size cannot be
  opened in the browser at all, and a low-memory device may refuse the allocation far
  earlier; the open then fails with an error in the viewer and the Console.

`await Doc.heapMB()` in the Console reports the worker's heap. Page rasters are handed to
the viewer as `blob:` URLs kept in a small least-recently-used cache (24 pages, 600
thumbnails); evicted URLs are revoked, so scrolling through thousands of pages does not
accumulate images. A plugin that stores a page URL instead of asking `Doc.pageImageURL(n)`
each time will find it revoked — that shows as a broken page image, not as a memory problem.

With the dev server's COOP/COEP headers, `performance.measureUserAgentSpecificMemory()`
gives the whole picture (page, workers, wasm heaps) in browsers that implement it.

## Browser support

| Feature | Used for | Without it |
|---------|----------|------------|
| WebAssembly | MuPDF, HarfBuzz | Nothing works |
| Module workers (`new Worker(url, { type: 'module' })`) | The MuPDF worker | No document opens. Chrome/Edge 80+, Firefox 114+, Safari 15+ |
| `crypto.subtle` (secure context) | The document's SHA-256 | No document opens — see step 4 |
| `createImageBitmap` | Opening image documents (PNG, JPEG, …) | PDFs open; images do not |
| `OffscreenCanvas` with a 2D context in a worker | Encoding page masks | No mask overlay. Chrome/Edge 69+, Firefox 105+, Safari 16.4+ |
| WebGL | Drawing the mask overlay | No mask overlay; the page itself is unaffected |
| IndexedDB | Per-browser caches a plugin may keep | The plugin recomputes. Private windows may deny it; that is handled as a cache miss |
| COEP `credentialless` | Cross-origin isolation (optional) | The page is not isolated; only the memory-measurement API is lost |

## Quick Diagnostic

Paste this into the browser Console on the loaded page:

```js
({
  secure: isSecureContext,
  isolated: crossOriginIsolated,
  plugins: await fetch('generated/plugins.json', { cache: 'no-cache' }).then(r => r.json()).then(p => p.map(x => x.name)),
  wasmType: await fetch(assetURL('vendor/mupdf/mupdf-wasm.wasm'), { method: 'HEAD' }).then(r => r.headers.get('content-type')),
  document: Doc.info && { pages: Doc.info.numPages, sha256: Doc.info.sha256.slice(0, 12) },
  heapMB: await Doc.heapMB(),
})
```

`secure` must be `true`, `wasmType` must be `application/wasm`, `plugins` lists what the
last build found, and `document` is `null` until one is open.
