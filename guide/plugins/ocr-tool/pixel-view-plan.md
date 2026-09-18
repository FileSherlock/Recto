# Plan — MuPDF pixel view for text boxes

*Status: **built** 2026-09-03 — see the "MuPDF pixel view" section of
[README.md](README.md) for what shipped. Written the same day as the plan;
kept as the design record. Every phase ends with the command that proves it.*

## What changed while building it

Four things the plan did not foresee, each caught by a proof rather than by
eye:

- **MuPDF rounds a float32 pen.** `certify:render` found one CFF phase where a
  double just under a ¼-px tie (45.87499999999999) snapped down while MuPDF
  snapped up; the snap now runs on `Math.fround(x)` and the certification
  reads 0 diffs on both pipelines.
- **The Diff must skip the reader's object mask.** Descenders dipping into a
  redaction box's padded rows were the "1–7 differing pixels" on otherwise
  clean lines; `diffLine` takes `detectObjects().mask` and reports those as
  "under a box/rule".
- **Lines pinned at the ½ y-phase.** Legacy sets carry ½-phase rasters and the
  reader may pin a line to them (`L.phy = 0.5`); the adapter stores `phy` per
  line (cache payload v2) and `renderLine` draws with those records.
- **Tolerant rungs.** A line read at ±tol is "clean" to the reader within that
  tolerance (2·tol on composite pixels); `diffLine` applies the same rule so
  "exact" always means "exact to the reader's own standard for that line".
