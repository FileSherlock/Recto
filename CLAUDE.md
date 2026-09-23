# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Recto is an extensible PDF editor that runs entirely in the browser: open a PDF or scanned image, edit/add text with
true font metrics (HarfBuzz shaping), mask regions, inspect embedded text. Vanilla JS + SVG + WebGL, MuPDF and
HarfBuzz as WebAssembly. It is a static website — no server code, no build step beyond one scan script, no bundler,
no JS package manager — and a user's document never leaves the browser. The site needs no Python: `tools/dev/*.py`
are standalone maintenance scripts (font files, the refiner's word list), run by hand when their inputs change.

## Commands

```bash
node tools/serve.mjs [port]             # dev server → http://localhost:5000 (rebuilds index.html on every request for it)
node tools/build.mjs                    # the scan: web/plugins/*/plugin.json → web/index.html + web/generated/*  (a deploy runs this once)
node --test "tests/**/*.test.mjs"       # the test suite (node:test, zero dependencies)
node tests/plugins/<name>/<file>.test.mjs   # one plugin's suite on its own
node tests/smoke/smoke.mjs              # browser smoke test over every golden document (needs Chrome + ../tol0's puppeteer-core)
```

Deploying is publishing `web/` on any static host after `node tools/build.mjs`; `.wasm` must be served as
`application/wasm`. `web/index.html` and `web/generated/` are build output (gitignored).

## Architecture: core + plugins, one manifest, one event bus

The dividing line is strict: **the core (`web/core/`) opens the document, reports its typography, hands out page
rasters one at a time, and runs no analysis.** Opening yields metadata only; pages are produced on demand, which is what
lets multi-thousand-page files open in a fraction of a second. Every feature beyond that is a plugin — a
self-contained folder under `web/plugins/` that can be deleted with no dangling reference, or dropped in to add the
feature. Full docs live in `guide/` (start with `guide/architecture/architecture-overview.md` and
`guide/tool-expansion-guide.md`).

- **`plugin.json` — what a plugin contributes.** Name (= folder name), `order`, `styles`, the five HTML slots
  (`toolbar_button` → the left tool column, `options_bar` / `ribbon_bar` → the ribbon, `sidebar` → a right panel,
  `settings` → a section of the Settings panel; fragment files next to the scripts), and `scripts_before_viewer` /
  `scripts_after_app`. `tools/build.mjs` scans the folders, inlines the fragments into `web/core/index.template.html`
  at its `@plugins:*` markers and emits the script tags in the fixed order. **Never edit `web/index.html`, the template
  or the build to add a plugin** — add a folder. The core arranges what it finds and names no plugin: the tool column
  is reordered and trimmed by the user (Customise tools, localStorage), ribbon groups that do not fit move under
  "More", the Settings button appears only when some plugin contributed a section.
- **`PDFHooks` — the event bus** (`web/core/hooks.js`, loaded before everything else): the core emits lifecycle events
  (`ui:ready`, `document:opening`, `viewer:clear`, `page:rendered`, `pages:refresh`, `document:loaded`,
  `zoom:changed`); plugins subscribe with `PDFHooks.on(...)`. The core never calls a plugin function by name. Handlers
  may be async and a throwing handler can't break the core. Per-document plugin state is reset on
  `document:opening`: the new document's first page renders before its `document:loaded` arrives.
- **`Doc` — the document service** (`web/core/doc-service.js`), the only file that talks to `pdf-worker.js`, the module
  worker that owns MuPDF and the open PDF: `Doc.open`, `Doc.pageImageURL(n, { thumb })` (blob: URLs in an LRU — ask
  each time, never store one), `Doc.pagePixels(n, { gray })`, `Doc.structuredText(n, { options, imageRect })` (raw
  MuPDF structured text in PyMuPDF's rawdict shape — a primitive, not analysis), `Doc.pageImageRect(n)`,
  `Doc.bytes()`, `Doc.close()` (terminates the worker: the only way a wasm heap gives memory back).
  `web/core/pdf-document.js` is the MuPDF side — an ES module with no DOM, imported by the worker and by the node tests.
- **`assetURL(path)`** (`web/core/hooks.js`): the build stamps every `<script>`/`<link>` with the file's content hash
  and writes the same hashes into `window.RECTO_ASSETS`; a script that fetches a sibling itself (a worker, a word list,
  a wasm) asks `assetURL('plugins/<name>/<file>')`. No version is ever bumped by hand. A URL handed to a Worker must be
  absolute (`new URL(assetURL(p), document.baseURI).href`).

Analysis is a second, plugin-owned pass: plugins listen for `document:loaded` (and `page:rendered`), take what they
need from `Doc`, do their work in their own code — a worker of their own when it is heavy — and draw their own
overlays. Prefer per-page work over whole-document passes so huge documents stay cheap.

### Baseline plugins

| Plugin | Role |
|---|---|
| `text_tool` | Edit/add text; `shaping.js` measures with HarfBuzz (`Shaping.widths`, `Shaping.fontMetrics`), `fonts.js` is the font catalogue (`FontCatalog`, from `generated/fonts.json`) |
| `embedded_text_viewer` | Inline overlay of the PDF's embedded text; `extract.js` turns `Doc.structuredText` into spans |
| `webgl_mask` | Black-region detection (`mask-core.js`, in the plugin's own worker) + GPU mask tinting |

Optional plugins are documented **only** in `guide/plugins/` — core code, baseline plugins and baseline docs must never
name an optional plugin (that's the contract; a mention elsewhere is a leak to fix). Optional plugins attach only
through the `PDFHooks` bus and guarded globals (`typeof fn === 'function'` call sites in `text_tool`); an optional
plugin may use a baseline plugin's global, guarded (`typeof Shaping !== 'undefined'`).

## Goldens and exactness

`tests/golden/` holds recorded reference outputs (open metadata, decoded-pixel hashes of page rasters, spans, masks,
font lists and metrics, widths — see its README). The suites hold the code to them: rasters and masks pixel for
pixel, spans within 1e-6, HarfBuzz numbers to the last digit. **A change to anything the goldens cover is done when
they pass, not when it looks right**; where a golden cannot be met, the page, the difference and the cause are
written down. Page rasters are the embedded scan's own samples, cropped with exact integer arithmetic — plugins that
read or redraw a page certify their result against those bytes.

`web/vendor/` holds the pinned WebAssembly builds (MuPDF 1.28.0, harfbuzzjs 1.6.1 = HarfBuzz 14.4.0); read
`web/vendor/README.md` before upgrading either — the core reads two MuPDF structs from the wasm heap, and the shaper
applies the legacy `kern` table that the minimal HarfBuzz build leaves out. A plugin may carry files synced verbatim
from another repository (its README under `guide/plugins/` says which folders); those are never edited here.

## Coordinate contract

`web/core/geometry.js` (`window.GEO`) is the single source of truth (`web/core/pdf-document.js` carries the same
constants for the worker). Two spaces: **image pixels at 96 DPI** (canonical geometry — box x/y/w/h, SVG viewBox) and
**PDF points at 72 DPI** (canonical typography — `sizePt`). Font size converts to px exactly once, at the SVG render
boundary. Use the named constants; never re-derive `0.75`, `133`, `816`, etc.

## Frontend conventions

- Script load order: `hooks.js` → `geometry.js` → `state.js` → `doc-service.js` → plugin `scripts_before_viewer` →
  `pdf-viewer.js` → `ui-events.js` → `app.js` → plugin `scripts_after_app`. Scripts in `scripts_before_viewer` can't
  call `app.js` globals (`openSubtoolbar`, `registerSubtoolbar`) at module scope — defer to a
  `PDFHooks.on('ui:ready', …)` handler.
- Plain classic scripts. Code that must also run under node (anything the suites hold to the goldens) is written without DOM
  access and publishes itself on `globalThis` (`EtvExtract`, `MaskCore`, `ShapingCore`); the tests import the very file
  the page loads.
- `state` and `els` (in `state.js`) hold **core-only** state and DOM refs. "A document is open" is `state.numPages > 0`.
  Plugin state lives in the plugin; plugins look up their own DOM with `document.getElementById(...)` using optional
  chaining (`?.`) so removal never throws.
- Toggle visibility only via the `.hidden` class (CSS transitions key on it), never `display:` directly.
- Subtoolbar plugins register their toggle with `window.registerSubtoolbar(btn)` and open/close via
  `window.openSubtoolbar(bar, btn)` — one options bar visible at a time. Right-panel plugins are fully self-owned: the
  plugin's `sidebar` fragment supplies its own container element, the plugin ships its own CSS and toggle wiring, and
  the core hosts no right panel — there is no core touchpoint.
- Every MuPDF wrapper (`Page`, `Pixmap`, `Image`, `StructuredText`) is `destroy()`ed where it is made; left to the
  garbage collector they hold hundreds of MB of wasm heap.
- `guide/ui-map.md` maps every visible control (label/tooltip → owning plugin → fragment → handler script). Update it
  in the same change whenever a control is added, moved, renamed, or removed.
