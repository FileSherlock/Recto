# The Text panel — `text-studio.js` + `toolbar.js`

Every setting of text is in one place: the **Text panel** (`#tt-studio`, the fragment
`studio.html`), a side panel docked at the right of the page — never over the page — and on a
phone a sheet at the foot of the screen; its edge (`.tt-resize`) is dragged to make it wider (on
a phone, taller), a double click gives the default size back. It shares the right side with any
other side panel **one at a time**: shown, it emits `sidepanel:shown` `{ id }` and hides when
another panel's arrives (`data-side-panel`), so the ¶ tool (`#tt-studio-btn`) switches the right
side to it and another panel's tool switches it away. Whether it is shown and which tab is open
are kept in this browser (localStorage `recto.textStudio.*`); the first time, a screen wider than
900 px shows it unless another side panel already is. There is no formatting ribbon: the ribbon
row (`#unified-options-bar-container`) holds other plugins' bars.

`text-studio.js` is the panel. `toolbar.js` maps its character settings onto a box that is not
a story (`window.utbPlainChar`), and keeps what every box shares: `getNaturalSpaceWidth` and
the calls that tell the panel the selection changed (`syncToolbarToBox`,
`syncToolbarToSelection` — names kept from the ribbon they once drove). `text-tool.js` adds and
deletes redaction boxes. All are scripts of the `text_tool` plugin (`web/plugins/text_tool/`).
Its fragments: `toolbar_button.html` (the tools in the left column — **Artistic Text**,
**Frame Text**, **Add Redaction Box**, **Undo**, **Redo** and the **Text panel** ¶) and
`studio.html` (the panel).

---

## What the panel acts on

The panel shows and sets the formatting of what is selected — any box — and its scope line
(`#tt-studio-scope`) says which:

| Selected | What can be set |
|---|---|
| **Artistic or Frame text** (`box.textMode`) | Everything — the selection of the text being edited, else all of the box's text (`storyApplyChar` / `storyApplyPara` / `storyApplyFrame`, [Artistic and Frame Text](artistic-and-frame-text.md)). A plain typed `harfbuzz` box becomes Artistic text on its first change (`ensureStory`) |
| **A box with one face** — an OCR line, embedded text, a redaction box's label | Its own fields (`utbPlainChar`, below): font family, size, style, **B I U S** (single lines), colour and opacity, pair kerning, tracking, space width, nudge; a redaction box also its match terms. Everything else is **locked** — greyed, a lock, the reason on hover; the Paragraph, Frame and Typography tabs say so once, at their top |
| **Nothing** | The font family and size **new text** takes (`TextPanel.newText()`; fonts.js puts the document's face there, a change made here is the user's own default), and the match terms a new redaction box takes |

