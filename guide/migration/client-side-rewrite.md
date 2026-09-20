# Client-side rewrite — the plan

Branch: `client-side-rewrite`. Goal: Recto as a **static website**. Every
piece of work the Django server does today moves into the browser
(JavaScript, plus MuPDF and HarfBuzz as WebAssembly). When the last phase is
done the result is copied into a new repository; `main` stays the Django
version and is never touched from this branch.

This file is the single source of truth for the work. It is written for a
fresh session that has not seen the conversation that produced it. Keep the
**Progress** checklist at the bottom current: tick a phase only when its
acceptance criteria pass, and write down anything a later phase must know.

## Why

Django is not slow. The cost is that the *server* does PDF work on every
request: `/page-image` reopens the PDF and re-encodes a PNG each time, and
text extraction runs per page. Measured 2026-09-18 on the same documents
(`reference/bench-reference.js`, numbers below), the same work in the browser
is 5–10× cheaper per page and costs the server nothing. The target server is
cheap hardware, so the fix is to stop sending it work — not to swap the web
framework.

| | browser: MuPDF 1.28 as WebAssembly, in a worker | Django dev server, same machine |
|---|---|---|
| start-up | wasm init 48 ms, heap 22 MB | — |
| open 5 p / 25 p / 340 p (66 MB) / 943 p | 4 / 1 / 34 / 6 ms | 136 / 660 / 910 / 310 ms |
| scanned page: decode the embedded raster | 2.6–2.9 ms | 25–39 ms per `/page-image` |
| vector page: render at 96 dpi | 5–25 ms (worst court page 186 ms) | 31 ms (worst 160 ms) |
| one page's text with per-character positions | 1.3–5.5 ms | 15–28 ms |
| every page of the 340-page scan: raster + text | 2.7 s | text scan alone: 7.0 s of server CPU |

Memory: the wasm heap is file size + 22 MB after open, about 100 MB after
browsing a 66 MB file, and bounded near file size + 280 MB (MuPDF's cache is
capped at 256 MB). A wasm heap never shrinks; terminating the worker frees it
(re-init 48 ms + reopen 34 ms). MuPDF's JS wrappers (`Image`, `Pixmap`, `Page`,
`StructuredText`) must be `destroy()`ed explicitly — left to GC they held
~250 MB extra in the benchmark.

## What must not be lost

1. **Drag-in / drag-out plugins.** Every feature beyond the core is a
   self-contained folder; deleting the folder removes the feature with no
   dangling reference, dropping one in adds it. This is the project's most
   valued property (it also keeps AI context small). It survives as: one
   `plugin.json` per folder + a scan step (below).
2. **The core runs no analysis** and never calls a plugin by name; plugins
   attach through the `PDFHooks` bus and `typeof`-guarded globals. Baseline
   code and docs never name an optional plugin.
3. **The coordinate contract** (`geometry.py` ↔ `geometry.js`): image px at
   96 DPI for geometry, PDF points for typography, converted once.
4. **Pixel exactness.** The OCR reader and pixel view certify against page
   bytes. Page rasters must stay byte-identical to what the server produced
   (same crop, lossless). The engine under
   `ocr_tool/static/ocr_tool/engine/` is synced verbatim from `../tol0` and is
   not edited here.
5. **No bundler, no runtime package manager.** Plain scripts, loaded in a
   fixed order. One zero-dependency Node script may generate `index.html`;
   nothing is transpiled or bundled.
6. **Privacy by construction.** A user's document never leaves the browser.

## Inventory — what the server does today

Server calls made by the frontend, and what replaces each:

| Call | Made by | Server work | Replacement |
|---|---|---|---|
| `POST /open-document` | `pdf_core/pdf-viewer.js` | store upload by sha256, `load_pdf_meta` (pages, page px size, fonts most-used first, suggested scale and body size) / `load_image_meta` | `crypto.subtle.digest` for the hash; metadata from the MuPDF worker; the `File` stays in memory |
| `GET /open-default` | `pdf_core/app.js` | serve the PDF in `assets/pdfs/` | static fetch of the file named in a generated manifest |
| `GET /page-image/<hash>/<n>` (+`?thumb=1`) | `pdf-viewer.js` (`state.pageImages[n]` → `img.src`) | `_first_raster` + `crop_to_page_ratio` (embedded raster, cropped) or a 96-dpi render → PNG | worker: same raster, same crop, PNG via MuPDF → `blob:` URL, created lazily per page and revoked when evicted |
| `GET /embedded-text-viewer/api/extract-spans` | `etv-fetch.js` (lean 200-page chunks + one full page) | `extracted_text/logic/extract.py` | the plugin's own JS port of `extract.py` over the core's raw structured-text primitive |
| `POST /widths` | `text_tool/toolbar.js`, `redaction_matching/api.js` (many strings per call) | HarfBuzz shaping (`text_tool/logic/width_calculator.py`) | HarfBuzz as WebAssembly (harfbuzzjs), same library ⇒ same numbers |
| `GET /font-metrics` | `text_tool/fonts.js` | HarfBuzz advances + kern pairs at a size (`font_metrics.py`) | same, via harfbuzzjs |
| `GET /fonts-list` | `text_tool/fonts.js` | `assets/fonts/fonts.json` + which files exist | generated static JSON (the scan step writes the `present` map) |
| `GET /webgl/mask/<hash>/<n>` | `webgl_mask/webgl-mask.js` | OpenCV black-region mask (`masking.py`, `artifact_visualizer.py`) | JS port in the plugin's own worker |
| `GET/PUT /ocr/cache/<hash>` | `ocr_tool/ocr-tool.js` | JSON file per document | IndexedDB; prebuilt JSON shipped as static files for bundled documents |
| static: glyph bundle, engine, `names.json`, fonts | several | none | unchanged static files |

