# Unified Toolbar — `toolbar.js` + `text-tool.js`

`toolbar.js` manages the formatting toolbar and is the single code path for reading and writing typography properties on any `UnifiedTextBox`. There is no branching on `box.type` — `embedded`, `redaction`, and `harfbuzz` boxes are all handled identically.

`text-tool.js` handles manual box creation and deletion.

Both are scripts of the `text_tool` plugin (`web/plugins/text_tool/`), listed in its `plugin.json` under `scripts_after_app`. The controls live in the plugin's own fragments: `toolbar_button.html` (the tools in the left column — **Add New Text**, **Add Redaction Box**, **Undo**, **Redo** and the **Text formatting** toggle `#toggle-fmt`), `options_bar.html` (the contextual formatting bar `#fabric-options-bar`, revealed while a box is selected) and `settings.html` (the **Redaction match** section of the Settings panel: width tolerance and letter case).

---

## Toolbar Controls

| Control ID | Property | Notes |
|------------|----------|-------|
| `#fabric-font-family` | `box.fontFamily` | Catalogue family name (e.g. `"Nimbus Roman"`, `"Times New Roman"`); the menu is filled from the catalogue by `fonts.js` |
| `#fabric-font-size` | `box.sizePt` | Displayed, entered, and stored in **points** — no conversion |
| `#fabric-bold` | `box.bold` | Toggle button (`.active` class = on) |
| `#fabric-italic` | `box.italic` | Toggle button |
| `#fabric-underline` | `box.underline` | Toggle button |
| `#fabric-strikethrough` | `box.strikethrough` | Toggle button |
| `#fabric-color` | `box.color` | Hex color; `null` = per-type default |
| `#kerning` | `box.kerning` (+ clears `box.kerningAuto`) | Checkbox. `box.kerning` is always the effective boolean; until the user touches the box it **follows the page** (`kerningAuto`, see below) and the label's tooltip says so |
| `#fabric-nudge-mode` | — | Toggle button; enters/exits micro-typography nudge mode on the selected span. Disabled unless the span's measured positions still apply (`utbCharsValid(box)`). |
| `#fabric-letter-spacing` | `box.letterSpacing` | em units |
| `#fabric-default-sw` | `box.defaultSpaceWidth` | Toggle button labelled **Default** (`.active` = on); when on, the font's native space width is used. Turn it off for manual slider control. |
| `#fabric-space-width` | `box.spaceWidth` | Slider; applies only while `#fabric-default-sw` is off. `#fabric-space-width-display` shows the value |
| `#toggle-space-labels` | — | Toggle button; shows the numeric width above each space (`setShowSpaceWidthLabels`) and, beside a redaction box, its gap to the text on either side in that line's spaces and px (`utbBarGaps` in `svg-renderer.js`; no badge where the bar touches the text) |
| `#utb-delete-box` | — | Deletes the selected box (`utbDeleteBox`); Delete / Backspace do the same outside a text field |
| `#tolerance`, `#tt-name-case` | `box.tolerance`, `box.uppercase` | The **Redaction match** section of the Settings panel (`settings.html`): the selected redaction's values, or the defaults for new boxes when none is selected (`#tt-match-scope` says which). Letter case is `false` (as typed), `true` (UPPERCASE), `'first'` or `'last'` (that name in capitals) — `utbApplyCase(text, mode)` in `unified-text-box.js` applies it. The values are read by whichever matching plugin is installed and are inert when none is |

---

## Font Size Units

Font size has a single canonical unit — **points** — stored on `box.sizePt`.
The toolbar reads and writes that value directly, with no DPI conversion:

```
toolbar input  =  box.sizePt        (points, both directions)
```

Points are converted to image pixels exactly once, at the SVG render boundary
(`GEO.docPtToPx(box.sizePt)` in `svg-renderer.js`). There is no separate px
`fontSize` field. The conversion helpers live on `window.GEO`, defined by the core's
`web/core/geometry.js` — the coordinate contract.

---

## `syncToolbarToBox(box)`

Reads from the `UnifiedTextBox` and pushes values into the toolbar UI. Called whenever a box is selected (from `drag-resize.js`) or when the selection changes.

