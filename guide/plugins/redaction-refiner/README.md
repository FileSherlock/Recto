# Redaction Refiner — `redaction_refiner`

Redraws detected redaction bars to the true extent of the hidden name, using the
words that surround each bar on its line. No UI: it runs automatically
whenever redactions are (re)connected to their text lines. The whole plugin is
three files in `web/plugins/redaction_refiner/` — `plugin.json` (one
`scripts_after_app` entry), `redaction-refiner.js`, and the word list
`words.txt` with its licence notice.

## What it does

For every `redaction` box it builds the **words on its row** from the
embedded/OCR spans sharing the line and takes the nearest word **left** and
**right** of the bar. Words are built from per-character positions when the span
carries them, so a text-layer span that still runs *under* the bar (a rectangle
drawn over live text) contributes only its visible words — anything lying mostly
under the bar is the redacted text itself and is never a neighbour. Nor is a
**remnant sliver**: a lone capital letter touching the bar (OCR reading the
exposed `S` of `SARAH` that the bar failed to cover) belongs to the hidden name,
so the bar grows over it and the next word out is the neighbour. Remnants are
announced on the `redaction:refined` event (below) — they are the hidden name's
own first/last letters, which a matcher can use as a filter.

### Adjacent bars

A bar **never looks past another redaction bar on its row**. Two bars a space
apart are usually the two halves of one name (`for ███ ███ traveling`), and the
text beyond a sibling says nothing about this bar's extent. Without that bound
each bar of a pair measures against the word on the far side of the other,
stretches across it, and — since the sibling does the same in reverse — the pair
collapses onto one span, so the same stretch of page is scored twice.

A word *between* the bar and its sibling is still legitimate evidence
(`███ and ███`). Only when there is no word in between does the edge keep its
**detected** position: there, the painted ink is the only evidence there is.
Such an edge is never `exact`, because it comes from the detector rather than a
reader pen. `box.refineInfo.blocked` reports which sides were bounded this way —
also for a bar with no neighbour at all, which gets a verdict (`left` / `right`
null, `blocked` set) though nothing moves it. That is how a matcher tells a
lone bar from one whose only company on the row is the other half of a name
(`redaction_matching` pairs such bars).

Whether a word is *behind* the sibling is judged by its centre, so a comma the
sibling's painted edge runs a pixel into (`[A], [B]`) still stands between the
bars and is B's neighbour as much as A's. And since a bar's bound is its
sibling's **current** edge, a full run visits bars in reading order and repeats
while a pass moves anything (at most three): visited B-first, `[A], [B]` used
to lose B's comma behind A's not-yet-refined edge.

### Punctuation the bar runs over

Text lying mostly under the bar is the redacted text itself (a text layer can
still carry it) and is never a neighbour. A **punctuation mark** is the
exception: the redactor's box often runs over the comma after a name
(`[Lesley Groff,] Jean` — 2.75 px of the comma under the bar on the reference
page), and a mark the reader still certified from what shows belongs to the
visible text, so it is the neighbour and the bar ends at its pen. Only a mark
covered whole is hidden text. A neighbour read that way is marked
`partial` (more than 2 px of it under the bar — a detector column plus a side
bearing is less), and a partial pen makes the edge **not exact**: it is
evidence, but not lattice-exact.

### Which text layer

When OCR has read the row, its words are used **in preference to** the embedded
ones: OCR reads the glyphs actually *visible* on the page after redaction,
whereas the embedded text layer can carry glyphs the redaction removed from
view — or drop the glyph touching the bar. The auto OCR of a long document can
take minutes, so until it lands the refiner works from the **embedded** spans on
the box's line (the same lookup `embedded_text_viewer` snaps to), and the
fragment rule below recovers what that layer dropped. When the OCR pass finishes,
`redactions:connected` fires again and every bar is re-derived from the OCR
words. Because both derivations describe the same page they land on the same
edge; the verdict is recorded on `box.refineInfo` (`source: 'embedded' | 'ocr' | 'ocr-tolerant'`). The row's spans come from its best source (`lineSpansFor`): the reader's line when it certified the row with letters (`box.ocr.trusted`, `source: 'ocr'`), else the text layer's spans (`'embedded'`), else a tolerant read (`'ocr-tolerant'`: its pens sit on the ink, its face may not be the page's, so no lattice-exact edge, no reader's-set widths and no page-pixel verdict come of it) — never an unread band. A page the reader could not read is thus refined against the text layer, and the width seam (`ocrMeasureWidths`, which needs `source: 'ocr'`) leaves such bars to HarfBuzz in the bar's face.