Python that is **not** ported (dead for the app — verify with grep before
deleting): `extracted_text/logic/calibrate.py`, `pdf_core/logic/{shaper,
line_breaker,layout_calculator}.py`, `pdf_core/management/commands/
measure_text.py`, the duplicate `width_calculator.py` copies in
`extracted_text` and `embedded_text_viewer`, every `models.py` / `admin.py` /
`migrations/` (empty), `document_store.py` eviction, `demo/` (a separate
Django demo project — out of scope, stays on `main`), `setup.sh`,
`run_app.bat`. `redaction_refiner/words_build.py` is a build-time word-list
script: keep it as a dev script.

Size of the job: about 7,700 lines of plugin/core JS already exist and mostly
move unchanged; about 2,900 lines of Python exist, of which roughly 1,300 are
live and need a JS equivalent (`document_loader.py` 317, `extract.py` 434,
`masking.py` + `artifact_visualizer.py` 292, width/metrics ~230).

## Target layout

Everything the static site serves lives under `web/`. Django apps stay in
place until Phase 8 so `main`-equivalent behaviour remains runnable on this
branch for comparison.

```
web/
  index.html                 GENERATED — never edited by hand
  core/                      was pdf_core/static/pdf_core  (+ index.template.html)
    doc-service.js           the ONLY thing that knows about the worker
    pdf-worker.js            module worker: MuPDF, the open document
  plugins/
    text_tool/               plugin.json + *.html fragments + js + css
    embedded_text_viewer/    (contains the extract.py port)
    webgl_mask/  ocr_tool/  redaction_matching/  redaction_refiner/  base64_tool/
  vendor/
    mupdf/                   mupdf.js, mupdf-wasm.js, mupdf-wasm.wasm  (1.28.0, pinned)
    harfbuzz/                hb.wasm + hbjs.js                          (pinned)
  assets/
    fonts/  pdfs/            moved from assets/
  generated/
    plugins.json  fonts.json  default-document.json
tools/
  build.mjs                  zero-dependency: scan web/plugins/*/plugin.json → index.html + generated/*
  serve.mjs                  dev server: static files, correct MIME, COOP/COEP, runs build on each index request
  golden/                    scripts that record the Django version's outputs (Phase 0)
tests/
  golden/                    recorded outputs (JSON / PNG), small
  *.test.mjs                 node:test suites against the goldens
```

### `plugin.json` — the static `tool.py`

```json
{
  "name": "text_tool",
  "order": 20,
  "styles": ["styles.css"],
  "toolbar_button": "toolbar_button.html",
  "options_bar": "options_bar.html",
  "ribbon_bar": null,
  "sidebar": null,
  "scripts_before_viewer": [],
  "scripts_after_app": ["fonts.js", "unified-text-box.js", "svg-renderer.js"]
}
```

Same slots as `pdf_core/base.py PDFTool`. `tools/build.mjs` inlines the HTML
fragments into `core/index.template.html` at the same four insertion points
the Django template has (styles, toolbar buttons, options/ribbon bars,
sidebars) and emits `<script>` tags in today's order: `hooks.js` →
`geometry.js` → `state.js` → plugins' `scripts_before_viewer` →
`pdf-viewer.js` → `ui-events.js` → `app.js` → plugins' `scripts_after_app`.
Cache-busters become the first 8 hex digits of each file's sha256 (no more
hand-bumped `v=` numbers). A static host cannot list directories, so the scan
runs when the dev server serves `index.html` and once at deploy — the same
moment Django's autodiscovery runs today. Template tags in fragments
(`{% static %}`) become relative paths.

### The document service (the one new core concept)

`core/doc-service.js` replaces every document endpoint with an async API and
is the only file that talks to `pdf-worker.js`:

```js
Doc.open(fileOrArrayBuffer, name) → { sha256, numPages, pageWidth, pageHeight, pdfFonts, suggestedScale, suggestedSize, pageImageType }
Doc.pageImageURL(n, { thumb })    → Promise<string>   // blob: URL of a lossless PNG; LRU of ~24 pages, revoked on eviction
Doc.structuredText(n)             → Promise<object>   // RAW MuPDF stext for one page: blocks/lines/spans/chars, quads, font, size, flags
Doc.pageImageRect(n)              → Promise<rect|null> // where the embedded raster sits on the page (extract.py needs it)
Doc.bytes()                       → ArrayBuffer        // for a plugin that runs its own worker
Doc.close()
```

`state.docHash` keeps its meaning (sha256 of the file). `state.pageImages`
stops being an array of URLs: `pdf-viewer.js` asks `Doc.pageImageURL(n)` when
it needs a page. The core still runs **no analysis** — `structuredText` is a
primitive, turning it into spans is the text plugin's job. Worker rules: one
module worker owns MuPDF and the document; every wrapper is `destroy()`ed;
the worker is terminated and recreated on `Doc.close()` so memory returns.
`reference/mupdf-worker-reference.js` is a working worker from the benchmark
(open, embedded-raster decode, 96-dpi render, text walk, heap reporting) —
start from it.