```js
fsInput.value = Math.round(box.sizePt * 100) / 100;  // points, shown directly
```

Also sets font family, bold/italic/underline/strikethrough active states, letter spacing, color, kerning, the Default space-width button, space-width slider, and nudge button state (active if micro-typo mode is active for this box, disabled unless `utbCharsValid(box)`). It reveals `#fabric-options-bar` — every selection path routes through here, so this is the single reveal point — and shows the Match group only for a `redaction` box.

The font menu is made to **show the box's family even when the catalogue lacks it** (an option marked "not installed" is added): every toolbar change writes the menu's value back into the box, so a menu left on another family would silently re-font the box the next time Bold is clicked.

---

## `persistFromToolbar(box)`

Reads the current toolbar state and writes it directly to the box, then calls `renderBox(box)`.

```js
const inputSize = parseFloat(el('fabric-font-size').value);   // points
box.sizePt = inputSize > 0 ? inputSize : box.sizePt;          // never 0, negative or NaN
```

Kerning is **not** read here — it has its own `change` handler, because
reading the checkbox on every toolbar change would turn a box that follows the
page into one with a fixed choice.

### Settings and measured positions

A box read from a PDF or by an analysis plugin carries `baseCharPositions`,
measured under one typography (`box.baseFace`: family, style, size, letter
spacing — snapshotted at construction). Those positions stop applying the
moment the box is set in anything else — bold glyphs at regular pens overlap —
or the user asks for a kerning the page did not have; `utbCharsValid(box)` is
the single test, `computeXPositions` returns `[box.x]` when it fails, and every
renderer then lays the text afresh. Going back to the measured typography
brings the positions back.

`box.kerningAuto` (true unless the creator passed `kerning` explicitly) lets an
analysis plugin decide the default: before rendering, `svg-renderer.js` asks
the guarded seam `window.utbAutoKerning?.(box)` and, on a boolean, writes it to
`box.kerning` — so SVG `font-kerning`, `Shaping.widths` requests and any pixel renderer
all read one effective value. The Kerning checkbox clears the flag for good.

If the Default button is off and the box has text, the manual `box.spaceWidth` from the slider is used.

If `box.type === 'redaction'`, `calculateWidthsForRedaction(box.id)` is called to recalculate the candidate-word width map. `text_tool` does not define that function — the call is `typeof`-guarded, so it resolves when a plugin supplies it and no-ops when none does. See [Optional Plugins](../plugins/).

---

## Natural Space Width

When the Default button is turned off, the slider is initialized to the font's natural space advance by measuring a single space with HarfBuzz — a call into `shaping.js` in the same plugin, in the page ([Text Measurement](width-calculator.md)):

```js
const data = await Shaping.widths({
  strings: [' '],
  family:  box.fontFamily,   // resolved through the font catalogue
  bold:    !!box.bold,
  italic:  !!box.italic,
  size:    box.sizePt,       // points
  scale:   GEO.docScale(),   // = (pageWidth / 612) × 100
  kerning: box.kerning,
});
// → { results: [{ text: ' ', width, chars }] }    width = the natural space advance
```

The result is written to `box.spaceWidth` and `box.nativeSpaceWidth`, and cached per face, size, kerning and scale. When the button is turned on again, `box.spaceWidth` is set to `null` (native font spacing). The helper is exposed as `window.getNaturalSpaceWidth(box)` for plugins that need the same number.

---

## Nudge Button

The **Nudge** button (`#fabric-nudge-mode`) in the Style group enters micro-typography mode on the selected span:

- **Click** when a span is selected and its measured positions apply (`utbCharsValid(box)`) → calls `enterMicroTypo(box)`.
- **Click** again (or press Escape) → calls `exitMicroTypo()`.
- The button is **disabled** when no span is selected or the span lacks valid per-character positions.

Double-click is a different gesture: it starts inline text editing (see `inline-edit.js`).

---

## Event Wiring

