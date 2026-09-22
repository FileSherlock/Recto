# Frontend — JavaScript Module Reference

Recto is a single-page application in vanilla JavaScript, and the page is all there is:
opening a document, rasterizing pages, extracting text, measuring text and detecting masks
all run in the browser. Nothing is transpiled or bundled. `tools/build.mjs` assembles
`web/index.html` from `web/core/index.template.html` and each plugin's
[`plugin.json`](../api-reference/api-reference.md#pluginjson--the-plugin-manifest); the
scripts are plain `<script>` tags in a fixed order.

## Loading Order

Cross-module integration happens through the **`PDFHooks`** event bus (module 1) rather
than the core calling plugin functions by name, so plugins are wired by *subscribing* to
lifecycle events at run time — the load order below matters only for the few direct global
dependencies noted in the last column.

The core scripts have fixed positions. Plugin scripts fill two slots —
`scripts_before_viewer` and `scripts_after_app` — and within a slot the plugins come in
the order of their manifest's `order` (`embedded_text_viewer` 10, `webgl_mask` 20,
`text_tool` 70), each plugin's scripts in the order its manifest lists them.

| Order | File | Defines | Subscribes / Emits | Depends On |
|-------|------|---------|--------------------|------------|
| 1 | `core/hooks.js` | `PDFHooks` (`on`/`off`/`emit`), `assetURL` | — | — (loaded first) |
| 2 | `core/geometry.js` | `GEO` — the coordinate contract's constants and `docPxPerPt` / `docPtToPx` / `docScale` | — | — |
| 3 | `core/state.js` | `state`, `els` | — | `GEO`, DOM elements |
| 4 | `core/doc-service.js` | `Doc` — the document service | — | `assetURL`, `GEO` |
| 5 | `webgl_mask/webgl-mask.js` *(slot `scripts_before_viewer`)* | `setupWebGLOverlay`, `clearWebGLContexts`, `updateWebGLUniforms`, `refreshWebGLCanvases` | **on:** `ui:ready`, `viewer:clear`, `page:rendered`, `pages:refresh` | `state`, `Doc`, `assetURL` |
| 6 | `core/pdf-viewer.js` | `openDocument`, `showDocument`, `announceDocument`, `showNoDocument`, `handleFileUpload`, `goToPage` | **emit:** `document:opening`, `viewer:clear`, `page:rendered`, `pages:refresh`, `document:loaded` | `state`, `els`, `Doc` |
| 7 | `core/ui-events.js` | `updateZoomLevelText`, `updateCSSZoom`, `processZoomFromText`, `renderThumbnails` | **emit:** `zoom:changed` | `state`, `els`, `Doc` |
| 8 | `core/app.js` | IIFE — wires core listeners; `openSubtoolbar`, `registerSubtoolbar`; opens the startup document | **emit:** `ui:ready` | All above |
| 9 | `embedded_text_viewer/extract.js` | `EtvExtract` (`extractSpans`, `leanSpan`, …) | — | — |
| 10 | `embedded_text_viewer/etv-fetch.js` | `utbFetchSpans`, `utbConnectRedactionsToLines`, `addEmbeddedTextSpan`, `_utbFindNearestLine`, `etvSpanCache` | **on:** `document:loaded`, `page:rendered` · **emit:** `redactions:connected` | `Doc`, `EtvExtract`; `utbState`, `renderBox`, … at run time |
| 11 | `text_tool/shaping.js` | `Shaping` (`widths`, `fontMetrics`), `ShapingCore` | — | `assetURL` |
| 12 | `text_tool/fonts.js` | `FontCatalog` | **on:** `document:loaded`, `typography:detected` | `Shaping` (run time) |
| 13 | `text_tool/unified-text-box.js` | `UnifiedTextBox`, `utbState`, `spanToUnified`, `normUtbFont`, `utbCharsValid`, `utbFindNearestLine` | — | `FontCatalog` (run time) |
| 14 | `text_tool/svg-renderer.js` | `renderBox`, `renderTextLayer`, `renderAllTextLayers`, `selectBoxInSVG`, `computeXPositions`, `clearAllSVGLayers` | **on:** `page:rendered` | `utbState`, `GEO` |
| 15 | `text_tool/drag-resize.js` | IIFE — SVG-native drag/resize event delegation | — | `utbState`, `renderBox` |
| 16 | `text_tool/ruler.js` | `refreshRuler` | **on:** `page:rendered` | `utbState`, `GEO` |
| 17 | `text_tool/toolbar.js` | `syncToolbarToBox`, `syncToolbarToSelection`, `getNaturalSpaceWidth` | — | `utbState`, `renderBox`, `Shaping` |
| 18 | `text_tool/micro-typo.js` | `enterMicroTypo`, `exitMicroTypo` | — | `utbState`, `computeXPositions`, `renderBox` |
| 19 | `text_tool/inline-edit.js` | `enterInlineEdit`, `commitInlineEdit`, `cancelInlineEdit` | — | `utbState`, `renderBox`, `exitMicroTypo` |
| 20 | `text_tool/text-tool.js` | `handleManualAddBox`, `handleManualAddText`, `utbDeleteBox` | — | `utbState`, `renderBox`, all above |

