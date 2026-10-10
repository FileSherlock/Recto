# UI Map — every visible control, who owns it, where it's wired

Lookup table for change requests phrased from the UI ("move the button with
tooltip X", "the Y slider does nothing"). Find the control by its label or
hover tooltip; the row names the owning plugin, the template that renders it,
and the script that handles it.

**Baseline only.** Optional plugins document their own UI in
`guide/plugins/<plugin>/` and are never listed here (see `guide/plugins/README.md`).

**Keep this file current:** whenever a control is added, moved, renamed, or
removed, update its row in the same change. New DOM ids take the owning
plugin's prefix (`tt-` text_tool, `etv-` embedded_text_viewer, `webgl-`
webgl_mask); legacy unprefixed and `fabric-*` ids belong to text_tool unless a
row says otherwise. Core chrome ids are unprefixed.

## Top toolbar

Core chrome only: `web/core/index.template.html`, wired in `web/core/app.js`. In the tables,
`core/<file>` is `web/core/<file>` and `<plugin>/<file>` is `web/plugins/<plugin>/<file>`.

| Label / tooltip | id | Template (owner) | Wired in |
|---|---|---|---|
| Toggle thumbnails | `toggle-sidebar` | `core/index.template.html` | `core/app.js` |
| Previous / Next Page, page number | `prev-page`, `next-page`, `page-input` | `core/index.template.html` | `core/app.js` |
| Zoom out / in, zoom % (also Ctrl+wheel) | `zoom-out`, `zoom-in`, `zoom-input` | `core/index.template.html` | `core/app.js` |
| Upload PDF (and drag-and-drop) | `upload-pdf-btn` + hidden `pdf-file` input | `core/index.template.html` | inline onclick + `core/app.js` |
| Settings | `toggle-settings` | `core/index.template.html` | `core/app.js` — opens `#settings-panel`; hidden when no plugin contributes a section |

## Tool column (`#tool-column`, left of the page)

Every plugin's `toolbar_button.html` lands in `#tool-column-items`, in the order of the
plugins' `order` values. The user reorders and hides tools in the **Customise tools** panel
(`tool-column-customise` → `#tool-customise`, `core/app.js`; kept in `localStorage` under
`recto.toolColumn`); a hidden tool moves into `#tool-column-overflow`, the **More tools**
popover (`tool-column-more`), and keeps working there.

| Label / tooltip | id | Template (owner) | Wired in |
|---|---|---|---|
| Toggle Embedded Text | `toggle-embedded-text` | `embedded_text_viewer/toolbar_button.html` | `text_tool/toolbar.js` (guarded `?.`) — toggles body class `hide-embedded-text`. embedded_text_viewer contributes no bar; this toggle is its only UI |
| Toggle WebGL Mask | `toggle-webgl` | `webgl_mask/toolbar_button.html` | `webgl_mask/webgl-mask.js` — opens `#webgl-options-bar` |
| Add New Text (click on page) | `tt-add-text-btn` | `text_tool/toolbar_button.html` | arm the tool: `text_tool/toolbar.js`; placement on page click: `core/app.js` → `handleManualAddText` (`text_tool/text-tool.js`) |
| Artistic Text Tool (click to type; drag sets the size; corners scale) | `tt-art-text-btn` | `text_tool/toolbar_button.html` | `text_tool/artistic-tool.js` — stays armed; a press on a story box edits it (`drag-resize.js`) |
| Frame Text Tool (drag a frame; arrows while dragging: a grid of frames) | `tt-frame-text-btn` | `text_tool/toolbar_button.html` | `text_tool/frame-tool.js` — stays armed; a press on a story box edits it (`drag-resize.js`) |
| Add Redaction Box (click on page) | `tool-add-box` | `text_tool/toolbar_button.html` | arm the tool: `core/app.js`; placement: `handleManualAddBox` (`text_tool/text-tool.js`) |
| Undo / Redo (Ctrl+Z, Ctrl+Shift+Z) | `tt-undo`, `tt-redo` | `text_tool/toolbar_button.html` | `text_tool/undo.js` — the tooltip names the step |
| Text formatting | `toggle-fmt` | `text_tool/toolbar_button.html` | `text_tool/toolbar.js` — opens/closes `#fabric-options-bar` via `openSubtoolbar` |
| Text panel — Character, Paragraph, Text Frame, Typography | `tt-studio-btn` | `text_tool/toolbar_button.html` | `text_tool/text-studio.js` — opens/closes `#tt-studio` |
| Customise tools… | `tool-column-customise` | `core/index.template.html` | `core/app.js` |
| More tools | `tool-column-more` | `core/index.template.html` | `core/app.js` — shown only while some tool is hidden |

## Settings panel (`#settings-panel`)

One panel; each plugin's `settings` fragment is a section of it (`#settings-sections`).