### The three rules

Look at the word facing the bar on each side (its tail on the left, its head on
the right):

- **Punctuation** is flush only when the mark **binds toward the bar**. The same
  comma reads differently from each side: `EPSTEIN, ███` has a real space the
  bar must not eat, while `███, and` is flush, because a comma binds to the word
  on its left.
  - **Closing** `. , ; : ! ? ) ] } » ” … % >` bind left — flush against a bar on
    their left, one space in from a bar on their right.
  - **Opening** `( [ { « “ ¿ ¡ <` bind right — the mirror. `<` and `>` are
    Unicode *math* symbols rather than `\p{P}`, but an email address in angle
    brackets (`Klein <███>`) delimits exactly like a paren, so they join the
    bracket classes instead of falling through to the word rule and losing a
    space-width at each edge.
  - **Dashes and slashes** `- – — / \ @ & _ ~` bind both ways when glued to a
    word (`co-` and `-conspirators` are one compound, so flush) and neither way
    when standing alone (a spaced dash keeps its space).
  - **Quotes** `" ' ‘ ’` bind to whichever side carries a word. A quote glued to
    a word has already closed it, so the hidden word is separate and a space
    sits between them (`the "example" ███`). A quote standing alone opens onto
    the hidden word, so it is flush (`said "███`). Stacked marks are looked
    through: the `(` behind the quote in `("███` is not a word, so the quote
    still opens.

  A spaced mark is sized like any other inter-word space on the row — **two**
  of them when the mark ends a sentence and the page spaces its sentences that
  way. A typed memo often does (`incident.  The same day`: a 9 px gap where a
  word gap is 5 on the reference page), so a bar that opens a sentence
  (`plane. [Bledsoe] said`) starts two spaces in; read as one, that bar came
  out a space too wide with reader pens on both sides. The convention is
  measured per page from the pens (the gap after a sentence-ending mark to the
  capital that follows, in the row's spaces, median over the page's sentence
  boundaries; two readable boundaries at least, else one space). A mark after
  an abbreviation or an initial (`Dr.`, `J.`, `U.S.`) ends no sentence; a
  number does. The verdict is on `box.refineInfo`, as `kind: 'punct'` with
  `reason: 'abuts' | 'spaced'` and `spaces: 1 | 2`.
- **A whole word** means a real inter-word space sits in the gap, so the edge is
  redrawn **one space-width in** from where the neighbour begins. A token is a
  whole word when it is in the shipped English list (`words.txt`, possessives and
  hyphen compounds included), **or** a name from the candidate pool
  (`state.namesData` / custom names, read through a guarded global), **or**
  capitalised (`Wexner` — a proper noun the list cannot know).
- **A word fragment** — not a word, but a dictionary word *completes* it. This is
  the `including ███ nd GHISLAINE MAXWELL` case: the redaction tool dropped the
  `a` of `and` from the text layer, leaving `nd`. Most-frequent completion first
  (`and` before `end`, `find`, `second` …), the missing letters are measured in
  the neighbour's own font, and the geometry must agree with where they would
  sit — right between the fragment and the name:
  - **under the bar** — the gap between bar and fragment is ~0 (the detector
    swallowed the letters) and the bar is wide enough to hold them plus a
    space, or
  - **visible but unread** — the gap is ~the missing letters' width (the
    letters are on the page; only the text layer lost them).

  If a completion fits, the edge is redrawn one space **plus the missing
  letters** in from the fragment. If none fits (`FORD` a full space away from
  the bar is a word, not `afFORD`), the token is treated as a whole word. If the
  fragment reading would collapse the bar, it falls back to the word reading.