## Phases

Each phase ends with a commit on this branch. Do them in order; every phase
leaves the static site runnable.

### Phase 0 — goldens from the Django version (before anything moves)

Record what the server returns today, so every port can be checked without
running Django again. Create `.venv` (`python3 -m venv .venv &&
.venv/bin/pip install -r requirements.txt`; `.venv/` is gitignored).

Documents: `assets/pdfs/*.pdf` (startup, 5 p), `demo/samples/EFTA00382083.pdf`
(25 p, all pages), `demo/samples/EFTA01011184.pdf` (340 p — pages 1, 2, 3, 85,
170, 255, 340 only), one generated **vector** PDF (write it with PyMuPDF in
the golden script: two pages, Times/Helvetica/Courier base-14 text, a filled
black rectangle, mixed sizes — deterministic), and one PNG and one JPG image
document.

Record into `tests/golden/<doc>/`: the `/open-document` JSON; per page the
sha256 of the `/page-image` PNG's **decoded pixels** plus width/height (not
the PNG bytes — encoders differ); `/extract-spans` JSON, both `lean=1` and
full; the mask PNG's decoded-pixel hash and the JSON around it;
`/fonts-list`; `/font-metrics` for Times New Roman, Arial, Courier New,
Nimbus Roman at 16 px and 13.3333 px, regular and bold; `/widths` for a fixed
list of 200 strings (names from `redaction_matching`'s `names.json`, with
kerning on and off, uppercase on and off, two scales).

Acceptance: `tools/golden/record.py` regenerates the folder byte-identically
twice in a row; total size under 5 MB.

### Phase 1 — skeleton: `web/`, `plugin.json`, build and dev server

`git mv` each app's `static/<app>/` to `web/plugins/<app>/` and
`pdf_core/static/pdf_core/` to `web/core/`; move templates' fragments next
to them; write each `plugin.json` from its `tool.py`; move `assets/` to
`web/assets/`. Write `tools/build.mjs` and `tools/serve.mjs`
(`reference/static-server-reference.py` shows the headers and MIME types
needed). Absolute `/static/<app>/…` URLs inside JS and CSS become relative to
the plugin.

Acceptance: `node tools/serve.mjs` serves an `index.html` whose script order
and DOM match the Django-rendered page (diff the two after normalising
URLs); moving a plugin folder out of `web/plugins/` and reloading removes its
button, bars, scripts and styles with no console error, and moving it back
restores them. Nothing opens a document yet.

### Phase 2 — documents and pages without a server

Vendor MuPDF 1.28.0 into `web/vendor/mupdf/`. Write `pdf-worker.js` and
`doc-service.js`. Port `document_loader.py`: `load_pdf_meta` (including the
font usage count and `_suggested_size` / `_span_size` — bbox height over
ascender − descender), `load_image_meta`, `_first_raster`,
`crop_to_page_ratio` (exact integer arithmetic — coordinates depend on it),
the 96-dpi fallback render, thumbnails. Switch `pdf-viewer.js` and `app.js`
to `Doc`. Image documents (PNG/JPG) go through `createImageBitmap`.

Acceptance: for every golden page, decoded pixels hash-equal the golden;
open metadata equals the golden JSON; the 340-page sample opens in under
200 ms and the 943-page court bundle scrolls without the heap exceeding file
size + 300 MB (log `HEAPU8.buffer.byteLength` from the worker); closing a
document returns the worker's memory.

### Phase 3 — embedded text

Port `extracted_text/logic/extract.py` to
`web/plugins/embedded_text_viewer/extract.js` over `Doc.structuredText`.
PyMuPDF's `rawdict` and mupdf.js's structured text expose the same data with
different shapes — write one adapter, then port the logic line for line
(space handling, `_span_size_pt`, the page-image rect transform, the lean
variant). Keep the chunked, abortable scan the viewer does today.

Acceptance: spans deep-equal the goldens (numbers within 1e-6) for every
golden page, lean and full; the whole-document scan of the 340-page sample
finishes in under 5 s without blocking the UI.

### Phase 4 — text measurement

Vendor harfbuzzjs. `web/plugins/text_tool/shaping.js` replaces `/widths`
and `/font-metrics` (same request objects in, same response objects out, so
callers change one line). Fonts are fetched once per face and cached. The
font catalogue (`fonts.json` + `present`) is written by the build.

Acceptance: `/widths` and `/font-metrics` goldens reproduce exactly (same
HarfBuzz ⇒ equal to the last printed digit; if the vendored version differs
from Python's `uharfbuzz`, state the versions and the largest difference
found); a redaction box with 688 candidates measures in under 300 ms.

### Phase 5 — masks

Port `webgl_mask/logic/masking.py` + `artifact_visualizer.py` to a worker in
the plugin. Threshold, dilation, connected components and the edge-line rule
are plain loops. `_remove_circles` uses OpenCV's `HoughCircles`: first try a
component-shape test (bounding box near square, fill ratio near π/4); if the
goldens cannot be met that way, lazy-load opencv.js **inside this plugin
only** and say so in its README.

Acceptance: mask pixels equal the goldens on every golden page, or every
differing page is listed with a picture and a reason.