| Event | Element | Action |
|-------|---------|--------|
| `change` | `#fabric-font-family` | `persistFromToolbar` |
| `input` | `#fabric-font-size` | Live `box.sizePt` + `renderBox` |
| `change` | `#fabric-font-size` | Full `persistFromToolbar` |
| `click` | bold/italic/underline/strikethrough buttons | Toggle `.active`, `persistFromToolbar` |
| `change` | `#fabric-letter-spacing` | `persistFromToolbar` |
| `input` | `#fabric-color` | `box.color = value`, `renderBox` |
| `change` | `#kerning` | `box.kerning = checked`, `box.kerningAuto = false`, `renderBox` |
| `click` | `#fabric-default-sw` | Toggle native vs manual space width; measure the natural width via `Shaping.widths` when turning it off |
| `input` | `#fabric-space-width` | Live `box.spaceWidth = value`, `renderBox`, update display label |
| `click` | `#fabric-nudge-mode` | Toggle micro-typography mode on selected span |
| `change` | `#tolerance`, `#tt-name-case` | Write `box.tolerance` / `box.uppercase` on the selected `redaction` box (`applyMatchControls`); guarded calls into a matching plugin |
| `click` | `#toggle-space-labels` | `setShowSpaceWidthLabels(active)` |
| `click` | `#toggle-fmt` | Open / close `#fabric-options-bar` through `openSubtoolbar` |
| `click` | `#tt-add-text-btn` | Arm `state.activeTool = 'text'` (mutually exclusive with the add-box tool) |
| `click` | `#toggle-embedded-text` | Toggle `hide-embedded-text` on `<body>` — shows / hides every `embedded` box |
| `click` | `#utb-delete-box` | `utbDeleteBox(utbState.selectedId)` |

Every handler that changes what a `redaction` box measures also calls `calculateWidthsForRedaction(box.id)` behind a `typeof` guard.

---

## Lifecycle: `text-tool.js`

> Span extraction and the `document:loaded` lifecycle subscription live in `web/plugins/embedded_text_viewer/etv-fetch.js`. `text-tool.js` handles only manual box creation and deletion.

### Placing new boxes

The click itself is caught by the core (`app.js`, a `mousedown` on the viewer), which maps it to document pixel space and calls whichever handler matches `state.activeTool` — both behind `typeof` guards.

- `window.handleManualAddBox(pageNum, x, y)`: delegates to `createNewRedaction()` if a plugin supplies it, otherwise creates a `type='redaction'` box directly. Calls `window._utbFindNearestLine?.()` — defined by `etv-fetch.js` (optional: gracefully absent if the `embedded_text_viewer` plugin is not installed). Both are optional seams; the tool works either way.
- `window.handleManualAddText(pageNum, x, y)`: creates a `type='harfbuzz'` box with `autoWidth: true` at the click, on the nearest shown line when there is one (`utbFindNearestLine`), and drops straight into inline edit. The type matters for visibility: extracted layers are shown and hidden wholesale by their toggles, and text the user just typed must never vanish with them.

### Deleting a box

`window.utbDeleteBox(id)` is the one removal path for every box type — the toolbar's Delete button and the Delete / Backspace keys both use it. A live inline-edit or micro-typo session on the box is torn down first, so no id in `utbState` outlives the box it points at. The keys are ignored while the caret is in a field, where they mean "erase a character". `utbDeleteBox(id, { silent: true })` is the undo stack taking a box out again — not a step of its own.

## Undo — `undo.js`

One stack (`window.utbUndo`) for what the user does to boxes: add, delete, move, resize, edit the text, change the formatting, nudge a character. What a plugin puts on the page by itself — an OCR read, the embedded text, a matcher's label — is regenerated, never undone, and a new document empties the stack (`document:opening`).

- `utbUndo.capture(boxes)` → token, then `utbUndo.commit(token, label, key)`: records the fields that changed between the two calls (nothing is pushed when nothing changed). A box's derived data — candidate widths, verdicts, the refiner's findings, the pixel raster — is not part of a step; it is derived again after a restore (a redaction whose typography changed has its widths measured again).
- `utbUndo.recordAdd(boxes, label)` / `utbUndo.recordDelete(box, index, label)`: an add or a delete, put back at the same index.
- **Collapsing.** Steps with the same `key` collapse while they follow each other: every drag of one box (`move:<id>`), every tick of one slider (`size:<id>`, `space:<id>`, `color:<id>`), every nudge of one character (`nudge:<id>:<i>`) is one step, as Word collapses repeated typing. Any other action in between starts a new step; a collapsed step that ends where it began is dropped.
- `undo()` / `redo()` / `canUndo()` / `canRedo()` / `peek()` / `clear()` / `onChange(fn)`.

