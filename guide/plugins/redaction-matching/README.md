# Redaction Matching — `redaction_matching`

Matches candidate names against redaction bars by **measured width**, and
shows the result on the bar and in the *All Matches* table. It owns the
candidates right panel (the `#tools-sidebar` host, its toolbar toggle, CSS and
wiring), the name pool (`web/plugins/redaction_matching/names.json` + custom names),
the per-box *Name format* settings, and the matches table. It does **not**
detect bars — it matches against whatever `redaction` boxes exist (from
`ocr_tool`, or the Add-Box tool).

## Candidates

Each redaction box carries its own `nameSettings` (a copy of the template
edited while no box is selected): *Generate* full name / first only / last only,
*Include* prefix / suffix / nickname, *Expand aliases* (every first / last
spelling a person has — **on by default**: the memos write `Lex Wexner` and
`Adriana Mucinska`, second aliases in the list, and a name the list holds but
never generates is a bar the page pixels are never asked about), and a
*starts with* / *ends with* letter filter (one
or more letters, case-insensitive, applied to the rendered candidate string). A
refiner that finds a letter of the hidden name sticking out of the bar fills
the filter for that box through the `redaction:refined` event, unless the user
typed one. Custom names (typed or pasted) are shared by every box; deleting a
row deletes the whole person from every box.

Widths come from HarfBuzz in the browser — `text_tool`'s
`Shaping.widths(request)` (`web/plugins/text_tool/shaping.js`, HarfBuzz as
WebAssembly), called behind a `typeof Shaping !== 'undefined'` guard, so
without `text_tool` nothing is measured and nothing throws. It is the same
deterministic shaper `text_tool` draws with; measuring with the browser's own
`getBBox()` instead reports fallback-font metrics until the page font has
laid out, and the same name then measures a few pixels wider on some loads
than on others. Names are measured in the **bar's own face, size and style** — a detected bar adopts them from the text line it is
connected to (`embedded_text_viewer`'s connect step prefers a reader-read
line, whose size is measured from the glyphs, over the embedded layer's) —
resolved through the font catalogue (`family` / `bold` / `italic`), with the
bar's kerning, uppercase and space-width settings applied, and **without
ligatures** (`ligatures: false`): a producer that set none — Word, by default
— laid `Groff` at f + f, and HarfBuzz's `ff` / `tt` ligatures would put such
a name half a pixel short of its bar, outside the pen lattice (*Lesley Groff*
and *Richard Barnett* on the memo).

When a reader has read the bar's row, the optional seam
**`window.ocrMeasureWidths(box, strings)`** (`ocr_tool`, over the reader's
glyph set) lays the strings out in the face that actually drew the page, and
those widths replace the HarfBuzz ones; the row's tolerance note names the set
(`· calibri102mid_1024`). A string the set cannot draw keeps its HarfBuzz
width. The two agree to the font unit on the memos; they differ where a
document was set in another build of the face (tol0 LAWS §6).

## Which names fit

A name fits when its measured width lies within the bar's **fit range**:

- **Over** (wider than the bar): the tolerance in force. That is the *Tolerance*
  field, unless a refiner has marked the bar **pen-exact** — both edges derived
  from the reader's ¼-px OCR pens (`box.refineInfo.exact`, and the bar not
  moved since) — in which case it is `±0.3 px`, two ⅛-px lattice snaps; a
  tighter field still wins. The row shows which (`±0.30 px · pens` / `±3 px`).
- **Under** (narrower than the bar): the same, unless an edge is the
  **detector's** — no reader pen on that side (a line end, a bar bounded by a
  sibling bar, or no refiner at all) — in which case the bar ends where the
  black box ends, and the redactor drew that box with room to spare (4.4 px
  past *BLEDSOE* on the reference page). Then a name may be narrower by up to
  0.4 em, capped at 10 px.

Names are listed best first: by **page verdict** when a hypothesis tester
scored them (below), then a pair reading before a single one, then a fit
before a near miss, then closeness. In Times many names tie to the font unit
(`SARAH KELLEN` 15416/2048 em, `JUSTIN NELSON` 15417), so this is a list, not
a winner: click a chip to pin that name on the bar, or press `[` / `]` with
the bar selected.

**Near misses.** Names the pen lattice excludes but the pixel tolerance admits
are not thrown away. With a hypothesis tester present they are scored too, and
one the page **could not contradict** joins the list (dotted chip, the title
says so) — width ranks, the page decides. That is what kept *Richard Barnett*
in view while HarfBuzz still formed the `tt` ligature that put it 0.51 px
short of its pen-exact bar. Without a tester they are the fallback when
nothing fits at all, shown under a red *No name fits the pen-exact width* note
as near misses, never as fits.

## Page-pixel verdicts

