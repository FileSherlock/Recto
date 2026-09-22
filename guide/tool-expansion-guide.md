# Tool Expansion Guide

A reference for adding new plugins to Recto. Read the architecture section first — it explains the conventions every plugin relies on.

> **Where a fragment lands.** `toolbar_button` goes into the left **tool column** (the user
> can reorder and hide tools there — a hidden tool moves under "More tools" and keeps
> working). The two ribbon slots: `options_bar` is a *contextual* bar — `openSubtoolbar()`
> shows one at a time and hides the rest; `ribbon_bar` is *persistent* — always visible, never
> hidden. Set where your bar sits in the ribbon's reading order with `order:` in your own
> stylesheet; the core deliberately never names a plugin's bar in its CSS, and ribbon groups
> that do not fit the width move under the ribbon's "More" button by themselves. `settings`
> is a section of the **Settings** panel (the gear in the top toolbar). No *baseline* plugin
> fills the `ribbon_bar` slot — see [Optional Plugins](./plugins/) for a worked example.

---

## Architecture Overview

### The Plugin System

A plugin is a folder under `web/plugins/` that holds a `plugin.json`. The folder is
self-contained: the manifest, the HTML fragments, the scripts, the styles, and any worker or
data file the plugin needs all live in it.

```
web/plugins/my_tool/
  plugin.json
  toolbar_button.html
  options_bar.html
  my-tool.js
  styles.css
```

```json
{
  "name": "my_tool",
  "order": 80,
  "styles": ["styles.css"],
  "toolbar_button": "toolbar_button.html",
  "options_bar": "options_bar.html",
  "scripts_after_app": ["my-tool.js"]
}
```

`tools/build.mjs` scans `web/plugins/*/plugin.json` and writes `web/index.html` from
`web/core/index.template.html`: each plugin's fragments are inlined at the template's
`<!-- @plugins:… -->` markers, its styles and scripts are emitted as `<link>` and `<script>`
tags in the fixed load order, and every local URL gets a content hash. **No manual edits to
`index.html`, the template or the build are needed** — `index.html` is generated and never
edited by hand.

A static host cannot list directories, which is why the scan is a build step rather than
something the page does. `node tools/build.mjs` runs once per deploy; the development server
(`node tools/serve.mjs`) runs the same scan on every request for `index.html`. **Dropping a
plugin folder in enables it on the next reload; dragging it out disables it.**

### `plugin.json` Reference

All fields, with their defaults (read by `readPlugins()` in `tools/build.mjs`):

```jsonc
{
  "name": "my_tool",              // Required — must equal the folder name

  "order": 1000,                  // Sorts plugins (ties by name). Decides the order of toolbar
                                  //   buttons, bars, and scripts within each bucket

  "styles": [],                   // Stylesheets, linked in <head>

  "toolbar_button": null,         // HTML fragment inlined into the tool column
                                  //   (#tool-column-items): one or more <button id>
  "options_bar": null,            // Contextual ribbon bar — one at a time,
                                  //   switched by openSubtoolbar()
  "ribbon_bar": null,             // Persistent ribbon bar — always visible
  "sidebar": null,                // HTML fragment inlined after the viewer — the
                                  //   fragment provides its own container +
                                  //   toggle button + wiring; the core hosts
                                  //   no right panel of its own
  "settings": null,               // A <section class="settings-section"> of the
                                  //   Settings panel (#settings-sections)

  "scripts_before_viewer": [],    // Scripts loaded before pdf-viewer.js
  "scripts_after_app": []         // Scripts loaded after app.js
}
```

(The comments are for this guide; a real `plugin.json` is plain JSON.)

Every path is relative to the plugin's folder. An omitted field takes its default, so a
manifest lists only the slots it fills. The build stops with a clear message when

- `name` differs from the folder name,
- a list field is not a list,
- the manifest names a file that does not exist,
- a fragment contains a server-side template tag (`{%` or `{{`) — fragments are plain HTML.

The orders of the baseline plugins are `embedded_text_viewer` 10, `webgl_mask` 20 and
`text_tool` 70. Pick an `order` by where your tool should sit in the column by default and by
which plugins' scripts yours must follow within a bucket.