### Phase 6 — OCR cache and the remaining plugins

`ocr_tool`: replace `/ocr/cache/<hash>` with IndexedDB (same JSON, same
version checks); ship the two committed cache files as static
`web/plugins/ocr_tool/cache/<hash>.json` and read those first.
`redaction_matching`, `redaction_refiner`, `base64_tool`: no server logic —
fix paths only. Update `../tol0/tools/sync-recto.mjs` for the new engine and
glyph locations and for hash busters coming from the build instead of
`tool.py` (that is a change in the tol0 repository; commit it there
separately).

Acceptance: the startup document reads from the shipped cache with no
network call other than static files; a second document reads, caches, and
re-opens from IndexedDB; `PixelView.verdict(page)` reports the same certified
and exact counts as on `main` (startup document: 308 certified lines, all
exact); `npm run recto-test` in tol0 passes against `tools/serve.mjs`.

### Phase 7 — tests and docs

Port the Python tests that still mean something to `node:test` suites under
`tests/` (goldens make most of them one-liners); keep the existing
`tests_js`. Add a browser smoke test with tol0's puppeteer-core harness: open
each golden document, select a box, toggle every toolbar setting, enable the
pixel view, assert no console error. Rewrite `CLAUDE.md`, `guide/architecture/
*`, `guide/tool-expansion-guide.md`, `guide/api-reference` (now the `Doc` API
and `plugin.json`), `guide/ui-map.md` paths.

Acceptance: `node --test tests/` passes; the smoke test passes; no document
in `guide/` mentions Django, `tool.py`, `manage.py` or an HTTP endpoint that
no longer exists.

### Phase 8 — remove Django, prepare the new repository

Delete every Django app's Python, `recto/`, `manage.py`, `requirements.txt`,
`setup.sh`, `run_app.bat`, `demo/` (they remain on `main`). Add a deploy note:
any static host; serve `.wasm` as `application/wasm`; long cache lifetimes
are safe because every URL carries a content hash; COOP/COEP headers are
optional. Write `MIGRATING.md` for the new repository (what changed for
plugin authors: `tool.py` → `plugin.json`, endpoints → `Doc`).

Acceptance: a clean clone plus `node tools/build.mjs` plus any static file
server runs the whole app; repository size and the list of vendored binaries
(MuPDF wasm ~10 MB, HarfBuzz wasm ~1 MB, glyph bundle ~12 MB, fonts ~24 MB)
are stated in the README. The user then creates the new repository from this
tree.

## Rules for the session doing the work

- Read `CLAUDE.md`, this file, then `guide/architecture/architecture-overview.md`
  and `guide/tool-expansion-guide.md` before writing code.
- One phase at a time, one or more commits per phase, never commit to `main`.
- A port is done when its goldens pass, not when it looks right. Where a
  golden cannot be met, write down the page, the difference and the cause.
- Do not edit files under `engine/` or `glyphs/` — they are synced from
  `../tol0`. Never run tol0's sync with `--allow-partial`.
- Do not name an optional plugin in core code or core docs.
- Keep `destroy()` discipline in every worker; check the heap after each
  phase on the 340-page sample.

## Open decisions (ask the user when the phase arrives)

- Phase 5: is circle rejection in the mask worth an 8 MB opencv.js if the
   shape test cannot match it?

## Progress

- [x] Phase 0 — goldens (2026-09-18: `tools/golden/record.py --check` → `identical`, three runs; 1.98 MB)
- [x] Phase 1 — skeleton, `plugin.json`, build, dev server (2026-09-18: `node --test tests/*.test.mjs` passes — generated page equals `tests/golden/index.html` after URL normalisation; every plugin dragged out and back in the browser with no console error)
- [x] Phase 2 — documents and pages (2026-09-18: `tests/documents.test.mjs` — metadata, pixel hashes, placements equal the goldens on all 40 golden PDF pages; browser canvas pixels equal the goldens; numbers in the notes)
- [x] Phase 3 — embedded text (2026-09-18: `tests/spans.test.mjs` — spans equal the goldens within 1e-6 on all 40 golden PDF pages, full and lean; 340-page scan 4.8 s in the browser, longest main-thread stall 45 ms)
- [x] Phase 4 — text measurement (2026-09-18: `tests/shaping.test.mjs` — all 23 `/widths` cases and all 16 `/font-metrics` tables EQUAL the goldens, largest difference 0; 688 candidates in 4–7 ms, a metrics table in 47 ms, in the browser)
- [x] Phase 5 — masks (2026-09-18: `tests/masks.test.mjs` — masks (or their absence) equal the goldens on all 40 golden PDF pages, one by a stated relation (scan-tall, below); no opencv.js)
- [x] Phase 6 — OCR cache, remaining plugins, tol0 sync (2026-09-18: startup document replays the shipped cache with static requests only; a second document reads, is stored in IndexedDB and replays on reopen; `PixelView.verdict` sums to 308 certified / 308 exact; tol0 `npm run recto-test` PASS against `tools/serve.mjs`)
- [x] Phase 7 — tests and docs (2026-09-18: `node --test "tests/**/*.test.mjs"` 82 pass; `node tests/smoke/smoke.mjs` PASS on all 7 golden documents; guide rewritten — see the notes for what the "no mention" check excludes)
- [x] Phase 8 — remove Django, prepare the new repository (2026-09-18: clean clone + `node tools/build.mjs` + `python3 -m http.server` runs the whole app — no console error, no failed request; sizes in the README; `MIGRATING.md` written). **Left to the user: create the new repository from this tree, and the two decisions below.**