Spaces are sized from the **neighbour word's own font and size** with
`text_tool`'s HarfBuzz shaper (`getNaturalSpaceWidth`, which measures through
`Shaping.widths`; else a `0.25em` estimate), and stretched to the row's
measured spacing when the line is justified (measured spaces clearly *above*
natural are trusted; a short one under the bar is ignored). The missing
letters of a fragment are measured by `Shaping.widths` directly — plain
advances, `kerning: false`, `ligatures: false`, as the matcher measures —
behind a `typeof Shaping !== 'undefined'` guard; without the shaper the
fragment rule is skipped.

Because both edges are rebuilt from the neighbours rather than nudged from the
painted ink, the result can be **narrower or wider** than the original bar — the
bar is redrawn and `calculateAllWidths` (when present) re-scores it.

### What it leaves alone

- Bars with no neighbouring words on their line (they still get a
  `refineInfo` saying so, with `blocked`).
- The box the user is currently selecting/editing.
- A bar whose neighbours have not changed since it was last refined (the
  re-run after every page hydration is a cheap signature compare).
- A bar the user **moved or resized** after refinement — unless better evidence
  arrives (the OCR layer replacing the embedded one), in which case it is
  re-derived.

## The word list

`web/plugins/redaction_refiner/words.txt` — one lowercase word per line, **most
frequent first**. It is the intersection of the
[google-10000-english](https://github.com/first20hours/google-10000-english) 20k
n-gram list (the *order*) with the lowercase entries of a
[SCOWL](https://wordlist.aspell.net) size-60 list (the *validity*; capitalised
and uppercase entries are proper nouns and abbreviations and are excluded so
web junk like `nd` cannot pass). About 15k words, 130 KB, fetched once per
session through `assetURL('plugins/redaction_refiner/words.txt')`, so the URL
carries the file's content hash and a rebuilt list is picked up at once. When
the list cannot be loaded the refiner degrades to the punctuation and space
rules. `python3 tools/dev/words_build.py` rebuilds it — a development script
that downloads the two source lists; the output is committed, so the site
itself needs neither the network sources nor Python. The licence notice is
`words.LICENSE.txt` next to it.

## How it attaches

| Plugin | Docs | What it does | Data it keeps |
|---|---|---|---|
| `redaction_refiner` | [redaction-refiner/](.) | Redraws redaction bars to the hidden-name extent via surrounding words, punctuation and a word list | The word list, `web/plugins/redaction_refiner/words.txt` |

- **Trigger** — subscribes to the generic **`redactions:connected`** PDFHooks
  event, emitted by `embedded_text_viewer`'s `utbConnectRedactionsToLines` after
  it snaps redactions to lines. That single emission covers both the span-load
  path (per hydrated page) and the post-OCR path (`ocr_tool` calls the same
  connect function when its run finishes).
- **Emits `redaction:refined`** after judging a bar:
  `{ boxId, source, changed, remnants: [{ text, side }] }`. Generic — it names
  no consumer; `redaction_matching` listens and turns the remnants into that
  box's starts-with / ends-with filter unless the user already typed one.
- **Guarded globals** — `renderBox` (text_tool), `calculateAllWidths`
  (redaction_matching), `getNaturalSpaceWidth` and `Shaping` (text_tool),
  `GEO` (the core, `web/core/geometry.js`), `state.namesData` /
  `state.customCandidates` (redaction_matching). Each call
  site guards, so the refiner degrades cleanly when a provider is absent — with
  no surrounding words it simply does nothing.
- **Manual re-run / inspection** — `window.refineAllRedactions()`,
  `window.refineRedaction(box, { force: true })`, and the pure helpers on
  `window.RedactionRefiner` (`classifyToken`, `completions`, `resolveEdge`,
  `punctBindsToward`, `facingRun` …).
  After a run, `box.refineInfo` says what each side was judged to be
  (`punct` / `word` / `fragment`, the token, the completion and its placement,
  `partial` when the bar covers part of the neighbour), which sides a sibling
  bar bounded (`blocked`), the `x`/`w` it produced, and `exact` — true when
  both edges came from the reader's OCR pens read whole, so the width is exact
  to mupdf's ¼-px lattice. A matcher reads `exact` to match names to a quarter
  pixel instead of a pixel tolerance, a missing side to allow for the
  redactor's padding, and `blocked` to pair bars (`redaction_matching` does).

## Tests

`node --test "tests/**/*.test.mjs"` runs both suites in
`tests/plugins/redaction_refiner/`: `words.test.mjs` covers the word list's
shape (skipped when the plugin is not installed), and `refiner.test.mjs` the
geometry (also runnable on its own:
`node tests/plugins/redaction_refiner/refiner.test.mjs`): the viewer's globals
are stubbed, the shaper is a Times-Roman metrics table (Times New Roman is
metric-compatible), and the fixture rows (`fixtures/efta_rows.json`) are real
embedded spans of a scanned court filing whose bars were measured from the
raster. Both fixture bars refine to `SARAH KELLEN`'s width
from the embedded layer alone, and again — to the same edge — once OCR words
that read `and` in full are added.

## Candidate verdicts from the page pixels

Width cannot split names that tie to the font unit, and a half-exposed glyph is
not a letter (`A` / `Æ`). So the names that fit the bar by width are *tested*,
never read: `web/plugins/ocr_tool/hypothesis-view.js` defines the seam
`window.ocrTestHypothesis(box, name)`, which draws the name where this refiner
put the bar — the neighbour word's glyph set, baseline, y-phase and ¼-px pens,
the row's own space — composites the bar over it as the redactor did (tol0
LAWS §8, bar last) and lets the page bytes outside the bar's black body judge it
(tol0 `engine/hypothesis.js`, certified there). `redaction_matching` calls it
after every width recompute and shows the verdict on each chip:

