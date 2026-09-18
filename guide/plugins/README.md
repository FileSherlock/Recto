# Optional Plugins

Everything in this folder documents a plugin that **Recto does not need**. The core
(`web/core/`) and the three baseline plugins — `text_tool`, `embedded_text_viewer`,
`webgl_mask` — never reference anything documented here.

That is the contract: **this folder is the only place in the guide that names an optional
plugin.** If you ever find a baseline document naming one, that's a leak worth fixing.

Every plugin, optional or not, is one self-contained folder under `web/plugins/`: a
`plugin.json` manifest, its HTML fragments (`toolbar_button.html`, `options_bar.html`,
`sidebar_tools.html`, …) next to its scripts and styles, and whatever data it ships. There
is no server side to any of them — every plugin here runs entirely in the browser.

## Installing a plugin

Drag its folder into `web/plugins/` and reload. `tools/build.mjs` (which the dev server
runs on every request for the page, and a deploy runs once) finds every folder that holds a
`plugin.json` and inlines its fragments, styles and scripts into the page; `index.html`,
the template and the build script are never edited. If the manifest names a file that is
not there, the build fails and says which.

## Removing a plugin

Nothing else in the repo or the guide has to change:

1. Delete the plugin folder (e.g. `web/plugins/redaction_matching/`) and reload. The build
   scans `web/plugins/` for folders holding a `plugin.json`, so it simply stops being found.
2. Delete its tests folder, if it has one (e.g. `tests/plugins/redaction_matching/`) — a
   plugin's own suites and browser-smoke steps travel with it.
3. Delete its docs folder (e.g. `guide/plugins/redaction-matching/`).
4. Delete its row from the table below.

Verified by `tests/index-page.test.mjs` for every installed plugin: built without it, the
page holds no reference to `plugins/<name>/` and the asset map no entry for it. With
`redaction_matching` removed, no candidates sidebar (`#tools-sidebar`) or its toggle button
appears in the page — the panel, its CSS, and its wiring all live in the plugin.

## Testing

```bash
node --test "tests/**/*.test.mjs"          # every suite, the optional plugins' included
node tests/smoke/smoke.mjs                 # the whole site in headless Chrome (needs ../tol0's puppeteer-core)
```

An optional plugin keeps its tests in `tests/plugins/<name>/`: `*.test.mjs` suites for
`node --test` (a `page.test.mjs` that checks its controls on the generated page skips
itself when the plugin is not installed), and optionally a `smoke.mjs` whose exported
`switches` / `settle` / `exercise` / `quiesce` steps the browser smoke test picks up when
the plugin is installed.

## Auto OCR

| Plugin | Docs | What it does | Data it keeps |
|---|---|---|---|
| `ocr_tool` | [ocr-tool/](ocr-tool/) | Byte-exact blind-reader OCR of the page rasters (client-side); certified lines land as editable `ocr` text boxes, detected redaction rectangles as `redaction` boxes. **MuPDF pixel view**: draws any text box from the reader's glyph bitmaps on mupdf's ¼-px lattice and diffs it against the page (via text_tool's `utbPixelRender` seam). Defines two optional seams a matcher may call: `window.ocrTestHypothesis` (a candidate name judged by the page pixels) and `window.ocrMeasureWidths` (candidates measured in the page's own face) | Shipped reads of the startup document in `web/plugins/ocr_tool/cache/<sha256>.json`; this browser's own reads in IndexedDB (`recto-ocr-cache`) |

- **Requires `text_tool`** (renders through the unified text box system); works with or without `embedded_text_viewer`.
- Its `engine/` + `glyphs/` folders (`web/plugins/ocr_tool/engine/`, `…/glyphs/`) are synced verbatim from the external `tol0` repo by its `tools/sync-recto.mjs` (`npm run sync:recto` there), which knows the `web/plugins/ocr_tool/` layout — edit the engine there, never in this repo. Cache-busters need no attention: the build stamps every script with its content hash. `npm run recto-test` there smoke-tests the embedded engine and the pixel view end to end.

## Base64 attachment decoder

Finds base64 blocks (the wrapped-line body of an email attachment) in the document's
text, decodes them in the browser, sniffs the file type from the magic bytes (PDF,
PNG, JPEG, GIF, WebP, ZIP, plain text), and offers each block as a download or an
in-browser view (new tab). It reads exactly one unified-text-box layer — whichever
of OCR / embedded is visible on screen — so duplicate layers never interleave and
corrupt a block. After a document loads it waits for the text layer to settle (the
`ocr_tool` state read through a guarded global, else a stability poll), scans, and —
if attachments were found and no subtoolbar is open — opens its own bar ready for
download/view.

| Plugin | Docs | What it does | Data it keeps |
|---|---|---|---|
| `base64_tool` | *(none yet)* | Base64 block detection → decode → typed download / in-browser view; subtoolbar UI (`web/plugins/base64_tool/base64-tool.js`) | *(none)* |

- **Requires `text_tool`** (reads `utbState.boxes`; all access guarded so removal
  never throws). Needs a text source to be useful: an `ocr_tool` read or an
  `embedded_text_viewer` layer. Pages the user has not visited are read from
  `embedded_text_viewer`'s lean span cache (`window.etvSpanCache`, guarded), so detection
  sees the whole document, not just the pages on screen.

## Redaction matching