The buttons are `#tt-undo` / `#tt-redo` (the fragment `toolbar_button.html`); the keys are Ctrl/⌘+Z and Ctrl/⌘+Shift+Z or Ctrl/⌘+Y — ignored while a field has the caret or an inline edit is open, where they are the field's own.

---

## The font catalogue — `fonts.js` + `generated/fonts.json`

`web/assets/fonts/fonts.json` is the one list of faces Recto knows: MuPDF's own
URW faces first (Nimbus Roman, Nimbus Sans, Nimbus Mono PS — what MuPDF draws
unembedded Times/Helvetica/Courier with), then DejaVu Serif and the Windows
faces documents are commonly set in (Times New Roman, Arial, Courier New, Calibri,
Cambria, Georgia, Tahoma, Segoe UI, Verdana, Century Schoolbook). Each family
names its style files (regular/bold/italic/bolditalic) and the PDF BaseFont
names that mean it. The face files sit beside it in `web/assets/fonts/`.

A static host cannot say which files exist, so the build says it:
`tools/build.mjs` joins the catalogue with the folder's contents and writes
`web/generated/fonts.json` — every family with a `present` map per style and a
content hash per present file ([shape](../api-reference/api-reference.md#webgeneratedfontsjson)).

Two consumers, one source:

- **`fonts.js`** (loaded right after `shaping.js`) fetches it, injects an `@font-face` rule per
  installed style (`assets/fonts/<file>?v=<hash>`, weight/style set so bold and italic
  resolve to the right file), fills `#fabric-font-family`, and exposes
  `window.FontCatalog` (`ready`, `default`, `families()`, `has`, `familyForPdfName`,
  `select(family, sizePt, source)`,
  `metrics(family, bold, italic, sizePx)` — the face's own advances and kern
  pairs at a pixel size from `Shaping.fontMetrics`, cached; what a plugin that
  measured a page's pens uses to lay pairs the page never wrote — and
  `fileUrl(family, bold, italic)`, the installed file of exactly that style or
  `null`: what a renderer that rasterizes glyphs itself loads; nothing is
  synthesized, a family without a bold italic has none).
  SVG text in `font-family: "Nimbus Roman"` is therefore drawn from the same
  file HarfBuzz measures with — and fetched from the same URL, so the browser
  downloads each face once.
- **`shaping.js`** takes `family`, `bold`, `italic` and resolves the file through
  the same catalogue (bold italic → bold → italic → regular
  → Times New Roman); the legacy `font: 'times.ttf'` form still works.

### Choosing the default face

`fonts.js` listens to two generic `PDFHooks` events and sets the menu (and
the size input) from them, so the core keeps no font list and no plugin is
named:

| Event | Emitted by | Effect |
|---|---|---|
| `document:loaded` (`pdfFonts`, `sizePt`) | the core viewer | the first declared BaseFont that maps to a catalogue family (`Times-Bold` → Nimbus Roman, `TimesNewRomanPSMT` → Times New Roman), else the default — a `declared` claim |
| `typography:detected` (`fontFamily`, `sizePt`, `source`) | any plugin that measured the page's face from its pixels | that family and size become the defaults for new boxes — a `detected` claim |

`FontCatalog.select(family, sizePt, source)` ranks the claims per document:
`detected` (measured from the page's pixels) outranks `declared` (the PDF's
font names) and `layer` (the embedded text layer's most used face, which
`embedded_text_viewer` submits when its spans arrive), whichever arrives
first; the user's own menu choice (no source) always wins. Every
`document:loaded` opens the ranking again. The layer's own
boxes map their font names through the catalogue with one exception: the
base-14 names `Times-Roman`, `Helvetica`, `Courier` become Times New Roman,
Arial and Courier New (`normUtbFont`) — a scanning producer's text layer names those
substitutes over a page set in the Windows face, and MuPDF's URW faces stay a
menu choice for a page MuPDF drew.
