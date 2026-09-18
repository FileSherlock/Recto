# Plan — verifying candidate names against the page pixels

*Status: **built** 2026-09-05 — Phase 0 (Recto: the pen-exact width and the
matcher's verdict display) and Phases 1–3 (tol0: `engine/hypothesis.js`, its
tests and bench; Recto: the seam `ocr_tool/hypothesis-view.js`; the corpus
report `tools/verify-redactions.mjs`). Engine work lives in tol0 (`engine/`,
certified there, synced verbatim); Recto only consumes verdicts. What the build
taught is at the end, under *What changed while building it*.*

## The premise: verify a list, never read a sliver

A half-exposed glyph is not a letter. The left two columns of `A` are the left
two columns of `Æ`; the visible top of `e` is the top of `é` minus an accent
the bar may or may not have covered. The reader already knows this: LAWS §8
accepts a glyph mostly under a box **only** when it is the *only* character in
the whole pool that fits, and on the clip benchmark refusal is the common
verdict (`open 1`: 15 right, 0 wrong, **360 refused** of 375 on Courier).
Recognising letters from slivers is a search over 4,516 glyph records with
almost no ink to constrain it. It cannot be made to work and this plan does
not try.

What *can* work is the same law run the other way round, over a short list:

> Given the names that already fit the bar by width, draw each one where the
> refiner says the hidden name sits — the line's own glyph set, baseline and
> ¼-px pens — composite the bar over it exactly as the redactor did (LAWS §8,
> bar last), and compare every page byte outside the bar's black body. A name
> that predicts ink where the page is white, or white where the page has ink,
> is **contradicted**. A name that reproduces every byte is **consistent**.
> Two consistent names are a **tie**, and a tie is the answer (METHOD rule 6).

The sliver never has to be identified. `A…` and `Æ…` are both drawn in full;
if the bar hid the difference, both stay consistent and the tie is reported.
The candidate list is what makes the comparison meaningful — which is why the
list must be short first (below), and why this is a *verification* stage, not
a reader.

## What the test file says (measured 2026-09-05)

`_temp_test_files/efta00018586.pdf`, the producer's own 816×1056 page image
(LAWS §7), the two `including ███ and GHISLAINE MAXWELL` bars:

| | bar 2 (item 2) | bar 1 (item 3) |
|---|---|---|
| black body | rows 681–707, cols 235–355 | rows 733–754, cols 321–442 |
| line's ink rows (`and`) | 670–694 | 726–747 (baseline 747) |
| body vs the name's caps | covers them fully | covers them fully, and 7 rows below the baseline |
| top edge row | byte 196 (light) — but the dips in it are the **previous line's descenders**, not the name | rows 731–732: bytes 139 / 74 with dips — previous line's descenders again |
| left edge | **`S` leaks**: cols 233–234 open, the rest under the edge; the reader reads it as `S` | col 320 is an edge of byte 56 (78 % covered); the name's first ink column sits under it |
| right edge | edge byte 52; `and` starts at 357 | edge byte 56; `and` starts at 444 |