Notes for later phases (append as you learn):

- **Phase 0 → all.** `tests/golden/README.md` defines the layout and the
  exact pixel-hash form (`sha256_rgba` / `sha256_gray` over raw decoded
  samples). Goldens were recorded with MuPDF **1.28.2** (PyMuPDF 1.28.2),
  HarfBuzz **14.4.0** (uharfbuzz 0.56.1), OpenCV 5.0.0, Pillow 12.3.0
  (`tests/golden/versions.json`). The plan pins mupdf.js 1.28.0: if the
  `vector` render hashes miss in Phase 2, try the MuPDF version first.
- **Phase 0 → 1.** `tests/golden/index.html` is the Django-rendered page to
  diff the generated one against. Its plugin order (embedded_text_viewer,
  webgl_mask, base64_tool, redaction_matching, redaction_refiner, ocr_tool,
  text_tool) is `os.listdir` order on the recording machine — Django has no
  ordering; give `plugin.json` `order` values that reproduce it.
- **Phase 1 → all.** Run the site with `node tools/serve.mjs [port]` (launch
  config `recto-static`, port 5050); run tests with
  `node --test tests/*.test.mjs` — Node 22 does not take a bare directory.
  `web/index.html` and `web/generated/` are gitignored build output.
  `geometry.js` moved from `text_tool` into `web/core/` (the core template
  always loaded it, so it could never be dragged out with the plugin).
- **Phase 1 → all: `assetURL()`.** Not in the original plan. The build writes
  `window.RECTO_ASSETS` (every core and plugin file → hash) into the page and
  `core/hooks.js` defines `assetURL('plugins/<name>/<file>')`, which appends
  the content hash. Anything a script fetches itself — a worker, `names.json`,
  `words.txt`, the glyph bundle, and later `pdf-worker.js`, the wasm files and
  the shipped OCR caches — must go through it; that is what makes "every URL
  carries a content hash" true. A URL handed to a Worker must be absolute
  (`new URL(assetURL(p), document.baseURI).href`). `web/vendor/` is not in the
  map yet: add that root in `assetMap()` when Phase 2 vendors MuPDF.
- **Phase 1 → 2.** `app.js` skips the startup auto-load while `Doc` is
  undefined and still holds the old `/open-default` fetch;
  `generated/default-document.json` (`file`, `name`, `bytes`, `v`) is already
  written. Upload still POSTs `/open-document` (a 405 from `serve.mjs`).
  COEP is `credentialless` so the CDN scripts/styles keep loading; the page is
  `crossOriginIsolated`.
- **Phase 1 → 4.** `generated/fonts.json` is already written by the build and
  read by `fonts.js`: the `/fonts-list` shape (`families` with `present`,
  `default`, `static: 'assets/fonts/'`) plus a `hashes` map per family.
  `tests/golden/fonts-list.json` differs only in `static` and `hashes`.
- **Phase 1 → 7/8: what is left of Django.** The UI no longer runs under
  Django (template and statics moved). The Python logic and
  `tools/golden/record.py` still do: `FONT_DIR`, `DEFAULT_DOCUMENT_DIR`,
  `STATICFILES_DIRS` and `words_build.py` point into `web/` now, and the
  recorder carries `index.html` over instead of rendering it. Python tests
  that read static files by path (`redaction_refiner/tests.py`,
  `text_tool/tests.py`) fail until Phase 7 ports or drops them.
- **Phase 2 → all: what was built.** `web/core/pdf-document.js` (ES module,
  no DOM — the port of `document_loader.py` plus the raw structured-text
  adapter; imported by the worker and by the node tests),
  `web/core/pdf-worker.js` (module worker, message plumbing only),
  `web/core/doc-service.js` (`window.Doc`, loaded right after `state.js`).
  `state.pageImages` is gone: ask `Doc.pageImageURL(n)` each time (LRU of 24
  pages / 600 thumbnails, evicted URLs are revoked); "is a document open" is
  `state.numPages`. Open decision 1 took its default: nothing is persisted.
  The dev server maps `/_dev/golden/`, `/_dev/samples/`, `/_dev/lab/` to
  `tests/golden/`, `demo/samples/`, `lab/` for browser checks.
- **Phase 2: measured** (this machine, Chromium, core only — plugins parked).
  340-page / 66 MB sample: pages showable 190–205 ms after `Doc.open()`
  (read 40 ‖ worker init 55, parse 73, geometry 22, gated by SHA-256 of 66 MB
  in a parallel worker), first page painted ~220 ms, `document:loaded` ~350 ms
  (typography pass 135 ms: fonts of every page + 25-page body-size sample).
  The 200 ms target is met for "showable", missed by ~20 ms for first paint;
  the floor is the hash. Startup document: 178 ms total. Django: 910 ms +
  page fetch. 943-page court bundle (22.8 MB): every page rendered and
  PNG-encoded in 42 s, heap peak 314.75 MB (limit 322.8), its metadata equals
  Python's (453 fonts in order, scale 417, size 11). `Doc.close()`: heap
  314.75 MB → worker terminated → 22 MB on reopen.
  `performance.measureUserAgentSpecificMemory` is not available in the
  embedded preview browser even when `crossOriginIsolated`.