- **Mixed-font lines.** A bold label with regular text is read through a union
  pool, and the line's font label names only one set; each glyph carries the
  set that drew it (`src`, from the engine's `L.glyphs`) and the adapter must
  keep that field on `baseCharPositions` — it used to rebuild them as `{c, x,
  w}` and drop everything else.
- **The other half of the certificate.** Matching drawn glyphs is not enough:
  the reader's orange "To:" line on the startup document drew exactly, yet the
  reader was right to be unsure — two quote marks on the page were never
  transcribed. `render.js residualInk` now reports page ink in a line's band
  that no drawn glyph explains, the Diff paints it orange, and "exact"
  requires both halves (drawn pixels match, no unexplained ink).
- **Box halos.** The reader forgives residue touching the ±2-column, ±3-row
  halo around a redaction box (a glyph half-swallowed by the redactor);
  `render.js objectMask` adds those halos to the diff's don't-care zone.

**Corpus result (2026-09-03, `node tools/verify-recto-pixels.mjs --max-pages 5`
over `_temp_test_files`):** 39 documents, 116 pages read, **7,445 of 7,445
reader-certified lines reproduce the page exactly**; 6 uncertified lines drawn
and compared; 0 SVG fallbacks; 15 documents skipped because their family is
not modelled by any shipped glyph set (Helvetica-declared eDiscovery PDFs —
the reader runs its whole tolerance ladder and certifies nothing), which is
the reader's limit, not the renderer's.

## What you will get

A toggle in the **Auto OCR** bar called **MuPDF pixels**. While it is on, every
text box is drawn the way MuPDF would have rasterized it onto this page — the
same glyph bitmaps the reader matched, on the same ¼-px pen lattice, on an
integer baseline — instead of the browser's smooth SVG text. Zoom in and you
see the anti-aliased pixels, not vector edges.

A second toggle, **Diff**, keeps only the pixels that *disagree* with the page
underneath and paints them red. A box that sits exactly where the page's ink
is shows zero red pixels; the status line says so. That is the "did I line it
up right" answer, measured rather than eyeballed.

Both toggles work on every box type: OCR-read lines use the exact glyph set the
reader picked for that line; embedded and hand-added boxes are mapped from
their font family and point size to a shipped set when one exists, and fall
back to normal SVG text (with a status message naming the missing set) when it
does not.

Nothing is exported or written into the page raster. This is a view and a
measurement. Burning text into the page image is a later step that reuses the
same renderer (see *Later*).

## Why this is cheap now

Almost everything already exists; the pieces just live in three places:

| Piece | Where it already is | What it gives us |
|---|---|---|
| MuPDF-exact glyph pixels | `web/plugins/ocr_tool/glyphs/glyphs.bin` — 77 sets, every char at the four ¼-px x-phases, with true coverage (`alpha`) and page bytes (`bytes`) | No rasterizer, no font files in the browser. The pixels are already downloaded for OCR. |
| Pen placement law | `engine/ocr-engine.js` `tryCand`: pixel column = `floor(pen) + dx + col`, row = `baseline + dy + row`, `pen = floor(pen) + phx` | The reader's pens (`baseCharPositions`) put a glyph on the page byte-exactly by construction. |
| Blend law | `engine/ocr-engine.js`, certified in tol0 `npm run certify:ftclone`: `e = a + (a>>7)`, `dst = (dst·(256−e))>>8`; linear sets: `((cv−s0)·a/255 | 0) + s0 + sh` | Overlapping glyphs (kerning overlaps, `f`-hook over `i`-dot) composite exactly. Over white a single glyph is simply its stored `bytes`. |
| Lattice law | tol0 `docs/LAWS.md` §1: x snaps to the nearest ¼ px, y rounds to a whole pixel (28.5 ≡ 29) | How to place *new* text (typed or edited) where MuPDF would put it. |
| Page pixels | `PageEngine._pageFor(img)` in `engine/ocr.js` — the whole-page gray buffer the reader used | The Diff toggle compares against exactly these bytes. |
| Per-box render hook | `web/plugins/text_tool/svg-renderer.js` `renderBox → _updateText` | One place to swap the `<text>` element for a pixel image. |

The one thing that does **not** exist yet is the forward direction: *given a
string, lay it out and composite it* — the reader only ever runs the law
backwards. That renderer is the core of this plan, and it goes where the
engine lives (tol0) so it can be certified against real MuPDF before Recto
runs it.

## Design

```
tol0 (engine, certified)                Recto
────────────────────────                ─────────────────────────────────────
engine/render.js  ──sync:recto──▶  web/plugins/ocr_tool/engine/render.js
  layoutLine()                          ▲ uses
  renderLine()                          │
  diffLine()                     web/plugins/ocr_tool/pixel-view.js   (Recto-owned)
                                        │ defines window.utbPixelRender(box)
                                        ▼ called through a guarded seam
                                 web/plugins/text_tool/svg-renderer.js
                                        _updateText: <text> ⇄ <image class="utb-pixel">
```

### 1. `engine/render.js` (tol0, DOM-free, synced verbatim)

Three pure functions, same coding style as `ocr-engine.js` (IIFE, works as a
browser global `OCRRender` and as a Node `require`).

- `layoutLine(set, text, x0, opts)` → `[{ch, pen, adv}]`.
  Accumulates advances in float from `x0` (no snapping while accumulating —
  PDF positions are absolute), then snaps each pen to the ¼-px lattice:
  `pen = round(x·4)/4` (round half up). Space uses `opts.spaceAdv` (see
  *Space advance*). Characters missing from the set are returned in
  `missing`; the caller decides what to do (Recto falls back to SVG).
  No kerning, no ligature substitution in v1 — MuPDF applies neither; the
  producer's kerning is what per-character nudges are for.
- `renderLine(set, glyphs, baseline, opts)` → `{x0, y0, w, h, gray, alpha, missing}`.
  Composites every glyph's `phy = 0` record for its `phx` over a white
  canvas through the blend law (standard or linear per `set.linear`), so
  overlaps composite the same way the page did. `gray` is the predicted page
  byte per pixel, `alpha` the max coverage (for tinted display). Baseline is
  rounded half-up to an integer before use, per LAWS §1.
- `diffLine(rendered, page, quant)` → `{mismatch: Uint8Array, count, ink}`.
  Compares `rendered.gray` (through `quant` — the page's palette map — when
  the reader used a palette pass) with `page.gray` on the glyphs' ink
  pixels only. `count === 0` means "this text is exactly the page".

Glyph lookup: build a `Map` keyed `ch|phx` per set on first use and cache it on
the set object (same pattern as the `_rare` flag in `anchorGroups`).

### 2. The seam in `text_tool` (baseline, generic — names no plugin)

In `svg-renderer.js`:

```js
// _updateText(g, box), after computing xs / baseline:
const pix = window.utbPixelRender?.(box, xs, baseline);   // optional plugin seam
if (pix) { hide <text>; upsert <image class="utb-pixel" x y width height href> with style image-rendering: pixelated; }
else     { remove <image.utb-pixel>; show <text>; }
```

`pix` is `{href, x, y, w, h, advanceW}` or `null`. `_autoFitWidth` uses
`pix.advanceW` for `autoWidth` boxes instead of `getComputedTextLength()`
(which returns 0 for a hidden `<text>`). `_updateSpaceLabels` is unchanged —
pixel boxes always have per-character positions.

That is the whole baseline change: about 25 lines, `typeof`-guarded like every
other optional seam, inert when nothing defines `utbPixelRender`. Document it in
`guide/architecture/unified-text-box.md` (Rendering Pipeline) and
`guide/frontend/embedded-text-viewer.md` (SVG internals) as "a plugin may
supply a pixel renderer" — without naming this plugin.

### 3. `pixel-view.js` (Recto-owned adapter in `ocr_tool`)

Defines `window.utbPixelRender(box, xs, baseline)`:

1. **Off?** → return `null` (SVG as today).
2. **Which glyph set?**
   - `box.ocr?.font` → the set the reader picked, looked up in
     `ocrToolState.sets` by name. A union name (`a+b`) uses each glyph's `src`
     (see *Adapter changes*), else the first set in the union that has the
     glyph.
   - otherwise map `(fontFamily, bold, italic, sizePx = sizePt × GEO.docPxPerPt())`
     to a set name via a small table — the inverse of `ocrFontFromSetName`:
     Times New Roman → `times*`, Courier New → `cour*`, Arial → `arial*`,
     Georgia → `georgia16`, Tahoma → `tahoma*`, Segoe UI → `segoeui*`,
     Verdana → `verdana*`, Calibri → `calibri16/calibrib16/calibrii16`; pick
     the set whose `sizePx` matches within 0.01. No match → `null` and
     `setOcrStatus('MuPDF pixels: no glyph set for Arial 11 pt — generate it in tol0 (fontgen) and sync')`.
3. **Pens.** With `baseCharPositions`: pens are `xs` (measured pens + nudges +
   space overrides, exactly what the SVG path uses), each snapped to ¼ px.
   Without: `layoutLine(set, box.text, box.x, {spaceAdv})`.
4. **Baseline.** `Math.floor(baseline + 0.5)`.
5. **Render** → `renderLine`; paint to an offscreen canvas as RGBA: tint =
   `box.color` or the type colour, alpha = coverage. With **Diff** on:
   `diffLine` against `ocrToolState.engine._pageFor(img)` for the box's page
   (the page raster is already loaded by the viewer); matching ink pixels in
   the tint, mismatching ones solid red.
6. Return `{href: canvas.toDataURL(), x: x0, y: y0, w, h, advanceW}`. Cache the
   result keyed on `(set, text, pens, baseline, mode, colour)` so drags don't
   re-render unchanged boxes.

On selection (a document-level `click` listener that reads `utbState.selectedId`,
the same pattern `inline-edit.js` uses for `dblclick`), the status line shows
`box: 812 ink px · 0 differ` (or the count).

Toggling either button calls `renderAllTextLayers()`. Both states are plain
module variables; nothing in the core or `text_tool` knows they exist.

### Space advance

The glyph sets contain no space character (fontgen's char list starts at `!`).
Two sources, in order:

1. `box.ocr.spaceAdv` — the page-calibrated space the reader measured
   (`res.spaceAdv`, e.g. 7.4077 px on the Courier gate document). Store it on
   every OCR box.
2. A per-family em-fraction table in `pixel-view.js` × `set.sizePx`
   (Times 0.250, Courier 0.600, Arial/Verdana/Tahoma/Segoe/Calibri ≈ 0.278 /
   0.352 / 0.313 / 0.274 / 0.226, Georgia 0.241). Mark it "approximate" in a
   comment; the clean fix is a fontgen entry for cp 32 with `adv` and an empty
   raster — the bundle layout already allows `w = 0` phases — done on the
   tol0 side whenever sets are next regenerated.

### Adapter changes in `ocr-tool.js`

- `box.ocr.spaceAdv = res.spaceAdv` on every OCR line box.
- Slim cache: add `spaceAdv` per page and `src` per entry (needed for union
  lines); bump `OCR_CACHE_VERSION` to 2. Regenerate the committed cache file
  (`web/plugins/ocr_tool/cache/<hash>.json`): open the app locally once, let
  the read finish, export it with `ocrExportCache()`.

### UI

`web/plugins/ocr_tool/options_bar.html`, new group **MuPDF view**:

| Tooltip | id | Handler |
|---|---|---|
| Show text as MuPDF pixels | `ocr-pixel-view` (toggle, `.active`) | `pixel-view.js` |
| Highlight pixels that differ from the page | `ocr-pixel-diff` (toggle; enabled only while pixel view is on) | `pixel-view.js` |

Optional plugins document their own UI here, not in `guide/ui-map.md` — add
the rows to this folder's `README.md`.

## Phases and how each one is proven

### Phase 1 — the renderer, in tol0

Files: `engine/render.js` (new, ~150 lines), `ftclone/certify-render.mjs`
(new), `test/render.test.js` (new), `package.json` scripts
`certify:render`, `test` extended.

Certification, the real one: render short strings through MuPDF itself —
`mupdf.Text.showGlyph` per glyph at float pens, the same way `certify.mjs`
drives `fillText` — with pens sweeping every 1/64 px across a pixel, and
byte-compare against `renderLine(layoutLine(...))` using a set generated by
`fontgen` from the same free font (Carlito TTF, Nimbus Mono CFF). This
certifies the snap rounding at the boundaries (½-phase ties in x, .5 ties in y)
where a written rule is most likely wrong. Adjust the rounding until it prints
0 diffs; the number, not the prose, is the law.

Round trip: `test/render.test.js` renders a synthetic page with `render.js`,
reads it back with `readPage`, and asserts every line is clean and the
transcript equals the input. This also closes the "synthetic whole-page gate"
the tol0 README lists as open.

```bash
cd ../tol0
npm run certify:render     # expect: 0 diffs at every pen phase, both pipelines
npm test                   # expect: all engine tests + the round trip green
```

### Phase 2 — the seam in text_tool

Files: `web/plugins/text_tool/svg-renderer.js` (no version to bump — the build
stamps its content hash), `guide/architecture/unified-text-box.md`,
`guide/frontend/embedded-text-viewer.md`.

```bash
node --test "tests/**/*.test.mjs"   # unchanged suites still green
node tools/serve.mjs 5000           # open a document: text looks exactly as before
```

With nothing defining `utbPixelRender`, the app must be pixel-for-pixel what it
is today.

### Phase 3 — sync + adapter + buttons

tol0: add `'render.js'` to `ENGINE_FILES` in `tools/sync-recto.mjs`; add the
matching `scripts_after_app` entry in `web/plugins/ocr_tool/plugin.json` (the
build stamps it with its content hash). Then:

```bash
cd ../tol0 && npm run sync:recto
```

Recto: `web/plugins/ocr_tool/pixel-view.js` (new, ~200 lines, listed in
`plugin.json` after `ocr-tool.js`), `options_bar.html`, `ocr-tool.js` (spaceAdv +
cache v2), `tests/plugins/ocr_tool/page.test.mjs` (the two DOM ids and the
script tags are on the generated page, the engine before the adapters).

```bash
node --test "tests/**/*.test.mjs"
```

Browser proof, extended in tol0's `tools/test-recto-app.mjs`: after the auto
read of the certified document, click `ocr-pixel-view` then `ocr-pixel-diff`
and evaluate in the page that **every clean `ocr` box reports 0 differing
pixels**. That is the overlay proven equal to the page, in the real browser,
through the real buttons.

```bash
cd ../tol0 && npm run recto-test
```

### Phase 4 — docs and commit

- `guide/plugins/ocr-tool/README.md`: a "MuPDF pixel view" section (what the
  two toggles do, the set-mapping rule, the space-advance sources, the fallback
  message) and the UI rows.
- tol0 `README.md`: `render.js` in the layout list; `certify:render` in "what
  runs with nothing installed".
- Commit Recto and tol0 separately.

## Things to know before starting

- **Zoom.** The page `<img>` switches to `image-rendering: pixelated` above
  100 % (`web/core/styles.css`). The SVG `<image>` gets the same style inline
  so both stay crisp together; check it once in Chrome at 400 %.
- **Drag feels stepped on purpose.** `drag-resize.js` moves `box.x` in float;
  the pixel image only moves in ¼-px steps because that is all MuPDF can do.
  Nudge mode (`micro-typo.js`) keeps working — it edits the same pens.
- **Inline edit drops measured pens.** `inline-edit.js` clears
  `baseCharPositions` when the text changes; the box then lays out through
  `layoutLine` from `box.x`. Expected, and the reason `spaceAdv` is stored.
- **The `y`-phase `0.5` rasters in legacy sets are never used.** MuPDF rounds y
  to an integer (LAWS §1, FONTS.md); the renderer reads `byPhy.get(0)` only.
- **Palette producers.** When `box.ocr.quant` is true, Diff must map
  predictions through `BlindOCR.quantMap(page)` or every AA pixel shows red.
- **Colour pages.** Diff compares against the *whitened* page the reader used
  (`BlindOCR.whitenColored`), not the raw gray, or coloured ink shows as
  mismatch.
- **Honest limits.** A font/size with no shipped set falls back to SVG and
  says which set is missing; a character not in the set falls back the same
  way. Neither is silently approximated — that is the tol0 rule carried over.
- **Sizes that ship today** (from `glyphs.bin`): 16 px / 12 pt for most faces;
  Courier at 10, 11, 12, 13, 16 px; Times at 13, 16, 17, 18 px; Tahoma/Segoe
  at 13, 13.33, 16 px; Arial and Calibri also at 18.66 px (14 pt); Century
  Schoolbook at 18.72 px; Nimbus Roman at 15.36, 16, 18.66, 24 px; Nimbus
  Mono at 12.36 px. Anything else needs a fontgen run in tol0 and a re-sync.

## Later (not in this plan)

- **Burn-in / export.** Compositing a rendered line *over the page bytes*
  through the same law gives a page raster with the edit baked in, pixel-exact
  to what MuPDF would have produced. Recto has no save path today; when it gets
  one, `renderLine` is the piece that makes edited scans indistinguishable.
- **Space glyph in the bundle.** Add cp 32 with its advance and an empty raster
  in fontgen so the em-fraction table can go away.
- **Keyboard ¼-px nudges** (arrow keys on a selected box in pixel view) for
  faster lining-up than dragging.
