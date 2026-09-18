# Unified Text Box System

All text on a page — extracted PDF text, manually added boxes, and text the editor shapes itself with HarfBuzz — is stored and rendered through a single data model and a single rendering pipeline. There are no separate state objects per box type. The model and the pipeline belong to the `text_tool` plugin (`web/plugins/text_tool/`); the core knows nothing about text boxes.

See [embedded-text-viewer.md](../frontend/embedded-text-viewer.md) for the full `UnifiedTextBox` field reference and SVG rendering internals.

---

## Box Types

| `type` | Origin | Role |
|---|---|---|
| `embedded` | `embedded_text_viewer` — `extract.js` turns `Doc.structuredText(n)` into spans, `spanToUnified(span)` turns a span into a box | Ground-truth text of the PDF's own text layer; shown and hidden as a layer by the embedded-text toggle |
| `ocr` | An OCR plugin (none in the baseline) | Text read from the page raster itself; behaves like `embedded` (inline-editable, counts as a text line for nearest-line/width flows). Inert when no OCR plugin is installed. |
| `redaction` | User draws a box on the page (Add Box tool), or an analysis plugin adds one | Snaps font/size to nearest text line (`embedded`/`ocr`). Its label text is **machine-managed by whichever plugin owns it** — which is why it is not hand-editable (see below). Inert if no such plugin is installed. |
| `harfbuzz` | The Add Text tool (`handleManualAddText` in `text-tool.js`) | Text this editor shapes, not a span extracted from the document. It is a type of its own because the extracted layers (`embedded`, `ocr`) are shown and hidden wholesale by their layer toggles, and text the user just typed must never vanish with them |

Each type renders with a distinct colour (defined in `svg-renderer.js::UTB_TYPE_COLORS`):
- `embedded` — blue
- `ocr` — cyan
- `redaction` — green
- `harfbuzz` — orange

---

## Module Reference

All five modules live in `web/plugins/text_tool/` and are loaded, in this order, by the `scripts_after_app` list of its `plugin.json` — after `shaping.js` (HarfBuzz measurement, `window.Shaping`) and `fonts.js` (the font catalogue, `window.FontCatalog`), which they build on.

| Module | Responsibility | Key exports |
|---|---|---|
| `unified-text-box.js` | `UnifiedTextBox` class and `utbState` global | `utbState.addBox()`, `getBox()`, `removeBox()`, `updateBox()`, `getPageBoxes()`, `reset()`; `spanToUnified(span)`, `utbCharsValid(box)`, `utbFindNearestLine(pageNum, y)` |
| `svg-renderer.js` | Renders boxes as SVG `<text>` elements in a per-page layer | `renderBox(box)`, `renderTextLayer(pageContainer, pageNum)`, `renderAllTextLayers()`, `computeXPositions(box)`, `computeBaseline(box)` |
| `toolbar.js` | Unified formatting toolbar — one code path for all box types | `syncToolbarToBox(box)`, `syncToolbarToSelection()` |
| `micro-typo.js` | Per-character nudge mode via hit-rects and a popover slider | `enterMicroTypo(box)`, `exitMicroTypo()` |
| `inline-edit.js` | Double-click WYSIWYG editing for `embedded` and `harfbuzz` boxes | `enterInlineEdit(box)`, `commitInlineEdit()`, `cancelInlineEdit()` |

---

## Rendering Pipeline

```
utbState.boxes
    │
    ▼
renderBox(box)            ← called by renderTextLayer() / renderAllTextLayers()
    │
    ├─ computeBaseline(box)          baseline y in SVG coordinate space
    │
    └─ computeXPositions(box)        absolute x array for SVG <text x="…">
           │
           ├─ box.baseCharPositions  per-char offsets from PDF extraction / HarfBuzz — only while
           │                         utbCharsValid(box): the box is still in the typography they were
           │                         measured under (box.baseFace) and no kerning the page lacked was asked for
           ├─ box.charAdvances[i]    accumulated per-char nudge deltas (micro-typo)
           └─ box.spaceWidth         manual word-spacing override (when defaultSpaceWidth=false)
    │
    ▼
SVG <text> element in .text-layer[data-page="N"]
    │
    └─ window.utbPixelRender?.(box, xs, baseline)   optional pixel-renderer seam
           returns {href, x, y, w, h, advanceW} → an <image class="utb-pixel">
           shows those pixels and the group gets `.utb-pixel-mode` (the <text>
           stays in the DOM, unpainted); null (or no plugin) → SVG text as usual
```

