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
| Upload PDF (and drag-and-drop) | `upload-pdf-btn` + hidden `pdf-file` input | `core/index.template.html` | `core/app.js` (the button clicks the hidden input) |
| Settings | `toggle-settings` | `core/index.template.html` | `core/app.js` — opens `#settings-panel`; hidden while no section is in it (a section a plugin moves elsewhere — into the Text panel's Display — no longer counts) |

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
| Artistic Text Tool (click to type; drag sets the size; corners scale) | `tt-art-text-btn` | `text_tool/toolbar_button.html` | `text_tool/artistic-tool.js` — stays armed; a click on a line of the page takes its face, size, baseline and space, and a tab stop where it goes on after a tab (a list label's: type the label, Tab, the text); a press on a story box edits it (`drag-resize.js`); a press on the ruler's marker or a nudge's slider is theirs, not the page's |
| Frame Text Tool (drag a frame; arrows while dragging: a grid of frames) | `tt-frame-text-btn` | `text_tool/toolbar_button.html` | `text_tool/frame-tool.js` — stays armed; a press on a story box edits it (`drag-resize.js`); a press on the ruler's marker or a nudge's slider is theirs, not the page's |
| Add Redaction Box (click on page) | `tool-add-box` | `text_tool/toolbar_button.html` | arm the tool: `core/app.js`; placement: `handleManualAddBox` (`text_tool/text-tool.js`) |
| Undo / Redo (Ctrl+Z, Ctrl+Shift+Z) | `tt-undo`, `tt-redo` | `text_tool/toolbar_button.html` | `text_tool/undo.js` — the tooltip names the step; a text being edited is left first (its edit is the step Undo takes back) |
| Text panel — font, spacing, kerning, paragraph, frame, typography and display | `tt-studio-btn` | `text_tool/toolbar_button.html` | `text_tool/text-studio.js` — shows / hides the docked `#tt-studio` |
| Customise tools… | `tool-column-customise` | `core/index.template.html` | `core/app.js` |
| More tools | `tool-column-more` | `core/index.template.html` | `core/app.js` — shown only while some tool is hidden |

## Settings panel (`#settings-panel`)

One panel; each plugin's `settings` fragment is a section of it (`#settings-sections`). The
baseline contributes none: text_tool's settings are in its Text panel, and a section marked
`data-text-panel` moves into the Text panel's Display section (`text_tool/text-studio.js`).
With no section left the Settings button is hidden.

## Ribbon row (`#unified-options-bar-container`, below the toolbar)

The core hosts this row (`index.html`); plugins inject bars into it. A
`.ribbon-bar` is persistent; an `.options-bar` is contextual — one visible at a
time, coordinated by `openSubtoolbar` in `core/app.js`. The row never scrolls:
groups that do not fit move under **More options** (`ribbon-more` →
`#ribbon-overflow`, `core/app.js`) and come back when there is room.

### WebGL Masks bar — `#webgl-options-bar` (webgl_mask, contextual)

Template: `web/plugins/webgl_mask/options_bar.html`

| Label / tooltip | id | Wired in |
|---|---|---|
| Reveal Strength | `edge-subtract` | `webgl_mask/webgl-mask.js` |

## Text panel — `#tt-studio` (text_tool)

Template: `web/plugins/text_tool/studio.html`; wired in `text_tool/text-studio.js` (a box that
is not a story: `text_tool/toolbar.js` `utbPlainChar`). Every setting of text: a side panel
docked at the right of the page, sharing it with any other side panel one at a time (a sheet at
the foot of the screen on a phone); shown / hidden with `tt-studio-btn` — which switches the right
side to it from another side panel — closed with `tt-studio-close`, its edge `.tt-resize` dragged
to make it wider (on a phone, taller; a double click: the default size). `tt-studio-scope`
says what it acts on — the selected text, all of a box's text, a line read from the page, or new
text; `utb-delete-box` beside it deletes the selected box (also Delete / Backspace outside a
field). While a text is edited the keyboard stays with it: the panel's buttons never take the
focus, its menus, checkboxes and colours give it back after a change, its fields at Enter
(`storyFocus`, `text_tool/story-edit.js`); Escape here leaves the text. Controls are bound by
their `data-k` (`char:` / `para:` / `frame:` + a StoryCore attribute). A setting the selection or
the drawing cannot have is greyed with a lock (`.tt-lock`, the reason on hover); a tab locked as
a whole says why at its top (`.tt-pane-lock`). Described in
[The Text panel](frontend/text-tool.md) and [Artistic and Frame Text](frontend/artistic-and-frame-text.md).

| Tab / section | Controls (id) |
|---|---|
| Character — font | `fabric-font-family` (filled by `text_tool/fonts.js`; with nothing selected: the font new text takes), `tt-ch-style`, `fabric-font-size`, `tt-size-down` / `tt-size-up`; `fabric-bold` / `fabric-italic` / `fabric-underline` / `fabric-strikethrough`, `tt-change-case`; colour `tt-ch-color` + `tt-ch-color-on`, opacity `tt-ch-opacity`, background `tt-ch-highlight` + `tt-ch-highlight-on` |
| Character — Spacing | **Pair kerning** `kerning` with its source `tt-kern-source` and ↺ `tt-kern-page` (follow the page again); manual kerning `tt-ch-kern`; tracking `tt-ch-tracking`; **Space width** `fabric-space-width` (px) + **Font's** `fabric-default-sw`; **Space as this line** `tt-space-line` with the line's space and tab stops `tt-space-line-src` (each paragraph the space of the page's line under it, and its tab stops where it goes on after a tab; locked off a line); **Nudge characters** `fabric-nudge-mode` (`text_tool/micro-typo.js`) |
| Character — the rest | Position & Transform (`tt-ch-shear`, `tt-ch-baseline`, `tt-ch-scalex`, `tt-ch-scaley`, `tt-ch-leading-ov`, `tt-ch-position`, `tt-ch-nobreak`); Decorations (`tt-ch-underline`, `tt-ch-strike`, `tt-ch-stroke`); Typography quick toggles `tt-q-*` and `tt-show-typography`; language `tt-ch-lang` |
| Character — Redaction match (`tt-settings`; `tt-match-scope` says whether the fields are the selected box's or the defaults for new boxes) | `tolerance` (width tolerance, px), `tt-name-case` (letter case: as typed / UPPERCASE / FIRST name / LAST name) — shown for a redaction box and with nothing selected; the ids are also read by whichever matching plugin is installed |
| Paragraph | `tt-pa-*`: alignment `tt-pa-align`; spacing (leading, indents, space before / after, use space before, sum); tab stops (`tt-pa-deftabs`, `tt-pa-tabs`, `tt-pa-tab-add`); justification; flow options; hyphenation; bullets & numbering; drop caps (`tt-pa-drop-on`); decorations |
| Frame (Text Frame) | `tt-fr-*`: fill, stroke, insets (`tt-fr-link`), Hide Overflow, height follows the text; columns, gutter, balance; column rules; vertical position (`tt-fr-valign`, max paragraph space, initial advance, minimum); `tt-convert-frame`, `tt-convert-art` |
| Typography | `tt-ot-*`: hide irrelevant features `tt-ot-hide`; ligatures; alternates; figures; capitals (`tt-ch-caps`); stylistic sets `tt-ot-ss` |
| Display (`tt-view`, the panel's foot) | **Space widths** `toggle-space-labels` (`setShowSpaceWidthLabels`); a plugin's Settings section marked `data-text-panel` lands here |

## Over the page (text_tool)

Drawn into each page's `.page-container`; an armed Artistic or Frame tool leaves presses on them to them.

| Label / tooltip | Element | Wired in |
|---|---|---|
| Ruler above the page — its marker (drag: the selected box's left edge, snapping to ⅛ inch; Alt: free) | `svg.ruler-layer` → `.ruler-marker` (one per page, no id) | `text_tool/ruler.js` — built on `page:rendered`; a drag is one undo step (`move:<id>`, collapsing with drags of the box) |
| Nudge popover — the pressed character's x nudge slider | `.utb-nudge-popover` | `text_tool/micro-typo.js` — opened by pressing a character while **Nudge characters** (`fabric-nudge-mode`) is on |

## Panels

- **Left thumbnails sidebar** — `#sidebar` in `core/index.template.html`, toggled
  by `toggle-sidebar` (`app.js`).
- **Right panels** — the core hosts none. A plugin that wants one supplies its
  own container, CSS, and toggle wiring (see `tool-expansion-guide.md`); text_tool's
  Text panel (above) is one. They share the right side one at a time: a panel shown
  emits `sidepanel:shown` and every other `[data-side-panel]` hides, so each panel's
  tool switches to it.