| Section | Controls (id) | Template (owner) | Wired in |
|---|---|---|---|
| Redaction match (`tt-settings`; `tt-match-scope` says whether the fields are the selected box's or the defaults for new boxes) | `tolerance` (width tolerance, px), `tt-name-case` (letter case: as typed / UPPERCASE / FIRST name / LAST name) | `text_tool/settings.html` | `text_tool/toolbar.js` (`applyMatchControls`, `syncMatchSettings`); the ids are also read by whichever matching plugin is installed — inert when none is |

## Ribbon row (`#unified-options-bar-container`, below the toolbar)

The core hosts this row (`index.html`); plugins inject bars into it. A
`.ribbon-bar` is persistent; an `.options-bar` is contextual — one visible at a
time, coordinated by `openSubtoolbar` in `core/app.js`. The row never scrolls:
groups that do not fit move under **More options** (`ribbon-more` →
`#ribbon-overflow`, `core/app.js`) and come back when there is room.

### Formatting bar — `#fabric-options-bar` (text_tool, contextual)

Same template. Revealed when a text/redaction box is selected
(`syncToolbarToBox` in `toolbar.js`), hidden on deselect (`drag-resize.js`),
or toggled manually via `toggle-fmt`.

| Group | Controls (id) | Wired in |
|---|---|---|
| Font | `fabric-font-family` (menu filled from the font catalogue by `text_tool/fonts.js`; preselected from the document's declared fonts or a plugin's `typography:detected`), `fabric-font-size` | `text_tool/toolbar.js` |
| Style | `fabric-bold` / `fabric-italic` / `fabric-underline` / `fabric-strikethrough`, `fabric-color`, **Opacity** `fabric-opacity` (slider) + `fabric-opacity-value` (%), `kerning`, `fabric-nudge-mode` | `text_tool/toolbar.js` (nudge mode itself lives in `micro-typo.js`) |
| Text *(Artistic / Frame text and typed boxes only)* | `tt-text-group`: `tt-size-up`, `tt-size-down`, `tt-change-case`, `tt-superscript`, `tt-subscript`, `tt-highlight-btn` + `tt-highlight` | `text_tool/toolbar.js` (`syncStoryControls`) → `story-edit.js` |
| Paragraph *(same)* | `tt-para-group`: `tt-align`, `tt-valign` (frames), `tt-leading-type` + `tt-leading`, `tt-bullets`, `tt-numbers` | `text_tool/toolbar.js` → `story-edit.js` |
| Columns *(frames)* | `tt-columns-group`: `tt-columns`, `tt-gutter` | `text_tool/toolbar.js` → `storyApplyFrame` |
| Panels *(story text)* | `tt-panels-group`: `tt-open-character`, `tt-open-paragraph`, `tt-open-frame`, `tt-open-typography` | `text_tool/text-studio.js` (`openTextStudio`) |
| Spacing | `fabric-letter-spacing`, `fabric-default-sw`, `fabric-space-width` (+ `-display`), `toggle-space-labels` | `text_tool/toolbar.js` |
| Box | `utb-delete-box` — removes the selected box of any type (also bound to Delete / Backspace, ignored while a field has the caret) | `utbDeleteBox` in `text_tool/text-tool.js` |

The redaction-only match terms (tolerance, letter case) are in the Settings panel above.
While Artistic or Frame text is selected, Font, Style and the story groups act on the
selected characters when it is edited, on all of its text otherwise. Space W. / Default set the
paragraphs' desired word spacing (shown in px of the face's space), sp# badges their spaces, and
Nudge kerns the pair before the pressed character (`micro-typo.js`, disabled while the text is
edited) — see `guide/frontend/artistic-and-frame-text.md`.

### WebGL Masks bar — `#webgl-options-bar` (webgl_mask, contextual)

Template: `web/plugins/webgl_mask/options_bar.html`

| Label / tooltip | id | Wired in |
|---|---|---|
| Reveal Strength | `edge-subtract` | `webgl_mask/webgl-mask.js` |

## Text panel — `#tt-studio` (text_tool)

Template: `web/plugins/text_tool/studio.html`; wired in `text_tool/text-studio.js` by each
control's `data-k` (`char:` / `para:` / `frame:` + a StoryCore attribute). Floating; drag it by
its tabs (`tt-studio-head`), close `tt-studio-close`; `tt-studio-scope` says what it acts on.
All of it is described in [Artistic and Frame Text](frontend/artistic-and-frame-text.md).

| Tab | Controls (id prefix) |
|---|---|
| Character | `tt-ch-*`: family, size, style, colour + opacity, background colour; Position & Transform (kerning, shear, tracking, scales, baseline, leading override, super/subscript, no break); Decorations (underline, strikethrough, outline stroke); Typography quick toggles `tt-q-*` and `tt-show-typography`; language |
| Paragraph | `tt-pa-*`: alignment `tt-pa-align`; spacing (leading, indents, space before / after, use space before, sum); tab stops (`tt-pa-deftabs`, `tt-pa-tabs`, `tt-pa-tab-add`); justification; flow options; hyphenation; bullets & numbering; drop caps (`tt-pa-drop-on`); decorations |
| Text Frame | `tt-fr-*`: fill, stroke, insets (`tt-fr-link`), Hide Overflow, height follows the text; columns, gutter, balance; column rules; vertical position (`tt-fr-valign`, max paragraph space, initial advance, minimum); `tt-convert-frame`, `tt-convert-art` |
| Typography | `tt-ot-*`: hide irrelevant features `tt-ot-hide`; ligatures; alternates; figures; capitals (`tt-ch-caps`); stylistic sets `tt-ot-ss` |

## Panels

- **Left thumbnails sidebar** — `#sidebar` in `core/index.template.html`, toggled
  by `toggle-sidebar` (`app.js`).
- **Right panel** — none in the baseline. A plugin that wants one supplies its
  own container, CSS, and toggle wiring (see `tool-expansion-guide.md`).