While Artistic or Frame text is edited the **keyboard stays with the text**: a button pressed in
the panel or the tool column — **B**, a tab, **−/+**, a tool — never takes it (`story-edit.js`
keeps the focus in the text), and a menu, a checkbox or a colour gives it back once its change
is made (`storyFocus`); a field typed in, such as the size, gives it back at **Enter**. So
choosing **B** at a caret and typing goes on in bold, and the font menu's type-ahead never
re-fonts the selection. **Escape** leaves the text from the panel as it does from the text (the
box stays selected; the next Escape is the page's).

A setting the target or the drawing cannot have is locked (`lockOf` in `text-studio.js`):
a box with one face has no paragraph, frame, OpenType or decoration-colour settings; the Frame
tab belongs to Frame text (its **Convert to Text Frame** stays usable); and while a **pixel
renderer** draws the text (below), what it cannot draw.

### The Character tab

| Control | Story attribute | A box with one face |
|---|---|---|
| `#fabric-font-family` (filled from the catalogue by `fonts.js`), `#fabric-font-size` (pt), `#tt-ch-style`, `#tt-size-down` / `#tt-size-up` | `fontFamily`, `sizePt`, `bold`, `italic` | `box.fontFamily`, `box.sizePt` (points, stored and shown as they are), `box.bold`, `box.italic` |
| **B I U S** `#fabric-bold`, `#fabric-italic`, `#fabric-underline`, `#fabric-strikethrough` | `bold`, `italic`, `underline`, `strike` (`single`) | `box.bold`, `box.italic`, `box.underline`, `box.strikethrough` |
| `#tt-change-case` | rewrites the text (`storyChangeCase`) | locked |
| Font Colour `#tt-ch-color` (+ `#tt-ch-color-on`), Opacity `#tt-ch-opacity` (%) | `color`, `opacity` | `box.color` (none: the type's colour), `box.opacity` |
| **Pair kerning** `#kerning` (+ `#tt-kern-source`, ↺ `#tt-kern-page`) | `autoKern`: `true`, `false`, `null` = as the page | `box.kerning` + `box.kerningAuto` |
| Manual kerning `#tt-ch-kern`, Tracking `#tt-ch-tracking` (‰ of an em) | `manualKern`, `tracking` | Tracking: `box.letterSpacing` (em) = ‰ ÷ 1000 |
| **Space width** `#fabric-space-width` (px) + **Font's** `#fabric-default-sw` | the paragraphs' desired Word Spacing (% of the face's space) | `box.spaceWidth` / `box.defaultSpaceWidth` |
| **Space as this line** `#tt-space-line` (+ `#tt-space-line-src`) | each paragraph's desired Word Spacing: the space of the page's line under its first line; and its `tabs` where that line goes on after a tab | locked |
| **Nudge characters** `#fabric-nudge-mode` | the pair's manual kerning (`micro-typo.js`) | `box.charAdvances` (while `utbCharsValid(box)`) |
| Background, Position & Transform, Decorations, Typography, Language | see [Artistic and Frame Text](artistic-and-frame-text.md) | locked |
| **Redaction match** `#tt-settings`: `#tolerance` (px), `#tt-name-case` (`#tt-match-scope` says whose) | — | a redaction box's `box.tolerance`, `box.uppercase` (`utbApplyCase`); shown for a redaction box and with nothing selected. The ids are read by whichever matching plugin is installed |

`#utb-delete-box` (beside the scope line) deletes the selected box (`utbDeleteBox`); Delete /
Backspace do the same outside a text field.

### Pair kerning

The font's pair kerning — **Yo**, **AV**, **To**, **Wa** set closer — is a checkbox showing the
kerning as drawn, and beside it where that comes from:

- **as the page: on / off** — nothing was chosen: the text kerns as the page's producer set
  this face, which an analysis plugin learns from the page's pixels and answers through the
  guarded seam `window.utbAutoKerning(box)` (`true` / `false` / nothing known);
- **unread page: off** — nobody has read the page: the text is set as Word sets text,
  **without** pair kerning (`StoryCore.resolveKern`; Word kerns only when asked);
- **yours (page: on / off)** — set with the checkbox, in both directions; ↺ follows the page
  again.

A story keeps the choice per character (`autoKern` `true` / `false`, `null` = as the page); a
box with one face in `box.kerning` + `box.kerningAuto` (true = as the page). A box that follows
the page is drawn again when a reader learns the page's kerning.

Measured over the eval harness's corpus (recto-eval, 2026-10-18 — 43 documents, 30,836 lines
read and certified): every page Word made, and every synthetic page set like Word, is set
**without** pair kerning; the Times e-mail printouts are kerned. 47 % of the lines hold a kern
pair of their face, so the choice decides them: text typed with the page's kerning reproduces
77.1 % of the lines pixel for pixel; with kerning always on (the old default for an unread
page) Word's Calibri page drops from 62.7 % to 15.7 %; with it always off the kerned e-mails
drop from 84.1 % to 33.1 %.

### Space width, Nudge

**Space width** sets the width of a space in px: a story's paragraphs' desired word spacing,
shown in px of the face's space of the selection's first character, or a plain box's manual
space width (its measured positions are moved by the difference). **Font's** is the face's own
space (100 %; a plain box: `box.spaceWidth = null`); unticking it starts from the face's space
measured by HarfBuzz (`getNaturalSpaceWidth`).

**Space as this line** (`#tt-space-line`) gives each paragraph of a story — the selection's
while the text is edited, else all — whose first line sits on a line read from the page the
space that line was set with, as its desired word spacing (`storyApplyParaEach`, one undo
step). Word justifies a line by widening its spaces, each line by its own amount; text retyped
over it with the face's own space misses the page's words by several px by the line's end (on
a justified Word affidavit, up to 74 px). Where the line goes on after a tab, the paragraph
also takes the line's tab stops (below). Beside the button, the space of the line under the
text and its stops (`#tt-space-line-src`: `line: 7.90 px`, `line: the font's`, `line: 8.09 px ·
tab at 36 pt`); the button is lit while every paragraph it would set has them. A new Artistic
text clicked on a line takes that line's space and stops already (`artistic-tool.js
create()`). The button is locked, with the reason, on a box with one face, on text no line of
the page is under, and over a line with neither a single space between two words nor a tab.

Which line: `utbLineAt(page, { x, y, h })` (`unified-text-box.js`) — the OCR or embedded line
from the most accurate source on that row (`utbLineRank`: certified OCR > embedded > tolerant
OCR, regardless of whether its overlay is hidden) whose band overlaps the band of the
paragraph's first line by half the smaller height at least (`storyParaStarts`: its first
character's box, an empty paragraph's caret line); of a row cut by redaction bars, the piece
the text starts in. How much: `utbLineWordSpacing(line,
face)` —

- the line's measured characters (`baseCharPositions`: a reader's pens, a PDF's positions) say
  where each of its words starts (`StoryCore.lineWords`); a piece of a cut row with no space of
  its own takes every piece of its row (`utbLinePieces`), each on its own;
- HarfBuzz lays the line's text in the paragraph's face as it is drawn — its kerning (as the
  page), ligatures, tracking — at the face's own space (`Shaping.widths`);
- each single space between two words is then the page's distance between their starts less
  the face's, plus the face's own space — what a typed space must be for the next word to land
  where the page's does — and the line's space is their mean (`StoryCore.lineSpace`), which
  lands its last word where the page has it. A tab's gap is left out (below). The page's own
  glyph room is not used: a reader's advances are off the face's by a few hundredths of a px a
  word, which a line of twelve spaces adds up, and a kerned page kerns the space before an *A*,
  which the face kerns again. Where the face sets the word before a space
  more than half a pixel off the room the page's glyphs take (`StoryCore.WORD_FIT`), the word is
  not in that face — an OCR layer's invisible text, stretched to the scan's words under a size
  of its own — and that space is what the page leaves between the two words;
- when the face's own space lands the line's spaces within a quarter pixel of the page's — the
  pen lattice MuPDF draws on (`StoryCore.wordSpacingFor`, `PEN_STEP`) — the face's own is kept
  (100 %): a line set with it reads back a hair off it, and the face's own draws it pixel for
  pixel.

Measured in the app (2026-10-18, headless Chrome): Artistic text made by the tool's click at the
start of every line read from 16 documents' first pages (731 lines), the line's text typed in,
every glyph's x against the page's — lines whose every glyph lies within ½ px: 495 with the
face's own space, **557** with the line's. The 77 lines given a space of their own (Word's
justified lines) go from 2 to 64, and from 1 to 10 drawn pixel for pixel by a pixel renderer;
every other line is drawn as before. What was left was mostly tab gaps after list labels and
bullets, which typed spaces take at the line's space — now a tab stop:

**A label's tab.** Word sets a list item as its label ("2.", "w.", "•"), a tab, and its text
from the list's tab stop. A reader writes the tab's gap as the spaces that fill it at the
line's space — "2.    Evidence" with four, "x.   A Lenovo" with three, "w. A Lenovo" with one —
and spaces typed for it miss the page's text by up to half a space or more, the rest of the
line with it (on the affidavit 0.5–3.8 px). Which gaps are a tab's, `StoryCore.lineTabGaps`: a
run of spaces, or one space wider than the line's own by `TAB_GAP` — 1 px over the lower middle
of its single spaces (Word sets a justified line's spaces alike: on 877 read lines of 22
documents every other single space is within 0.52 px of its line's, and the affidavit's three
labels written with one space are 1.35–2.5 px wider). Such a gap says nothing about the line's
space (`lineSpace` leaves it out), and where it ends the line goes on (`StoryCore.lineTabs`;
`utbLineInfo`'s `tabs`: the page x of each word after one). `utbLineTabStops(line, x0)` makes
them left tab stops, in pt from a paragraph's left edge `x0` (none at or before it): the click's
new paragraph's, from its first pen, and Space as this line's, from the paragraph's first
character less its first-line indent. A tab typed after the label grows to its stop
(`story-render.js` `passTabs`) and the text after it starts on the page's, to Chrome's 1/64-px
layout unit. Two spaces after a full stop are a run too: a stop there leaves typed spaces as
they were.

Measured the same way (2026-10-18, 22 documents, 877 lines, each line typed as a person retypes
it — a tab after a list label, the reader's spaces elsewhere): lines within ½ px **624 → 664**.
The affidavit's 12 list lines go from 0.53–3.83 px to 0.17–0.33 px (all 35 of its lines within
½ px); with their bullets and numbers, 20 of the Arial memo's 20 lines are within ½ px (14
before), 48 of the FBI summary's 51 (37; its second release 43 of 46, 32); no line is further
off, in a word or in pixels (pixel-exact 650 → 653). Typed with spaces instead of a tab, 39 of
the 42 lines given a stop land as before; the affidavit's three labels written as one space
land 0.25–0.42 px further off (1.30–2.20 → 1.66–2.63 px), the line's space no longer counting
the tab's gap.

**Nudge characters** enters micro-typography mode (`enterMicroTypo`): every character gets a
hit area, and a character's x nudge is the manual kerning of the pair it closes (a story) or
its `charAdvances` delta (a plain box, while its measured positions hold — `utbCharsValid`;
otherwise the button is disabled and says why). Pressing it again or Escape leaves it.
Double-click is a different gesture: it starts inline text editing (`inline-edit.js`).

### Display

The panel's foot holds the switches that change how the page's text is drawn, for every box:
**Space widths** (`#toggle-space-labels` → `setShowSpaceWidthLabels`: the width of every run
of spaces, and beside a redaction box its gaps to the text, in `utbBarGaps`' terms) — and any
plugin's Settings section marked `data-text-panel`, which moves here from the Settings panel
when the Text panel is installed (and stays in Settings when it is not).

### A pixel renderer, and what it cannot draw

A plugin that draws text as raster pixels (the `utbPixelRender` seam, see
[Artistic and Frame Text](artistic-and-frame-text.md#how-it-is-drawn)) says whether it is
drawing through `window.utbPixelRenderOn()` (its name, or null) and the `pixels:changed` hook.
While it draws, the panel locks what it cannot draw — `StoryCore.PIXEL_LIMITS`: opacity, a
background colour, an outline, scales, shear, synthesised super/subscript and OpenType figure
positions, small caps (All Caps can be drawn), double lines (single ones can) — and what it lays
past, `StoryCore.PIXEL_IGNORES`: the OpenType features (one glyph per character, as the page's
producer set them). A paragraph's list markers, fill and rules and a frame's column rules are
HTML around the text and are locked too. The reason names the renderer and how to unlock:
turn it off in the Display section.

---

## Font Size Units

Font size has a single canonical unit — **points** — stored on `box.sizePt`. The panel reads
and writes that value directly, with no DPI conversion. Points are converted to image pixels
exactly once, at the SVG render boundary (`GEO.docPtToPx(box.sizePt)` in `svg-renderer.js`).
There is no separate px `fontSize` field. The conversion helpers live on `window.GEO`, defined
by the core's `web/core/geometry.js` — the coordinate contract.

The font menu **shows the box's family even when the catalogue lacks it** (an option marked
"not installed" is added), so a menu left on another family never re-fonts a box.

---

## Settings and measured positions

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
all read one effective value. The Pair kerning checkbox clears the flag; ↺ sets it again.

Every change to a `redaction` box's typography also calls
`calculateWidthsForRedaction(box.id)` behind a `typeof` guard: `text_tool` does not define
that function — it resolves when a plugin supplies it and no-ops when none does. See
[Optional Plugins](../plugins/).

---

## Natural Space Width

When **Font's** is unticked on a plain box, the space width starts from the font's natural
space advance, measured by HarfBuzz — a call into `shaping.js` in the same plugin, in the page
([Text Measurement](width-calculator.md)):

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

The result is written to `box.spaceWidth` and `box.nativeSpaceWidth`, and cached per face, size,
kerning and scale. Ticking **Font's** again sets `box.spaceWidth` to `null` (native font
spacing). The helper is exposed as `window.getNaturalSpaceWidth(box)` for plugins that need
the same number.

---

## Event Wiring

The data-k controls go through one handler (`onChange` → `apply`): a story's through
`storyApplyChar` / `storyApplyPara` / `storyApplyFrame`, a plain box's through
`utbPlainChar.apply(box, patch, key)` — one undo step, a `key` collapsing a field's live
changes (`char:sizePt:<id>`, …) — and with nothing selected the font and size of new text.

| Event | Element | Action |
|-------|---------|--------|
| `change` / `input` | any `[data-k]` control | `apply(scope, { key: value })` as above |
| `click` | a `[data-toggle]` button (B I U S, the quick Typography toggles) | its attribute to its on / off value |
| `change` | `#kerning` | `apply('char', { autoKern: checked })` |
| `click` | `#tt-kern-page` | `apply('char', { autoKern: null })` — as the page again |
| `change` | `#fabric-default-sw` | the face's space (`wordSpacing: 100` / `spaceWidth = null`), or the measured natural width to start from |
| `input` / `change` | `#fabric-space-width` | a story's word spacing (% of its face's space), a plain box's `spaceWidth` |
| `click` | `#tt-space-line` | each target paragraph's `wordSpacing` from the page's line under it (`utbLineAt`, `utbLineWordSpacing`, `storyApplyParaEach`), and its `tabs` where that line goes on after a tab (`utbLineTabStops`) |
| `click` | `#fabric-nudge-mode` | `enterMicroTypo` / `exitMicroTypo` on the selected box |
| `click` | `#tt-size-up` / `#tt-size-down` | every run's size ± 1 pt (`storyMapChar`), a plain box's `sizePt` ± 1, new text's size |
| `change` | `#tt-change-case` | `storyChangeCase` |
| `change` | `#tolerance`, `#tt-name-case` | the selected redaction box's `tolerance` / `uppercase`; guarded calls into a matching plugin |
| `change` | `#toggle-space-labels` | `setShowSpaceWidthLabels(checked)` |
| `click` | `#tt-studio-btn`, `#tt-studio-close` | show / hide the panel |
| `click` | `#toggle-embedded-text` | Toggle `hide-embedded-text` on `<body>` — shows / hides every `embedded` box |
| `click` | `#utb-delete-box` | `utbDeleteBox(utbState.selectedId)` |