So on this document pixels add **nothing beyond what already shipped**: bar 2's
leaked `S` is the remnant the refiner already turns into a *starts with S*
filter (unique → SARAH KELLEN), and bar 1 leaks no ink at all — a full-height
body with dark edges, which §8 rightly refuses as evidence ("dark edges carry
no evidence", the compositor's rounding is not the glyph's). Bar 1's five
names tied to the font unit (SARAH KELLEN, JUSTIN NELSON, TONY PODESTA, GÉRALD
MARIE, NOOR SIDDIQUI) would all come back **no evidence**, and the tie stands
until something outside the pixels breaks it — in practice the typed filter.

That is the honest scope: this stage breaks ties **where the redactor leaked
ink** — a partial first/last glyph beside the bar, glyph tops or descenders
above/below a bar shorter than the line, or a *light* (≥ 160) edge line
carrying the hidden glyphs' composite. Across the corpus that is common (the
clip benchmark and `report`'s clipped `S` are real cases); on a bar like item
3 it is nothing, and the verdict must say so rather than guess.

## What you will get

In **All Matches**, every chip gets a verdict:

- `✓` **consistent** — drawn at the name's position, every page byte outside
  the body matches (to the line's own tolerance), and no page ink in the
  name's window is left unexplained.
- `✗` **contradicted** — with the pixel counts (`3 differ · 0 unexplained`).
- `–` **no evidence** — the bar left no ink to compare (bar 1 above).

Chips sort consistent first; the bar's label is the first consistent name;
the counter reads `2 of 6 consistent`. Contradicted names stay visible (greyed)
so a wrong elimination can be seen and overridden by clicking. Nothing is
hidden, nothing is decided from a sliver.

## Why it is cheap now

| Piece | Where it already is | What it gives us |
|---|---|---|
| Forward renderer | tol0 `engine/render.js`: `layoutLine`, `renderLine`, `diffLine`, `objectMask`, `residualInk` | Draw a candidate string on the ¼-px lattice with the line's set and composite through the certified blend law |
| The bar model | LAWS §8 + `detectObjects`' EDGE MODEL in `engine/ocr-engine.js` | Body = 0, edge cell = `(gb·k)>>8`, open page = `gb`, bar drawn **last**; linear-law variant verified byte for byte on `report`'s clipped `S` |
| Which set, baseline, y-phase, tolerance, space | Every OCR segment's `box.ocr` (`font`, `baseline`, `phy`, `tol`, `spaceAdv`) and its `baseCharPositions` (the reader's pens) | The hidden name shares its line's set, baseline and phase — the prediction is byte-exact by construction, not fitted |
| Where the name sits | `redaction_refiner`: `box.refineInfo` (neighbour words, their spans, the name's x-range) | `pen0` = left neighbour's last pen + advance + the line's space |
| Page bytes, whitening, palette, box mask | `web/plugins/ocr_tool/pixel-view.js` (`pvPageInfo`: page, `det`, `quant`) | The same bytes the reader certified against, already in memory |
| The short list and the chips | `redaction_matching`: `getBoxMatches`, `setBoxMatch`, the chip renderer, the `redaction:refined` hook | Somewhere to put a verdict, and a signal to invalidate it |
| Certification harness | tol0 `tools/clip-bench.mjs`, `ftclone/certify-render.mjs` | Paints boxes over known glyphs bar-last through the law and counts right / wrong / refused per leak — the exact shape of proof this needs |

The one thing that does not exist is the hypothesis test itself: *compose a
string with a bar over it and judge it against the page*. It goes in tol0
(`engine/hypothesis.js`) so it can be certified before Recto runs it.

## Design

### 0. Narrow the list first (Recto, no pixels)

Comparing pixels for 62 names is waste; comparing for 6 is a verdict. Three
things already shrink the list, one is new:

- **Exact pens instead of a pixel tolerance** *(new)*. The reader's pens on
  the line are exact (§1, §6): `pen0 = penEnd(left word) + space_line`, and a
  candidate must satisfy `|pen0 + advanceW(candidate) + space_line − pen(right
  word)| ≤ ¼ px` (each pen snaps to the lattice). `space_line` is **this
  line's own** inter-word space — median of its measured gaps minus advances,
  which is what a justified line stretches — falling back to the page's
  `spaceAdv` when the line has fewer than two other gaps, and to *rank only*
  (METHOD rule 8) when a justified line has none. On bar 1 that is `128.5 =
  name + 2 × 4.0` → 120.5 ± 0.25 px → **5 names instead of 62** (the sixth,
  NICKI HASKELL, is 0.8 px off). `advanceW` comes from `layoutLine` with the
  line's set, so it is the same arithmetic the renderer will use.
- **Remnants** (`redaction:refined` → starts-with / ends-with) — shipped.
- **The typed filter** — shipped.
- **Not** document-level width comparison — excluded by decision, see *Later*.

### 1. `engine/hypothesis.js` (tol0, DOM-free, synced verbatim)

One pure function beside `render.js`:

```
testHypothesis(page, det, set, line, box, text, opts)
  page  {w, h, gray}        whitened page (LAWS §5), palette-quantized producers pass opts.quant
  det   detectObjects(page) the box objects and edge model
  set   the line's glyph set (union lines: per-glyph src, as pixel-view does)
  line  {baseline, phy, tol, spaceLine, penLeft, penRight}   from the row's OCR segments
  box   the detected box object overlapping the bar (x0,x1,y0,y1 + edge bytes)
  text  the candidate
→ { verdict: 'consistent' | 'contradicted' | 'no-evidence',
    pens, advanceW, penFit,            // the §0 equation, in px
    open:   {ink, match, differ},      // pixels on the open page
    edge:   {ink, match, differ},      // light-edge composites (byte ≥ 160)
    dark:   {ink},                     // dark-edge / body pixels — counted, never judged
    unexplained,                       // page ink in the window no glyph explains
    mism }                             // for a diff overlay
```

Steps, each one an existing law:

1. **Layout.** `layoutLine(set, text, pen0, {spaceAdv: spaceLine})`; missing
   glyphs → `no-evidence` with `missing` (never approximated).
2. **Render.** `renderLine(set, glyphs, baseline, {phy})` → predicted bytes
   over white, `gray`.
3. **Composite the bar, bar last** (§8): for every pixel of the window —
   body → 0; edge cell with complement `k` → `(gray·k)>>8`; open → `gray`.
   Linear sets use the linear product with the light-contributor shift, the
   same code path `renderLine` already has for glyph-over-glyph. `k` per edge
   cell comes from the edge byte itself: `(255·k)>>8 = edge`.
4. **Compare** on the window `[pen0 − 2, penEnd + 2] × the line's band`, every
   pixel, not only ink: predicted vs page, `|Δ| ≤ tol` (2·tol on composite
   pixels — scanLine's rule), through `quant` when the page was palettized.
   Classify each pixel by the bar model: open / light edge / dark-or-body.
5. **Residual** the other way (the second half of the certificate, exactly as
   `residualInk`): page ink in the window that neither the candidate nor the
   bar explains.
6. **Verdict.** `contradicted` if any open pixel differs or any ink is
   unexplained; else `consistent` if `open.ink + edge.ink ≥ minInk`
   (default 12 — the "little ink fits many glyphs" floor from §8, applied to
   the *whole string*, not one glyph); else `no-evidence`. Light-edge
   composites judge like open pixels — they are the prior ink the reader
   already composites against; a light-edge-only verdict is reported with
   `edgeOnly: true` so the UI can show it fainter. Dark edges never judge
   (§8, and *shadow* stays opt-in as in the reader).

Nothing here is a threshold to tune: tolerance is the line's own, the floor is
the reader's, and the classification is the measured edge model.

### 2. Certification (tol0)

`tools/hypothesis-bench.mjs`, from `clip-bench.mjs`: on a certified page, pick
a word, paint a black box over it bar-last through the law with edges 196 ·
165 · 119 · 74 · 52 and leaks `open 0 / 1 / 2` columns each side, and at each
setting run `testHypothesis` over a list = **the truth + every string in the
page's vocabulary whose `advanceW` ties it within ¼ px** (the same equation as
§0; on a Times page that list is rarely empty). Count, per setting:

| truth consistent | truth contradicted | decoys contradicted | ties |
|---|---|---|---|
| must be 100 % | **must be 0** — the gate | the number this feature is worth | reported, never resolved |

Two named cases must be in `test/hypothesis.test.js`: a synthetic page with
`A…` and `Æ…` under a bar leaving two open columns (both consistent, tie
reported — the premise of this plan, asserted), and the §8 page (`A` under a
187 edge) with the truth plus one decoy of equal advance. Then the corpus
gate: `npm run gate` must not change by a byte (the engine's read path is
untouched — this file is called only by Recto).

### 3. Sync and the Recto adapter

- tol0 `tools/sync-recto.mjs`: add `hypothesis.js` to `ENGINE_FILES`.
- `web/plugins/ocr_tool/pixel-view.js` (or a sibling `hypothesis-view.js`,
  listed after it in `web/plugins/ocr_tool/plugin.json`): define the guarded seam
  `window.ocrTestHypothesis(box, text) → verdict | null`. It resolves, from
  `box.refineInfo`: the neighbour words' spans → their `ocr` records (set via
  `pvSetsForBox`, baseline, `phy`, `tol`, pens), `spaceLine` from the row's
  pens, `pen0`/`penRight`; the page via `pvPageInfo(page)` (already whitened,
  with `det` and `quant`); the box object as the `det.objects` entry of type
  `box` overlapping the bar. Returns `null` when the row has no OCR segments
  (embedded-only rows carry no set), when no set is shipped for the face, or
  when the bar has no detected object — every `null` names its reason in the
  status line, like the pixel view's fallbacks.
- `web/plugins/redaction_matching/api.js`: after
  `calculateWidthsForRedaction`, for each name in `getBoxMatches(box)` call the
  seam when it exists (`typeof ocrTestHypothesis === 'function'`), store
  `box.verdicts[name]`, and render chips `✓ / ✗ / –` with the counts in the
  title; `shownMatch` prefers consistent names; the `redaction:refined` hook
  and any width recompute clear `box.verdicts`. The §0 exact-pen filter goes in
  `getBoxMatches` when the row has pens, else the tolerance as today.

### 4. Corpus proof (Recto + tol0)

`tools/verify-redactions.mjs` in tol0 (sibling of `verify-recto-pixels.mjs`):
over `_temp_test_files`, for every detected bar with a candidate list, log the
list size after width, after §0, and the verdict counts. Assert on
`efta00018586`: bar 2 → SARAH KELLEN consistent, the other five contradicted
by the open `S` columns; bar 1 → six `no-evidence`, tie kept. The report is
the feature's value in numbers: how many bars across the corpus end unique,
tied, or without evidence.

## Phases and how each one is proven

### Phase 0 — exact pens (Recto only, no engine work) — **built**

What shipped (matcher v=15, refiner v=2):

- The refiner publishes `box.refineInfo.exact` (both edges derived from OCR
  pens) with the `x`/`w` it produced; a bar moved since is not exact.
- `getBoxMatchInfo(box)` uses `±0.3 px` (two ⅛-px lattice snaps) for a
  pen-exact bar instead of the Tolerance field (a tighter field still wins),
  and falls back to the field — **flagged `loose`** in the row — when nothing
  fits the exact width, so near misses stay visible as near misses. The
  matches row shows the tolerance in force (`±0.30 px · pens`).
- Verdict consumption: `scoreMatches(box)` calls
  `window.ocrTestHypothesis(box, name)` when it exists, stores
  `box.verdicts[name]`, and the chips show `✓ ✗ –`, sort consistent first
  and count `n of m consistent`. Without a provider it is inert.
- The plan's §0 equation is realised through the refiner's geometry rather
  than re-derived: with OCR pens on both sides, `box.w = penRight − penLeftEnd
  − 2·space_line`, so "candidate advance = box.w ± ¼ px" *is* the equation.
  `space_line` is the refiner's row space (the row's measured pens when the
  line is justified, the natural advance otherwise).