All paths are relative to `web/`; plugin files live under `web/plugins/`.

> **Slot 5 is also the optional-plugin slot.** `scripts_before_viewer` — after
> `doc-service.js`, before `pdf-viewer.js` — is where a plugin defines globals the baseline
> modules call behind `typeof` guards. See [Optional Plugins](../plugins/).

> **Note:** Because `PDFHooks` is defined first and subscriptions are order-independent, a
> plugin can call `PDFHooks.on(...)` at module scope regardless of where it loads.
> `etv-fetch.js` loads *before* the `text_tool` scripts it calls into; that is safe because
> every such call happens inside an event handler or an async continuation, never at
> module scope. For the same reason `app.js` opens the startup document only after
> `DOMContentLoaded` — by then every `scripts_after_app` script has subscribed to
> `document:loaded`.

## Modules that are not `<script>` tags

| File | Loaded by | Role |
|------|-----------|------|
| `core/pdf-worker.js` | `doc-service.js` (`new Worker(…, { type: 'module' })`) | The module worker that owns MuPDF and the open PDF. Only `doc-service.js` talks to it |
| `core/pdf-document.js` | `pdf-worker.js` (`import()`) | ES module with no DOM: `openPdf(mupdf, Module, bytes)` → page count, declared fonts, suggested scale and size, page rasters, raw structured text, image placement. The node tests import it directly |
| `plugins/webgl_mask/mask-worker.js` | `webgl-mask.js` (`new Worker`) | The mask plugin's own worker |
| `plugins/webgl_mask/mask-core.js` | `mask-worker.js` (`importScripts`) | `MaskCore.buildMask` — pure loops, also loaded by the node tests |
| `vendor/mupdf/mupdf.js` + `mupdf-wasm.wasm` | `pdf-worker.js` | MuPDF as WebAssembly |
| `vendor/harfbuzz/index.mjs` + `harfbuzz.wasm` | `shaping.js` (`import()`) | HarfBuzz as WebAssembly |

Every one of these URLs goes through [`assetURL()`](../api-reference/api-reference.md#windowrecto_assets-and-asseturl),
so it carries the file's content hash. `shaping.js`, `extract.js` and `mask-core.js` keep
their measuring cores free of DOM on purpose: the `node:test` suites in `tests/` load the
very files the browser runs.

## Libraries

| Library | From | Purpose |
|---------|------|---------|
| MuPDF 1.28.0 (WebAssembly) | `web/vendor/mupdf/` | Opens PDFs, decodes embedded scans, renders pages, structured text |
| harfbuzzjs 1.6.1 = HarfBuzz 14.4.0 (WebAssembly) | `web/vendor/harfbuzz/` | Text shaping for width measurement |
| Material Symbols | Google Fonts | Toolbar icons |
| Inter font | Google Fonts | UI typography |

The vendored builds are pinned and copied in verbatim; `web/vendor/README.md` lists
versions, licences and what an upgrade has to check.

## Module Documentation

- [API Reference](../api-reference/api-reference.md) — `Doc`, `plugin.json`, the build outputs, `PDFHooks` events, the baseline plugins' public globals
- [State Management](state-management.md) — `state` object schema and `els` DOM cache
- [PDF Viewer](pdf-viewer.md) — Opening a document, page navigation, rendering
- [UI Events](ui-events.md) — Zoom, thumbnails
- [SVG Text Layer](embedded-text-viewer.md) — `UnifiedTextBox` data model, SVG rendering, embedded text ingestion, inline editing, micro-typography
- [Toolbar & Text Tool](text-tool.md) — Formatting toolbar controls, manual boxes, the font catalogue
- [Text Measurement](width-calculator.md) — `shaping.js`: HarfBuzz widths and face metrics
- [WebGL Mask](webgl-mask.md) — Mask detection in a worker, GPU-accelerated mask rendering
- [Optional Plugins](../plugins/) — plugins outside the baseline, and the guarded-global seams they attach through
