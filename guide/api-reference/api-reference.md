# API Reference

Recto is a static website. There is no server API: every call below is a JavaScript
call made inside the page, and the document the user opens never leaves the browser.
This page is the reference of those browser APIs — what the core offers to plugins,
what a plugin declares to the build, what the build writes, and the public globals of
the baseline plugins.

| Surface | Defined in | What it is |
|---------|-----------|------------|
| [`Doc`](#doc--the-document-service) | `web/core/doc-service.js` | The document service: open a file, page rasters, page pixels, raw structured text |
| [Viewer entry points](#viewer-entry-points) | `web/core/pdf-viewer.js`, `web/core/ui-events.js` | `openDocument`, `showDocument`, `announceDocument`, `goToPage`, `renderThumbnails` |
| [`PDFHooks`](#pdfhooks-events) | `web/core/hooks.js` | The lifecycle event bus between the core and the plugins |
| [`plugin.json`](#pluginjson--the-plugin-manifest) | `web/plugins/<name>/plugin.json` | What a plugin contributes to the page |
| [Build outputs](#build-outputs) | `tools/build.mjs` | `web/index.html` and `web/generated/*.json` |
| [`window.RECTO_ASSETS` + `assetURL()`](#windowrecto_assets-and-asseturl) | `tools/build.mjs`, `web/core/hooks.js` | Content-hashed URLs for files a script fetches itself |
| [`Shaping`](#shaping--text-measurement-text_tool) | `web/plugins/text_tool/shaping.js` | Text widths and face metrics through HarfBuzz |
| [`FontCatalog`](#fontcatalog--the-font-catalogue-text_tool) | `web/plugins/text_tool/fonts.js` | The font catalogue on the page |
| [`EtvExtract`](#etvextract--embedded-text-spans-embedded_text_viewer) | `web/plugins/embedded_text_viewer/extract.js` | Spans from a page's raw structured text |
| [`MaskCore`](#maskcore--page-masks-webgl_mask) | `web/plugins/webgl_mask/mask-core.js` | The mask of one page raster |

> **Optional plugins document their own APIs.** This reference covers the core and the
> baseline plugins only. A plugin outside the baseline owns its documentation, in its own
> folder under [`guide/plugins/`](../plugins/) — so removing the plugin removes its API
> docs with it, and this page never goes stale.

---

## `Doc` — the document service

`window.Doc` is the only code that talks to `web/core/pdf-worker.js`, the module worker
that owns MuPDF (WebAssembly) and the open PDF. The viewer and every plugin go through
`Doc`; none of them imports MuPDF or posts to the worker.

The service runs **no analysis**. It opens the document, describes it, and hands out
primitives — a page's raster, its pixels, its raw structured text. Turning those into
spans, masks or anything else is a plugin's job.

One document is open at a time. `Doc.open()` closes the previous one first.

### `Doc.open(source, name, { early })`

```js
const info = await Doc.open(file, file.name, { early: info => showFirstPage(info) });
```

| Argument | Type | Description |
|----------|------|-------------|
| `source` | `File` \| `Blob` \| `ArrayBuffer` | The document's bytes |
| `name` | string | File name; its extension decides PDF or image. When the name has no known extension the blob's MIME type decides, and PDF is the last resort. A `File`'s own `name` is read when `name` is omitted |
| `early` | function, optional | Called once, with a partial result, as soon as pages can be shown (see below). PDFs only |

Supported formats: PDF, and the images PNG, JPEG, TIFF, BMP, WebP.

Resolves to the document's description — **metadata only**; no page raster is part of it:

```json
{
  "sha256": "9f2c…64 hex chars…e1",
  "numPages": 3,
  "pageWidth": 816,
  "pageHeight": 1056,
  "pdfFonts": ["TimesNewRomanPSMT", "TimesNewRomanPS-BoldMT"],
  "suggestedScale": 133,
  "suggestedSize": 12.0,
  "pageImageType": "image/png"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `sha256` | string | SHA-256 of the file's bytes — the document's identity (`state.docHash`), which plugins key per-document caches off. Computed in a throw-away worker of its own, so neither the page nor the MuPDF worker waits for it |
| `numPages` | int | Page count (`1` for an image) |
| `pageWidth` / `pageHeight` | int | The pixel space of the page: 816 × 1056 for a PDF, the image's own size for an image document |
| `pdfFonts` | array | BaseFont names the PDF declares, the one on the most pages first (equal counts keep first-seen order). `[]` for images |
| `suggestedScale` | int | px-per-pt as a percentage, measured from the first placed raster of the document (its pixel width over its placed width in points); `133` when no page has one. See [Scale & Size Detection](../architecture/scale-and-size-detection.md) |
| `suggestedSize` | float | The body-text size in points: the mode of the span sizes (to the nearest 0.5 pt) over the first 25 pages, long spans (≥ 20 characters) first. `12.0` when the document has no text |
| `pageImageType` | string | MIME type of the page rasters — `"image/png"` for PDFs, the file's own type for an image document |

**`early`.** Opening a PDF has two passes. The first — parse, page count, page size,
scale — takes milliseconds; the second reads the declared fonts of every page and samples
the body size, which on a long document takes noticeably longer. `early(info)` fires
between the two with `{ sha256, numPages, pageWidth, pageHeight, suggestedScale,
pageImageType }`: identity and geometry are final, `pdfFonts` and `suggestedSize` are
still to come. From that moment `Doc.pageImageURL()` works, and a page request goes
ahead of the typography pass in the worker's queue — which is how the viewer puts page 1
on screen before the open has finished. An exception thrown by `early` is logged and
does not fail the open.

**Superseded opens.** A second `Doc.open()` started before the first has finished makes
the first reject with `another document was opened meanwhile`; its answers are dropped.

After the promise resolves, `Doc.info` holds the same object and `Doc.timings` says where
the time went, in milliseconds (`readMs`, `initMs`, `parseMs`, `geometryMs`, `readyMs`,
`typographyMs`, `totalMs`; an image document reports `totalMs` only).

### `Doc.pageImageURL(n, { thumb })` → `Promise<string>`

A `blob:` URL of page `n`'s raster (1-based), a lossless PNG encoded by MuPDF.

For a PDF page the raster is the page's **embedded scan** — the first image on the page
that is not a JPEG or JPEG 2000 stream — with its own samples, never resampled. A scan
taller than the 8.5 × 11 ratio loses its excess bottom rows, so the raster has the ratio
the pixel coordinate space assumes. A page with no such image is **rendered at 96 DPI**
instead, which lands in the same pixel space. These are the exact pixels every coordinate
consumer shares.

`{ thumb: true }` gives the 180 px wide variant for the thumbnail strip (an area average
of the same raster).

Rejects with `no document is open`, or a `RangeError` (`no page <n>`) when `n` is not an
integer in `1..numPages`.

**LRU and revocation — ask each time, never store.** URLs are made lazily and kept in two
least-recently-used maps: 24 full pages and 600 thumbnails. A URL that falls out is
**revoked**, and so is every URL of a document when it is closed or another is opened. A
stored URL can therefore stop working at any time; call `Doc.pageImageURL(n)` at the
moment the URL is needed — a repeated call for a cached page costs nothing and marks it
recently used.

### `Doc.pagePixels(n, { gray })` → `Promise<object | null>`

The same raster as samples, for a plugin that analyses pixels:

```js
{ width, height,            // pixels
  components,               // samples per pixel: 1 gray, 3 RGB, one more when alpha is true
  alpha,                    // boolean
  samples,                  // Uint8Array, width × height × components, rows top to bottom
  source,                   // 'embedded' — the page's scan | 'render' — a 96-DPI render of a born-digital page
  rect }                    // [x0, y0, x1, y1] in PDF points: where the scan is placed on the page; null for a render
```

`{ gray: true }` gives one component per pixel, colour converted by MuPDF. The `samples`
buffer is transferred out of the worker, so it belongs to the caller and may be
transferred on to the caller's own worker.

`source` matters to analysis: a plugin looking for marks in a scan has nothing to find on
a rendered page. `null` for an image document — decode `Doc.pageImageURL(1)` instead.

### `Doc.structuredText(n, { options, imageRect })` → `Promise<object>`

The **raw** MuPDF structured text of one page, in PyMuPDF's "rawdict" shape:

```js
{ rect: [x0, y0, x1, y1], width, height,          // the page, in PDF points
  blocks: [
    { number, type: 0, bbox,                      // a text block
      lines: [{ wmode, dir: [x, y], bbox,
        spans: [{ size, flags, bidi, char_flags, font, color, alpha,
                  ascender, descender, origin, bbox,
                  chars: [{ c, origin, bbox, synthetic }] }] }] },
    { number, type: 1, bbox }                     // an image block: its bbox only
  ],
  imageRect }                                     // only when asked for
```

All coordinates are PDF points. A span is a run of characters of one style; `font` is the
font's name with a subset prefix (`ABCDEF+`) removed; `flags` carries the style bits
superscript `1`, italic `2`, serifed `4`, monospaced `8`, bold `16`; `color` is `0xRRGGBB`
and `alpha` `0..255`; `ascender` / `descender` are the face's own, read from MuPDF's font
struct in the wasm heap because the JavaScript binding exposes neither (see
`web/vendor/README.md`). The text is the page's own content; what annotations draw is not
part of it.

| Option | Default | Description |
|--------|---------|-------------|
| `options` | `'preserve-whitespace'` | A MuPDF structured-text option string |
| `imageRect` | `false` | `true` adds `.imageRect` — the value of `Doc.pageImageRect(n)` — in the same trip to the worker, which is what a text plugin needs to map points to image pixels |

An image document answers with an empty page: `{ rect: [0, 0, w, h], width, height, blocks: [] }`.

### `Doc.pageImageRect(n)` → `Promise<rect | null>`

Where the page image sits on the page: the placement `[x0, y0, x1, y1]`, in PDF points, of
the page's **largest** image by placed area. `null` when the page has no image (it is
shown as a render of the full page, so the page rectangle is the placement) and for an
image document.

### `Doc.bytes()`, `Doc.heapMB()`, `Doc.close()`

| Call | Returns | Description |
|------|---------|-------------|
| `Doc.bytes()` | `Promise<ArrayBuffer>` | The open document's bytes, for a plugin that runs its own worker over the file. Rejects when no document is open |
| `Doc.heapMB()` | `Promise<number \| null>` | Size of the worker's WebAssembly heap in MB; `null` when no worker is running |
| `Doc.close()` | — | Revokes every URL of the document, rejects whatever is still queued (`the document was closed`) and **terminates the worker**. A WebAssembly heap never shrinks; ending the worker is what returns the memory. The next `open()` starts a new one (about 50 ms) |
| `Doc.info` | object \| `null` | The last `open()`'s result |
| `Doc.timings` | object \| `null` | Where that open's time went (ms) |

### Request order

Requests go to the worker one at a time. Among the queued ones the most urgent kind goes
next — a shown page ahead of the typography pass, ahead of text, pixels and placements,
ahead of thumbnails — and requests of one kind keep their order. A plugin scanning a
whole document's text therefore never delays the page the user just turned to.

### Image documents

A PNG, JPEG, TIFF, BMP or WebP file is a one-page document that MuPDF never sees. Its
size comes from `createImageBitmap`; `pageImageURL(1)` is a URL of **the file itself**
(nothing is re-encoded), and the thumbnail is a 180 px canvas downscale. `pagePixels` and
`pageImageRect` answer `null`, `structuredText` an empty page, `pdfFonts` is `[]`,
`suggestedScale` `133`, `suggestedSize` `12.0`. `early` is not called.

---

## Viewer entry points

Global functions of the core viewer. Plugins rarely call them — they react to the
[events](#pdfhooks-events) these functions emit — but a plugin that opens a document itself,
or turns pages, uses the same entry points as the core.

| Function | Defined in | Description |
|----------|-----------|-------------|
| `openDocument(source, name, file)` | `web/core/pdf-viewer.js` | The whole sequence: emits `document:opening`, calls `Doc.open(source, name, { early })`, shows the document from the `early` call (or from the final result when `early` never fired), then `announceDocument`. `file` is the user's `File`, `null` for the startup document. Resolves to `Doc.open()`'s result |
| `showDocument(info)` | `web/core/pdf-viewer.js` | Takes `Doc.open()`'s result or its early form: fills `state.numPages`, `state.pageWidth`, `state.pageHeight`, `state.docHash`, resets the page counter, then `goToPage(1)` and `renderThumbnails()` |
| `announceDocument(info, file)` | `web/core/pdf-viewer.js` | Emits `document:loaded` with `{ file, isDefault, pdfFonts, sizePt }` and awaits the handlers |
| `goToPage(pageNum)` | `web/core/pdf-viewer.js` | Shows one page: awaits `Doc.pageImageURL(pageNum)`, emits `viewer:clear`, builds `#pageContainer<n>` with `<img id="page<n>">`, emits `page:rendered` and `pages:refresh`. A later call, or another document, overtakes one that is still waiting for its raster |
| `renderThumbnails()` | `web/core/ui-events.js` | Rebuilds the thumbnail strip; each thumbnail asks `Doc.pageImageURL(n, { thumb: true })` when it scrolls into view |

`handleFileUpload()` (file input and drag-and-drop) and the startup load in
`web/core/app.js` both go through `openDocument()`. See [PDF Viewer](../frontend/pdf-viewer.md).

---

## `PDFHooks` events

`window.PDFHooks` (`web/core/hooks.js`, the first script of the page) is the only way the
core reaches a plugin: the core **emits**, plugins **subscribe**. The core never calls a
plugin function by name, so deleting a plugin folder leaves the core emitting into the
void with nothing dangling.

```js
const off = PDFHooks.on('page:rendered', ({ pageContainer, pageNum }) => { … });   // returns an unsubscribe function
PDFHooks.off('page:rendered', handler);
await PDFHooks.emit('my-plugin:event', payload);                                   // → array of the handlers' results
```

Handlers may be async. `emit()` awaits them one after another in registration order, and
a handler that throws is logged and skipped — it can break neither another plugin nor the
core.

| Event | Payload | Emitted |
|-------|---------|---------|
| `ui:ready` | — | By `app.js`, once the core toolbar is wired. The place to attach plugin buttons and to call `registerSubtoolbar` / `openSubtoolbar` |
| `document:opening` | `{ file, name, isDefault }` | By `openDocument()`, before anything changes: `state` still describes the previous document. Reset per-document plugin state here (a finished flag, a run in progress) — pages of the new document show, with `page:rendered`, **before** its `document:loaded` arrives |
| `viewer:clear` | — | By `goToPage()`, just before the viewer is emptied for a page change. Tear down per-page resources |
| `page:rendered` | `{ pageContainer, pageNum }` | By `goToPage()`, after the page container (with its `<img>`) entered the DOM. Draw per-page overlays |
| `pages:refresh` | — | By `goToPage()`, right after `page:rendered`. Re-sync per-page overlays |
| `document:loaded` | `{ file, isDefault, pdfFonts, sizePt }` | By `announceDocument()`, once the open has finished. `file` is `null` and `isDefault` `true` for the startup document; `pdfFonts` and `sizePt` are `Doc.open()`'s `pdfFonts` and `suggestedSize` |
| `zoom:changed` | `{ zoom }` | By `updateCSSZoom()` whenever the zoom factor is applied |
| `typography:detected` | `{ fontFamily, sizePt, source }` | By a **plugin** that measured the page's face from its pixels. `text_tool` makes that face and size the default for new boxes |
| `redactions:connected` | — | By `embedded_text_viewer`, after `type: 'redaction'` boxes were linked to their text lines |

The core emits `viewer:clear`, `page:rendered`, `pages:refresh` and `zoom:changed` without
awaiting them; `ui:ready`, `document:opening` and `document:loaded` are awaited.

Any plugin may emit events of its own on the same bus; name them `<topic>:<what>` and
document them with the plugin.

---

## `plugin.json` — the plugin manifest

A plugin is a folder under `web/plugins/` that holds a `plugin.json`. The manifest says
what the plugin contributes to the page; the build does the rest. Dropping a folder in
adds the plugin on the next build; deleting the folder removes every trace of it.
**Never edit `web/index.html`, `web/core/index.template.html` or `tools/build.mjs` to add
a plugin.**

```json
{
  "name": "webgl_mask",
  "order": 20,
  "styles": ["webgl-mask.css"],
  "toolbar_button": "toolbar_button.html",
  "options_bar": "options_bar.html",
  "ribbon_bar": null,
  "sidebar": null,
  "scripts_before_viewer": ["webgl-mask.js"],
  "scripts_after_app": []
}
```

All paths are relative to the plugin's folder.

| Key | Type | Inlined / emitted at | Description |
|-----|------|----------------------|-------------|
| `name` | string | — | Must equal the folder name |
| `order` | number | — | Sorts the plugins; ties are broken by name. A manifest without a finite `order` sorts as `1000`. The order decides the sequence of every slot below — toolbar buttons left to right, bars, scripts |
| `styles` | list | `<!-- @plugins:styles -->` in `<head>` | Stylesheets, one `<link>` each |
| `toolbar_button` | file \| `null` | `<!-- @plugins:toolbar_buttons -->` | HTML fragment: the plugin's button in the top toolbar |
| `ribbon_bar` | file \| `null` | `<!-- @plugins:bars -->` | HTML fragment: a persistent bar in the options row. `openSubtoolbar` never hides a `.ribbon-bar` |
| `options_bar` | file \| `null` | `<!-- @plugins:bars -->` | HTML fragment: a contextual bar (class `options-bar`), one visible at a time. Per plugin the ribbon bar comes first, then the options bar |
| `sidebar` | file \| `null` | `<!-- @plugins:sidebars -->` | HTML fragment: a right panel. The fragment supplies its own container; the core hosts no right panel |
| `scripts_before_viewer` | list | `<!-- @plugins:scripts_before_viewer -->` | Classic scripts loaded after `doc-service.js` and before `pdf-viewer.js` — for globals that must exist before the viewer runs. They cannot call `app.js` globals at module scope; defer to `PDFHooks.on('ui:ready', …)` |
| `scripts_after_app` | list | `<!-- @plugins:scripts_after_app -->` | Classic scripts loaded after `app.js`, in the listed order |

A missing list means `[]`, a missing single slot `null`. Files a plugin loads itself — a
worker, a data file — are not listed; they are fetched through
[`assetURL()`](#windowrecto_assets-and-asseturl).

### Rules the build enforces

`tools/build.mjs` stops with a message naming the file when:

- `plugin.json` is not valid JSON;
- `name` differs from the folder name;
- `styles`, `scripts_before_viewer` or `scripts_after_app` is not a list;
- the manifest names a file that does not exist in the plugin's folder;
- an HTML fragment contains a template tag (`{%` or `{{`) — fragments are inlined verbatim, nothing evaluates them;
- the template lacks one of the `@plugins:*` markers or the `@assets` marker, or contains an unknown `@plugins:` marker.

A folder without a `plugin.json`, or one whose name starts with a dot, is not a plugin and is skipped.

---

## Build outputs

`node tools/build.mjs` writes four files, all generated and none edited by hand. The
development server (`tools/serve.mjs`) runs the same `build()` on every request for
`index.html`, so in development the scan is always current. Nothing is transpiled or
bundled.

### `web/index.html`

`web/core/index.template.html` with the plugin fragments inlined at the markers and the
scripts in the fixed order: `hooks.js` → `geometry.js` → `state.js` → `doc-service.js` →
plugins' `scripts_before_viewer` → `pdf-viewer.js` → `ui-events.js` → `app.js` → plugins'
`scripts_after_app`. Every local `src` / `href` gets `?v=<first 8 hex digits of the file's
SHA-256>`, so any cache lifetime is safe: a changed file has a new URL.

### `web/generated/plugins.json`

The plugins found, in load order — each manifest with its defaults filled in, plus `base`:

```json
[
  { "name": "embedded_text_viewer", "order": 10,
    "styles": ["styles.css"],
    "toolbar_button": "toolbar_button.html", "options_bar": null, "ribbon_bar": null, "sidebar": null,
    "scripts_before_viewer": [], "scripts_after_app": ["extract.js", "etv-fetch.js"],
    "base": "plugins/embedded_text_viewer/" }
]
```

### `web/generated/fonts.json`

The font catalogue (`web/assets/fonts/fonts.json`) joined with what is actually installed
in `web/assets/fonts/`:

```json
{
  "families": [
    { "family": "Nimbus Roman",
      "class": "mupdf",
      "note": "URW base-35 Times — the face MuPDF itself draws unembedded Times with",
      "pdfNames": ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic", "Times", "NimbusRoman"],
      "files":   { "regular": "NimbusRoman-Regular.otf", "bold": "NimbusRoman-Bold.otf", "italic": "NimbusRoman-Italic.otf" },
      "present": { "regular": true, "bold": true, "italic": true },
      "hashes":  { "regular": "309259a8", "bold": "f9d03469", "italic": "31abd3f9" } }
  ],
  "default": "Times New Roman",
  "static": "assets/fonts/"
}
```

| Field | Description |
|-------|-------------|
| `families[].family` | The family name — also the CSS `font-family` the page draws it with |
| `families[].class`, `note` | Catalogue metadata (`"mupdf"` marks MuPDF's own faces); `note` is the menu tooltip |
| `families[].pdfNames` | PDF BaseFont names that mean this family |
| `families[].files` | Style → file name; styles are `regular`, `bold`, `italic`, `bolditalic`, and a family lists only the ones it has |
| `families[].present` | Style → does the file exist |
| `families[].hashes` | Style → content hash of a present file, the `?v=` of its URL |
| `default` | `Times New Roman` when its regular file is present, else the first family whose regular file is |
| `static` | URL prefix of the face files, relative to the site root |

### `web/generated/default-document.json`

The startup document: the PDF **directly** in `web/assets/pdfs/` (the alphabetically first
when there are several; subfolders are ignored on purpose). Swap the startup document by
replacing that file.

```json
{ "file": "assets/pdfs/EFTA00434905.pdf", "name": "EFTA00434905.pdf", "bytes": 656725, "v": "2da97a0a" }
```

`{ "file": null }` when the folder holds no PDF. `app.js` fetches `<file>?v=<v>` after
`ui:ready` and `DOMContentLoaded` — once every plugin script has subscribed — and opens
it with `openDocument(blob, name, null)`.

---

## `window.RECTO_ASSETS` and `assetURL()`

The build stamps the page's own `<script>` and `<link>` tags. A file a script loads
**itself** — a worker, a word list, a WebAssembly module — needs the same treatment, or a
stale copy could be served from cache after an update.

`window.RECTO_ASSETS` is an object written into the page at the `<!-- @assets -->` marker:
site-relative path → 8-hex content hash, for every file under `web/core/`, `web/vendor/`
and each installed plugin's folder (the template and the manifests excepted).

```js
assetURL('plugins/my_plugin/data.json')   // → 'plugins/my_plugin/data.json?v=1a2b3c4d'
assetURL('no/such/file')                  // → 'no/such/file'   (an unknown path comes back unchanged)
```

Rules:

- Every file a script fetches on its own goes through `assetURL()`. No version number is bumped by hand anywhere.
- `RECTO_ASSETS` doubles as a directory listing a static host cannot give: `path in window.RECTO_ASSETS` says whether a file shipped, without a request.
- A URL handed **to a worker** (for `importScripts` or `import()` inside it) must be absolute, because a worker resolves relative URLs against its own script: `new URL(assetURL(path), document.baseURI).href`.
- Face files are not in the map; their hashes travel in `generated/fonts.json` (`hashes`).

---

## `Shaping` — text measurement (`text_tool`)

`window.Shaping` measures text with HarfBuzz 14.4.0 (WebAssembly, `web/vendor/harfbuzz/`)
over the catalogue's face files. Both calls are async; the first one loads HarfBuzz and
the catalogue, and each face file is fetched once. Another plugin calls it guarded —
`typeof Shaping !== 'undefined'` — so it keeps working when `text_tool` is absent.
Internals: [Text Measurement](../frontend/width-calculator.md).

### `Shaping.widths(request)`

```js
const { results } = await Shaping.widths({
  strings: ['Hamburgefonstiv', 'Quick Brown Fox'],
  family: 'Times New Roman', bold: false, italic: false,
  size: 12, scale: GEO.docScale(),
  kerning: true, ligatures: true, force_uppercase: false,
});
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `strings` | array | `[]` | Strings to measure |
| `family` | string | — | Catalogue family name. Resolved with fallbacks: the asked style, then the family's plainer styles, then `Times New Roman` |
| `bold`, `italic` | bool | `false` | The style asked for |
| `font` | string | — | Legacy form, read only when `family` is absent: a catalogue file name such as `'times.ttf'` (the `.ttf` may be omitted). Unknown → the catalogue's default family |
| `size` | number | `12` | Font size in **points** |
| `scale` | number | `133` | px-per-pt as a percentage — pass `GEO.docScale()` |
| `kerning` | bool | `true` | The `kern` feature, and with it the face's legacy `kern` table |
| `ligatures` | bool | `true` | `false` turns `liga` and `clig` off: the plain advances a producer that set no ligatures laid on the page |
| `force_uppercase` | bool | `false` | Measure the uppercased string |
| `space_width` | number \| `null` | `null` | Substitute this advance (image px) for every space glyph |

```
width = Σ advance / upem × size × scale / 100          (image pixels)
```

Response:

```json
{ "results": [
    { "text": "Hamburgefonstiv", "width": 111.40828125000002,
      "chars": [{ "c": "H", "x": 0 }, { "c": "a", "x": 11.52580078125 }, { "c": "m", "x": 18.609609375 }] }
] }
```

`chars` has one entry per **glyph**: `c` is the first character of the glyph's cluster,
`x` the pen position before it. An empty string answers `{ text, width: 0 }`. When no face
can be found or loaded, every result is `{ text, width: 0, error }`.

**Justified mode.** `{ strings: [text], mode: 'justified', block_w, … }` answers
`{ "space_width": number | null }` — the space advance that makes the shaped line exactly
`block_w` pixels wide; `null` when the text has no space, `block_w` is not positive, or no
face was found.

### `Shaping.fontMetrics({ family, bold, italic, size_px })`

A face's own advances and every kern pair at one pixel size, with ligatures and
contextual substitutions off (`fi` measures as f + i). This is the table a plugin judges
a page's measured pen positions against to learn whether the document's producer kerned,
and lays typed text with when it did.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `family` | string | the catalogue default | Catalogue family name |
| `bold`, `italic` | bool \| `1` \| `'1'` | `false` | Style |
| `size_px` | number | `16` | Pixel size, `0 < size_px ≤ 512` |

```json
{
  "family": "Times New Roman", "bold": false, "italic": false,
  "file": "times.ttf", "sizePx": 16, "upem": 2048,
  "space": 4,
  "adv":  { "A": 11.5546875, "V": 11.5546875, "e": 7.1015625 },
  "kern": { "AV": -2.0625, "Yo": -1.6015625, "Ve": -1.7734375 },
  "missing": []
}
```

`adv` covers printable ASCII, common punctuation and the accented Latin letters; a
character the face lacks is listed in `missing`. `kern` holds only the non-zero pairs.
Resolves to `null` when `size_px` is out of range or no file is installed for the family.
Tables are cached per face file and size; the first call shapes every pair once.

---

## `FontCatalog` — the font catalogue (`text_tool`)

`window.FontCatalog` (`web/plugins/text_tool/fonts.js`) reads `generated/fonts.json`,
injects one `@font-face` rule per installed style, fills the font menu
(`#fabric-font-family`), and answers questions about faces.

| Member | Returns | Description |
|--------|---------|-------------|
| `ready` | `Promise` | Resolves once the catalogue is loaded, the rules injected and the menu filled |
| `default` | string | The default family |
| `families()` | array | The `families` of `generated/fonts.json` |
| `has(family)` | bool | Is this family in the catalogue |
| `familyForPdfName(name)` | string \| `null` | A PDF font name → catalogue family: subset prefix, spaces, commas and hyphens are ignored, the longest matching alias wins (`'ABCDEF+TimesNewRomanPS-BoldMT'` → `'Times New Roman'`) |
| `select(family, sizePt, source)` | bool | Sets the toolbar's font and size — the default for the next added box. `source` ranks the claim per document: `'detected'` outranks `'declared'` and `'layer'`; a call without `source` is the user's own choice and always wins. `false` when a stronger claim already holds |
| `metrics(family, bold, italic, sizePx)` | `Promise<object \| null>` | `Shaping.fontMetrics(...)`, cached per face and size; `null` on failure |
| `fileUrl(family, bold, italic)` | string \| `null` | The content-hashed URL of the installed file of **exactly** that style — what a renderer that rasterizes glyphs itself loads. `null` when that style is not installed; nothing is synthesized |

---

## `EtvExtract` — embedded text spans (`embedded_text_viewer`)

`globalThis.EtvExtract` (`web/plugins/embedded_text_viewer/extract.js`) holds pure
functions — no DOM, no document service — that turn `Doc.structuredText()` into the spans
the viewer draws.

```js
const raw = await Doc.structuredText(n, { imageRect: true });
const spans = EtvExtract.extractSpans(raw, n, raw.imageRect || raw.rect);
```

| Member | Description |
|--------|-------------|
| `extractSpans(raw, pageNum, imgRect)` | All text spans of one page, in image pixels. `imgRect` is the placement of the page image in PDF points, or the page rectangle when the page has no embedded raster |
| `leanSpan(span)` | The span reduced to `LEAN_FIELDS` — about a tenth of the full span |
| `LEAN_FIELDS` | `['page', 'text', 'x', 'y', 'w', 'h', 'sizePt', 'font']` |
| `spanSizePt(rawSpan)` | A raw span's font size in points: bbox height over (ascender − descender), which a text layer's per-word horizontal scaling does not inflate; the raw `size` as fallback |
| `pyRound(x, n)` | Rounds to `n` decimals on the exact binary value, ties to even — the arithmetic of Python's `round()`, which the recorded outputs in `tests/golden/` hold to the last digit |
| `PAGE_W`, `PAGE_H` | `816`, `1056` |

A span:

```json
{
  "page": 1,
  "text": "IN THE CIRCUIT COURT",
  "x": 245.33, "y": 112.67, "w": 326.0, "h": 16.0,
  "fontSize": 16.0,
  "sizePt": 12.0,
  "font": "TimesNewRomanPSMT",
  "flags": 4,
  "lineId": "1_3",
  "_blockLineId": "1_0_2", "blockId": "1_0", "isBlockEnd": false, "blockW": 326.0,
  "chars": [{ "c": "I", "x": 0.0, "w": 8.2 }]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `page` | int | 1-based page number |
| `text` | string | The span's text |
| `x`, `y`, `w`, `h` | float | Left, top, width, height in image pixels (the 816 × 1056 space), 2 decimals |
| `fontSize` | float | Font size in image pixels |
| `sizePt` | float | Font size in PDF points, 4 decimals — the canonical value |
| `font` | string | The raw PDF font name; the viewer maps it through the font catalogue |
| `flags` | int | Style bits: superscript `1`, italic `2`, serifed `4`, monospaced `8`, bold `16` |
| `lineId` | string | `"<page>_<n>"` — groups spans on the same visual line (tops within 3 px) |
| `_blockLineId`, `blockId`, `isBlockEnd` | | The MuPDF block and line the span came from; is it on the block's last line |
| `blockW` | float | The width the span must fill under justification: to the next span on its line, or to the block's widest right edge |
| `chars` | array | Per character: `c`, `x` (offset from the span's `x`), `w` (advance) |

`embedded_text_viewer` also exposes `window.etvSpanCache`, a read-only view of the lean
spans of the whole document for plugins that scan text: `complete()`, `anyText()`,
`hasPage(p)`, `isHydrated(p)`, `spansFor(p)` (an array of lean spans, or `null`). See
[SVG Text Layer](../frontend/embedded-text-viewer.md#embedded-text-ingestion).

---

## `MaskCore` — page masks (`webgl_mask`)

`globalThis.MaskCore` (`web/plugins/webgl_mask/mask-core.js`) holds pure loops with no DOM;
the plugin runs them in its own worker (`mask-worker.js`).

### `MaskCore.buildMask(gray, width, height)` → `Uint8Array | null`

`gray` is one byte per pixel — `Doc.pagePixels(n, { gray: true }).samples`. The result is
a gray mask of the same size, or `null` when the page has no blacked-out region:

| Mask value | Meaning |
|------------|---------|
| `255` | Inside a blacked-out region |
| `0` | Clear page |
| mid-gray | On the two pixel rings around a region: `255 −` the brightest page pixel along that edge run — the paper's brightness, which the shader un-blends the anti-aliased border with |

A region is a solid block of pure black (`gray ≤ 0`): thin strokes are opened away with a
5 × 5 element, components smaller than 17 × 10 px or with `area / perimeter < 2` are
dropped, and so are discs (punched holes, bullets). What remains is filled, holes
included.

`MaskCore` also exports the steps — `labelComponents`, `filterComponents`, `removeDiscs` —
for tests. See [WebGL Mask](../frontend/webgl-mask.md).
