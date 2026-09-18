# Embedded Text Viewer Implementation

The `embedded_text_viewer` is a fully self-contained, removable plugin (`web/plugins/embedded_text_viewer/`) that extracts all embedded PDF text spans in the browser and renders them as an SVG overlay directly on top of the main viewer's page image. It makes any text hidden underneath page graphics visible by drawing it in blue at its original coordinates.

## Features

- **Integrated Overlay:** Renders natively inside the main viewer — no separate page or window required.
- **Toggle Button:** A toolbar icon (`#toggle-embedded-text`, shipped as the plugin's `toolbar_button.html`) shows/hides the overlay without leaving the current view. The click flips the body class `hide-embedded-text`; the wiring and the CSS rule that keys on it live with the renderer, in `text_tool`.
- **SVG-Based Rendering:** Text is rendered as SVG `<text>` elements via `web/plugins/text_tool/svg-renderer.js`, not DOM spans.
- **No requests:** Spans are computed from the core's raw primitive, `Doc.structuredText(n)` — nothing is fetched, and the document never leaves the browser.
- **Fully Removable:** Deleting the `web/plugins/embedded_text_viewer/` folder removes the button, the extractor, and all span logic in one step.

## Architecture

The plugin follows the standard Recto "toolbar button + overlay" pattern used by `webgl_mask` and `text_tool`. The core runs no analysis: it hands out MuPDF's structured text as it is, and turning that into spans is this plugin's job.

```mermaid
sequenceDiagram
    participant Core as pdf-viewer.js (hooks)
    participant JS as etv-fetch.js
    participant Doc as Doc.structuredText (core document service)
    participant X as extract.js (EtvExtract)
    participant State as utbState
    participant Renderer as svg-renderer.js

    Core->>JS: document:loaded
    loop background, whole document in fixed page chunks (12, then 100)
        JS->>Doc: structuredText(p, imageRect)
        Doc-->>JS: raw structured text + image placement
        JS->>X: extractSpans(raw, p, imageRect) → leanSpan
        JS->>JS: normalize sizes; cache per page (etvSpanCache)
    end
    Core->>JS: page:rendered (pageNum)
    JS->>Doc: structuredText(pageNum, imageRect)
    Doc-->>JS: raw structured text + image placement
    JS->>X: extractSpans(raw, pageNum, imageRect) — full spans with chars
    JS->>State: hydrate: add UnifiedTextBox entries for that page
    JS->>Renderer: renderAllTextLayers()
    JS->>JS: utbConnectRedactionsToLines()
    Note over Renderer: SVG <text> elements rendered<br/>in blue over the page image
```

Two tiers keep huge documents affordable. **Lean** spans (text, geometry, size, font — no per-character data) are extracted for every page in the background, so anything that scans the whole document's text has it at roughly a tenth of the full size. **Full** spans (with per-character positions) are extracted one page at a time, the moment that page is rendered, and turned straight into text boxes — memory follows what the user visits, not the size of the document.

## Span Extraction Lifecycle — `etv-fetch.js`

`etv-fetch.js` owns all ETV-specific lifecycle logic:

- **`utbFetchSpans()`** — the background loop: extracts LEAN spans for the whole
  document in fixed page-range chunks (the first 12 pages, then 100 at a time), page by
  page through the document service. Every `await` yields, so a long scan never blocks the
  UI, and the loop stops the moment `state.docHash` changes. Lean spans go into a per-page
  cache of JSON strings.
- **`etvHydratePage(pageNum)` / `etvFetchFull(pageNum)`** — on `page:rendered`, extracts that
  one page's FULL spans (with per-character positions), normalizes font sizes, and populates
  `utbState` with `type='embedded'` `UnifiedTextBox` objects. Boxes exist only for visited pages.
- **`etvNormalize(spans)`** — the document's body size is the median `sizePt` of the first
  non-empty batch, rounded; every span within 1 pt of it snaps to it, others round to whole
  points. The first batch also selects the layer's most used face as the toolbar default
  (`FontCatalog.select(face, undefined, 'layer')` — a claim a plugin that *measured* the
  page's face outranks).
- **`window.etvSpanCache`** — read-only view of the lean cache (`complete() / anyText() /
  hasPage(p) / isHydrated(p) / spansFor(p)`) for plugins that scan the whole document's text.
- **`utbConnectRedactionsToLines()`** — Links redaction boxes to their overlapping text lines by snapping `lineId`, `y`, and `h`, and lets the bar adopt the line's face, size and style. Emits the generic `redactions:connected` event when done.
- **`window.addEmbeddedTextSpan(pageNum, x, y)`** — Creates a new `type='embedded'` box, snaps to the nearest text line, selects it, and opens the toolbar.
- **`window._utbFindNearestLine(pageNum, y)`** — Helper used by `text_tool/text-tool.js` when placing manual boxes (optional: gracefully absent if the ETV plugin is not installed). Only lines on a layer that is currently shown are candidates.
- **`document:loaded` subscription** — resets the hydrated set (the core reset `utbState`),
  invalidates the cache if the hash changed, kicks the background loop, and re-hydrates
  whatever page is on screen. The first page renders before `document:loaded` arrives, so
  this handler is what hydrates it.
- **`pdf-file` change listener** — Clears stale overlays the moment a new file is selected, before the new document is open (the actual re-extraction happens on the subsequent `document:loaded`).

`extract.js` and `etv-fetch.js` are declared, in that order, as `scripts_after_app` entries in the plugin's `plugin.json`. Cross-plugin calls into `text_tool` (`utbState`, `spanToUnified`, `renderAllTextLayers`, …) only happen inside event handlers and async continuations, so it does not matter that `text_tool`'s scripts load later.

## The Extractor — `extract.js`

`extract.js` defines `globalThis.EtvExtract`. It is pure functions — no DOM, no document service — so `tests/spans.test.mjs` loads the very same file under Node and holds its output to recorded reference spans for every reference page.

Its input is `Doc.structuredText(n)`: MuPDF's structured text in PyMuPDF's "rawdict" shape (`blocks → lines → spans → chars`, each with a `bbox` in PDF points), extracted with the `preserve-whitespace` option. Its second input is the **image placement** — where the page's scan sits on the page, in PDF points (`Doc.pageImageRect(n)`, delivered in the same round trip with `{ imageRect: true }`). A page without an embedded raster is shown as a 96-dpi render of itself, so its placement is the page rectangle.

What `extractSpans` does, in order:

1. **Coordinates.** PDF points map to the viewer's 816 × 1056 pixel space through the image placement: `scaleX = 816 / placement width`, `scaleY = 1056 / placement height`. Scaling by the page space rather than the raster's own pixel size keeps overlay positions right whatever the scan's resolution.
2. **Merge.** Adjacent spans of a line that share font, flags and colour (and sizes within 1 pt) are merged into one run — PDFs often split one visual run into many tiny spans — unless the gap between them exceeds 1.5 em.
3. **Crop.** A span starting below the page's bottom edge (1056 px) is skipped; one crossing it is clamped.
4. **Split into groups.** Each character's advance is the distance to the next character's x (the last one runs to the span's right edge); its *true gap* is that advance minus its own box width. A run is split at a tab, at a space whose gap exceeds 0.4 em, at a second consecutive space, and after a regular character followed by a gap over 0.5 em (whose width is then clamped to its own box). Each group becomes one span, so tabular text does not turn into one over-wide box.
5. **Recover omitted spaces.** A non-space character followed by a gap between 0.15 em and 0.5 em gets a space inserted after it: MuPDF dropped the space token, the gap says there was one.
6. **Size.** `sizePt` is the span's bounding-box height divided by the face's (ascender − descender). MuPDF's own `size` is the text matrix expansion, which the per-word horizontal scaling (`Tz`, 60–150 %) of a scanned document's text layer inflates word by word — an 11.46 pt layer reads 11.7–11.95. The vertical extent is not affected by `Tz`, so height over (ascender − descender) is the size the text was set in.
7. **Lines.** Spans are sorted by `y` and grouped into lines with a 3 px tolerance → `lineId = "<page>_<n>"`.
8. **`blockW`.** The width a span must fill under justification: for a mid-line span the distance to the next span on its line, for a line's last span the distance to the block's widest right edge.

Numbers are rounded the way Python's `round()` rounds them — half to even, on the exact binary value (`pyRound`) — which is what lets the reference spans be met to the last printed digit.

## API

| Function | Description |
|----------|-------------|
| `EtvExtract.extractSpans(raw, pageNum, imgRect)` | All text spans of one page, in image-pixel coordinates. `raw` is `Doc.structuredText(pageNum)`; `imgRect` is `[x0, y0, x1, y1]` in PDF points. |
| `EtvExtract.leanSpan(span)` | The lean form of a span: `page, text, x, y, w, h, sizePt, font` (`EtvExtract.LEAN_FIELDS`). |
| `EtvExtract.spanSizePt(span)` | The size rule of step 6, for one raw span. |
| `EtvExtract.pyRound(x, n)` | Python-compatible rounding to `n` decimals. |
| `window.etvSpanCache` | The lean whole-document cache (see above). |

### Span Format

```json
{
  "page": 1,
  "text": "IN THE CIRCUIT COURT",
  "x": 245.33,
  "y": 112.67,
  "w": 326.00,
  "h": 16.00,
  "fontSize": 16.00,
  "sizePt": 12.0,
  "font": "TimesNewRomanPSMT",
  "flags": 0,
  "lineId": "1_3",
  "_blockLineId": "1_0_2",
  "blockId": "1_0",
  "isBlockEnd": false,
  "blockW": 326.00,
  "chars": [{"c": "I", "x": 0.0, "w": 8.2}]
}
```

`x / y / w / h` and `fontSize` are image pixels in the 816 × 1056 space; `sizePt` is PDF points; `font` is the raw PDF font name (the viewer maps it through the font catalogue); `flags` are PyMuPDF's span flag bits (bold = 16, italic = 2, …); `chars` holds per-character offsets and advances relative to `x`.

## Files

```
web/plugins/embedded_text_viewer/
├── plugin.json            # manifest — scripts_after_app: extract.js, etv-fetch.js
├── toolbar_button.html    # toggle-embedded-text button inlined into the toolbar
├── extract.js             # EtvExtract: raw structured text → spans (pure, tested under Node)
├── etv-fetch.js           # Lifecycle: lean scan, per-page hydration, line-snapping, etvSpanCache
└── styles.css             # The plugin's stylesheet
```