Candidate-name matching against redaction bars: it owns the candidates right panel (the
`#tools-sidebar` host, its toggle button, CSS, and wiring) plus the name pool, name-format
settings, and matches table. It does **not** detect bars itself — it matches names against
whatever `redaction` boxes exist on the page, so it needs a detector installed to have
anything to work on.

| Plugin | Docs | What it does | Data it keeps |
|---|---|---|---|
| `redaction_matching` | [redaction-matching/](redaction-matching/) | Candidate-name → redaction-bar width matching in the bar's own face; owns the candidates sidebar (name format, starts-with / ends-with filter, matches table). Names that tie on width are all listed — click one or press `[` / `]` to choose the bar's label; page-pixel verdicts (`✓ ✗ –`) rank them when a hypothesis tester is present. Two bars that are one name (a space apart, or split over a line break) are read as one person: first name on one bar, last name on the other | The name pool, `web/plugins/redaction_matching/names.json` (fetched once) |

## Redaction refiner

Redraws detected redaction bars to the true hidden-name extent by reading the
words that surround each bar: punctuation is flush only when the mark binds
toward the bar (a comma binds left, so `EPSTEIN, ███` keeps its space while
`███, and` is flush); a whole word (in the shipped English word list, the
candidate-name pool, or capitalised) has a real space before it, so the edge is
redrawn one space-width in; a word *fragment* (`nd` left over when the redaction
dropped the `a` of `and`) has its missing letters next to the bar, so the edge is
redrawn one space plus those letters in. Spaces and letters are sized from the
neighbour word's own font. It works from the embedded layer at once and re-derives
from the OCR words when that (slower) pass lands. No UI — it runs on the generic
`redactions:connected` PDFHooks event that `embedded_text_viewer` emits after
snapping redactions to lines.

| Plugin | Docs | What it does | Data it keeps |
|---|---|---|---|
| `redaction_refiner` | [redaction-refiner/](redaction-refiner/) | Redraws redaction bars to the hidden-name extent via surrounding words, punctuation and a word list | The word list, `web/plugins/redaction_refiner/words.txt` (fetched once) |

- **Attaches through the `redactions:connected` hook and guarded globals** (`renderBox`,
  `calculateAllWidths`, `getNaturalSpaceWidth`, `GEO`, `state.namesData`) — never imports.
- **Emits `redaction:refined`** (generic, names no consumer) with the remnant slivers it
  found sticking out of a bar — the hidden name's own first/last letters.
  `redaction_matching` listens and fills that box's starts-with / ends-with filter from
  them; without a refiner the event never fires and the filter stays manual.
- **Needs `redaction` boxes and surrounding text** (an `embedded_text_viewer` or
  `ocr_tool` line). With neither it no-ops. The hook emission is generic and names no
  plugin, so it stays put — emitting into the void — if the refiner is removed.

## Dependency order

```
redaction_matching ──runtime globals──> text_tool ──> core (web/core/)
ocr_tool           ──runtime globals──> text_tool ──> core
base64_tool        ──runtime globals──> text_tool ──> core
redaction_refiner  ──'redactions:connected'──> embedded_text_viewer ──> core
redaction_refiner  ──'redaction:refined'  ──> (redaction_matching listens, optionally)
```

Load order follows each manifest's `order` (ties by name): `embedded_text_viewer` 10,
`webgl_mask` 20, `base64_tool` 30, `redaction_matching` 40, `redaction_refiner` 50,
`ocr_tool` 60, `text_tool` 70. None of the attachments above depends on it — they resolve
at call time, inside event handlers.

- **`redaction_matching` attaches to `text_tool` through guarded globals**, not imports. See
  [the seam contract](#the-seam-contract).
- **It needs a source of `redaction` boxes.** `ocr_tool` emits them as it reads, and the
  Add-Box tool creates them manually; without either, there is simply nothing to match.
- **Text is measured by `text_tool`'s shaper.** `redaction_matching` and `redaction_refiner`
  call `Shaping.widths(request)` (HarfBuzz as WebAssembly, `web/plugins/text_tool/shaping.js`)
  behind a `typeof Shaping !== 'undefined'` guard, and `ocr_tool` reads a face's kern table
  through `FontCatalog.metrics` (→ `Shaping.fontMetrics`). Without `text_tool` nothing is
  measured and nothing throws.
- **The Match controls** (Tolerance / Kerning / Uppercase) live in `text_tool`'s formatting
  ribbon under shared element IDs (`#tolerance`, `#kerning`, `#force-uppercase`).
  `redaction_matching` reads them if present and no-ops if not.

## The seam contract

`text_tool` is a baseline plugin and does not depend on the redaction suite. But it does
contain `typeof fn === 'function'` guarded call sites for functions that only
`redaction_matching` defines — `createNewRedaction`, `calculateWidthsForRedaction`,
`selectRedaction`, `updateAllMatchesView`, `renderCandidates`, `syncNameSettingsUI`.

These are **deliberate re-attachment seams**, and they work in both directions:

- **Plugin installed** — `api.js` is a `scripts_before_viewer` entry in the plugin's
  `plugin.json`, with no IIFE wrapper, so its top-level `function` declarations are true
  globals. The guards resolve and the call
  sites light up.
- **Plugin absent** — the guards are false and the call sites silently no-op. Nothing breaks,
  nothing is left dangling.

`text_tool` also declares a `type: 'redaction'` box variant with a few fields only this suite
populates (`widths`, `tolerance`, `nameSettings`, `candidates`). Those are inert when the
suite is absent. See [Unified Text Box](../architecture/unified-text-box.md).
