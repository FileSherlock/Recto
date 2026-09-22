# Auto OCR — `ocr_tool`

Byte-exact OCR of the page rasters, running entirely in the browser. The
toolbar's scanner button opens a subtoolbar with **This page** / **All pages**;
every line the reader certifies lands in the unified text box system as an
editable `type: 'ocr'` box — the same pipeline `embedded_text_viewer` feeds
embedded spans through — and detected redaction rectangles land as
`type: 'redaction'` boxes.

## Auto read + layer choice

Every loaded document is read automatically (`document:loaded` → all pages,
fire-and-forget). When the run settles the adapter compares non-whitespace
character counts of the `ocr` and `embedded` layers and shows exactly one:

- OCR volume within 80% of the embedded layer (`OCR_AUTO_SIMILARITY`), or no
  embedded text at all (scanned pages) → **OCR layer shown**, embedded hidden
  (the reader's measured ¼-px pens beat PDF extraction).
- OCR read substantially less → embedded stays, the OCR overlay is hidden so
  the two layers never draw on top of each other.

The choice just flips the existing body classes (`hide-ocr-text` /
`hide-embedded-text`) **and** both toolbar toggle buttons' active state, so
manual toggling afterwards starts from a state that matches the screen; the
verdict is appended to the status line. Opening a new document mid-run
cancels the old run — already on `document:opening`, before the new
document's first page shows (the page in flight is abandoned at its next
band) — and the new auto read starts on `document:loaded`. Manual runs never
flip layers.

This matters for scanned/eDiscovery documents: their pages are images, so the
embedded-text extractor has nothing to read. The blind reader recovers the
text from the pixels — *certified, not guessed*: a line is byte-clean only
when its glyphs reproduce the page bytes exactly through the producer's
proven blend law; anything unexplained is an honest `□`.

## Spaces in the transcript