- **Phase 2: `Doc.open(source, name, { early })`** — an addition to the
  plan's API. `early(info)` fires when identity + geometry are known;
  `pdf-viewer.js openDocument()` shows page 1 then, and announces
  `document:loaded` after the typography pass. With plugins installed their
  own work (OCR of the previous document, 404s of unported endpoints)
  dominates any timing — measure the core with `web/plugins/` emptied.
- **Phase 2 → 3: the adapter is done.** `Doc.structuredText(n, options)`
  returns PyMuPDF's `rawdict` shape (blocks → lines → spans → chars; span:
  `size, flags, char_flags, bidi, font, color, alpha, ascender, descender,
  origin, bbox`; char: `c, origin, bbox, synthetic`), built the way
  `JM_make_spanlist` builds it (style-run splitting, `JM_char_quad`
  correction when ascender − descender < 1, mediabox clipping). Options are
  MuPDF option strings; `STEXT.WHITESPACE` (the default) is what `extract.py`
  uses — do NOT add `preserve-spans`, PyMuPDF does not. mupdf.js 1.28 exposes
  neither font ascender/descender nor char flags: both are read from MuPDF
  structs in the wasm heap (`FONT_FT_FACE = 76` → FT_Face `units_per_EM` @68,
  `ascender` @70, `descender` @72; `fz_stext_char` fields by offset, verified
  against the accessors at run time). Ascender/descender equal PyMuPDF's to
  the last digit on the goldens' seven base-14 faces. Not ported: a
  zero-width char's advance lookup inside the `JM_char_quad` correction, and
  annotation text (PyMuPDF runs annotations into the text page, mupdf.js
  `toStructuredText` runs page contents only). See `web/vendor/README.md`.
- **Phase 7: tests.** Run with `node --test "tests/**/*.test.mjs"` (quoted:
  node expands the glob, and the plan's `node --test tests/` does not work on
  Node 22). The Python tests that still meant something became
  `tests/page-controls.test.mjs` (controls on the generated page, load
  orders, no script calling a server endpoint), the catalogue/resolve tests
  in `tests/shaping.test.mjs`, and `tests/plugins/redaction_refiner/
  words.test.mjs`; the two `tests_js` suites moved to `tests/plugins/<name>/`.
  Optional plugins keep their checks beside their plugin's tests
  (`page.test.mjs`, and `smoke.mjs` steps the smoke harness discovers), so
  the top-level suites name only the core and the baseline plugins, and every
  plugin-dependent test skips when the plugin is not installed. The drag-out
  test scans with `build({ absent })` — it used to move real folders and
  raced the suites reading them in parallel. `tests/smoke/smoke.mjs` borrows
  puppeteer-core from `../tol0/node_modules`.
- **Phase 7: docs.** The "no document mentions Django / `tool.py` /
  `manage.py` / a dead endpoint" check covers `guide/` without
  `guide/migration/` (this plan and its reference files are about exactly
  those things), plus `README.md` and `CLAUDE.md`. `MIGRATING.md` and
  `tests/golden/README.md` name them on purpose.
- **Phase 8: what was removed and what was kept.** Every Django app's Python,
  `recto/`, `manage.py`, `requirements.txt`, `setup.sh`, `run_app.*`,
  `nginx_app.conf`, `recto.service`, `demo/`, and the recorder
  (`tools/golden/` — it needed the server's Python; it is at commit
  `01cb580`, and answered `identical` one last time before it went). Kept as
  standalone development scripts: `tools/dev/fonts_setup.py` (needs
  fontTools; no Django any more) and `tools/dev/words_build.py`. The two
  corpus samples moved to `tests/samples/`; a suite skips a sample that is
  not in the checkout, so the 66 MB one can stay out of the new repository
  (then 7 of the 40 golden PDF pages go unchecked). Untracked local leftovers
  (`demo/prerendered`, `media/`, `db.sqlite3`, `debug_out/`,
  `_temp_test_files/`, `lab/`, `.venv/`) were not touched; `.gitignore`
  covers them.
- **Phase 8: sizes** (clean clone, without `.git`): 119 MB — `web/` 49 MB
  (fonts 24, glyph bundle 12, MuPDF wasm 11, HarfBuzz 0.5, startup PDF 0.6,
  all code and data of core + plugins 2.6), `tests/` 69 MB (samples 67,
  goldens 2.2), `guide/` 0.4. `.git` of this branch is 120 MB because it
  carries `main`'s history; a new repository starts at the tree's size.
- **Still open — for the user.** (3) Which fonts may ship in a public
  repository: `web/assets/fonts/` holds proprietary Windows faces (Times New
  Roman, Arial, Courier New, Calibri, Cambria, Georgia, Tahoma, Segoe UI,
  Verdana, Century Schoolbook) beside the free URW/DejaVu ones; the font
  catalogue degrades per family when files are absent (`present` map), and
  `tests/shaping.test.mjs` needs the faces its goldens name. (4) The licence
  of the whole: MuPDF's WebAssembly build is AGPL-3.0.