Both bars of a plugin land in `#text-toolbar-row`, its `ribbon_bar` before its `options_bar`.
A `settings` fragment is a `<section class="settings-section">` with an `<h3>` and
`.settings-row` / `.settings-check` rows (the core's classes); it lands in `#settings-sections`
and the gear button (`#toggle-settings`) shows up as soon as one plugin has a section.

### Global JavaScript Objects

These globals are available to all plugin scripts:

- **`PDFHooks`** (`web/core/hooks.js`) — the lifecycle event bus, loaded first before everything else. Plugins call `PDFHooks.on(event, handler)`; the core calls `PDFHooks.emit(event, payload)`. This is the primary integration point — see [Frontend Lifecycle](#frontend-lifecycle--the-pdfhooks-bus) below.
- **`assetURL(path)`** (`web/core/hooks.js`) — the content-hashed URL of a file of the site. Every file your script loads by itself goes through it — see [Loading your own files](#loading-your-own-files--asseturl).
- **`GEO`** (`web/core/geometry.js`) — the coordinate contract: image pixels at 96 DPI for geometry, PDF points for typography. Read its constants and `docPxPerPt()` / `docPtToPx()` / `docScale()` instead of re-deriving `0.75`, `133` or `816`.
- **`state`** (`web/core/state.js`) — **core** application state only (page count and size, current page, zoom, the open file, `docHash`). Plugin state lives in the plugin; the core state object holds nothing plugin-specific. "A document is open" is `state.numPages > 0`.
- **`els`** (`web/core/state.js`) — cached DOM references for **core** elements only (viewer, page controls, sidebar). Plugins look up their own DOM with `document.getElementById(...)`; the core `els` holds no plugin elements.
- **`Doc`** (`web/core/doc-service.js`) — the document service: page rasters, page pixels, raw structured text, the document's bytes. See [The Document Service](#the-document-service--doc).

### Script Load Order

Scripts load in this order, controlled by the `scripts_before_viewer` and `scripts_after_app` fields of each manifest:

```
hooks.js                  ← defines window.PDFHooks and assetURL (loaded first)
  → geometry.js           ← window.GEO
  → state.js
  → doc-service.js        ← window.Doc
  → [scripts_before_viewer of each plugin, by order]
  → pdf-viewer.js
  → ui-events.js
  → app.js                ← defines window.openSubtoolbar, window.registerSubtoolbar; emits 'ui:ready'
  → [scripts_after_app of each plugin, by order]
```

`PDFHooks` exists before any plugin script, so a plugin can call `PDFHooks.on(...)` at module scope regardless of which bucket it loads in. Subscribing is order-independent for the *runtime* events (page render, document load, zoom, …) — the core emits those after every script has run. That holds for the startup document too: `app.js` waits for `DOMContentLoaded` before it opens it, so a `scripts_after_app` script that subscribes to `document:loaded` at module scope never misses the first document.

**Exception — `ui:ready`:** it is emitted *during* `app.js` execution, i.e. after the `scripts_before_viewer` bucket but **before the `scripts_after_app` bucket has even parsed**, and the bus does not replay past events to late subscribers. A `ui:ready` handler registered from `scripts_after_app` never fires. The rule:

- `scripts_before_viewer` — cannot touch `app.js` globals at module scope; do UI wiring inside a `PDFHooks.on('ui:ready', …)` handler. This is what `webgl_mask/webgl-mask.js` does.
- `scripts_after_app` — wire the UI **at module scope** (the DOM and `app.js` globals already exist); do not use `ui:ready`. This is what `text_tool/toolbar.js` does.

### Frontend Lifecycle — the PDFHooks Bus

The core viewer never calls plugin functions by name; it **emits events** and plugins **subscribe**. Register handlers at module scope:

```js
PDFHooks.on('page:rendered', ({ pageContainer, pageNum }) => {
  // draw your per-page overlay into pageContainer
});
```

Events emitted by the core:

| Event | When | Payload |
|-------|------|---------|
| `ui:ready` | core toolbar wired (mid-`app.js`, BEFORE `scripts_after_app` parse — only `scripts_before_viewer` can catch it) | — |
| `document:opening` | a document is about to be opened; `state` still describes the previous one | `{ file, name, isDefault }` |
| `viewer:clear` | viewer torn down before a page change | — |
| `page:rendered` | a page container was added to the DOM | `{ pageContainer, pageNum }` |
| `pages:refresh` | re-sync per-page overlays | — |
| `document:loaded` | a document finished loading | `{ file, isDefault, pdfFonts, sizePt }` |
| `zoom:changed` | viewer zoom factor changed | `{ zoom }` |

One more event travels on the bus without the core emitting it: `typography:detected`
`{ fontFamily, sizePt, source }`, emitted by a plugin that *measured* the page's face.
`text_tool` selects that family and size as the default for new boxes.

Handlers may be `async` (the core awaits them in registration order), and a throwing handler is caught so it can't break the core or other plugins. `on()` returns a function that unsubscribes. Because subscriptions live in the plugin's own script, deleting the plugin folder removes them automatically.

**Reset per-document state in `document:opening`, not in `document:loaded`.** The viewer shows
page 1 of a new document as soon as its geometry is known and announces the document only
after the typography pass. So the order for every document is `document:opening` →
`page:rendered` (page 1) → `document:loaded`. A flag cleared in `document:loaded` would still
describe the previous document while the new one's first page renders. Code that can run at
any moment guards itself the other way round as well: remember `state.docHash` before an
`await` and compare it afterwards, as `webgl_mask/webgl-mask.js` and
`embedded_text_viewer/etv-fetch.js` do.

### The Document Service — `Doc`

Everything a plugin needs from the open document comes from `window.Doc`. The document lives
in a worker that only `web/core/doc-service.js` talks to; the file never leaves the browser.

| Call | What a plugin gets |
|------|--------------------|
| `Doc.pageImageURL(n, { thumb })` | `Promise<string>` — a `blob:` URL of page *n*'s lossless PNG raster. URLs live in a small LRU and an evicted one is revoked: **ask each time, never store the URL** |
| `Doc.pagePixels(n, { gray })` | `Promise<{ width, height, components, alpha, samples: Uint8Array, source, rect }>` — the same raster as samples. `gray: true` gives one component per pixel. `source` is `'embedded'` (the page's scan) or `'render'` (a 96-dpi render of a born-digital page). `null` for an image document — decode `Doc.pageImageURL(1)` instead |
| `Doc.structuredText(n, { options, imageRect })` | `Promise<object>` — MuPDF's raw structured text: `{ rect, width, height, blocks → lines → spans → chars }`, coordinates in PDF points. `options` is a MuPDF option string (default `'preserve-whitespace'`); `imageRect: true` adds `.imageRect` in the same round trip. An image document answers with no blocks |
| `Doc.pageImageRect(n)` | `Promise<rect \| null>` — where the page's largest image sits on the page, in PDF points |
| `Doc.bytes()` | `Promise<ArrayBuffer>` — the document's bytes, for a plugin that runs its own worker over the file |
| `Doc.info` | the last `open()`'s result: `{ sha256, numPages, pageWidth, pageHeight, pdfFonts, suggestedScale, suggestedSize, pageImageType }` |

Opening and closing (`Doc.open`, `Doc.close`) belong to the core viewer:
`openDocument(source, name, file)` in `web/core/pdf-viewer.js` wraps `Doc.open` with the
lifecycle events. A plugin calls neither `Doc.open` nor `Doc.close` itself — opening a
document behind the viewer's back would leave `state` and every other plugin describing the
previous one.

Requests are answered one at a time by priority (a shown page first, thumbnails last), so a
plugin's whole-document pass never delays the page the user is turning to. Prefer per-page
work triggered by `page:rendered` over a whole-document pass; when a whole-document pass is
the point, run it in chunks and check `state.docHash` between them. Key per-document caches
off `state.docHash` (the SHA-256 of the file).

The core runs no analysis: `structuredText` and `pagePixels` are primitives. Turning them
into spans, masks or anything else is your plugin's job.

### Loading Your Own Files — `assetURL()`

The build stamps a content hash on every `<script>` and `<link>` of the page. A file your
script loads *by itself* — a worker, a data file, a wasm binary — gets the same treatment
through `assetURL()`, which looks the path up in `window.RECTO_ASSETS` (every file of
`web/core/`, `web/vendor/` and each installed plugin):

```js
const names = await fetch(assetURL('plugins/my_tool/names.json')).then(r => r.json());
```

`path` is relative to the site root. Going through `assetURL()` is what makes a long cache
lifetime safe: a changed file gets a new URL, and nobody bumps a version by hand. An unknown
path comes back unchanged. The map doubles as a directory listing the page can consult
without a request: `window.RECTO_ASSETS['plugins/my_tool/data/x.json']` is `undefined` when
the file does not exist.

### Two UI Patterns

There are two distinct plugin UI patterns. Choose one based on what your tool needs:

| Pattern | Used by | Adds |
|---|---|---|
| **Subtoolbar** | `webgl_mask`, `text_tool` | A tool-column button that swaps the options bar row |
| **Right Panel** | (e.g. a matching sidebar) | A tool-column button that opens a full-height side panel |

---

## Pattern A — Subtoolbar Plugin

Use this when your tool needs a row of controls (sliders, selects, checkboxes) rather than a persistent panel. Example: `webgl_mask`.

The subtoolbar row is mutually exclusive — only one bar is visible at a time. This is enforced by `window.openSubtoolbar`, defined in `app.js`.

### File Structure

```
web/plugins/my_tool/
  plugin.json              ← the manifest
  toolbar_button.html      ← button inlined into the tool column
  options_bar.html         ← bar inlined into #text-toolbar-row
  my-tool.js               ← toggle logic + tool behaviour
  styles.css
```

### Step 1 — Write the Manifest

```json
{
  "name": "my_tool",
  "order": 80,
  "styles": ["styles.css"],
  "toolbar_button": "toolbar_button.html",
  "options_bar": "options_bar.html",
  "scripts_after_app": ["my-tool.js"]
}
```

### Step 2 — Toolbar Button

```html
<!-- toolbar_button.html -->
<button id="toggle-my-tool" class="icon-button" title="My Tool">
  <span class="material-symbols-outlined">your_icon_name</span>
</button>
```

### Step 3 — Options Bar

Start with `class="options-bar hidden"`. The bar must be hidden by default; `openSubtoolbar` manages visibility from here.

```html
<!-- options_bar.html -->
<div id="my-tool-bar" class="options-bar hidden">
  <div class="options-divider"></div>
  <div class="options-group">
    <div class="options-group-header">My Setting</div>
    <div class="options-group-controls">
      <input type="range" id="my-slider" min="0" max="100" value="50">
    </div>
  </div>
</div>
```

### Step 4 — JavaScript Toggle (module scope + `registerSubtoolbar`)

Put your tool script in `scripts_after_app` and wire the toggle **at module scope** — the toolbar DOM and the core's `openSubtoolbar`/`registerSubtoolbar` already exist by then. Do **not** wrap the wiring in `PDFHooks.on('ui:ready', …)`: that event fires before `scripts_after_app` scripts parse and is never replayed, so the handler would silently never run (see the load-order note above; `text_tool/toolbar.js` wires exactly this way). Call `registerSubtoolbar(button)` once so the core can deactivate your button generically when another subtoolbar opens. **You never edit `app.js`.**

```js
// my-tool.js  (a scripts_after_app entry)

(function wireMyTool() {
  const btn = document.getElementById('toggle-my-tool');
  const bar = document.getElementById('my-tool-bar');
  if (!btn || !bar) return;

  // Let the core manage this button without naming the plugin.
  window.registerSubtoolbar?.(btn);

  btn.addEventListener('click', () => {
    if (bar.classList.contains('hidden')) {
      window.openSubtoolbar?.(bar, btn);   // open my bar (closes the others)
    } else {
      window.openSubtoolbar?.(null, null); // back to no contextual bar
    }
  });
})();
```

(Only a `scripts_before_viewer` script should use the `ui:ready` handler pattern for UI wiring — it is the one bucket that runs early enough to catch the event.)

`openSubtoolbar` hides every element with class `options-bar` and deactivates every registered toggle, then shows the one you pass. Because it operates by class + registry, **no core edit is required** — that is the whole point of the pattern.

That's it. No changes to the template, the build, or `app.js` — the manifest scan and the hook bus handle everything. Reload the page served by `node tools/serve.mjs` and the button is there.

---

## Pattern B — Right Panel Plugin

Use this when your tool needs a persistent, scrollable side panel.

### File Structure

```
web/plugins/my_panel/
  plugin.json              ← the manifest
  toolbar_button.html      ← button inlined into the tool column
  panel.html               ← <aside> inlined after the viewer
  my-panel.js              ← open/close logic + panel behaviour
  styles.css               ← the panel's own container styles
```

### Step 1 — Write the Manifest

```json
{
  "name": "my_panel",
  "order": 90,
  "styles": ["styles.css"],
  "toolbar_button": "toolbar_button.html",
  "sidebar": "panel.html",
  "scripts_after_app": ["my-panel.js"]
}
```

### Step 2 — Toolbar Button

```html
<!-- toolbar_button.html -->
<button id="toggle-my-panel" class="icon-button" title="My Panel">
  <span class="material-symbols-outlined">your_icon_name</span>
</button>
```

### Step 3 — Panel HTML

The `sidebar` fragment is inlined after the viewer, inside `#main-content`. The core
provides **no** right-panel host, so **your fragment supplies its own container** —
including its own CSS (put the container/width/hidden styles in your plugin's stylesheet,
not the core's). Delete the folder and nothing about a right panel remains in the core.

```html
<!-- panel.html -->
<aside id="my-panel" class="hidden">
  <div id="my-panel-header">
    <span>My Panel</span>
  </div>
  <!-- panel content -->
</aside>
```

### Step 4 — JavaScript Toggle

Your panel owns its own open/close — the core wires nothing. Look up your own
button and container and toggle them:

```js
// my-panel.js
document.getElementById('toggle-my-panel')?.addEventListener('click', () => {
  const panel = document.getElementById('my-panel');
  const btn   = document.getElementById('toggle-my-panel');
  const nowHidden = panel?.classList.toggle('hidden');
  btn?.classList.toggle('active', !nowHidden);
});
```

If two right panels can be open at once and you want them mutually exclusive,
coordinate that **between the plugins** (e.g. each hides the other by id in its
own open handler) — the core provides no shared right-panel coordinator.

That's it. No changes to the template, the build, or `app.js`.

---

## Doing the Work — Analysis in the Browser

There is no server to send the document to. A plugin that analyses the document reads it
through `Doc`, computes in the browser — in a worker when the work is heavy — and draws its
own overlay.

### Reading the Document

```js
// One page's gray pixels, e.g. to find regions in the scan:
PDFHooks.on('page:rendered', async ({ pageContainer, pageNum }) => {
  const hash = state.docHash;
  const raster = await Doc.pagePixels(pageNum, { gray: true });
  if (!raster || hash !== state.docHash) return;      // image document, or the document changed meanwhile
  // raster.samples: Uint8Array, raster.width × raster.height, one byte per pixel
});
```

Geometry you derive from the raster is already in the viewer's coordinate space (image
pixels). Geometry you derive from `Doc.structuredText` is in PDF points and must be mapped
through the page image's placement — `embedded_text_viewer/extract.js` is the reference
for that transform.

Two facts about rasters decide what an analysis may assume. `source === 'embedded'` means
the samples are the page's own scan, pixel for pixel; `source === 'render'` means MuPDF drew
a born-digital page at 96 DPI. `webgl_mask` builds a mask only for `'embedded'` pages, for
example.

### Running a Worker

Heavy loops belong in a worker of the plugin's own, so the page stays responsive. The worker
file sits in the plugin folder and is reached through `assetURL()`:

```js
// my-tool.js (page side)
const absolute = path => new URL(assetURL(path), document.baseURI).href;

const worker = new Worker(assetURL('plugins/my_tool/my-worker.js'));
worker.postMessage({ type: 'init', core: absolute('plugins/my_tool/my-core.js') });
```

```js
// my-worker.js
self.onmessage = e => {
  const m = e.data;
  if (m.type === 'init') { importScripts(m.core); return; }
  // … compute, then self.postMessage({ id: m.id, result }, [transferables])
};
```

The rules behind this shape:

- **A URL the worker resolves itself must be absolute.** Inside a worker a relative URL
  resolves against the worker's script, not against the page, and the worker has no
  `assetURL()` (the asset map lives on the page). So the page builds the content-hashed,
  absolute URL — `new URL(assetURL(p), document.baseURI).href` — and hands it in with an
  `init` message. `web/core/doc-service.js` starts the MuPDF worker the same way.
- **Transfer buffers instead of copying them.** `Doc.pagePixels()` gives you a fresh
  `Uint8Array`; pass `[raster.samples.buffer]` as the transfer list.
- **Keep the computing part free of the DOM.** `webgl_mask/mask-core.js` is pure loops
  behind one global (`MaskCore`), `mask-worker.js` is a thin shell around it. That split is
  what lets a Node test import the very file the browser runs (see
  [Testing a Plugin](#testing-a-plugin)).
- A module worker (`new Worker(url, { type: 'module' })`) works the same way with
  `await import(absoluteURL)` in place of `importScripts`.

### Measuring Text

Text measurement is a service of the `text_tool` plugin, not of the core:

```js
if (typeof Shaping !== 'undefined') {
  const { results } = await Shaping.widths({
    strings: ['Hello'], family: 'Times New Roman', bold: false, italic: false,
    size: 12,                    // POINTS
    scale: GEO.docScale(),       // px-per-pt as a percentage
    kerning: true,
  });
  // results[0].width in image px; results[0].chars = [{ c, x }]
}
```

Guard every call into another plugin this way (`typeof X !== 'undefined'`, or
`typeof fn === 'function'` for a function): your plugin must keep working — with that
feature dark — when the other folder is dragged out.

> **Note for logic-only files** (no UI of their own): a script that only provides functions
> to other scripts — like `embedded_text_viewer/extract.js` or `text_tool/shaping.js` — is
> simply listed in its plugin's manifest ahead of the scripts that use it. There is no
> separate kind of module for it.

---

## Testing a Plugin

```bash
node --test "tests/**/*.test.mjs"     # every suite, a few seconds, no browser
node tests/smoke/smoke.mjs            # the whole site in headless Chrome
```

The suites are plain `node:test` files with no dependencies. A plugin's own suites live in
`tests/plugins/<plugin_name>/`; they are picked up by the glob above.

**Pure logic** — a classic script that has no DOM in it and publishes one global — is
imported directly, the very file the browser loads:

```js
await import('../../../web/plugins/my_tool/my-core.js');   // a classic script: defines globalThis.MyCore
const { compute } = globalThis.MyCore;
```

For that to work the script attaches its API to `globalThis` (not `window`) and touches
`window` / `document` only behind a `typeof` check. `tests/masks.test.mjs`,
`tests/spans.test.mjs` and `tests/shaping.test.mjs` test the baseline plugins this way,
against recorded reference outputs in `tests/golden/` (see `tests/golden/README.md`);
`tests/documents.test.mjs` does the same for the core's `pdf-document.js`. Where a result
is a number or a pixel, the suites require equality with the golden, not closeness.

**Scripts that use the viewer's globals** are run with those globals stubbed: the test sets
`globalThis.window`, `document`, `state`, `PDFHooks`, `GEO`, `assetURL` (and `Shaping`,
`utbState`, … as needed) to small fakes, then executes the plugin file with
`vm.runInThisContext(fs.readFileSync(file, 'utf8'))` and calls its functions.

**A plugin's tests must survive the plugin's removal.** Skip when the folder is gone:

```js
const PLUGIN = path.resolve(HERE, '..', '..', '..', 'web', 'plugins', 'my_tool');
const skip = !fs.existsSync(path.join(PLUGIN, 'plugin.json')) && 'plugin not installed';
test('…', { skip }, () => { /* … */ });
```

**Your controls on the generated page.** `build()` is importable, so a test can assemble the
page without writing it and look for the plugin's markup and script order. Put this in
`tests/plugins/my_tool/page.test.mjs`:

```js
import { build, WEB } from '../../../tools/build.mjs';

const { html, plugins } = build({ write: false });
const skip = !plugins.some(p => p.name === 'my_tool') && 'plugin not installed';

test('every control is on the page', { skip }, () => {
  for (const id of ['toggle-my-tool', 'my-tool-bar', 'my-slider'])
    assert.ok(html.includes(`id="${id}"`), `#${id} is missing from the generated page`);
});
```

`tests/page-controls.test.mjs` does this for the core and the baseline plugins, and checks
that no script, style or fragment under `web/` addresses a server endpoint. A plugin outside
the baseline brings its own page checks rather than adding itself to that file — the same
contract as in the code: the baseline never names an optional plugin.

One suite covers every plugin without being told about it. `tests/index-page.test.mjs`
builds the page with each installed plugin treated as absent
(`build({ write: false, absent: [name] })`) and asserts that no `plugins/<name>/` reference
is left, neither in the markup nor in the asset map — the drag-out property.

**The smoke test** (`tests/smoke/smoke.mjs`) starts `tools/serve.mjs` on a free port, opens
every golden document through the real file input in headless Chrome, selects a text box,
clicks every toolbar toggle (`header button[id^="toggle-"]`, so yours is included) and every
formatting switch, turns a page — and fails on any console error, page error or failed
request. An installed plugin adds its own steps with `tests/plugins/<name>/smoke.mjs`,
exporting any of:

| Export | Purpose |
|---|---|
| `switches` | ids to click on and off along with the core's |
| `settle(page, doc)` | wait until the plugin is done with a freshly opened document |
| `exercise(page, doc, note)` | drive the plugin's own UI; push remarks onto `note` |
| `quiesce(page)` | stop background work before the next document |

The smoke test needs Chrome (`--chrome <exe>` or the `CHROME` variable) and `puppeteer-core`,
which is not a dependency of this repository: the script looks in `./node_modules` and
`../tol0/node_modules` and exits with code 2 when it finds neither. `--only <golden name>`
runs a single document.

Finally, check the removal by hand once: drag your folder out of `web/plugins/`, reload, and
confirm the console is clean and the rest of the app works.

---

## Existing Plugins — Quick Reference

| Folder | Type | `order` | Toggle Button ID | Bar / Panel ID |
|---|---|---|---|---|
| `web/plugins/text_tool` | Subtoolbar | 70 | `toggle-fmt` (+ the Insert, Undo and Redo tools) | `fabric-options-bar`; a Settings section (`tt-settings`) |
| `web/plugins/webgl_mask` | Subtoolbar | 20 | `toggle-webgl` | `webgl-options-bar` |
| `web/plugins/embedded_text_viewer` | Toolbar toggle only | 10 | `toggle-embedded-text` | — |
| `web/core` | Core (always on) | — | — | `unified-options-bar-container` (bar host) |

---

## Checklist — Adding a New Tool

1. **Create the plugin folder** (`web/plugins/my_tool/`)
2. **Write `plugin.json`** — `name` equal to the folder name, an `order`, and only the slots you fill
3. **Create the fragments** — `toolbar_button.html`, `options_bar.html`, a settings section and/or a sidebar fragment; plain HTML, no template tags
4. **Create scripts and styles** — every file the manifest names must exist, or the build fails with a message saying which
5. **Wire runtime behaviour through `PDFHooks`** — subscribe to lifecycle events (`page:rendered`, `document:loaded`, …); reset per-document state in `document:opening`; for a subtoolbar in `scripts_after_app`, call `registerSubtoolbar(btn)` and add your click handlers at module scope (NOT inside `ui:ready` — it has already fired)
6. **Read the document through `Doc`**, load your own files through `assetURL()`, and put heavy loops in a worker
7. *(Right panel only)* provide your own container element, its CSS, and its toggle wiring inside the plugin — the core hosts no right panel
8. **Add tests** under `tests/plugins/my_tool/` — logic suites, a `page.test.mjs`, optionally smoke steps — all of which skip when the folder is absent
9. **Update [`guide/ui-map.md`](./ui-map.md)** — it maps every visible control to its owning plugin, fragment and handler script

**Zero changes needed to**: `web/core/index.template.html`, `web/index.html`, `tools/build.mjs`, `app.js`, or any other plugin's code.

**To disable a plugin**: drag its folder out of `web/plugins/`. The next build finds no manifest, so the page carries no markup, style, script or asset-map entry of it.

---

## Best Practices

- **Never use `display: block` directly.** Always toggle the `.hidden` class. Sidebars use CSS transitions keyed on `.hidden`; bypassing it breaks animations.
- **Use optional chaining (`?.`) on all `getElementById` calls** in plugin JS. This ensures your script doesn't throw when a control it expects is absent.
- **Guard `openSubtoolbar` calls** with `typeof openSubtoolbar === 'function'` when your script is in `scripts_before_viewer`. Scripts in `scripts_after_app` can reference it directly.
- **Integrate through `PDFHooks`, not by name.** Subscribe to lifecycle events instead of having the core call your functions, and look up your own DOM with `document.getElementById`. A subtoolbar plugin's only core touchpoints are the generic `registerSubtoolbar` + `openSubtoolbar`; a right panel is fully plugin-owned (its own container, CSS, and toggle wiring) with no core touchpoint at all.
- **Keep plugin logic self-contained.** Fragments, scripts, styles, workers and data files all belong in the plugin folder; nothing of a plugin lives in `web/core/`.
- **Guard calls into other plugins** (`typeof Shaping !== 'undefined'`, `typeof fn === 'function'`). Any folder can be dragged out at any time.
- **Never store a page URL.** `Doc.pageImageURL(n)` answers from an LRU whose evicted URLs are revoked — ask again when you need the page again.
- **Never hand-write a `?v=` number.** The build hashes what the page references; `assetURL()` covers what your scripts load themselves.
- **Disable by removing the folder.** The build scans `web/plugins/` — moving the folder out is the off-switch. There is no list of plugins to edit anywhere.