The reader's glyph sets carry no space glyph; a break's spaces are counted
from its gap (`blindocr.js lineEntries`). Since 2026-09-15 the space is
calibrated **per set on the page** (a 16-px Times header and a 13-px
Courier body have different spaces, and one calibration for both wrote
every Courier space of the startup document's first page as two), and within
a line the unit is the line's own: gaps that agree with each other within
two lattice snaps are one space each whatever their width (a justified line
stretches every gap alike), and where they do not agree a gap counts against
the line's narrowest-half median, so a typist's double space after a period
is still two. Each line carries the space it was shaped with
(`box.ocr.spaceAdv`, `spaceAdv` on the slim line; the page's calibration is
the fallback for older caches).

## The read cache

A finished whole-document read is kept, slimmed down to exactly the fields
`ocrAddBoxes` consumes (`ocr-result.js`), under the document's SHA-256
(`state.docHash`). A later open of the same bytes replays the boxes through
the normal `ocrAddBoxes` path — no engine, no ~10 MB glyph download — and the
status line ends in `precomputed`. Two tiers hold the same JSON
(`{ version, pages }`) under the same version check:

1. **Shipped reads** — `web/plugins/ocr_tool/cache/<sha256>.json`, committed
   to the repository. The **startup document** (the PDF in
   `web/assets/pdfs/`, opened automatically) is the one document every
   visitor sees, so its read ships with the site instead of being re-run in
   every browser. The adapter looks the file up in the build's asset map
   (`window.RECTO_ASSETS`) before asking for it, so a document without a
   shipped read costs no request. Visitors can never overwrite these files —
   they are static.
2. **This browser's own reads** — IndexedDB database `recto-ocr-cache`. Every
   finished **All pages** read is stored there, uploads included; the last 8
   documents are kept (`OCR_CACHE_KEEP`). It never leaves the browser, and it
   is best-effort: in a private window or on a full disk the next open simply
   reads again.

A miss in both tiers falls back to the live engine read.

- **Shipping a read** after swapping the startup PDF: open the app, let the
  automatic read finish, run `ocrExportCache()` in the browser console — it
  downloads the open document's read as `<sha256>.json` — and commit that file
  to `web/plugins/ocr_tool/cache/` (see the `README.md` there). tol0's
  `node tools/recto-cache.mjs` does the same headless: it serves this site,
  waits for the read and writes the file. Stale files of old documents can
  be deleted.
- `version` (`OCR_CACHE_VERSION`, currently 3 — only black boxes are kept; 2: per-page `spaceAdv`, per-line
  `phy`, per-entry `src`) guards the payload shape; a file or a stored read
  with another version is ignored.
- A fresh browser profile has no second tier, so tol0's `npm run recto-test`
  (which uploads its certified document in a fresh browser profile and waits
  for the auto cycle) always exercises the real engine.

## The engine is developed elsewhere

`web/plugins/ocr_tool/engine/` (`core.js`, `ocr.js`, `ocr-engine.js`,
`blindocr.js`, `render.js`, `set-fonts.js`, `hypothesis.js`, `ftraster.js`) and
`web/plugins/ocr_tool/glyphs/` (`glyphs.bin` + the `index.json` that lists it)
are **verbatim copies** from the external `tol0` repo (`Desktop/tol0`, the certified port of the older
`char_training`), where the reader is developed and certified against a
multi-document corpus gate. **Never edit those copies
here.** The workflow:

1. Edit the engine in `tol0`, run its tests and certifications (`npm test`,
   `npm run certify:ftclone`, `npm run certify:render`) and its gate.
2. `npm run sync:recto` there (`tools/sync-recto.mjs`, which knows the
   `web/plugins/ocr_tool/` layout) — copies the engine + glyph bundle in.
   Nothing else is rewritten: the build stamps every script, and `assetURL`
   every file a script fetches itself, with its content hash, so a synced
   file has a new URL by construction. Never pass `--allow-partial`: it
   would replace the glyph bundle with whatever subset the tol0 checkout
   happens to hold.
3. `npm run recto-test` there — headless end-to-end smoke: serves this site
   with `node tools/serve.mjs`, uploads its certified document through the
   real file input, runs Auto OCR, asserts byte-clean boxes and a zero-diff
   pixel view. (`npm run sync:recto -- --check` reports staleness without
   writing.)

Only `ocr-tool.js` (the adapter: UI wiring, page-raster → engine buffer,
lines → UnifiedTextBoxes), `ocr-worker.js` (the Worker the adapter reads
in), `law-worker.js` (the Worker it learns the producer's law in),
`ocr-result.js` (the slim result shape shared by the worker, the cache
and `ocrAddBoxes`), `pixel-view.js` (the MuPDF pixel view) and
`hypothesis-view.js` (the hypothesis and width seams) are owned by this
plugin and edited here, together with `plugin.json`, the two HTML fragments
(`toolbar_button.html`, `options_bar.html`) and `styles.css`. A new engine
file is added to `scripts_after_app` in `plugin.json`, in load order.

## How it reads

- **Off the main thread.** The engine is synchronous JavaScript that yields
  only between bands, and a page in a face the sets do not carry runs the
  whole tolerance ladder — tens of seconds with the full bundle. The adapter
  therefore builds the page buffer (canvas → gray, colour whitening — that
  part needs the DOM) and posts it to a dedicated Worker, `ocr-worker.js`,
  which imports the same engine scripts the page loaded (their content-hashed
  URLs, read off the page's `<script>` tags, so it can never run a stale
  copy), loads the glyph bundle once (`assetURL`, made absolute — a worker
  resolves relative URLs against its own script), and
  returns the **slim** result (`ocr-result.js`) — the shape the read cache
  stores, replayed through the same `ocrAddBoxes`. Zooming, page
  changes and editing stay live while a read runs. The main thread loads the
  glyph sets only for the pixel view, or to read inline in a browser without
  Workers (the fallback, same results). **Stop** cancels between bands: the
  page in progress is abandoned (no boxes for it), earlier pages keep theirs;
  loading another document does the same before its own auto read starts.
- Input pixels are `Doc.pageImageURL(n)` — the core document service's
  lossless, ratio-cropped page rasters, the very images the viewer displays,
  so OCR coordinates line up with the page by construction. The URL is asked
  for each time a page is read, never stored: the service keeps a small LRU
  and revokes evicted URLs. Coordinates scale into the 816×1056 viewBox space
  (scale = 1.0 for the standard 96-dpi document family).
- Passes escalate exactly like the char_training app: byte-exact first (plain
  → palette-quantized → same-size mixed-font union pools), per-pixel
  tolerances only after that, and the status line always names the weakest
  machinery used (`byte-clean`, `clean@±1 (palette)`, …). The winning pass is
  reused as the first try on the next page.
- Per-glyph measured ¼-px pens go into `baseCharPositions`, so the SVG
  overlay reproduces the original character placement; the box `y/h` are
  chosen so `computeBaseline()` returns the *measured* baseline exactly.
- Line font/bold/italic/size come from the winning glyph set
  (`timesbd16` → Times New Roman bold 12 pt, `cour13` → Courier New 9.75 pt).
- Non-byte-clean lines render in orange (`box.color` override); unreadable
  bands become red `□` marker boxes. `box.ocr = {clean, tol, quant, union,
  font, baseline, fails}` rides on every box for downstream tooling —
  `trusted` marks a certified line whose letterforms are evidence of the
  face — one letter at ±2 or better (`To: "`, byte-exact in times16), three
  on a looser rung (a row of dots certifies in any face at ±10). A detected
  redaction box carries `box.ink = { x0, x1 }`, the black ink's own extent in
  viewBox px, kept apart from `x`/`w` which a refiner moves: the hidden text
  can start no earlier and end no later.
- Detected redaction rectangles become `redaction` boxes — when `box-rules.js`
  (`OCRBoxRules`, DOM-free, tested in `tests/plugins/ocr_tool/box-rules.test.mjs`)
  lets them. The engine's `detectObjects` types by height alone (≤ 4 rows a
  rule, taller a box), so a grey table cell, a logo's plate, a thick rule, a
  photograph or a page border arrive with the redactions. First, bars that
  touch across a separator arrive twice — the rows the separator's ink
  bridges make one run across two or three bars, the other rows make each
  bar on its own — so a box containing other boxes on its rows is replaced
  by what it covers beyond them (`deoverlap`: the first bar of a `[bar]:[bar]:[bar]`
  line, 3 px of separator left out). Then two rules sort the boxes, applied
  before the read is slimmed (the cache, payload version 3, holds only what
  stays): **black** — the interior, one pixel in from every
  side, is ≥ 90 % ≤ 48/255 (a box too thin to have an interior keeps the
  reader's word); and **where the text is** — on a page with ≥ 8 distinct
  text rows (unread bands count) the box either shares its rows with a line
  (a band overlaps ≥ 0.4 of its height) or stands on the text grid (a line
  within 0.6 × pitch above or below, and the box ≥ 0.6 × pitch tall — one
  line's bar or a block of lines); a box narrower than 40 px and taller than
  1.6 lines is a border or two bars' junction, never a name's bar. A page
  with fewer rows keeps every black box. Measured 2026-09-22: every real bar
  on the corpus and on EFTA00173953 overlaps a line by 0.47–0.84 of its
  height or lies 0–11 px from one and is 0.78–1.27 lines tall, so the rules
  drop nothing real there. `OCRTool.dropped(page)` lists what went (`why`,
  black fraction, overlap, gap, height in lines); the status line counts it.
  The survivors are snapped to their text lines via the guarded
  `utbConnectRedactionsToLines?.()` seam, and keep the face of that line (an
  OCR line's face is measured from the glyphs; the embedded layer's most used
  face is only for a bar on no line).

## Dependencies and seams

- **Requires `text_tool`** — boxes are `UnifiedTextBox`es rendered by
  `svg-renderer.js` (which defines the `ocr` type colors).
- **`embedded_text_viewer` is optional** — when present, its redaction
  line-connect treats `ocr` lines as text lines; when absent the call
  no-ops.
- The type-level seams in the baseline (`'embedded' || 'ocr'` filters in
  `unified-text-box.js` / `etv-fetch.js`, the `ocr` entries in the type color
  maps) are inert when this plugin is absent — same pattern as the
  `redaction` box type.
- No server side. Its data are static files inside its own folder (the
  glyph bundle, the shipped reads in `cache/`) and one IndexedDB database in
  the visitor's browser. Removing the plugin is just deleting
  `web/plugins/ocr_tool/` (the cache lives inside it), plus
  `tests/plugins/ocr_tool/`, this docs folder and its row in
  [`../README.md`](../README.md).

## The hypothesis seam (`hypothesis-view.js`)

`window.ocrTestHypothesis(box, name) → Promise<verdict | null>` for
`redaction_matching`: a candidate name is drawn where the refiner put a
redaction bar, the bar is composited over it (tol0 LAWS §8, bar last) and the
page bytes outside the bar's black body return `consistent`, `contradicted` or
`no-evidence` with the pixel counts (`open`, `edge`, `unexplained`), the pens
and the width fit. It reuses the pixel view's page info (the whitened page,
`detectObjects` with its edge model, the palette map) and set lookup, and the
engine's `hypothesis.js` (synced verbatim, certified in tol0 by
`test/hypothesis.test.js` and `tools/hypothesis-bench.mjs`). Nothing in it
identifies a sliver; it verifies a short list. Registered after
`pixel-view.js`; without `redaction_refiner` it returns `null`.

The same file defines the **width seam** `window.ocrMeasureWidths(box,
strings) → Promise<{ widths: (number | null)[], face } | null>`: the strings
laid out in the reader's glyph set for the bar's row (`OCRRender.layoutLine`,
plain — no page metrics — with the refiner's row space), so a matcher measures
candidates in the face that actually drew the page, at its own advances,
rather than in the installed font file. Widths come back in viewBox px; a
string with a glyph the set lacks is `null`; the call is `null` when the row
has no reader line or no set is loaded. `redaction_matching` takes these over
its HarfBuzz widths when offered.

## Limits

Byte-exact reading requires the document family's renderer to be modelled —
the shipped glyph sets cover the corpus families proven in char_training
(MuPDF Times/Arial/Georgia 16 px em, Courier New 13 px em, the eDiscovery
linear-compositor and palette-quantized producers, mode-2 color pages).
On an unmodelled producer the reader reports `□`s or escalates to tolerant
mode and says so in the status line — it never silently guesses. New
families are added in char_training (new glyph exports / producer laws),
then synced.

## MuPDF pixel view

Two switches in the **MuPDF pixels** section of the Settings panel (`settings.html`, wired in `pixel-view.js`):

| Switch | id | What it does |
|---|---|---|
| Draw text as MuPDF pixels | `ocr-pixel-view` | Every text box is drawn from the reader's own glyph bitmaps on mupdf's ¼-px pen lattice and whole-pixel baseline, instead of SVG text — the raster mupdf would have produced. Tinted like the SVG text (alpha = ink darkness); pixelated when zoomed. |
| Diff: highlight the pixels that differ from the page | `ocr-pixel-diff` | Matching ink pixels go faint, pixels whose predicted byte differs from the page turn solid red, and page ink inside the line's band that no drawn glyph explains turns solid orange (the reader's residual — a quote mark it never transcribed). The status line reports `OCR lines n/m exact` (reader-certified lines, which must all be exact — within the reader's own ±tol when a line was read on a tolerant rung) and `other boxes n/m exact` (embedded / hand-added text, compared but not expected to match) for the page and, on selection, the box's ink-pixel and differing-pixel counts. |

- **Which glyph set draws a box.** OCR lines: the set the reader picked
  (`box.ocr.font`; a union name resolves per glyph through
  `baseCharPositions[i].src`). Other boxes (embedded, hand-added): the
  shipped set whose family, bold/italic and pixel size match
  (`sizePt × px/pt`, within 0.02 px). No match → the box stays SVG and the
  status line names the missing set.
- **The reader's own terms.** An OCR line is re-drawn with the y-phase
  records the reader pinned it to (`box.ocr.phy`, 0.5 on the legacy sets
  that carry ½-phase rasters) and judged at the tolerance of the rung it was
  read on (`box.ocr.tol`: byte-exact at 0; |Δ| ≤ tol, 2·tol on composite
  pixels, otherwise — scanLine's rule). "Exact" in the status line means
  exact to that standard.
- **Both halves of the certificate.** The renderer proves one direction:
  every drawn pixel is the page. The reader proves the other: no ink in the
  band was left unexplained (`box.ocr.residual`, its own residual count —
  `clean` means no failure columns and residual 0). "Exact" needs both. For a
  line the reader marked unclean (orange text), the Diff locates the leftover
  ink with `render.js residualInk` (page ink in the reader's judged rows that
  no drawn glyph covers, outside the object mask and the detected redaction
  rectangles) and paints it orange; the status line quotes the reader's own
  count. The location is a rebuild of the reader's bookkeeping and can differ
  by a few fringe pixels around a redaction box; the count is the reader's.
- **Pens.** Measured pens (plus nudges and space overrides) when the box has
  per-character positions; otherwise a fresh layout through `render.js
  layoutLine` under **the producer's law** (below), from the sub-lattice
  start the reader line was laid from (`render.js lineStart` over
  `box.ocr.entries`) and with the line's own measured gaps for its spaces —
  so an edited line keeps its unchanged pens and continues under the same
  law. New breaks use the reader's page-calibrated space (`box.ocr.spaceAdv`,
  also stored in the slim cache, payload version 2) or an approximate
  per-family em fraction.
- **The producer's law.** A certified line fixes the face, the size and every
  pen, not how the producer arrived at them, and that differs between
  documents in the same face (measured 2026-09: Courier New laid at the
  PDF's 1/1000-em advance, 7.8 px, where the set's hmtx says 7.80127 — one
  lattice step by the 30th glyph; Nimbus Mono laid at 12.36 px where the
  set's em64-truncated size says 12.359375; an email header kerned with the
  font's table while the body of the same document was not). After each
  page's boxes exist, `ocr-tool.js ocrLearnProducer` learns, per (page,
  set), the law that writes the most certified pens back — advances at
  1/1000 em or the set's hmtx, the laid size searched to 5e-6, kerned with
  the face's own table or not — with `render.js producerMetrics` and the
  kern table from `text_tool` (`FontCatalog.metrics` → `Shaping.fontMetrics`,
  HarfBuzz in the browser). The search is about a second of arithmetic per
  searched hypothesis on a Courier page (measured 2026-09 on the startup
  document, 65 lines; since 2026-09-20 the engine skips a search that can no
  longer win, which brings a page whose pens scale 1 already writes to
  ~12 ms), after every page of a read and for every page of a cache replay —
  so it runs in a Worker of
  its own, `law-worker.js`, which imports the page's own `engine/render.js`
  and gets the slim entries and the kern table by structured clone; the
  reader's worker goes on with the next page meanwhile, and the main thread
  only fetches the kern table and stores the answer (inline as before in a
  browser without Workers). A pair the page never wrote ("Yo", "Ve") is therefore laid with
  the font's kern only on a page whose producer kerned. `window.ocrProducerFor(page,
  set)` returns the law; the status line names it on selection (`law 1/1000
  em × 1.00000, no kerning (300/300 words written back)`); a set the page
  never certified is laid under the least assumption (1/1000 em, the set's
  size, no kerning) and the status says `assumed`. `PixelView.laws(page)`
  and `PixelView.relayout(boxId)` expose the law and a re-layout of any box
  through this path with its pixel diff — the headless test that typed text
  is the page. The law is the deterministic part of a producer; a page laid
  by Word carries, on top of it, Word's own per-glyph rounding, which places
  the same word differently at different starts (measured 2026-09 on a
  Times affidavit and on a Word 365 export of the same text: 31 of 36 and
  26 of 38 repeated words differ). No writer that has only the page can
  reproduce that — typed text on such a page lands on the producer's pens
  except for one lattice step on about 2 % of glyphs, and the certified
  lines themselves are always exact because they are re-laid from their own
  pens.
- **Diff compares against the reader's page**: the viewer's `<img>` through
  `PageEngine` + `whitenColored`, through the page's palette map when the
  line was read with a palette pass, and never under the reader's object
  mask or box halos (`render.js objectMask`: `detectObjects` plus the ±2-column,
  ±3-row halo around every redaction box, where the reader forgives clipped
  glyph fragments; a descender dipping into a box's padding or a glyph
  half-swallowed by the redactor is reported as "under a box/rule", not as a
  difference) — so zero differing pixels means the same thing as
  the reader's byte-clean. Hidden layers (`hide-ocr-text` /
  `hide-embedded-text`) are not drawn or counted.
- **Every text setting is drawn.** The bundle holds the faces, styles and
  sizes the corpus needed; a typed box is set in whatever the toolbar says.
  `pvSetsForBox` takes, in order: the reader's set(s) while the box is still
  in the face it was read in (`utbFaceChanged`), a bundled plain set of the
  box's family, style and size, and otherwise a set **rasterized on demand**
  from the catalogue's own font file (`FontCatalog.fileUrl` →
  `engine/ftraster.js loadFace` / `makeSet` — the certified port of mupdf's
  glyph pipeline that generated the bundle, now fed font bytes; an on-demand
  set is byte-identical to a generated one, `tol0 test/ftraster.test.js`). So
  Times bold italic, Arial 9.5 pt or Courier New 11 pt bold italic are mupdf
  pixels too; making a read line bold switches it to that face and laying it
  afresh, switching back restores its measured pens and its zero diff.
  **Underline / strikethrough** are filled rectangles from the face's own
  metrics (`post` underline, `OS/2` strikeout, top-edge convention) under
  mupdf's *path* rasterizer — a 17 × 15 sub-sample grid, not the glyph
  pipeline (`ftraster.js rectCoverage`, `npm run certify:rect`: 0 differing
  bytes over 4,384 rectangles) — blended after the glyphs by `renderLine`.
  **Letter spacing** and a manual **space width** go through `layoutLine`.
  **Kerning**: `pixel-view.js` answers text_tool's `utbAutoKerning` seam with
  whether the page's producer kerned the box's family, so a new box follows
  the page; the Kerning checkbox then wins in both directions (the status
  line says `your Kerning setting, not the page's`), with the face's kern
  pairs from `FontCatalog.metrics` quantized and scaled under the page's law. A set
  the page never certified (a bold italic nobody wrote) borrows the
  *structure* of its family's law on that page — quantization, scale,
  kerned-or-not — never its tables.
- **Honest limits.** A character the face lacks, a style the family has no
  file for (nothing is synthesized), a set that is not loaded, or a
  page raster that is not 1:1 with the viewBox → SVG fallback, never an
  approximation. The seam is `window.utbPixelRender` in `svg-renderer.js`
  (see [Unified Text Box](../../architecture/unified-text-box.md)).
- **Proofs.** tol0: `npm run certify:render` (render.js vs real mupdf at every
  1/64 pen phase, both TTF and CFF pipelines, forced overlaps — 0 diffs),
  `npm test` (synthetic round trip render → readPage → clean). Recto:
  `node --test "tests/**/*.test.mjs"` — `tests/plugins/ocr_tool/page.test.mjs`
  checks the controls on the generated page and that the engine loads before
  the adapters; `tests/plugins/ocr_tool/smoke.mjs` adds this plugin's steps
  (wait for the auto read, pixel view on and off) to the browser smoke test,
  `node tests/smoke/smoke.mjs`. Browser: tol0's `npm run recto-test`
  asserts every byte-clean OCR box reports 0 differing pixels; its
  `tools/verify-recto-pixels.mjs` runs the same check over a folder of PDFs.
  Design record: [pixel-view-plan.md](pixel-view-plan.md).

## Faces: `engine/set-fonts.js` and the toolbar default

Every glyph set names the face it was rendered from in `engine/set-fonts.js`,
generated in tol0 from the registry's PROVENANCE (`npm run set-fonts`, asserted
current by `npm test`, synced with the engine): `{ family, bold, italic, file,
sizePx, plain }`, or `null` for page-cut sets. Family names are the text tool's
catalogue names, so a line read with `nimbus791` is a `Nimbus Mono PS` box and
the browser draws its vector text from the URW file itself.

- `ocrAddBoxes` sets each segment's family/bold/italic from the set that drew
  most of its glyphs (per-glyph `src` on union lines), through
  `ocrFontFromSetName`.
- When a read finishes (live or replayed from the cache) the adapter emits
  `typography:detected { fontFamily, sizePt, source: 'ocr' }` with the
  dominant face and size of the certified lines (weighted by glyph count);
  `text_tool`'s `fonts.js` selects it in the font menu and size input. Not
  after a weak read (`ocrReadIsWeak`: fewer than 3 certified lines, or fewer
  than half of the lines read): the claim outranks the text layer's, and on
  a page the reader could not read the two lines it certified at ±10 named
  Cambria for a Times New Roman 11 pt memo.
- The pixel view picks the glyph set for a hand-typed box by family and size
  through the same table (`plain` sets only — stock face, stock law).