- **Phase 6: what was built.** `ocr-tool.js` looks a read up first among the
  shipped files (`web/plugins/ocr_tool/cache/<sha256>.json`, moved from
  `ocr_tool/cache/`; the build's asset map says whether one exists, so a miss
  costs no request and no 404), then in IndexedDB (`recto-ocr-cache`, last 8
  documents, same `{ version, pages }` and version check). Every finished
  whole-document read is stored there now — uploads included, which the
  server version never cached; a fresh browser profile has none, so tol0's
  smoke test still runs the real engine. There was one committed cache file,
  not two. To ship a cache: `ocrExportCache()` in the console, or tol0's
  `node tools/recto-cache.mjs`. The glyph bundle is still fetched on a cache
  hit — `ocrLearnProducer` needs the sets on the main thread; that was so on
  `main` too. No plugin makes a same-origin request outside `core/`,
  `plugins/`, `vendor/`, `assets/`, `generated/` any more.
- **Phase 6: `document:opening`** — a new lifecycle event, emitted by
  `openDocument()` before anything changes. Since Phase 2 the new document's
  pages show ~100 ms before its `document:loaded`; in that window
  `OCRTool.state.autoDone` still said "done" for the previous document, and
  tol0's smoke test (rightly) failed on it. Plugins reset per-document state
  on `document:opening`; the OCR plugin does.
- **Phase 6: tol0** (commit `664abe4` on its `master`): `tools/
  recto-layout.mjs` lets `sync-recto`, `test-recto-app`, `verify-recto-pixels`
  and `recto-cache` work with both layouts. `sync-recto --check` reports all
  eight engine files identical to tol0's; it then refuses on tol0's own
  partial-bundle guard (2 of 77 sets missing from the local `glyphs.bin`) —
  unrelated to the rewrite, and not overridden.
- **Phase 5: what was built.** `web/plugins/webgl_mask/mask-core.js` (pure
  loops, `globalThis.MaskCore.buildMask(gray, w, h)`), `mask-worker.js` (the
  plugin's own worker: builds the mask, returns it as a PNG blob — the form
  the overlay already loaded), and `webgl-mask.js` asks
  `Doc.pagePixels(n, { gray: true })` — a new core primitive (the raster's
  samples, transferred; `source` says embedded scan or render) — instead of
  fetching. OpenCV's pieces are written out exactly: 5×5 open with its border
  rule, external 8-connected components, Suzuki border following for
  `contourArea` / `arcLength` (float32 segment lengths over the
  CHAIN_APPROX_SIMPLE corners), FILLED as "the component and what it
  encloses". ~150 ms per page in the worker.
- **Phase 5: open decision 2 is settled — no opencv.js.** `HoughCircles` finds
  no circle on any of the 37 corpus pages; it fires only on the disc drawn
  into `scan-tall`. The component-shape test (box square within 2 px, 16–44 px
  across, filled 0.70–0.85 ≈ π/4) removes that disc and leaves every other
  golden untouched.
- **Phase 5: the one differing page — `scan-tall`.** The server masked the
  UNCROPPED first image (1000×1320) while the viewer shows the cropped raster
  (1000×1294), so its overlay was stretched over the page. The port masks the
  pixels the viewer shows: its mask equals the golden's top 1294 rows exactly
  (asserted in the test; the golden picture is `tests/golden/scan-tall/
  mask-1.png`). Same root for a second, untested difference: the server took
  the page's *first* image even when it was a JPEG the viewer does not show;
  the port masks only a page whose shown raster is the embedded scan
  (`source === 'embedded'`), and a rendered page has no mask, as before.
- **After the migration (2026-09-19): two deliberate mask deviations.**
  (1) *No fill.* The server's `drawContours FILLED` masked whatever a region
  enclosed; on EFTA00173953 the bars of adjacent lines touch, form one
  component, and the white gaps between them — semicolons included — were
  masked. The mask is now the component's own pixels. None of the 366 corpus
  pages has an enclosed gap, so every mask golden still passes; a synthetic
  case in `tests/masks.test.mjs` holds the rule. (2) *Image documents are
  masked.* The server answered 204 for them (the `image-*` goldens still say
  so; the mask suite only runs PDFs). `webgl-mask.js` now fetches
  `Doc.pageImageURL(n)` when `Doc.pagePixels` yields `null`, and the worker
  decodes it over white and grays it with `MaskCore.grayOf`; the
  `state.hasPdf` guard on `page:rendered` is gone.
- **After the migration (2026-09-19): the mask's edges are reworked — a third
  deliberate deviation.** The server's two rings (one `255 − max` per
  contiguous ring run) left behind: the diagonal corner pixels of a two-line
  rim; the darker of two rims on one straight side (two boxes ending in the
  same pixel column — a black sliver beside a semicolon on EFTA00173953);
  pixels under two crossing rims; a third rim line. Measured on that page: a
  rim pixel is `page × t`, `t` constant along one side of one box; crossing
  rims multiply exactly (`bc · d3 / 255 = 9b`); a box covers `ax · ay` of its
  corner pixel; resampling rings by a few levels next to convex corners.
  `MaskCore.transmission` reads `t` off the page per side, piece, line and
  corner (guide/frontend/webgl-mask.md has the rules); detection is untouched
  and is now `MaskCore.regions`. **The mask goldens hold the regions, no
  longer the ring values**: `tests/masks.test.mjs` requires region ⇔ 255 in
  the recorded mask (one recorded pixel is a black page pixel on a server
  ring), and holds the edges to pages built in the test. The yardstick was
  text: on a real text page with boxes of known rims laid at random over the
  text, rim residue fell 10–40×, text lost under light and medium rims stayed
  level or fell, and under rims darker than 90 % it rose by some tens of
  pixels a page — the price of the four dark-rim rules, each of which was
  kept only after looser versions had been measured and thrown out (a paper
  tolerance in the shader: ×5 text lost under dark rims; overlap dips without
  outline evidence: ×2–10). 48 redacted pages of the local corpus: non-white
  pixels within 3 px of a region 18 423 → 11 457, the rest being text; every
  pixel the old mask kept dark and the new one whitens was checked to be rim.
  ~10–60 ms a page on top of detection. The shader is unchanged.