The SVG layer uses a fixed `viewBox` matching document pixel space (`state.pageWidth` × `state.pageHeight`, 816 × 1056 for a PDF). Zoom is handled entirely by CSS sizing on the layer element — coordinate values in `box.x/y/w/h` never change. Font size is the one quantity kept in points (`box.sizePt`); it becomes pixels exactly once, at this boundary, through `GEO.docPtToPx()`.

The layer is drawn by event, not by call: `svg-renderer.js` subscribes to `page:rendered` and runs `renderTextLayer(pageContainer, pageNum)` for the page the core just put into the DOM. When the core opens another document it resets the model through guarded calls (`utbState.reset()`, `clearAllSVGLayers()`), which do nothing when `text_tool` is absent.

**Kerning seam.** Before rendering, a box whose kerning nobody chose (`box.kerningAuto`) asks `window.utbAutoKerning?.(box)` — `typeof`-guarded like every plugin seam — and takes a boolean answer as `box.kerning`. An analysis plugin that knows whether the page's producer kerned answers; without one the box keeps `false`.

**Pixel-renderer seam.** A plugin may define `window.utbPixelRender(box, xs, baseline)` to draw a box as a raster in image-pixel space instead of vector text (`xs` = the absolute per-character x positions the SVG would use, or `[box.x]`; `baseline` = `computeBaseline(box)`). `svg-renderer.js` calls it `typeof`-guarded for every box; the result rides on the transient `box._pixel` so `_autoFitWidth` can size auto-width boxes from its `advanceW`. Double-click on the image opens inline edit like on the text. With no plugin defining the seam the pipeline is unchanged.

---

## Interactions

### Toolbar

Clicking any box activates the formatting toolbar. `syncToolbarToBox(box)` pushes the box's properties into the UI; every control writes back directly to the `UnifiedTextBox` instance via `utbState.updateBox()`. There is no branching on `box.type`.

### Space Width

Each box has an independent `defaultSpaceWidth` boolean and `spaceWidth` float.

- `defaultSpaceWidth = true` — the box uses the font's native space advance (`nativeSpaceWidth`, measured once per face, size and kerning with `Shaping.widths({ strings: [' '], … })` and cached).
- `defaultSpaceWidth = false` — the slider is active; `spaceWidth` overrides the space width and `computeXPositions` shifts all characters after each space accordingly.

### Inline Text Editing

Double-clicking an `embedded`, `ocr`, or `harfbuzz` box calls `enterInlineEdit(box)`, which places a `<foreignObject>` overlay containing a styled `<input>` that matches the box's font, size, weight, style, and colour.

- `Enter` or click-away → `commitInlineEdit()` saves `box.text` and re-renders.
- `Escape` → `cancelInlineEdit()` discards changes.

`redaction` boxes are excluded by an explicit type guard: their `labelText` is machine-managed by the plugin that owns them, not typed by hand. See [SVG Text Layer](../frontend/embedded-text-viewer.md#inline-text-editing--inline-editjs).

### Micro-Typography (Nudge Mode)

Clicking the Nudge button (↔) in the toolbar calls `enterMicroTypo(box)`. The renderer draws invisible hit-rects over each character. Clicking a character opens a popover slider that writes a delta (in px) to `box.charAdvances[charIndex]`. `computeXPositions` accumulates all prior deltas so nudging character *i* also shifts characters *i+1, i+2, …* — matching the SVG `<text x="…">` array contract.