If `window.ocrTestHypothesis(box, name)` exists (`ocr_tool` defines it over
tol0's `engine/hypothesis.js`), every name a reading shows on a bar is tested
after each width recompute and the chip carries the verdict: `✓` consistent,
`✗` contradicted, `–` no evidence; the row counts `n of m consistent`. The
seam draws the name where the refiner put the bar and lets the page bytes
outside the bar's body judge it; two consistent names are a tie. Without a
provider nothing runs. Design and limits:
[../redaction-refiner/pixel-evidence-plan.md](../redaction-refiner/pixel-evidence-plan.md).

## Two bars, one name

A name can be redacted as two bars — its halves a space apart on one row
(`[Nadia] [Marcinkova]`), or split by a line break (`…, [Nadia]` ending one
row and `[Marcinkova], …` opening the next). The refiner's verdict on each bar
tells the cases apart without new geometry:

- **row** — `refineInfo.blocked` says a sibling bar bounded the neighbour
  search on that side and no neighbour was found there: nothing but the other
  bar. The two must be within 0.75 em of each other. A word between them
  (`[A] and [B]`, `[A], [B]`) keeps them apart.
- **line** — the last bar of a row (no word and no bar after it) and the first
  bar of the next row (nothing before it), the next row starting between 0.5
  and 1.8 bar heights down.

Linked bars are read as **one person**: a first name against the first bar and
a last name against the second, each within its own fit range — the same
strings the *First only* / *Last only* formats generate, constrained to come
from one person (a custom name splits at its last space; prefix and suffix
follow the *Include* settings of the bar they land on). The gap between the
bars is detector ink, not a measured pen, so the halves are never summed
across it. A **pair reading** appears as a dashed chip showing this bar's half
(`Nadia` on one bar, `Marcinkova` on the other; the title names the whole
person and the partner bar), the row says which bar holds the other half, and
clicking it labels both bars. Each half is judged on its own bar by the
hypothesis tester: contradicted anywhere is contradicted, consistent on both
is consistent, otherwise no evidence. A bar without a refiner verdict is never
linked. (`[Bledsoe] [is a]` on the reference page links too — and yields no
pair, because no person's last name is 22 px wide.)

## How it attaches

- `web/plugins/redaction_matching/plugin.json` declares the toolbar toggle
  (`toolbar_button.html`, `#toggle-tools`), the right panel
  (`sidebar_tools.html`, `#tools-sidebar`), `styles.css`, and `api.js` as a
  `scripts_before_viewer` entry. `names.json` is fetched by `api.js` through
  `assetURL`, so its URL carries the file's content hash.
- Reads `utbState.boxes` (text_tool) and writes `box.text` / `box.labelText`,
  `box.widths`, `box.verdicts`, `box.matchPick`, `box.nameSettings`,
  `box.candidates`.
- Listens to **`redaction:refined`** (remnant letters → letter filter).
- Reads **`box.refineInfo`** (`exact`, `left` / `right`, `blocked`) when a
  refiner wrote it; without one every bar is a raster bar with detector edges.
- Calls **`window.ocrTestHypothesis`** and **`window.ocrMeasureWidths`** when
  defined; **`Shaping.widths`**, **`getNaturalSpaceWidth`**,
  **`renderBox`**, **`GEO`**, **`selectBoxInSVG`** / **`syncToolbarToBox`**
  through guards.
- Globals it exposes: `getBoxMatchInfo`, `getBoxMatches`, `fitRange`,
  `effectiveTolerance`, `linkFor`, `halfStrings`, `scoreMatches`,
  `shownMatch`, `setBoxMatch`, `cycleBoxMatch`, `matchesLetterFilter`,
  `calculateWidthsForRedaction`, `calculateAllWidths`, `selectRedaction`.

## Tests

`node --test "tests/**/*.test.mjs"` runs both suites in
`tests/plugins/redaction_matching/`:

- `page.test.mjs` — on the generated page: the sidebar controls, and what
  `api.js` must (and must not) contain. Skipped when the plugin is not
  installed.
- `matching.test.mjs` — the matcher's width logic under Node with the viewer's
  globals stubbed (also runnable on its own:
  `node tests/plugins/redaction_matching/matching.test.mjs`): the fit ranges
  (pixel tolerance, the pen lattice, the detector padding), the loose
  fallback, the near-miss rescue, verdict ranking, the letter filter, and the
  two-bar readings (row and line links, the one-person constraint, settings
  shaping the halves, pinning both bars, halves judged separately).

## Dependencies

```
redaction_matching ──utbState / renderBox / Shaping / getNaturalSpaceWidth──> text_tool ──> core (web/core/)
                   ──GEO, state, els, PDFHooks, assetURL───────────────────> core
                   ──'redaction:refined', box.refineInfo (optional)────────> a refiner
                   ──window.ocrTestHypothesis, ocrMeasureWidths (optional)─> a reader (ocr_tool)
```

Removing it: delete `web/plugins/redaction_matching/`,
`tests/plugins/redaction_matching/` and this docs folder, and drop its row
from [`../README.md`](../README.md). On the next reload the build does not
find it, and no candidates sidebar remains in the page.