- **Phase 4: what was built.** `web/vendor/harfbuzz/` is harfbuzzjs 1.6.1 =
  HarfBuzz **14.4.0**, the very version Python's uharfbuzz 0.56.1 recorded the
  goldens with — so the numbers are equal, not close.
  `web/plugins/text_tool/shaping.js` (classic script; `ShapingCore` for node,
  `window.Shaping.widths(request)` / `.fontMetrics(request)` in the browser,
  same request and response objects as the endpoints). Callers changed:
  `toolbar.js`, `fonts.js`, and — guarded with `typeof Shaping` —
  `redaction_matching/api.js`, `redaction_refiner`. Fonts are fetched once per
  face at the URL the `@font-face` rule uses.
- **Phase 4: the `kern` table.** harfbuzzjs is a *minimal* build without the
  legacy `kern` table, and Times New Roman, Arial, Tahoma, Verdana, Segoe UI
  and Century Schoolbook here kern through nothing else (unkerned widths were
  up to 14 px off). `shaping.js` parses the table (version 0, horizontal
  format 0) and applies it as `hb_kern_machine_t` does — `kern >> 1` onto the
  left advance, the rest onto the right — when kerning is requested and GPOS
  has no `kern` feature **for the text's script** (Tahoma kerns Arabic
  through GPOS and Latin through `kern`). Checked beyond the goldens against
  Python on every face of the catalogue: 90 face × ligature combinations,
  203 strings incl. Cyrillic and Greek, widths and per-character offsets —
  all equal (1e-13 from the check's own scale arithmetic).
- **Phase 3: what was built.** `web/plugins/embedded_text_viewer/extract.js`
  (classic script, pure functions on `globalThis.EtvExtract`, loaded before
  `etv-fetch.js`; node imports it as it is). `etv-fetch.js` keeps its two
  tiers and its chunking — a chunk is now a loop of
  `Doc.structuredText(p, { imageRect: true })` + `extractSpans`, aborted when
  `state.docHash` changes. `Doc.structuredText` takes `{ options, imageRect }`
  and its result carries the page `rect` (the fallback placement). Python's
  `round(x, n)` is reproduced exactly (`pyRound`: exact binary value, ties to
  even — `toFixed` alone sends ties up). The scan costs two MuPDF text passes
  per page (text, then `preserve-images` for the placement); folding them
  into one would renumber blocks wherever an image is painted between text
  runs, so they stay separate. The heap reaches the 256 MB store cap during a
  whole-document scan of the 340-page sample (299 MB; limit 66 + 300).
- **Phase 2 → 3/5: what a usable raster is.** `extract_image` returns PNG for
  everything except a stream whose LAST filter is DCTDecode/JPXDecode (kept
  as JPEG/JPX and therefore skipped by `_first_raster`); gray and RGB samples
  are written as they are (ICC-based included, no colour management), other
  colourspaces go to DeviceRGB. MuPDF 1.28.0 (wasm) and 1.28.2 (PyMuPDF)
  render the `vector` pages identically.
- **Phase 0 → 2.** Every corpus raster is 816×1056 DeviceGray 8-bit Flate, so
  the ratio crop never fires on them; the added `scan-tall` document
  (1000×1320 → 1294 rows, stored ICCBased and returned by `extract_image` as
  RGB) is the only crop golden. `/open-document` reports 816×1056 for every
  PDF regardless of raster size. Thumbnails are Pillow LANCZOS — hold a JS
  thumbnail to the golden's size, not its hash. For image documents the
  served bytes are the file (`sha256_bytes`); the JPEG pixel hash is Pillow's
  decode and only indicative. `pages.json → raster` records, per page,
  embedded-vs-render, the placement `rect` and the `text_rect` that
  `Doc.pageImageRect` must return.
- **Phase 0 → 3.** A multi-page chunk equals the per-page answers laid end to
  end, and lean is a field subset of full (both asserted by the recorder), so
  goldens are per page. In the `vector` document a tab comes back as U+FFFD
  and runs of spaces split spans — both are in the golden.
- **Phase 0 → 5.** The mask is computed on the **uncropped first image** of
  the page (`get_grayscale_image_bytes`), not on the cropped page raster:
  `scan-tall` has a 1000×1294 page image and a 1000×1320 mask. Mask PNGs are
  stored (`mask-<n>.png`) so a differing page can be pictured.
- **Phase 0 → 8.** Two golden documents live in `demo/samples/`, which Phase 8
  deletes: move them (66 MB + 3.6 MB) under `tests/` or drop the tests that
  need the files first.
