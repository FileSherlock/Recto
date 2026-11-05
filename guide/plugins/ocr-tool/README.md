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
- `version` (`OCR_CACHE_VERSION`, currently 4 — the rules are kept beside the
  bars, and an entry carries its glyph's `ink`; 3: only black boxes are kept;
  2: per-page `spaceAdv`, per-line `phy`, per-entry `src`) guards the payload
  shape; a file or a stored read with another version is ignored. It does not
  follow the engine or the glyph bundle: after a sync a document this browser
  already read replays its old read until **All pages** is run on it again.
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
   happens to hold. Before a bundle sync, back up `glyphs.bin` and A/B-read
   the golden PDFs under both bundles. The last bundle sync, 2026-11-05, went
   from 77 to 86 sets (DejaVu Sans Mono 1024, Times 833, the Nimbus Roman
   942/849/768 sets; the 77 payloads byte-identical; 39 of 40 recorded golden
   pages read the same, `vector` p2 still ±10). Engine files were copied by
   hand before that
   (2026-10-10: `blindocr.js`, `ocr-engine.js`, `set-fonts.js` —
   recto-eval's full tier 12 better, 0 worse, 249 more certified segments;
   the last, 2026-10-11: `ocr-engine.js` — a tall glyph glued to a bar
   stays readable, a short underline is a rule (full tier 2 better, 0
   worse), dark ink an underline's pad hides from every read glyph keeps
   its line from certifying (one synthetic line in the corpus), a colour
   shown fully covered 12 times is a pen (20 before; a short light-blue
   word read), and text-shaped colour no pen explains — whitened, `lost` —
   keeps its line from certifying (blindocr.js passes it on; 1 better, 0
   worse); gate 19/19 byte-identical; the startup document's read
   unchanged byte for byte each time).
3. `npm run recto-test` there — headless end-to-end smoke: serves this site
   with `node tools/serve.mjs`, uploads its certified document through the
   real file input, runs Auto OCR, asserts byte-clean boxes and a zero-diff
   pixel view. (`npm run sync:recto -- --check` reports staleness without
   writing.)

