# Redaction Matching — `redaction_matching`

Matches candidate names against redaction bars by **measured width**, and
shows the result on the bar and in the *Name matching* panel. It owns that
right panel (the `#tools-sidebar` host, its toolbar toggle, CSS and wiring),
the name lists (`web/plugins/redaction_matching/*.json` + the names typed into
the panel), each bar's *formats* and filter, and the label each bar
shows. It does **not** detect bars — it matches against whatever `redaction`
boxes exist (from `ocr_tool`, or the Add-Box tool).

## Where it is developed

In a repository of its own, **`redaction-matching`** (`Desktop/redaction-matching`,
beside Recto — the arrangement tol0's engine has). Recto's
`web/plugins/redaction_matching/`, `tests/plugins/redaction_matching/` and
`guide/plugins/redaction-matching/` are verbatim copies of that repository's
folders at the same paths, synced in by its `npm run sync:recto`: change them
there, never in Recto — the sync refuses to overwrite a copy that was changed
in Recto. In `redaction-matching`, `npm run serve` is this site with the
working copy in place of Recto's (`tools/serve.mjs --plugin <folder>`), and
`npm test` runs the suites below against it.

## Lists — what names there are

A bar is compared with the names of every list that is **on**. The lists are
the whole document's:

| List | File | On at start |
| --- | --- | --- |
| People | `names.json` — 2,439 people, with their aliases, titles, suffixes, nicknames, and a middle initial, gender, e-mail addresses and links where known | yes |
| Businesses | `contacts-businesses.json` — the businesses of the contacts book, with a note and their page | no |
| Your names | typed or pasted into the panel | yes |

A shipped list is a JSON array in the plugin's folder, fetched through
`assetURL` (so its URL carries the file's hash), declared by one line of
`NAME_LISTS` in `api.js`. An entry is either an object or a **plain string**,
which every format writes as it stands (an e-mail address list is a file of
strings and a line in `NAME_LISTS`):

```json
{ "first": ["Edward", "Jay"], "middle": null, "last": ["Epstein"], "prefix": null,
  "nickname": null, "suffix": null, "gender": null, "email": [],
  "links": { "adress-book": "p17", "wiki": "EdwardEpstein" } }
```

- `first`, `last` — a person's first spelling is their own, the others are
  aliases; a business is a `last` alone.
- `middle` — a middle name or initial (a string, or several spellings).
- `prefix`, `suffix`, `nickname` — one each, or null.
- `gender` — `"f"` or `"m"` (`female` / `woman`, `male` / `man` read the
  same); any other value counts as *not recorded*, as null does.
- `email` — the person's addresses. One cut off where the list was read
  (`jcayne@`, `katieford@fordmanagement.` — no domain ending after the @) is
  written by no format: measured short, it could fit a bar the real address
  would not. The ℹ card shows it, marked *cut off* (68 in `names.json`).
- `note` — shown in the ℹ card (a business's address, number or contact). An
  entry whose note says it is a *section heading* (BRAZIL, MEDICAL — the
  contacts book's headings) is not a name and is skipped.
- `links` — where the entry was read and where to read more, shown in the ℹ
  card. `"adress-book": "p17"` (spelled so in the lists) is the page of the
  address book, linked to that page of its PDF
  ([Jeffrey Epstein's Little Black Book](https://archive.unbarpdf.com/other/Jeffrey%20Epstein%27s%20Little%20Black%20Book.pdf),
  `#page=17`; `NAME_ADDRESS_BOOK` in `api.js`). `"wiki"` marks a section of Wikipedia's
  [List of people named in the Epstein files](https://en.wikipedia.org/wiki/List_of_people_named_in_the_Epstein_files):
  its anchor is the value, or the entry's first last name when the value is
  empty (`"wiki": ""` on Dershowitz → `#Dershowitz`; `"EdwardEpstein"`,
  `"Mountbatten-Windsor"`, `"Bill_Gates"` where the section's anchor is not the
  last name). Any other key shows its value: an http(s) address as a link,
  anything else as text.

Every field but `first` and `last` may be missing, null or empty. In
`names.json` they are filled only where the list itself says so: a **gender**
from a title that gives one (Mr, Ms, Mrs, Miss, Sir, Lady, Lord, Prince,
Princess, Duke, Duchess, Earl, Baron, Baroness, Viscount, Viscountess,
Marquess, Sheikh, Sultan, Señor) on an entry of one person — 91 of them; an
entry for a couple (*Sir* over "Anthony" and "Carole" Bamford) is left
without one — and a **middle initial** where a spelling of the first name
writes it beside the plain one ("Jeffrey" and "Jeffrey E.": 23). 412 entries
have e-mail addresses, 1,880 their address-book page and 169 a Wikipedia
section; every business has its page. The Names section says, per list, how
many entries record a gender, a middle name, an e-mail address.

Your names come one per line or comma-separated (a comma is always a
separator). A typed name is a person: its last word is the last name and the
words before it the first (`Lex Wexner`; `Ghislaine de Rothschild` is first
`Ghislaine de`, last `Rothschild`); one word is a name of its own; anything
with an `@` is written as typed. Adding a name switches Your names on.

The eye button on a fitting name **hides** the entry behind it from every
bar — a whole person, with all their spellings, and every entry that writes
the same reading (`names.json` holds a few people twice or three times; a
two-bar reading hid only the first); a typed name simply leaves Your names.
*Show again* (Names section) brings the hidden back. Pasting is linear: 60,000
names go in in a fraction of a second.

`state.namesData` holds every entry of the shipped lists as the files have
them, and `state.customCandidates` Your names as typed: a refiner reads both
as a vocabulary (a name beside a bar is a whole word). `state.candidates` is
what a new bar would be compared with — `embedded_text_viewer`'s capitals
test reads it.

## Formats — how a bar writes a name

A **format** is a pattern of a name's parts and the characters between them.
A part is written the way it comes out:

| Pattern | Sarah Kellen | Aspen Club (a business) |
| --- | --- | --- |
| `{First} {Last}` | Sarah Kellen | Aspen Club |
| `{LAST}, {First}` | KELLEN, Sarah | ASPEN CLUB |
| `{F}. {Last}` | S. Kellen | Aspen Club |
| `{first}.{last}` | sarah.kellen | aspen club |
| `{Title} {Last}` | *(none — no title)* | *(none)* |

| Part | Writes |
| --- | --- |
| `{First}` `{Middle}` `{Last}` | the names as the list spells them |
| `{F}` `{M}` `{L}` | their initials |
| `{Nick}` | the nickname |
| `{Title}` `{Suffix}` | the list's `prefix` and `suffix` |
| `{Mr}` | *Mr* for an entry recorded as a man |
| `{Ms}` `{Mrs}` `{Miss}` | *Ms*, *Mrs*, *Miss* for an entry recorded as a woman |
| `{Email}` `{User}` `{Domain}` | an address, the part before its @, the part after it |

A part in capitals comes out in capitals (`{LAST}`), in lowercase in
lowercase (`{last}`), otherwise as the list has it; an initial is a capital
unless it is written `{f}`. Every part but the first and last name exists for
some entries only, and a format that asks for one writes **nothing** for an
entry without it. A missing first or last name drops out together with the
characters before it, so an entry with one name (a business, `Abby`) reads
the same under every format — but never as a lone initial. Every other
character stands as typed; a `\` writes the sign after it as it stands (`\[`,
`\{`, `\|`, `\\`).

Two signs make one pattern several, the way a regular expression matches
several strings — here, though, every string is **made** and measured:

| Pattern | Makes |
| --- | --- |
| `{First}[ {M}.] {Last}` — `[ … ]` is optional | Jeffrey Epstein, Jeffrey E. Epstein |
| `[{Title} ]{First} {Last}` | Abdul Alianizi, Dr Abdul Alianizi |
| `{First\|Nick} {Last}` — `{A\|B}` is either part | Dara Gehringer, Preece Gehringer |
| `{First\|F.} {Last}` — each choice with text of its own | Sarah Kellen, S. Kellen |
| `{Mr\|Ms}. {Last}` | Mr. … for the men, Ms. … for the women |

The pattern is read into a tree (text, parts with their choices, optional
groups, which nest) and spelt out into its **variants**, plain patterns of the
first kind; each writes its names, and the format's names are all of theirs.
A pattern of more than 32 variants is refused (*make it two formats*): every
name is measured, and a few choices multiply quickly. A middle name is not
written twice: under `{First} {M}. {Last}` the spelling "Jeffrey E." (which
writes it already) makes nothing, and "Jeffrey" makes *Jeffrey E. Epstein*.

A bar can have **several formats on**; its names are all of theirs. *Every
spelling of first / last names* (on by default) takes every alias a person has
— the memos write `Lex Wexner` and `Adriana Mucinska`, second aliases in the
list, and a name the list holds but never generates is a bar the page pixels
are never asked about.

Formats belong to **each bar** (`box.nameSettings`): a new bar starts with a
copy of the defaults, which the panel edits while no bar is selected; *Apply
to all bars* gives every bar — and every new one — the selected bar's formats
and spellings.

### The pill editor

A format opens as **pills on a track**, one per part of its tree, coloured by
what they are — a name (blue), a title (violet), an e-mail address (green),
text (grey, its spaces shown as ␣) — with a dashed frame around what is
optional (its **?** makes it required again):

- **Click** a pill for its controls. A part has one row per choice — which
  part, its case (**Aa** as written, **AA** capitals, **aa** lowercase; an
  initial **A** or **a**), a full stop after it — and *+ or another part* adds a choice (after
  First comes Nickname, after Mr comes Ms). Text has one click for the usual
  separators (␣ `,␣` `,` `.` `.␣` `_` `-` `@`) and a field for anything else;
  emptied, the text goes when the field is left. Both have *Optional*, ← →
  (a part changes places with the next part, the text between staying where it
  is), and remove (a part goes with the text after it, or — last — the text
  before it, so what stood around it still reads). Escape closes them.
- **Drag** a pill, or an optional group as a whole, to a place between two
  others (a caret shows where), or onto the middle of another part to swap
  the two. Pointer events: a finger drags too.
- **The palette** under the track adds First, Middle, Last, Title, Suffix,
  Mr / Ms, E-mail or Text — at a click where it usually goes (a title first,
  the middle initial after the first name, the rest last), or dragged to
  where it should. A part only some entries have comes **optional**, with its
  separator, beside other parts — `+ Middle` on `{First} {Last}` makes
  `{First}[ {M.}] {Last}` — so the format still writes everyone else.
- Under it: up to three **examples** (the first person each variant can
  write, the richest first) and **how many names** the format makes for the
  bar, through its filter; past 20,000 the count warns that measuring will
  take a while. The Format section's head line gives the bar's total.

*Type a pattern* is the same format as text. Typing redraws the pills at each
keystroke that leaves the pattern readable (an error says what is wrong and
the format keeps its last good pattern); a change made with the pills writes
the pattern again.

**Letter case** in Recto's Text panel (its Redaction match section; text_tool's `box.uppercase`, per bar)
applies *on top of* the format — leave it at *As typed* and the format
decides; the panel shows a chip while it is set (`embedded_text_viewer` sets
it to capitals when the bar's line writes its other names that way). The
hypothesis tester and the page-face widths apply it the same way, so all
three see the same string.

Each bar also has a **filter**, its own (*Apply to all bars* leaves it be):

- **Starts with / ends with** — one or more letters, case-insensitive, on the
  name as written (so under `{LAST}, {First}` the start is the last name's).
  A refiner that finds a letter of the hidden name sticking out of the bar
  fills it for that bar through the `redaction:refined` event, unless the
  user typed one (*seen* in the Filter summary).
- **Gender** — *Women*, *Men*, *Not recorded*, all on at first: which entries
  the bar's names come from. A typed name, a plain-string entry and most of
  `names.json` have no gender recorded, so turning *Not recorded* off leaves
  few names; the context of a bar ("she", "his wife") is what the filter is
  for.

## Widths

Widths come from HarfBuzz in the browser — `text_tool`'s
`Shaping.widths(request)` (`web/plugins/text_tool/shaping.js`, HarfBuzz as
WebAssembly), called behind a `typeof Shaping !== 'undefined'` guard, so
without `text_tool` nothing is measured and nothing throws. It is the same
deterministic shaper `text_tool` draws with; measuring with the browser's own
`getBBox()` instead reports fallback-font metrics until the page font has
laid out, and the same name then measures a few pixels wider on some loads
than on others. Names are measured in the **bar's own face, size and style** — a detected bar adopts them from the text line it is
connected to (`embedded_text_viewer`'s connect step prefers a line the reader
certified, whose size is measured from the glyphs, over the embedded layer's;
where the reader failed on the row, the layer is the reference) —
resolved through the font catalogue (`family` / `bold` / `italic`), with the
bar's kerning, letter case and space-width settings applied, and **without
ligatures** (`ligatures: false`): a producer that set none — Word, by
default — laid `Groff` at f + f, and HarfBuzz's `ff` / `tt` ligatures would
put such a name half a pixel short of its bar, outside the pen lattice
(*Lesley Groff* and *Richard Barnett* on the memo).

When a reader has read the bar's row, the optional seam
**`window.ocrMeasureWidths(box, strings)`** (`ocr_tool`, over the reader's
glyph set) lays the strings out in the face that actually drew the page, and
those widths replace the HarfBuzz ones; the width's tooltip names the set
(`measured in the page's own face (calibri102mid_1024)`). A string the set
cannot draw keeps its HarfBuzz width. The two agree to the font unit on the
memos; they differ where a document was set in another build of the face
(tol0 LAWS §6).

**What could not be measured is never a width.** The shaper is asked to
report (`report: true`): the face it measured with, and the characters each
name has no glyph for. A name it gave no width, or one with a character the
face lacks (`王小明` in Times "fitted" at its placeholder glyph's 37.34 px), is
not compared — the panel says how many. A face that stands in for the bar's
(`Garamond` is not installed, `Nimbus Mono PS` has no bold) gets a warning
chip, `≈ Times New Roman`, and the width's tooltip says why; the page's own
face, where a reader measured, needs none. When nothing could be measured at
all — a font that failed to load — the panel says so with the reason
(`box.widthError`), never *No name fits*; a bar not measured yet says
*Measuring…* and is measured. The shaper takes the names in batches of 1,500
and every bar's pass a task of its own, the shown page's bars first, so the
page answers while a document's bars are measured.

**The space inside a name** (`settleSpaceWidth`) is the line's: the font's
own space where the line is not justified, the measured one where it is. It
is the **bar's own face's** space, plus what justification added to the
line's: a bold bar on a regular Verdana line takes the bold face's 5.469 px,
not the regular 5.625. It is settled again when the bar's face, size, line or
kerning changes; a space set by hand in the Text panel stays.

## Which names fit

A name fits when its measured width lies within the bar's **fit range**:

- **Over** (wider than the bar): the tolerance in force. That is the *Width
  tolerance* in Recto's Text panel (Redaction match), unless a refiner has marked the bar
  **pen-exact** — both edges derived from the reader's ¼-px OCR pens
  (`box.refineInfo.exact`, and the bar not moved since) — in which case it is
  `±0.3 px`, two ⅛-px lattice snaps; a tighter field still wins. The bar's
  chip shows which (`±0.3 px · pens` / `±3 px`).
- **Under** (narrower than the bar): the same, unless an edge is the
  **detector's** — no reader pen on that side (a line end, a bar bounded by a
  sibling bar, an edge the ink held against a word a tab stop away —
  `refineInfo.left/right.kind === 'ink'` — or no refiner at all) — in which
  case the bar ends where the black box ends, and the redactor drew that box
  with room to spare (4.4 px past *BLEDSOE* on the reference page). Then a
  name may be narrower by up to 0.4 em, capped at 10 px. A side whose ink
  reaches the text column's edge runs to the **margin** (`refineInfo.margin`):
  the name may end anywhere before it, so no narrower name is too narrow. The
  chip names what bounds the bar where no pen does (`· ink right`,
  `· right margin`), and its tooltip says why.

Names are listed best first: by **page verdict** when a hypothesis tester
scored them (below), then a pair reading before a single one, then a fit
before a near miss, then closeness. In Times many names tie to the font unit
(`SARAH KELLEN` 15416/2048 em, `JUSTIN NELSON` 15417), so this is a list, not
a winner: click a name to pin it on the bar (click it again to unpin), or
press `[` / `]` with the bar selected.

**Near misses.** Names the pen lattice excludes but the pixel tolerance admits
are not thrown away. With a hypothesis tester present they are scored too, and
one the page **could not contradict** joins the list (its offset underlined
with dots; its ℹ card says so) — width ranks, the page decides. That is what
kept *Richard Barnett* in view while HarfBuzz still formed the `tt` ligature
that put it 0.51 px short of its pen-exact bar. The others wait folded under
*n near misses*. Without a tester they are the fallback when nothing fits at
all, shown under a red *No name fits the pen-exact width* note as near
misses, never as fits — and nothing is written on the bar from such a list
unless the user pins one of its names. A tolerance changed in the Text panel
lets other names in without a new measurement: those the page has not
judged are judged then, and the bar labelled again.

## Page-pixel verdicts

If `window.ocrTestHypothesis(box, name)` exists (`ocr_tool` defines it over
tol0's `engine/hypothesis.js`), every name a reading shows on a bar is tested
after each width recompute and the name carries the verdict: `✓` consistent,
`✗` contradicted (struck through), `–` no evidence. The label drawn on the bar
takes the same verdict's colour (`box.labelColor`, a `text_tool` seam the SVG
text and the pixel view both honour): green when the page vouched for the
name, amber when it left no evidence, red when it contradicted it; a label
the tester has not judged (yet) is grey — the type's own colour is a green
too close to "vouched" — and without a tester the label keeps the type's
colour. Only the newest scoring of a bar writes its verdicts: one still
running for the bar's old geometry, finishing later, is dropped. The label sits on the edge the
refiner knows exactly (`box.labelAlign`, the same kind of seam): a name that
ends at a comma or a word's pen but starts somewhere after a tab stop is drawn
ending at the bar's right edge. The seam draws the name where the refiner put
the bar and lets the page bytes outside the bar's body judge it; two
consistent names are a tie. Without a provider nothing runs. Design and
limits:
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

Linked bars are read as **one entry**, each half within its own bar's fit
range. The halves are what a format's variant writes before and after the
space between the given names (first, middle, nickname) and the last name:
`{First} {LAST}` puts `Sarah` on the first bar and `KELLEN` on the second,
`{LAST} {First}` the other way round, `{Title} {First} {Last}` `Dr. Gregory`
and `Bledsoe`, `{First} {M}. {Last}` `Jeffrey E.` and `Epstein` — an
initial's full stop goes with it. A variant whose names are joined by
anything else makes no halves — the comma of `{Last}, {First}` would stand on
the page between the bars — and neither does one with a single name. The
halves come from the variants of the formats on either bar and every spelling
either bar asks for, each through its own bar's letter filter, and only from
an entry both bars' gender filters let through (it is one person); a typed
name splits at its last space, and a plain-string entry has no halves. The gap between the
bars is detector ink, not a measured pen, so the halves are never summed
across it. A **pair reading** shows this bar's half with the other half
greyed beside it (its ℹ card names the partner bar), the bar notes which bar
holds the other half, and pinning it labels both bars (unpinning unpins
both). Each half is judged on its own bar by the hypothesis tester:
contradicted anywhere is contradicted, consistent on both is consistent,
otherwise no evidence. A bar without a refiner verdict is never linked.
(`[Bledsoe] [is a]` on the reference page links too — and yields no pair,
because no person's last name is 22 px wide.)

## The panel

The *Name matching* panel, top to bottom:

- **The selected bar** — its width (the tooltip names the face it was measured
  in), the tolerance chip, a letter-case chip while the Text panel's Letter case is
  set, then the names that fit, best first: verdict, the name as the bar
  writes it (in the bar's face) with an ℹ behind it, its offset against the
  bar in px, a pin on the pinned one, and the hide button. Twelve show, then
  *Show all*; near misses fold away. With no bar selected it says to select
  one.
- **The name field** — measures what is typed against the selected bar as you
  type (`140.92 px −0.81 too narrow`); Enter (or *Add*) adds it to Your names,
  Shift+Enter starts another line, and a pasted list adds every name.
- **Format** (collapsed; its summary lists the formats on) — the selected
  bar's formats and how many names they make, or the defaults for new bars;
  one opens in the pill editor.
- **Filter** (collapsed; selected bar only) — starts with / ends with, and
  gender.
- **Names** (collapsed; its summary says which lists are on and how many
  entries) — the lists' switches and counts (under a list of people, how many
  record a gender, a middle name, an e-mail address), Your names, the hidden.

**The ℹ card.** The ℹ behind a fitting name (or a near miss) holds
everything about it. First how it fits: its width and offset against the bar,
the page's verdict, why a near miss is kept, and for a pair the whole name and
which bar holds the other half. Then who it is: every entry that writes it (three, then how many more; a pair
reading's one person), as its list records it — the full name (title, first,
middle, last, suffix), its other spellings and nickname, *Woman* or *Man*
where the list records a gender, the list, its e-mail addresses, its note,
its address-book page (a link to that page of the book) and a link to its
Wikipedia section (both open a new tab). An
address the list has cut off at the page's edge is shown marked *cut off*.
Hovering the ℹ opens the card, which stays while the pointer is on it so its
links can be followed. A click on the ℹ (a tap, Enter) pins it until Escape,
a click elsewhere or another click on the ℹ; from the keyboard the focus moves
into it, and Escape gives it back to the ℹ. The card hangs in the panel
(`#rm-info-card`, outside the scrolling body), under its ℹ or — with more room
there — above it, follows its name when the list is drawn again and closes
when the name is gone, the body scrolls it out of view, or the panel hides.
The row itself has no tooltip.

The panel is as wide as its left edge is dragged (double-click for the
default); on a screen under 769 px it is a sheet docked at the bottom, as tall
as its top edge is dragged, with a close button.

It shares the right side with the host's other side panels — Recto's Text
panel, another plugin's — **one at a time**: shown, it emits `sidepanel:shown`
`{ id }` on the bus and hides when another panel's arrives (the host's
convention; `data-side-panel` marks the panels), so its tool (`#toggle-tools`)
switches the right side to it and the Text panel's ¶ tool switches it away.
Whether it is shown is kept in this browser (localStorage
`recto.nameMatching.open`), applied at load — before a later plugin's panel
decides whether to show itself; the first time it is shown. Its size is not
kept.

## How it attaches

- `web/plugins/redaction_matching/plugin.json` declares the toolbar toggle
  (`toolbar_button.html`, `#toggle-tools`), the right panel
  (`sidebar_tools.html`, `#tools-sidebar` — `text_tool` keeps a bar selected
  while it is clicked), `styles.css` (scoped to the panel), and `api.js` as a
  `scripts_before_viewer` entry — one classic script, as Recto's page test
  holds its script list to the recorded one. The lists are fetched by
  `api.js` through `assetURL`.
- Reads `utbState.boxes` (text_tool) and writes `box.text` / `box.labelText`,
  `box.labelColor`, `box.labelAlign`, `box.widths`, `box.widthFace`,
  `box.widthError`, `box.shapedFace`, `box.unshaped`, `box.verdicts`,
  `box.matchPick`, `box.nameSettings`, `box.candidates`.
- Listens to **`redaction:refined`** (remnant letters → letter filter) and
  **`document:opening`**: a measurement or scoring still running for the old
  document's bars stops, and nothing of it is written or drawn (its labelled
  bar used to land on the next document's page 1). A bar no longer in
  `utbState` is never labelled.
- Reads **`box.refineInfo`** (`exact`, `left` / `right`, `blocked`) when a
  refiner wrote it; without one every bar is a raster bar with detector edges.
- Calls **`window.ocrTestHypothesis`** and **`window.ocrMeasureWidths`** when
  defined; **`Shaping.widths`**, **`getNaturalSpaceWidth`**,
  **`renderBox`**, **`GEO`**, **`selectBoxInSVG`** / **`syncToolbarToBox`**
  through guards.
- Globals Recto calls by name: `createNewRedaction` (text_tool's Add Box tool),
  `calculateWidthsForRedaction`, `calculateAllWidths`, `selectRedaction`,
  `updateAllMatchesView`, `renderCandidates`, `syncNameSettingsUI`. Others it
  exposes: `getBoxMatchInfo`, `getBoxMatches`, `fitRange`,
  `effectiveTolerance`, `linkFor`, `halfStrings`, `scoreMatches`,
  `shownMatch`, `setBoxMatch`, `cycleBoxMatch`, `matchesLetterFilter`,
  `matchesGenderFilter`, `parseNamePattern` (→ `{ tree, variants, error }`),
  `nameFromPattern` (one variant), `namesOfPattern` (all of them),
  `patternOfNameTree`, `makeNames`, `setNameList`, and what the ℹ card says
  of an entry: `nameEntryFull`, `nameEntryAlso`, `nameEntryLinks`.

## Tests

`node --test "tests/**/*.test.mjs"` runs both suites in
`tests/plugins/redaction_matching/`:

- `page.test.mjs` — on the generated page: the panel's controls, and what
  `api.js` must (and must not) contain. Skipped when the plugin is not
  installed.
- `matching.test.mjs` — the matcher under Node with the viewer's globals
  stubbed (also runnable on its own:
  `node tests/plugins/redaction_matching/matching.test.mjs`): the fit ranges
  (pixel tolerance, the pen lattice, the detector padding), the loose
  fallback, the near-miss rescue, verdict ranking, the letter filter, the
  two-bar readings (row and line links, one entry across both, settings and
  formats shaping the halves, pinning both bars, halves judged separately, a
  middle initial's and a choice's halves, both bars' gender filters), the
  formats (parts old and new, case, missing names, optional groups, choices,
  escapes and errors, the pills writing a pattern back as it was, what each
  pill action does to the tree, the default format against the old *Full
  name* on `names.json`), the lists (entries' new fields, a middle name not
  written twice, `names.json` filled only where it says so, every
  address-book link a page and every Wikipedia link a section of the list),
  the gender filter, and the ℹ card (cut-off addresses kept out of the
  formats, an entry's full name, other spellings and links, how a reading fits, every entry behind a name, a pair's one person, a list's text
  never markup).

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
find it, and no name-matching panel remains in the page.