Proof on the reference page (`debug_out/smoke.py` — a local, uncommitted
browser script that drives the running app — 2026-09-05): bar 1 lists
**5 names** (the font-unit tie) at `±0.30 px · pens` instead of 62 at ±3 px;
bar 2 the same 5, narrowed to SARAH KELLEN by its remnant `S`.

```bash
node --test "tests/**/*.test.mjs"    # tests/plugins/redaction_matching/, tests/plugins/redaction_refiner/
python debug_out/smoke.py            # bar 1: 5 names · ±0.30 px · pens
```

### Phase 1 — `hypothesis.js` + certification (tol0)

Files: `engine/hypothesis.js`, `test/hypothesis.test.js`,
`tools/hypothesis-bench.mjs`, `package.json` (`bench:hypothesis`).

```bash
cd ../tol0
npm test                    # A/Æ tie asserted; §8 page: truth consistent, decoy contradicted
npm run bench:hypothesis    # truth contradicted: 0 at every edge × leak; print the decoy table
npm run gate                # unchanged by a byte
```

### Phase 2 — sync, adapter, chips (Recto)

```bash
cd ../tol0 && npm run sync:recto
cd ../Recto
node --test "tests/**/*.test.mjs"
python debug_out/smoke.py   # bar 2: "1 of 6 consistent" → SARAH KELLEN; bar 1: "0 of 6 · no evidence"
```

