# Artistic and Frame Text — Affinity's text, in Recto

`text_tool` has the two kinds of text object Affinity has — **Artistic text** and **Frame
text** — with Affinity's tools, its text context toolbar and its Character, Paragraph, Text
Frame and Typography panels. Settings are named, ordered and defaulted as in Affinity 3, and
the numbers behind them (leading, first baseline, super/subscript, small caps, decorations,
vertical justification) follow Affinity's own rules. Where Recto differs, the last section
says so.

Both kinds are `harfbuzz` boxes — text the user added, never hidden with the extracted
layers — that carry a **story** (`box.textMode` `'artistic'` | `'frame'`, `box.story`, see
[Unified Text Box](../architecture/unified-text-box.md#artistic-and-frame-text-story-boxes)).
A story is rich text: every character has its own character attributes, every paragraph its
own paragraph attributes.

---

## The tools

| Affinity | Recto (tool column) | What it does |
|---|---|---|
| Frame Text Tool | **Frame Text Tool** `#tt-frame-text-btn` | A **drag** draws a frame and puts the caret in it (a drag that starts on a line of the page takes that line's face, bold / italic and size). **Shift** keeps it square, **Ctrl** draws it from the centre. While dragging, the **arrow keys** make a grid of frames (Left/Right: one column fewer/more, Down/Up: one row more/fewer), **Ctrl+arrows** widen or narrow the gap between them. A **press without a drag** creates nothing — on an object it selects it, on the page it deselects. A press on Artistic or Frame text puts the caret there. |
| Artistic Text Tool | **Artistic Text Tool** `#tt-art-text-btn` | A **click** starts Artistic text with its baseline at the point, in the ribbon's font and size — or, beside a line of the page's text, in **that line's face, bold / italic and size on its baseline** (as Add New Text does). An empty one is half an em wide (a drag's: the drag's width), so it can be seen and pressed. A **drag** sets the size: the font's typographic ascent is the drag's height, the baseline its lower edge. Artistic text breaks only at its returns; its box is its text's extent. Its **corner handles scale** it — every size in the story by the same factor, the opposite corner fixed. |
| — | **Add New Text** `#tt-add-text-btn` | Recto's own one-line box: it snaps to the nearest line of the page and takes that line's face, bold / italic and size. It becomes Artistic text the moment a setting only stories have is used on it (its first baseline stays where it was). |

Both Affinity tools stay armed, as Affinity's do, until clicked again or another placing tool
is chosen. **Escape** leaves the text being edited (the box stays selected), then deselects,
and with nothing selected puts the tool down.

A frame **reflows** when its eight handles resize it. Text that does not fit shows Affinity's
red **overflow marker** at the frame's bottom right.

**Convert to Text Frame / Convert to Artistic Text** (Affinity's Layer menu) are at the foot of
the Text Frame tab: the story stays, and so does the text on the page — the box moves so that
the first line starts and sits where it did (a frame puts its first baseline at its Initial
advance, Artistic text hangs from it); a converted Artistic text's frame is its text's extent.

**Fitting text over the page** — the ribbon's Spacing and Style tools a one-line box has work on
Artistic and Frame text too, through attributes Affinity already has:

- **Space W.** (`fabric-space-width`, px) sets the paragraphs' desired **Word Spacing**
  (Paragraph ▸ Justification, % of the face's space) so that a space is that wide in the face of
  the selection's first character; **Default** (`fabric-default-sw`) is 100 % — the face's own
  space. The pixel view lays the spaces at that width, and the paragraph's desired letter spacing
  after every glyph, as the HTML does.
- **sp#** (`toggle-space-labels`) badges every run of spaces inside a line with its width.
- **Nudge** (`fabric-nudge-mode`) puts a hit area on every character; a character's x nudge is the
  **manual kerning** of the pair it closes (Kerning ▸ Manual on the character before it), so it
  moves that character and the rest of its line. The story's first character moves the whole
  text; the first character of another line has nothing to kern against and has no hit area.

Kerning nobody chose follows the page, as a typed box's does (`utbAutoKerning`, when an analysis plugin answers it).

New Artistic and Frame text is **black**, Affinity's default fill. (A plain typed box keeps
Recto's orange for text the user added.)

### Editing

Double-click a story box, or press on it with either text tool. The browser places the caret,
extends the selection (Shift, double-click a word, triple-click), moves with the arrow keys and
runs input methods; every change goes through the story model.

| Keys | |
|---|---|
| Enter | New paragraph (it takes the current paragraph's attributes) |
| Shift+Enter | Line break inside the paragraph |
| Tab | A tab (to the next tab stop) |
| Ctrl+B / Ctrl+I / Ctrl+U | Bold / Italic / Underline — on unless all of the selection already has it |
| Ctrl+Shift+> / Ctrl+Shift+< | Every character one point larger / smaller |
| Ctrl+Shift+- | Discretionary (soft) hyphen |
| Ctrl+Z / Ctrl+Y | Undo / redo inside the session; leaving it records the session as one step on the box undo stack |
| Ctrl+C / Ctrl+X / Ctrl+V | Plain text; a pasted line feed starts a paragraph |
| Escape | Leave the text (the box stays selected) |

With a **caret** (no selection) a character setting applies to the text typed next, as in
Affinity. While a box is only **selected**, every setting applies to all of its text.

---

## Where the settings are

- **The ribbon** (`#fabric-options-bar`, the text context toolbar) — in Affinity's order: Font
  family and size, **+/−** size, **B I U S**, **Font Colour** with its **Opacity**,
  **Change Case** (UPPERCASE / lowercase / Sentence case / Title Case — rewrites the text),
  **Superscript / Subscript**, **Highlight Colour**, **Align**, **Vertical Align** (frames),
  **Paragraph Leading**, **Bulleted / Numbered List**, **Number of columns** and **Gutter**
  (frames), and buttons that open the panels.
- **The Text panel** (`#tt-studio`, the ¶ button in the tool column) — Character, Paragraph,
  Text Frame, Typography tabs. It floats; drag it by its tabs. A setting that differs inside
  the selection shows blank.

---

## Character

Per character (`box.story…runs[].attrs`). Lengths in points, tracking and kerning in ‰ of an
em, as Affinity's panel shows them.

| Affinity | Attribute | How Recto sets it |
|---|---|---|
| Font Family, Font Size, Font Style | `fontFamily`, `sizePt`, `bold`, `italic` | Faces from the font catalogue; Recto's catalogue has Regular, Bold, Italic, Bold Italic |
| Font Colour (+ opacity) | `color`, `opacity` | The fill; opacity is the fill colour's alpha (decorations without a colour of their own follow it, the highlight does not) |
| Background Colour | `highlight` | Behind the glyphs |
| Kerning: Auto | `autoKern` | The font's GPOS `kern`, else its `kern` table. Affinity has no optical kerning |
| Kerning: Manual | `manualKern` | ‰ added after each character, on top of tracking |
| Tracking | `tracking` | ‰ of the run's size after every glyph |
| Baseline | `baselineShift` | Raises the text; leading unchanged |
| Leading Override | `leadingOverride` | The run's own leading; a line takes the largest leading of its runs |
| Shear | `shear` | Slants each glyph about its baseline (±85°) |
| Horizontal / Vertical Scale | `scaleX`, `scaleY` | Each word scaled about its baseline; horizontal scale takes its scaled width |
| Super/Subscript | `position` | Affinity's synthesis for every font: **58.3 %** of the size, the baseline **33.3 %** of the size up / down |
| No break | `noBreak` | The run is not broken across lines |
| Underline, Strikethrough: No / Single / Double, colour | `underline`, `underlineColor`, `strike`, `strikeColor` | Position and thickness from the font as Affinity reads them: the underline from `post` (fallback 0.1 em below, 0.05 em thick), the strikeout from `OS/2`. A colour of None is the text's |
| Outline Stroke, colour | `strokeWidth`, `strokeColor` | Drawn behind the fill |
| Language | `lang` | Hyphenation and language-specific glyphs (`locl`) |

---

## Paragraph

Per paragraph (`box.story.paragraphs[].attrs`).

| Affinity | Attribute | How Recto sets it |
|---|---|---|
| Alignment: Left, Centre, Right, Justified Left / Centre / Right, Justified All, Towards / Away from Spine | `align` | "Justified X" justifies every line and aligns the last one X. A PDF page read alone is a right-hand page: towards the spine is left |
| Leading: Default / Multiple / % Height / Exactly / At Least | `leadingType`, `leading` | Default is the face's ideal leading, **(hhea ascender − descender + line gap) / em × size** (1.1 × size without `hhea`); Multiple multiplies it; % Height is a percentage of the size; At Least is the larger of ideal and value; Exactly is the value. Every run brings its own, a line takes the largest |
| Left / Right / First Line Indent | `leftIndent`, `rightIndent`, `firstIndent` | |
| Space Before / After, Use space before, Sum | `spaceBefore`, `spaceAfter`, `spaceBeforeMode`, `sumSpacing` | Between paragraphs the larger of after and before (Sum: both). Use space before: only between paragraphs (default), only at the column top, always |
| Tab Stops: default spacing; Left / Centre / Right / Decimal, leaders | `defaultTabs`, `tabs` | Default stops every 36 pt; a tab grows to reach its stop |
| Justification: Word / Letter Spacing min / desired / max | `wordSpacing…`, `letterSpacing…` | 80 / 100 / 133 % and 0 / 0 / 0 % of the space's advance |
| Flow: Start (Anywhere / In Next Column), Keep with previous, Prevent orphans, Keep together, Prevent widows, Keep with next | `startAt`, `keepWithPrevious`, `preventOrphans`, `keepTogether`, `preventWidows`, `keepWithNext` | Between the columns of a frame |
| Hyphenation: auto, min word 5, min prefix 2, min suffix 2, max consecutive | `hyphenate`, `hyphMinWord`, `hyphMinBefore`, `hyphMinAfter`, `hyphMaxLines` | The browser's hyphenation dictionaries (see below) |
| Bullets & Numbering: No List, Bullet, 1 2 3, I II III, i ii iii, A B C, a b c, 01, 001, 0001; text; start at; tab stop indent | `list`, `listChar`, `listSuffix`, `listStart`, `listIndent` | A number counts on from the previous numbered paragraph of its kind; any other paragraph ends the list |
| Drop Caps: enable (3 lines), height in lines, number of characters, distance | `dropLines`, `dropChars`, `dropDistance` | Sized so its cap height spans from the first line's cap height to the last line's baseline |
| Decorations: fill, top and bottom rules | `fill`, `ruleAbove`, `ruleBelow`, `ruleColor`, `ruleWeight` | |

---

## Text Frame

Per frame (`box.frame`). A new frame has them all at zero, as in Affinity.

| Affinity | Attribute | How Recto sets it |
|---|---|---|
| Fill, Stroke | `fill`, `stroke`, `strokeWidth` | The frame shape behind the text |
| Insets (Link Insets) | `insetLeft/Right/Top/Bottom`, `linkInsets` | They never invert the inner box |
| Hide Overflow | `hideOverflow` | Off: what does not fit shows outside the frame |
| Number of columns, Gutter | `columns`, `gutter` | Equal columns; gutters keep their width unless they alone are wider than the frame |
| Balance text in columns | `balance` | |
| Column Rules: colour, weight, style, top / bottom gap | `ruleColor`, `ruleWeight`, `ruleStyle`, `ruleTop`, `ruleBottom` | A line in the middle of every gutter |
| Vertical Position: Top / Centre / Bottom / Justify | `valign` | Centre and Bottom move the lines by half / all of the room left. Justify first gives each paragraph gap up to **Max Paragraph Space**, then spreads the rest evenly over every gap between baselines |
| Max Paragraph Space | `maxParaSpace` | |
| Initial advance: Default / Leading / Pointsize / Ascent / Cap Height / X Height / Fixed; Minimum | `baseline`, `baselineMin` | The first baseline sits **max(metric, Minimum)** below the inner top. Default is the typographic ascent, max(top of 'l', cap height); Cap Height and X Height are the tops of 'H' and 'x'; Fixed is 0 — the baseline at Minimum |
| — | `autoHeight` | Recto: the frame's height follows its text (Affinity has no such switch) |

---

## Typography (OpenType)

Per character. The tab lists only the features the font carries ("Hide irrelevant features",
as Affinity's panel does; untick it to see them all greyed).

- **Ligatures** — Standard (`liga`), Contextual (`clig`), Discretionary (`dlig`), Historical (`hlig`)
- **Alternates** — Contextual (`calt`), Stylistic (`salt`), Swash (`swsh`, `cswh`), Historical
  Forms (`hist`), Ornaments (`ornm`), Slashed Zero (`zero`)
- **Figures** — Style Lining / Oldstyle (`lnum` / `onum`), Width Proportional / Tabular (`pnum`
  / `tnum`), Position Superior / Inferior / Numerator / Denominator / Scientific Inferior
  (`sups` / `subs` / `numr` / `dnom` / `sinf`), Ordinals (`ordn`), Fractions (`frac`)
- **Capitals** — None, Caps to Small Caps (`c2sc`), Small Caps (`smcp`), All Caps, All Small
  Caps, Caps to Petite Caps (`c2pc`), Petite Caps (`pcap`), All Petite Caps, Titling (`titl`),
  Unicase (`unic`); Case-Sensitive Forms (`case`), Capital Spacing (`cpsp`), Titling Alternates
- **Stylistic Sets** — `ss01` … `ss20`

All Caps is always synthesised (upper case). **Small caps** and **caps to small caps** come
from the font, and are synthesised as Affinity synthesises them when it has neither: the
letters drawn as capitals at the font's xHeight / capHeight (OS/2; 0.714 without). All small
caps is synthesised only when the font has neither feature. Petite caps, titling and unicase
come from the font only.

The Character tab repeats Affinity's eight quick toggles: standard ligatures, contextual
alternates, ordinals, fractions, superior and inferior figures, all caps, small caps.

---

## How it is drawn

- **The model** — `story-core.js` (`StoryCore`, no DOM, tested under node): attributes stored as
  overrides of Affinity's defaults, positions `{ p, o }` (paragraph, UTF-16 offset), edits
  (`insertText`, `deleteRange`, `replaceRange`, `applyChar`, `mapChar`, `applyPara`,
  `changeCase`), list markers, and the mapping of attributes to CSS (`runCSS`, `paraCSS`) and of
  face metrics to Affinity's numbers (`scaledMetrics`, `leadingPx`, `firstBaselinePx`,
  `capsPlan`).
- **The face metrics** — `Shaping.faceMetrics` reads the tables Affinity sets text with
  (`hhea`, `post`, `OS/2`), the outlines of H, x, l and q, and the font's OpenType feature
  list, through the same HarfBuzz build that measures widths.
- **The picture** — `story-render.js` draws the story as HTML in a `<foreignObject>` of the
  box's SVG group. The browser shapes it with the very face files HarfBuzz measures (the
  catalogue's `@font-face` rules). What CSS has no word for is laid after the browser's layout:
  the first baseline (the flow is moved until the measured baseline lands at Affinity's initial
  advance), vertical alignment and justification, tab stops, drop caps, scale and shear,
  synthetic small caps, column rules. A frame's flow fills its columns one after another; a line
  that does not fit moves to a column beyond the frame, never shown cut — its being there is
  the overflow.
- **Editing** — `story-edit.js` makes that markup editable. Every leaf `<span data-o>` holds one
  text node and says where in its paragraph it starts, so a DOM position maps to the model
  exactly; every `beforeinput` becomes a StoryCore edit and the story is drawn again.
- **A pixel renderer** — when a plugin defines the `utbPixelRender` seam, a story is drawn through it as one-line pieces: each line cut into one piece per run (a justified line at its spaces too); the browser's layout gives a line's start and baseline relative to the flow, the flow's origin comes from the box's own numbers (the browser truncates a foreignObject's position to a 1/64 px grid, which would move pens on the ¼ px lattice), the seam lays each piece's glyphs and its advance places the next piece. So the first line of Artistic text starts at `box.x` on the baseline it was given — measured on the startup document, the same text typed with Add New Text and with the Artistic Text Tool at the same click draws the same pixels. Only while every piece can be drawn (no highlight, stroke, scale, shear, synthetic super/subscript or small caps, opacity, double lines) and not while the story is edited; otherwise it stays HTML.
- **The panels** — `text-studio.js` binds every control by its `data-k` attribute name;
  `toolbar.js` routes the ribbon to the story while a story box is selected.

---

## Not like Affinity (yet)

- **Text flow between frames** (linking, autoflow), **text wrap** around other objects, the
  **baseline grid**, **optical alignment**, **initial words**, **character and paragraph
  styles**, **font collections** and **variable-font axes** are not there.
- **Columns** are equal; Affinity's per-column widths and gutters are not.
- **Justification** widens spaces (the browser's); the minimum / maximum word and letter
  spacing and the hyphenation zones and scores are kept but not used.
- **Auto-hyphenation** uses the browser's dictionaries: Chrome on Windows, macOS and Android
  has them; an embedded Chromium (such as an app's built-in browser) may not — then only
  discretionary hyphens break words (the Paragraph tab says so).
- **Paragraph decorations** are a fill and a top and bottom rule; Affinity's full edge-by-edge
  decorations are not.
- **Font styles** are the catalogue's four per family.
- **Frame text scale** (resizing a frame to scale its text) is not there; resizing reflows.
- A frame's text is not written into the PDF — like every box, it lives on the page while the
  document is open.

## Files

`web/plugins/text_tool/`: `story-core.js`, `story-render.js`, `story-edit.js`,
`frame-tool.js`, `artistic-tool.js`, `text-studio.js`, `studio.html` (the panel),
`options_bar.html` (the ribbon groups); `shaping.js` (`faceMetrics`). Tests:
`tests/story.test.mjs`, `tests/page-controls.test.mjs`.