- `✓` **consistent** — every judged pixel matches, no page ink in the name's
  window is left unexplained, on at least 12 pixels of evidence;
- `✗` **contradicted** — with the counts in the chip's title;
- `–` **no evidence** — the bar left nothing to compare (a body whose edge
  columns carry no shadow of the name), or the set lacks a glyph.

A dark edge column judges too: strip the column's own byte and the darker
pixels are the hidden name's first (or last) column, compared with one byte
of slack for the box compositor's rounding — on the reference page that is
what names the item-3 bar SARAH KELLEN from nine pixels of a 74 edge. An
edge too dark to hold two levels apart is body, and a matched pixel counts
only where the page shows a shadow. The seam also tells the tester the gap
to each neighbour (none before a comma) and a name that overruns its right
neighbour by over 1¼ px is contradicted with the reason `width`; a name that
ends early is not, and its fit (`penFit`) is on the verdict for the matcher.
A bar whose list holds exactly one name the page did not contradict, on no
evidence of its own, is a *survivor* in `tools/verify-redactions.mjs`. The
bar's own top and bottom rows judge too where they lie inside this line's
band (a bar padded a row below the baseline shadows the descenders); the
bars seen so far are padded past them, so that evidence is still waiting
for a producer that draws its bars tight.

Two consistent names are a tie, and the tie is the answer. Inputs come from
`neighboursFor(box)` (the neighbour OCR segments and their pens),
`box.refineInfo` (the row space) and the pixel view's page info; the seam
returns `null` — with the reason in `OCRHypothesisView.reasons` — when the
row has no OCR segments, no set is loaded for the face, the raster is not 1:1,
or no detected box overlaps the bar. Design, measurements and limits:
[pixel-evidence-plan.md](pixel-evidence-plan.md); the corpus report:
tol0 `tools/verify-redactions.mjs`.

## Dependencies

```
redaction_refiner ──'redactions:connected' hook──> embedded_text_viewer
                  ──runtime globals─────────────> text_tool ──> core (web/core/)
```

- **Needs a source of `redaction` boxes** (e.g. `ocr_tool` or the Add-Box tool)
  and **surrounding text** on their lines (`embedded_text_viewer` spans or
  `ocr_tool` lines). With neither, there is nothing to measure against and it
  no-ops.
- Removing it: delete the `web/plugins/redaction_refiner/` folder,
  `tests/plugins/redaction_refiner/` and this docs folder, and drop its row
  from the table in [`../README.md`](../README.md). The
  `redactions:connected` emission in `embedded_text_viewer` is generic (it names
  no plugin) and simply emits into the void once no one subscribes.