### Phase 3 — corpus report and docs

```bash
cd ../tol0 && node tools/verify-redactions.mjs --max-pages 5
```

Then: this plan gets a *What changed while building it* section, the refiner
and ocr-tool READMEs get the seam and the chip verdicts, tol0's LAWS gets a
§8 paragraph on string hypotheses if the bench teaches anything new.

## Hand-over checklist for the tol0 session

Everything Recto-side that can exist without the engine exists. What the tol0
session builds, in order, and the contract it plugs into:

1. **`engine/hypothesis.js`** — `testHypothesis(page, det, set, line, box,
   text, opts)` as specified in *Design §1*, DOM-free, beside `render.js`.
2. **`test/hypothesis.test.js` + `tools/hypothesis-bench.mjs`** — *Design §2*;
   the gate is *truth contradicted = 0*; the `A…`/`Æ…` tie is asserted.
3. **`tools/sync-recto.mjs`** — add `hypothesis.js` to `ENGINE_FILES`, sync.
4. **The seam in Recto's `ocr_tool`** (adapter file listed after
   `pixel-view.js` in `web/plugins/ocr_tool/plugin.json`): define
   `window.ocrTestHypothesis(box, name) → Promise<verdict | null>` where
   `verdict = { verdict: 'consistent' | 'contradicted' | 'no-evidence', open:
   {ink, match, differ}, edge: {ink, match, differ}, unexplained, pens,
   advanceW, penFit, mism? }`. Inputs already on the box: `box.refineInfo`
   (`left.span` / `right.span` are the neighbour OCR segments with `ocr.font`,
   `ocr.baseline`, `ocr.phy`, `ocr.tol`, `ocr.spaceAdv` and `baseCharPositions`
   = the reader's pens; `left.inkEdge` / `right.inkEdge` / `space` give
   `pen0` and `penRight`), `box.uppercase` (draw the name uppercased when
   set), `box.page`. Page bytes, `det`, `quant` and the sets come from
   `pixel-view.js` (`pvPageInfo`, `pvSetsForBox`, `pvEnsureSets`). Return
   `null` — with a status-line reason — when the row has no OCR segments, no
   set is shipped for the face, or no detected box object overlaps the bar.
   The matcher already calls it after every width recompute and renders the
   result; nothing in `redaction_matching` needs to change.