Only `ocr-tool.js` (the adapter: UI wiring, page-raster → engine buffer,
the read's boxes into `utbState`), `line-boxes.js` (which boxes a read makes —
DOM-free, `OCRLineBoxes`, below), `box-rules.js` (which dark regions are
redactions, DOM-free), `ocr-worker.js` (the Worker the adapter reads
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
  part needs the DOM) and posts it to a dedicated Worker, `ocr-worker.js` —
  the page as `BlindOCR.whitenColored` made it, not only its grays: the
  colour law's acceptance band (`bandLo`/`bandHi`), the `converted` and
  `whitened` maps and the lost ink (`lost`). Until 2026-10-11 only `gray`
  and `converted` crossed, so the app read coloured text more strictly than
  the engine does: an e-mail page's blue links were 47 □ in the browser and
  0 with the band (recto-eval's 12 colour pages: 203 □ against 114), and a
  colour photo's residue came back as rows of `llll'□□□`. The worker
  imports the same engine scripts the page loaded (their content-hashed
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
- Which boxes a read makes is `line-boxes.js` (`OCRLineBoxes`), DOM-free like
  `box-rules.js`: the page loads it before `ocr-tool.js`, node imports the same
  file (`tests/plugins/ocr_tool/line-boxes.test.mjs`, and the evaluation
  harness below). `pageBoxes(page, slimRead, pass, { sx, sy })` returns plain
  specs in the order `ocrAddBoxes` adds them — `{ data, ocr?, ink? }`, `data`
  what `new UnifiedTextBox(data)` takes — and `lawInputs`, `readIsWeak`,
  `dominantTypography` answer the adapter's other questions of a read.
  `ocrAddBoxes` only makes the boxes and starts the law learning.
- **Underline, colour and face** (since 2026-10-10). A box carries one
  underline, one colour and one face, so a line is split where any of them
  changes, as it is at a bar (a blue underlined link inside a black
  sentence: three boxes; a bold label and its regular value — "Subject:" |
  "Vacation 4.18.11 …" — two). Each is a WORD's, its glyphs' majority, and a
  line splits between words only (inside a word two glyphs can share an
  anti-aliased pixel). A word drawn by a set with no face of its own (the
  bullet sets) takes its neighbour's. The underline
  is a rule the read found — `detectObjects`' thin `'rule'` objects, which the
  slim read keeps since cache version 4; one under a single short word,
  shorter than the 40-px run rule, since the engine sync of 2026-10-11
  (`will □not` read `will not`) — starting below the baseline row and
  no deeper than the line's descent, under the glyph's middle
  (`underlinedEntries`). Not the glyphs' own feet: a run of bottom strokes
  along the baseline row (`ZzZE` in base64, the serifs of "Summary") is a rule
  to `detectObjects` one row up; not a separator that runs on more than an em
  past the line's text (a heading's rule across the column); not a slice of a
  redaction box (the engine types a bar's thin rows `'rule'` too). The rule
  rides on the box (`box.ocr.underline`): an unedited read line draws no
  underline in the pixel view (the page's rule is there, masked from every
  verdict — a rectangle only approximates its anti-aliased ends), an edited
  one draws it at the rule's rows (Calibri's own underline sits a row higher
  than the memo's three-row rule). The colour is the glyph's ink: the colour law
  reads coloured text as coverage through its pen (`Engine.colourInk`), so
  right after a read, on the main thread where the raster is, `inkColours`
  gives every glyph whose dark pixels the law converted the colour of its
  most covered pixel, a run of glyphs on one pen's ramp the run's darkest —
  stamped on the entry as `ink` (the slim read keeps it; black glyphs carry
  none). An uncertified line keeps the reader's orange instead. Measured
  (recto-eval, full tier): underline 0 → 23 of 23 synthetic words, none where
  the page has none; colour on every certified coloured line (the rest of the
  colour page's lines are not certified — the colour law's reading, an engine
  question); every segment as read is still the page, and the startup
  document's boxes are unchanged (its one rule is a separator).
- **Paragraphs** (`OCRLineBoxes.paragraphs(boxes, { page, w })`, since
  2026-10-10; nothing in the page calls it yet — a Frame text made from a
  read paragraph would): a page's read lines as a word processor set them —
  lines, alignment, left / first-line / right indents, leading, space before,
  list items. A line joins the paragraph above when it is in the same size
  and face, at the paragraph's leading, and the line above was full (word
  wrap: the next line's first word would not have fitted after it — the
  column's right is where long lines agree, on a ragged page the margin
  mirroring the left one), or centred or right-set the same way, or the two
  are an indented block. A two-line paragraph whose gap is the page's gap
  between paragraphs is two. Justified lines end at the margin and are spaced
  wider than the paragraph's last line. A list marker before a tab-wide gap
  starts an item (its indents hang). The leading is pooled over the page's
  paragraphs of a size and, within a measurement's ±1 px, taken as Word's
  single, 1½ or double spacing for these faces (1.15 × size). Measured
  (recto-eval, 115 synthetic paragraphs): paragraphs 114, alignment, indents
  and leading 117 of 117. The one miss is a known limit: lines broken inside
  a paragraph (Shift+Enter, an address block) look like paragraph ends — an
  e-mail's header lines are set the same way and are paragraphs.
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
  line, 3 px of separator left out), and a bar the engine cut into slices
  — each shorter than a line, typed rule or box — is one box again
  (`restack`: slices whose rows touch and whose columns match within 3 px,
  over the columns they all share). The engine cut a bar so when a tall
  glyph was glued to its side (a `(` against a Calibri bar, 2026-10-11);
  its bar-body clip no longer takes such a glyph since the sync of that
  date, and `restack` stays for reads made before it. Then two rules sort
  the boxes, applied
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

Where the name sits and how its words are spaced come from the refiner's
verdict on the bar (`box.refineInfo`). The gap to each neighbour (`hvGap`) is
how far from the neighbour's ink the refiner put that edge: a space; two after
a sentence on a page that spaces its sentences so; none where a mark binds to
the name (`(`, `<`, a quote, the comma after it — the refiner's punctuation
rules, not a second copy of them); a fragment's missing letters and a space.
An edge at the bar's ink (the neighbour is not the name's — a label a tab stop
away) gives no pen at all: the name is placed from the other side, and with no
pen on either side the seam declines rather than draw the name a space after
the label and contradict it (four true names on the tab-stop pages, until
2026-10-11). The
space between the name's words (`hvRowSpace`) is the row's, the one the
refiner derived the bar with — from whichever side carries one: a side that
abuts a mark carries 0, which is not the row's. With neither (a bar between
two marks, or before the refiner has run) it is the face's own space under the
producer's law, the face loaded first (`pvSpaceAdv`, as typed text gets it),
and only without the face the reader's calibration. Until 2026-10-10 the
first side's space was taken even when it was that 0, and the gap was one
space whatever the refiner had found: measured on bars whose hidden text is
known (recto-eval's `match.*`: three synthetic pages made for the cases, and
the FBI summary's second release), a two-word name beside `( )` or quotes
measured one space short and fell out of the matcher's 0.3 px window (one
opening a line before a comma measured short too), and the true name after a
double-spaced sentence end with no word after the bar was contradicted (on
the summary page too). After:
the width seam 30 → 38 of 39 bars, the hypothesis seam 35 → 38 of 39, 16
units better, 0 worse.

The same file defines the **width seam** `window.ocrMeasureWidths(box,
strings) → Promise<{ widths: (number | null)[], face } | null>`: the strings
laid out in the reader's glyph set for the bar's row (`OCRRender.layoutLine`,
plain — no page metrics — with the row space, `hvRowSpace` above), so a matcher measures
candidates in the face that actually drew the page, at its own advances,
rather than in the installed font file. Widths come back in viewBox px; a
string with a glyph the set lacks is `null`; the call is `null` when the row
has no reader line or no set is loaded. `redaction_matching` takes these over
its HarfBuzz widths when offered.

## Measuring it: the evaluation harness

`~/Desktop/recto-eval`, a repository of its own beside Recto and tol0 (kept out
of Recto so this one stays small), scores what this plugin makes of a read —
letters and word spaces against tol0's checked transcripts, faces, styles,
sizes, underline, colour, paragraphs and redaction bars against synthetic pages
with known answers (laid out from specs, rendered by MuPDF at 96 dpi, embedded
as scans), confirmed hand labels and second releases of a redacted page (what
a bar hides, typed into it with the bar's formatting, against the release that
shows it), the embedded text layer as a second opinion, how redaction
matching measures a bar whose hidden text is known (the refined bar, the
width and hypothesis seams, asked about that text only: `match.*`) — and
whether the detected formatting **writes the page back**: every
certified segment drawn as read, re-laid under the law (`PixelView.relayout`),
and typed afresh from its formatting alone, each judged by the pixel view's own
diff. It runs this plugin's files headless (the engine, `line-boxes.js`,
`ocr-tool.js`, `pixel-view.js`, `hypothesis-view.js`, the redaction refiner,
text_tool's box model) and certifies that a node
read of the startup document is the browser's shipped read and the headless
pixel view the smoke test's verdict. Its skill (`.claude/skills/ocr-eval/SKILL.md`
there) is the loop: the top failure group, a measured counterfactual, the
change where it belongs, `node run.mjs --against latest`; its
`IMPROVEMENTS.md` is the worklist. Fixed 2026-10-10 with it: the typed space
(see Pens, below — typed write-back over the full tier's 30,564 certified
segments 66.4 % → 77.1 %, 3,267 better, 3 worse and explained) and
`render.js lineLayout`'s set change inside a word (re-laid lines 112 better,
0 worse; the Calibri page 17 → 46 of 49); the matcher's seams' space and gaps
(*The hypothesis seam*, above; 16 better, 0 worse); underline and colour on the
boxes (above); paragraphs (above). Still open there: coloured lines
the colour law leaves uncertified; the shipped Times New Roman, Courier New and
Segoe UI files are another build than the bundle's sets in a few characters
each (the report lists them).

### Typed text over the page: how close it comes (2026-10-18)

The question this answers: typed with text_tool's Artistic text over a line the page already
has — the line's face, style, size, its first pen and baseline, the text the reader read — how
close do the typed glyphs come to the page's? Two measurements, both with scratch scripts over
this repository and recto-eval (kept in the session, not committed):

- **MuPDF pixels, the whole corpus** — recto-eval's typed write-back (`wb.typed`, every
  certified segment of the full tier: 43 documents, 30,836 segments) laid three ways: kerning
  **as the page** (what text_tool does), **always on** (Affinity's default, and text_tool's
  before 2026-10-18 for a page nobody had read), **always off** (Word's default).
- **The browser's own text** — the app in headless Chrome: Artistic text made over every
  trusted OCR segment of 13 documents (up to their first three pages), every glyph's x as the browser
  laid it against the reader's pen, with text_tool's new defaults (kerning as the page, no
  ligatures) and the old ones (kerning and ligatures on); the same stories through the pixel
  view, started where the page's lattice lets the line start.

**Who kerns.** Every page Word made — the affidavit and the warrant (Times New Roman), the FBI
summary in both releases (Calibri), the eDiscovery memo, the palette pages — and every
synthetic page (set like Word) is set **without** pair kerning; the Times 16 px e-mail
printouts (the startup document's header, v3, email, big, the e-mails of 2010 and 2019) are
kerned. Courier and Nimbus Mono bodies have no kern pairs. 47 % of the segments hold a pair of
their face's kern table, so the choice decides them. **No producer used a ligature**: 0 of
30,836 read lines has an fi / fl ligature glyph.

| typed in MuPDF pixels (`wb.typed`) | as the page | always on | always off |
|---|---:|---:|---:|
| all 30,836 segments | **77.1 %** | 76.9 % | 46.4 % |
| FBI summary p2 (Calibri, Word) | **62.7 %** | 15.7 % | 62.7 % |
| FBI summary p2, second release | **15.2 %** | 4.3 % | 15.2 % |
| synthetic: 21 faces | **90.5 %** | 33.3 % | 90.5 % |
| synthetic: Calibri report / Verdana spacing | **50.0 / 75.0 %** | 12.5 / 25.0 % | 50.0 / 75.0 % |
| big (340 pages of kerned Times e-mail) | **84.1 %** | 84.1 % | 33.1 % |
| the 2019 e-mail (kerned) | **63.3 %** | 63.3 % | 43.3 % |

In the browser (HTML text, no pixel view), per document — lines whose every glyph lies within
½ px of the page's pen; lines whose glyphs inside each word do (the word gaps left out); lines
the pixel view then draws exactly; the median glyph error — new defaults / old:

| document | lines | ≤ ½ px | in-word ≤ ¼ px | pixels exact | median error, px |
|---|---:|---:|---:|---:|---:|
| startup p1–3 (kerned Times header, Courier body) | 191 | 191 / 191 | 190 / 190 | 190 / 190 | 0.06 / 0.06 |
| synthetic: 21 faces | 21 | 20 / 8 | 20 / 7 | 19 / 7 | 0.06 / 0.23 |
| synthetic: Verdana spacing | 8 | 8 / 2 | 8 / 2 | 6 / 2 | 0.09 / 0.58 |
| synthetic: Arial memo | 20 | 14 / 13 | 20 / 15 | 11 / 8 | 0.13 / 0.16 |
| synthetic: Times letter | 22 | 12 / 7 | 22 / 14 | 12 / 7 | 1.31 / 1.67 |
| synthetic: Calibri report | 8 | 4 / 1 | 8 / 1 | 4 / 1 | 3.52 / 3.78 |
| synthetic: justified Times | 18 | 5 / 5 | 18 / 17 | 4 / 4 | 1.91 / 1.91 |
| affidavit (Word, Times, justified) | 35 | 13 / 9 | 27 / 18 | 3 / 2 | 5.30 / 5.88 |
| FBI summary p2 (Calibri) | 51 | 37 / 15 | 48 / 11 | 32 / 8 | 0.13 / 1.20 |
| FBI summary p2, second release | 46 | 32 / 8 | 43 / 7 | 6 / 2 | 0.09 / 1.30 |
| the 2019 e-mail (kerned Times) | 30 | 30 / 30 | 28 / 28 | 19 / 19 | 0.06 / 0.06 |
| the 2010 e-mails p1–2 (kerned Times, palette pages) | 77 | 77 / 77 | 76 / 76 | 64 / 64 | 0.08 / 0.08 |

What it says:

- **Inside a word the typed text is the page's** once kerning is the page's and ligatures are
  off: the glyphs land within ¼ px of the reader's pens on 93–100 % of the lines of every
  document but the Word affidavit (27 of 35: Word lays the same word differently by where it
  starts, the lab's open case) — the browser lays a face's own advances, the producer its
  1/1000-em widths, and the difference stays under the lattice step. Kerning the wrong way is
  the largest error — the Calibri page kerned drops from 48 to 11 lines of 51, the kerned 2010
  e-mails unkerned from 76 to 62 of 77 — and the browser's default ligatures the next (48 → 26
  on the Calibri page: Calibri ligates fi, fl, ff).
- **Between words** the page decides: Word **justifies** its lines by widening each line's
  spaces, and puts its rounding into some gaps; text typed with the face's own space misses those
  by up to several px by the line's end (the affidavit's, the Times letter's and the Calibri
  report's medians above are their justified lines). Artistic text now takes the line's space
  (below); Frame text with Justified alignment justifies with the browser's spaces, not Word's.
- **Pixel-exact lines** follow the in-word result where the line's gaps are the face's own (the
  e-mails, the synthetic faces page: 19 of 21); on Word's justified pages few lines are
  (affidavit 3 of 35): the producer's own word gaps, which no per-word law reproduces.
- Typed over a read line, a story's pieces are the typed box's (same glyph set, law and pens),
  and with the page's read terms (`pvTerms`) the same verdict, line for line.

### Typed text takes the line's space (2026-10-18)

Artistic text clicked on a read line now takes that line's space as its paragraph's Word Spacing,
and the Text panel's **Space as this line** sets it again, paragraph by paragraph
([The Text panel](../../frontend/text-tool.md#space-width-nudge)). text_tool measures it from
its own data — the line box's `baseCharPositions`, here the reader's pens: the line's text laid
in the face by HarfBuzz as the story draws it, its word starts against the reader's, one width
per line; the face's own space where that lands the line within a quarter pixel. It does not read
`box.ocr` (the reader's `spaceAdv` is its set's calibration, not the line's).

The same browser study as above, now through the tool's own click (`create()`: the line's face,
size, baseline, first pen — and its space), the reader's text typed in; before = the same story
with the face's own space. Every glyph's x against the reader's pen (the caret rect, plus half a
legacy-`kern`-table kern, as above):

| document | lines | given a space of their own | ≤ ½ px | in-word ≤ ¼ px | MuPDF pixels exact | median glyph error, px |
|---|---:|---:|---:|---:|---:|---:|
| startup p1–3 (kerned Times header, Courier body) | 191 | 0 | 191 → 191 | 190 → 190 | 190 → 190 | 0.06 → 0.06 |
| synthetic: Times letter | 22 | 10 | 12 → **22** | 22 → 22 | 12 → 12 | 1.31 → 0.06 |
| synthetic: Arial memo | 20 | 0 | 14 → 14 | 20 → 20 | 11 → 11 | 0.13 → 0.13 |
| synthetic: Calibri report | 8 | 4 | 4 → **8** | 8 → 8 | 4 → 4 | 3.52 → 0.06 |
| synthetic: 21 faces | 21 | 0 | 20 → 20 | 20 → 20 | 19 → 19 | 0.06 → 0.06 |
| synthetic: Verdana spacing | 8 | 0 | 8 → 8 | 8 → 8 | 6 → 6 | 0.09 → 0.09 |
| synthetic: justified Times | 18 | 14 | 5 → **18** | 18 → 18 | 4 → **6** | 1.91 → 0.06 |
| synthetic: justified Calibri | 18 | 14 | 5 → **18** | 18 → 18 | 5 → **8** | 2.73 → 0.06 |
| synthetic: justified Courier | 21 | 12 | 9 → **21** | 21 → 21 | 9 → **13** | 0.14 → 0.06 |
| synthetic: underline mixed | 9 | 0 | 9 → 9 | 9 → 9 | 5 → 5 | 0.06 → 0.06 |
| affidavit (Word, Times, justified) | 35 | 21 | 13 → **23** | 27 → 25 (≤ ¼ px + 1/64: 27 → 28) | 3 → 3 | 5.30 → 0.13 |
| FBI summary p2 (Calibri) | 51 | 1 | 37 → 37 | 48 → 48 | 32 → 32 | 0.13 → 0.13 |
| FBI summary p2, second release | 46 | 1 | 32 → 32 | 43 → 43 | 6 → 6 | 0.09 → 0.09 |
| the 2019 e-mail (kerned Times) | 30 | 0 | 30 → 30 | 28 → 28 | 19 → 19 | 0.06 → 0.06 |
| the 2010 e-mails p1–2 (kerned Times, palette pages) | 77 | 0 | 77 → 77 | 76 → 76 | 64 → 64 | 0.08 → 0.08 |
| e-mail printout p1 + base64 p2 (EFTA00751637) | 156 | 0 | 29 → 29 | 25 → 25 | 121 → 121 | 0.33 → 0.33 |
| **all** | 731 | 77 | 495 → **557** | 581 → 579 (585 → 586) | 510 → **519** | |

- **Justified lines land.** The lines given a space of their own are Word's justified lines (and
  one misread letterhead, below); with it every glyph of 64 of the 77 lies within ½ px of the
  reader's pen, against 2 before — the median glyph error on the affidavit falls from 5.30 to
  0.13 px, on the Calibri report from 3.52 to 0.06.
- **Every other line is drawn as before.** A line set with the face's space measures as the
  face's own (100 %, `wordSpacingFor`: within a quarter pixel over the line), so the startup
  document, the e-mails, the faces and Verdana pages are line for line what they were — also in
  pixels. Measured from the page's own glyph room instead of the face's layout, those lines read
  3.95–3.99 px for a 4.000 px space (the reader's advances are a few hundredths of a px a word
  off the face's) and lost exact lines; and a kerned page's "Tue, 19 Apr 2011" header lost ½ px
  (the page kerns the space before the *A*, and so does the face).
- **Pixel-exact lines** rise on the justified pages (Times 4 → 6, Calibri 5 → 8, Courier 9 → 13;
  of the 77 lines, 1 → 10): one width per line lands the line's ends and most of its words, not
  Word's own rounding, gap by gap.
- **In-word** is unchanged: the two affidavit lines below ¼ px that are not any more moved from
  0.250 to 0.266 px — one 1/64-px layout unit of Chrome's character rects, at the threshold —
  and within ¼ px plus that unit the affidavit counts 27 → 28.
- **What is left**: tab gaps — a list label's or a bullet's ("w. A Lenovo…", "2.    Evidence…",
  "•    Requests…": 11 of the 13 lines given a space and still off, 0.5–3.8 px), which a run of
  typed spaces takes at the line's space (now a tab stop: below); the FBI letterhead in both releases (the other 2), its
  letter-spaced capitals read as "FE DERAL BUREAUOF" (20 px either way); and on a monospace
  base64 page (EFTA00751637 p2, 79 lines, no spaces) the browser's own advances, 0.8 px off by
  a line's end in HTML either way, while the pixel view draws it exact either way.
- **recto-eval**, full tier against `full-2026-10-18-11-09-59` (run `full-2026-10-18-12-07-37`):
  0 better, 0 worse — its typed write-back types a one-line box, not a story. Its `whatIf.pageSpace` (one width per line from
  the reader's solved gaps, under the pixel view's law) is the same idea for that box: the group
  "word gaps — one width per line" holds 1409 segments, 4.6 % of `wb.typed`.

### A list label's tab becomes a tab stop (2026-10-18)

Word sets a list item as its label, a tab, and its text from the list's stop: on the affidavit
the lettered labels at x 144 with their text at 168, the numbered ones at 144 with theirs at 192.
The reader writes the tab's gap as the spaces that fill it **at the line's space** — a 36 px gap is
four spaces on a line of 8–9 px spaces and eight on one of 4.5 px — or, where the stop is just
past the label, as **one wider space** ("w." 8.5 px on a line of 6.75 px spaces, "z." 13 against
10.5, "aa." 5.75 against 4.45). Typed spaces take it at the line's space and miss the text by up to
half a space or more. text_tool now reads such a gap as a tab (`StoryCore.lineTabGaps`: a run of
spaces, or one space more than `TAB_GAP` = 1 px wider than the lower middle of the line's single
spaces), leaves it out of the line's space, and gives Artistic text clicked on the line a left tab
stop at the page's x of the word after it (`utbLineTabStops`; the Text panel's **Space as this
line** sets the stops again) — from its own data again, the line box's `baseCharPositions`. Over
877 read lines of the 22 documents below, every single space but those three labels' lies within
0.52 px of its line's lower middle; theirs are 1.35–2.5 px wider. The runs are bullets and numbers
(the memo, the FBI summary), the affidavit's labels, and two spaces after a full stop (the FBI
summary, the e-mails, the seams page) — a stop there leaves typed spaces as they were.

The same study (the tool's own click; 22 documents now, the tab pages and four more synthetic
pages added), each line typed as a person retypes it: **a tab after a list label** (the line's first
word: a number, one or two letters or a roman numeral with "." or ")", a bracketed one, a
bullet) or for a run of three spaces or more, the reader's spaces elsewhere; before = the code
before this change, the reader's text typed:

| document | lines | typed with a tab | ≤ ½ px | in-word ≤ ¼ px | MuPDF pixels exact |
|---|---:|---:|---:|---:|---:|
| affidavit (Word, Times, justified) | 35 | 12 | 23 → **35** | 25 → 25 | 3 → 3 |
| synthetic: Arial memo | 20 | 6 | 14 → **20** | 20 → 20 | 11 → **14** |
| FBI summary p2 (Calibri) | 51 | 12 | 37 → **48** | 48 → 48 | 32 → 32 |
| FBI summary p2, second release | 46 | 12 | 32 → **43** | 43 → 43 | 6 → 6 |
| 18 other documents (no list line) | 725 | 0 | 518 → 518 | 510 → 510 | 598 → 598 |
| **all** | 877 | 42 | 624 → **664** | 646 → 646 (≤ ¼ px + 1/64: 653 → 653) | 650 → **653** |

- **List lines land**: every glyph of the 42 within ⅓ px of the reader's pen — the affidavit's 12
  from 0.53–3.83 px off to 0.17–0.33 px, the memo's 6 from 0.72–1.89 to 0.13–0.16, the FBI
  summary's 12 from 0.19–2.31 to 0.13–0.23 (second release 0.22–2.19 to 0.13–0.16). In-word, one
  affidavit line moves from 0.250 to 0.266 px and another back — Chrome's 1/64-px layout unit at
  the threshold.
- **Nothing else moves**: only the three one-space labels change their line's space (the tab's gap
  no longer counted); no line of any document is further off, in a word or in pixels.
- **Pixels**: the memo's three bullet lines become exact; the other list lines come much closer
  but not exact — mismatched pixels 1300–2927 → 204–1408 on the affidavit, 527–3279 → 23–261 on the
  FBI summary (529–3228 → 59–521 on its second release). Their text after the tab starts on the
  reader's pen; laying it from the start the page's lattice lets it instead (`OCRRender.lineStart`
  over the words after the tab, as the study does for every line's start) makes no line exact —
  that start is the pen itself on all but five affidavit lines (−0.125 to +0.04 px). On the FBI
  pages most of what is left on some lines is the bullet: the reader reads it from a glyph set of
  its own (`bullet16`, `bulleto16`), and the story's Calibri bullet misses 20–30 of its 32 ink px
  (the sub-bullet *o* 48 of 49); the text after the tab is exact on 2 of the 12.
- **Typed with spaces instead**, 39 of the 42 lines given a stop land as before (the stop is not
  used); the affidavit's three one-space labels 0.25–0.42 px further off (1.30–2.20 → 1.66–2.63
  px). Typing a tab where the page has two spaces after a full stop lands the next word within
  ½ px but not on the producer's pixels (the pixel view lays the text after a tab from the browser's
  stop, not from the float pen two spaces carry): six FBI lines exact with spaces are not with a
  tab.
- **recto-eval**, full tier against `full-2026-10-18-12-07-37` (run `full-2026-10-18-12-50-50`):
  0 better, 0 worse — its typed write-back types a one-line box, not a story.

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

Two switches (`settings.html`, wired in `pixel-view.js`). Their section is marked
`data-text-panel`: text_tool's Text panel moves it into its **Display** section, beside Space
widths — with no Text panel it stays in the Settings panel.

| Switch | id | What it does |
|---|---|---|
| Draw text as MuPDF pixels | `ocr-pixel-view` | Every text box is drawn from the reader's own glyph bitmaps on mupdf's ¼-px pen lattice and whole-pixel baseline, instead of SVG text — the raster mupdf would have produced. Tinted like the SVG text (alpha = ink darkness); pixelated when zoomed. |
| Diff: pixels that differ from the page | `ocr-pixel-diff` | Matching ink pixels go faint, pixels whose predicted byte differs from the page turn solid red, and page ink inside the line's band that no drawn glyph explains turns solid orange (the reader's residual — a quote mark it never transcribed). The status line reports `OCR lines n/m exact` (reader-certified lines, which must all be exact — within the reader's own ±tol when a line was read on a tolerant rung) and `other boxes n/m exact` (embedded / hand-added text, compared but not expected to match) for the page and, on selection, the box's ink-pixel and differing-pixel counts. |

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
  pixels, otherwise — scanLine's rule). Under the linear compositor (the
  eDiscovery producer's sets) a composite pixel the reader accepts one
  darker than the law — the producer's junction arithmetic is 1-ambiguous
  there — is accepted here too (`render.js diffLine`, since 2026-10-11:
  the warrant's 17 lines where an `f` overlaps its neighbour were certified
  at tolerance 0 and drawn 1–4 px off). "Exact" in the status line means
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
  law. The words of that re-layout are the transcript's (`render.js
  lineLayout`): a union line whose reader took one word's glyphs from two
  sets of the same face and size (two builds of Calibri) is still laid as
  one run per word, each glyph under its own set's law — broken at the set
  change, as before 2026-10-10, the word's fragments got starts of their own
  and its break a phantom space, and on a Calibri page 29 of 33 such lines
  moved when re-laid. A word the law cannot write — no start lays all of its
  pens: a Word page places one word differently by where it starts (tol0
  LAWS §10) — is laid as the page has it, each glyph nudged off the law to
  its own pen (`lineLayout`'s `nudges`, `layoutLine`'s `opts.nudges`); after
  an edit the glyphs before it and after it still line up with the reader's
  and keep theirs (`pvNudges`), so an edit leaves the words it did not touch
  as the page has them. Before 2026-10-11 such a word came back under the
  law, a lattice step off: re-laying moved the pens of 3,600 of the full
  tier's 30,700 certified segments (12 % of a Times e-mail's); now 15 (words
  with a ligature glyph, which the box's text spells as two letters).
  Every space without a measured gap of its own — all of
  a typed box's, a new break in an edited line — is **the face's own space
  under the producer's law** (`pvSpaceAdv`: its advance quantized and scaled
  as the law lays every glyph; 600/1000 em × 13 px = 7.800 px on the startup
  document's Courier body). Until 2026-10-10 it was the reader's per-set
  calibration (`box.ocr.spaceAdv`), an estimate made for counting spaces that
  runs low (7.699 px there; 3.512 px on an e-mail whose gaps are all 4.000),
  so typed text slipped a lattice step every few words. The calibration is
  still the answer where the face is not known (a page-cut set) or still
  loading. The matcher's seams space a name with the refiner's row space and
  fall back to this law space (*The hypothesis seam*, above).
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
  the page (and where nothing is known text_tool sets it unkerned, as this
  law assumes); the Pair kerning checkbox then wins in both directions (the status
  line says `your Kerning setting, not the page's`), with the face's kern
  pairs from `FontCatalog.metrics` quantized and scaled under the page's law. A set
  the page never certified (a bold italic nobody wrote) borrows the
  *structure* of its family's law on that page — quantization, scale,
  kerned-or-not — never its tables.
- **The terms a typed box is judged by.** A read line is judged by its own
  terms (`box.ocr`: y-phase, its rung's tolerance, its palette map); text typed
  over the page — a typed box, a story's piece — by its page's (`pvTerms`: the
  pass every line of the page was read with). Before 2026-10-18 typed text was
  judged at tolerance 0 without the palette, so on a colour page read through
  its palette the Diff showed red where the pens and glyphs were the page's
  (Artistic text over the FBI summary's page 2: 532 and 555 px on two lines
  whose typed boxes, judged by the line's terms, differ in none).
- **Honest limits.** A character the face lacks, a style the family has no
  file for (nothing is synthesized), a set that is not loaded, or a
  page raster that is not 1:1 with the viewBox → SVG fallback, never an
  approximation. The seam is `window.utbPixelRender` in `svg-renderer.js`
  (see [Unified Text Box](../../architecture/unified-text-box.md));
  `window.utbPixelRenderOn()` (`'MuPDF pixels'` while on, else null) and the
  `pixels:changed` hook tell text_tool's Text panel whether it draws, so the
  panel locks what a piece cannot carry (opacity, background, outline, scale,
  shear, synthetic super/subscript, small caps, double lines, OpenType
  features) with the reason.
- **Proofs.** tol0: `npm run certify:render` (render.js vs real mupdf at every
  1/64 pen phase, both TTF and CFF pipelines, forced overlaps — 0 diffs),
  `npm test` (synthetic round trip render → readPage → clean). Recto:
  `node --test "tests/**/*.test.mjs"` — `tests/plugins/ocr_tool/page.test.mjs`
  checks the controls on the generated page and that the engine loads before
  the adapters, `line-boxes.test.mjs` the boxes a read makes (replayed from the
  startup document's shipped read); `tests/plugins/ocr_tool/smoke.mjs` adds this plugin's steps
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

- `OCRLineBoxes.pageBoxes` sets each segment's family/bold/italic from the set
  that drew most of its glyphs (per-glyph `src` on union lines), through
  `OCRLineBoxes.fontFromSetName`.
- When a read finishes (live or replayed from the cache) the adapter emits
  `typography:detected { fontFamily, sizePt, source: 'ocr' }` with the
  dominant face and size of the certified lines (weighted by glyph count);
  `text_tool`'s `fonts.js` selects it in the font menu and size input. Not
  after a weak read (`OCRLineBoxes.readIsWeak`: fewer than 3 certified lines, or fewer
  than half of the lines read): the claim outranks the text layer's, and on
  a page the reader could not read the two lines it certified at ±10 named
  Cambria for a Times New Roman 11 pt memo.
- The pixel view picks the glyph set for a hand-typed box by family and size
  through the same table (`plain` sets only — stock face, stock law).