`window.TextPanel` = `{ open, close, sync, newText, setNewText }`; `window.openTextStudio(tab)`
opens it on a tab.

---

## Lifecycle: `text-tool.js`

> Span extraction and the `document:loaded` lifecycle subscription live in `web/plugins/embedded_text_viewer/etv-fetch.js`. `text-tool.js` handles only manual box creation and deletion.

### Placing new boxes

The click itself is caught by the core (`app.js`, a `mousedown` on the viewer), which maps it to document pixel space and, for the add-box tool, calls `handleManualAddBox` behind a `typeof` guard. Text is added with the Artistic and Frame Text tools, which catch their own presses (below).

- `window.handleManualAddBox(pageNum, x, y)`: delegates to `createNewRedaction()` if a plugin supplies it, otherwise creates a `type='redaction'` box directly. Takes the nearest line from `utbFindNearestLine` (`unified-text-box.js`, preferring the most accurate source on that row regardless of whether its overlay is hidden); without one, the font and size new text takes (`newTextFont()`, the Text panel's).

### Artistic and Frame text

`frame-tool.js` (the Frame Text Tool) and `artistic-tool.js` (the Artistic Text Tool) place
story boxes; `storyConvert(box, 'frame' | 'artistic')` converts between them. See
[Artistic and Frame Text](artistic-and-frame-text.md).

### Deleting a box

`window.utbDeleteBox(id)` is the one removal path for every box type — the Text panel's Delete button and the Delete / Backspace keys both use it. A live session on the box is ended first, so no id in `utbState` outlives the box it points at: an inline edit (`cancelInlineEdit`) or micro-typo mode (`exitMicroTypo`) is torn down, and Artistic or Frame text being edited is committed (`commitStoryEdit`) — its edit is a step of its own before the delete's, so Undo brings the text back as it was typed. The keys are ignored while the caret is in a field, where they mean "erase a character". `utbDeleteBox(id, { silent: true })` is the undo stack taking a box out again — not a step of its own (a session still open on the box ends without one).

## Label seams — `labelColor`, `labelAlign`

Two fields a plugin that judged a box's label may set; `text_tool` reads them and never
sets them. `box.labelColor` is a CSS colour for the label (`null` = the type's colour; the
user's own `box.color` wins). `box.labelAlign` is `'right'` when a label laid afresh (no
measured character positions) should end at the box's right edge instead of starting at
its left — the SVG text takes `text-anchor: end` at `box.x + box.w`; a pixel renderer lays
the text so that it ends there. Both are transient like the label itself: the undo stack
does not keep them.

## Undo — `undo.js`

One stack (`window.utbUndo`) for what the user does to boxes: add, delete, move, resize, edit the text, change the formatting, nudge a character. What a plugin puts on the page by itself — an OCR read, the embedded text, a matcher's label — is regenerated, never undone, and a new document empties the stack (`document:opening`).

- `utbUndo.capture(boxes)` → token, then `utbUndo.commit(token, label, key)`: records the fields that changed between the two calls (nothing is pushed when nothing changed). A box's derived data — candidate widths, verdicts, the refiner's findings, the pixel raster — is not part of a step; it is derived again after a restore (a redaction whose typography changed has its widths measured again).
- `utbUndo.recordAdd(boxes, label)` / `utbUndo.recordDelete(box, index, label)`: an add or a delete, put back at the same index.
- **Collapsing.** Steps with the same `key` collapse while they follow each other: every drag of one box (`move:<id>`, its ruler marker's too — `ruler.js`), every tick of one slider (`size:<id>`, `space:<id>`, `color:<id>`), every nudge of one character (`nudge:<id>:<i>`) is one step, as Word collapses repeated typing. Any other action in between starts a new step; a collapsed step that ends where it began is dropped. A collapsed step holds every box any of its actions touched, each as it was before the first and as it is after the last — a drag of one piece of a line sideways, then of the whole line down, is undone and redone whole.
- `undo()` / `redo()` / `canUndo()` / `canRedo()` / `peek()` / `clear()` / `onChange(fn)`. An edit still open — Artistic or Frame text (`commitStoryEdit`), an inline edit (`commitInlineEdit`) — is committed before `undo()` or `redo()` moves the stack: the Undo button pressed while typing takes the typing back as one step, and no edit goes on in a box the stack removed or changed under it. (Never from inside an entry's own undo: a step committed there would cut the stack.)

The buttons are `#tt-undo` / `#tt-redo` (the fragment `toolbar_button.html`); the keys are Ctrl/⌘+Z and Ctrl/⌘+Shift+Z or Ctrl/⌘+Y — ignored while a field typed in (a text or number field) has the caret or an inline edit is open, where they are the field's own. A menu, a checkbox or a colour that has the keyboard — as one does right after a change in the Text panel — leaves them to the stack.

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
  resolve to the right file), fills the Text panel's font menu `#fabric-font-family`, and exposes
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

`fonts.js` listens to two generic `PDFHooks` events and sets the font and size
new text takes from them (`TextPanel.setNewText`; the panel shows them while
nothing is selected — without the panel, the menu's own value), so the core
keeps no font list and no plugin is named:

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