5. **`tools/verify-redactions.mjs`** — *Design §4*; assert the reference page
   (bar 2 unique, bar 1 six-way `no-evidence`).

*Widths, settled 2026-09-05:* the names that "fell outside the matcher's
width windows" on the memo (Lesley Groff, Richard Barnett at 0.51 px short)
were HarfBuzz forming Calibri's `ff` / `tt` ligatures, not another build of
the face — the archive's Calibri 5.75 and 5.87 carry the installed 6.11's
advances. `Shaping.widths` now takes `ligatures: false` (the matcher and the
refiner send it), and `ocr_tool` offers `window.ocrMeasureWidths`, the reader's set
laid out plain with the refiner's space, which the matcher prefers; the two
agree to the font unit. Lex Wexner and Adriana Mucinska were never generated
(second aliases) — alias expansion is on by default now.

Two inputs the refiner now supplies that the seam's own estimate does not
know (EFTA00038617, Calibri, 2026-09-05): a bar that opens a sentence on a
page that double-spaces its sentences starts **two** spaces after the period
(`refineInfo.left.spaces === 2`, and `left.edge` already includes it — the
engine's `line.pen0` input is the place to hand it over; `penLeft +
spaceLine` puts `Bledsoe` a space too far left after `plane.`); and a
neighbour the bar partly covers is `partial`, its pen a sliver reading. On
that page the seam contradicts `Gregory Bledsoe` on one unexplained pixel
with a page-metric advance of 107.02 px against 107.44 px from the font, and
returns `consistent` for all 73 names in range on the clean `Richard
Barnett` bar, where `no-evidence` would be honest.

## Limits, stated up front

- **No shadow, no verdict.** A body whose edge columns carry no shadow of the
  name yields `no-evidence` for every candidate, and the UI shows that as a
  tie. (A dark edge with a shadow in it is evidence — see *What changed*.)
- **The list must contain the truth.** `consistent` means *not contradicted by
  the page*, never *proven*. A name absent from the pool cannot be found.
- **Producer rasters only.** The whole chain is byte-exact because these pages
  are the producer's own MuPDF rasters (LAWS §7). A true scan gets no set, no
  certificate, and `null` from the seam.
- **Faces without a shipped set** fall back to `null` and say so, as the pixel
  view does.
- **Cost is fine.** `renderLine` is milliseconds; six names per bar is nothing;
  sixty-two would still be under a second — but only after §0, so the verdict
  list stays readable.

## Later

- **Document-level width comparison — excluded** (decision 2026-09-05). Carrying
  one bar's evidence to another bar of the same width in the same document is a
  prior, not a measurement: two equal-width bars are two people as easily as
  one. It is not to be built; every bar is judged on its own line.
- **Bar-padding prior.** Redactors pad consistently (here: the name plus its
  trailing space, edges 52–56). Learned per document from bars with a unique
  answer, it tightens the width equation for the rest.
- **Shadow reads, opt-in.** Under `--shadow`, dark-edge composites judge too
  (§8's benchmark: never wrong synthetically, wrong on real boxes). With a
  six-name list the odds change; measure before enabling.

## What changed while building it (2026-09-05)

The design held; the details that measurement forced are these, in the order
they were found (each one first showed up as the *truth* being contradicted on
`tools/hypothesis-bench.mjs`, the one outcome the plan forbids):

- **The producer's metrics are not the set's.** A name's pens are the
  accumulated advances only for the font build the page was set in, and never
  across a kern pair: v3's `OPERATED` has its `T` 1.75 px left of the plain
  advance (the `AT` pair), and a 2008 Times draws the current outlines at other
  advances. `render.js pageMetrics` measures both from the page's own pens —
  the median of next.pen − pen per glyph and per pair over the certified lines
  (a pair kerns at ≥ ⅜ px) — and `layoutLine` takes them. The seam builds the
  table from the page's OCR boxes; the bench from the read. Measured advances
  also tightened the width tie itself: 68 → 59 decoys on v3 p2.
- **Pens are searched.** The first glyph within 1¼ px of the space estimate on
  the ¼-px lattice, the last glyph within 1¼ px of the accumulated advance
  (the two glyphs that carry evidence under a full-height bar); a pen the set
  cannot draw (a phase it lacks) never outranks a judged one.
- **Only edge columns judge.** A bar's top and bottom rows carry the
  neighbouring lines' descenders and ascenders and the corners where two bars
  meet; over the box's own rows the column's bar byte is its maximum
  corroborated by a second row — the reader's mode is fooled by a uniform
  stem shadow, and the second unshadowed row may hold the bar over a glyph's
  254 (a `d` stem left 196 once, 194 once) — and black under an edge is
  destroyed: a black glyph pixel and another bar's body composite to the
  same 0.
- **Unvoted flush lines are destroyed, not open.** When the hidden glyphs
  shadow most of an edge column (a bar no taller than its text) the reader's
  constancy vote fails and the column stays unpadded; the tester treats the
  columns and rows flush against a box body as the bar's edge with an alpha
  nobody measured. The reader's own small-box detector learnt the matching
  lesson: a row whose extent differs by up to 3 px continues the stack, and the
  box takes the mode of its rows' extents (a 34-px bar over `VISA`, leaked by
  two columns, had no box at all before).
- **Unexplained ink is judged in the reader's band rows only**, with the
  neighbour words *and* the neighbouring lines' glyphs drawn as explained — at
  a 12-px pitch the line above's descenders share rows with this line's
  ascenders.

What the bench says now (tol0 `npm run bench:hypothesis`, 15 settings each,
dark edges judged): Courier page 22 words — truth consistent 235, contradicted
**0**, no-evidence 95; decoys 1,942 of 2,055 contradicted, 20 ties (`-0800` /
`-0000`, `01:13:54` / `01:12:12`, `Re:` / `To:` two columns in — the
difference is under the body, which is the premise measured). Times page 42
words — truth consistent 469, contradicted **0**, no-evidence 161; decoys 890
of 915 contradicted, 13 ties (`Departs:` / `Locator:` under a dark edge,
`9:10` / `9:47`). Before the dark edges judged the truth was consistent 113
and 168 times, and `Record` was contradicted once on the line whose only
space estimate is the page's fallback — a bar-byte estimate, cured by the
corroboration above. On the reference document the item-2 bar tested with its
five font-unit ties by pixels alone keeps SARAH KELLEN (open 9/9, edge 8/8,
unexplained 0) and contradicts the other four; the item-3 bar keeps it too
(below). `tools/verify-redactions.mjs` asserts both.

- **Dark edges judge, with a byte of slack.** The plan expected bar 1 (item
  3) to yield *no evidence*: a full-height body with dark edges. The user's
  rule — find the black body's edge column, strip its own byte, keep the
  darker pixels — turns that column into evidence: its nine darker pixels
  (68, 44, 44, 70, 65, 45, 45, 45, 69 under a 74 edge) are the hidden name's
  first column. The reader still refuses a dark edge for a single glyph (the
  compositor slips a byte), but over a list one byte of slack is harmless:
  SARAH KELLEN hits 9 of 9, the three drawable decoys hit 1–2 and leave 7–9
  unexplained, GÉRALD MARIE is contradicted at its own pen. With the evidence
  floor lowered (the list's contradictions guard; 12 was the reader's
  single-glyph floor, 6 the first list floor, 2 since the memos — see the
  clue pixels below) both bars of the reference document now resolve to
  SARAH KELLEN, and `verify-redactions.mjs` asserts both.

**What two memos with known text taught (2026-09-05, later).** The user
supplied `EFTA00038617` and `EFTA01649149` (Calibri 1.02, read at tol 2)
with their un-redacted sources; `tools/hypothesis-truth.mjs` (tol0) runs the
tester on every real bar against its truth and Recto's name list, and
`verify-redactions.mjs` asserts both memos. Five rules came out of it, all in
`engine/hypothesis.js` and LAWS §8:

- an edge too dark to hold two levels apart (edge ≤ 4·(tol + slack)) is
  body — a 1..3 column beside a stem matched all 64 names on the Barnett bar;
- a match is evidence only where the page shows a shadow: Sarah Kellen's
  "8 of 8" edge pixels were one real one;
- the gap to a neighbour is a space unless the neighbour touches (the seam
  passes `gapLeft`/`gapRight`: 0 before a comma) — every memo bar sits before
  a comma, and the assumed space put the truth 3 px off;
- a name that overruns its right neighbour by over 1¼ px is contradicted
  (reason `width`); one that ends early is not, and its `penFit` is reported
  for the matcher — on the reference bar the matcher's near-miss S-names now
  tie by pixels, and only the fit separates them;
- a tolerance page keeps the set's metrics (the measured pens gave "Lesley
  Groff" 76.08 px on one memo page and 77.91 on the other; the set 77.24, the
  bars 77).

The finding itself: these bars are the names' advance boxes, the bearings
sit inside the body, and the edge columns carry the bar's own byte — except
where the last glyph overhangs its advance box or the first one leans out.
The user named them: the last r of "Lex Wexner" (two pixels under the 151
right edge, 71 and 39) and the last f of "Lesley Groff" (two under the 211
edge, 172 and 192); the tester also finds the A of "Adriana Mucinska". Strip
the bar's own byte and what remains is the compositor's rounding or a clue
pixel. The evidence floor of 6 had discarded them; at 2 the three names are
consistent, every decoy that survives with them shares the letter (r-names,
"Andre Assaf", A-names), and within ½ px of width Lex Wexner and Lesley
Groff stand alone. Elsewhere no name gets evidence; the truth is never
contradicted (18 bars); where the list holds it, it is the one name the
page did not contradict (Sarah Kellen on the first memo, 9 of 9 others
contradicted) — the verifier now counts such a bar as a *survivor*. Five truths are missing from the matcher's lists
on their bars (Adriana Mucinska, Lex Wexner, Lesley Groff, Richard Barnett,
Gregory Bledsoe) although `names.json` holds every one of them: the
matcher's width window, not the pixels — the page is set in Calibri 1.02,
whose advances are not the modern Calibri's and which does not kern (the
user's rule for the old Windows fonts; tol0's calibri102 set lays "Lesley
Groff" out at 77.24 px against a 77-px bar, "Richard Barnett" 101.49 against
101.8, "Gregory Bledsoe" 106.95 against 107.5).

Across Recto's first 22 test documents (`node tools/verify-redactions.mjs`,
2026-09-05, dark edges judged, 5 pages read per document): 361 bars, 183 with
a candidate list — 4 unique, 1 tied, 88 no-evidence, 76 with every name
contradicted, 14 unscored. Before the dark edges judged the same documents
gave 0 unique, 106 no-evidence and 59 all-contradicted: the dark edge columns
turned no-evidence bars into contradictions (the list not containing the
truth — those bars hide e-mail addresses and IDs) and, on EFTA00382173, into
four unique names (one of them 1 consistent against 60 contradicted) and one
tie. The user tested and approved the result; the next improvements are on
Recto's side, first the redaction boxes drawn twice (the report scores the
same bar twice on that page).

Not built, by decision: document-level width comparison (the tester now
contradicts an overrun; a name that ends early is the matcher's call, on
`penFit`). Not built yet: the bar-padding prior.

**The bar's own rows (2026-09-05, last).** The tester now judges a bar's top
and bottom rows where they are this line's own — inside the box's columns,
within the band, where no neighbouring line inks the cell, and only when the
row's byte holds the majority of the row. It was built for the descenders (a
bar padded one row below the baseline shadows a `g`), and measured: every
real bar so far is padded past them (the memo's bars end a row below the
band, the reference's thirteen rows below), so the rows carried nothing on
any real document; on the bench they added 15 decoy contradictions on the
Courier page at no cost to the truth. Bars drawn tight to their text
(`--rows tight` on the bench) are the unsupported case, rows or no rows: the
reader fragments the box and a column shadowed on every row but one has no
corroborated byte. Recto's redaction boxes are drawn by hand or by the
refiner and are padded; the row evidence waits for a producer that is not. Shadow reads stay opt-in in the reader; the tester judges
dark edges on its own terms (a list, a byte of slack).
