# Migrating a plugin from the server-based Recto

Recto used to be a Django application whose server opened the document, rendered pages, extracted text, measured
strings and built masks. This repository is the same editor as a static website: all of that runs in the browser
(MuPDF and HarfBuzz as WebAssembly), and a document never leaves it. The server-based version is the `main` branch of
the original repository.

The plugin model did not change — a plugin is still one self-contained folder that can be dropped in or deleted with
no dangling reference, it still attaches through the `PDFHooks` bus, and the core still names no plugin. What changed
is where the folder lives, how it declares itself, and what it calls instead of an endpoint.

## 1. The folder

| server-based | static |
|---|---|
| `<app>/` — a Django app at the repository root | `web/plugins/<app>/` |
| `<app>/static/<app>/*.js, *.css, data files` | the same files, directly in the plugin folder |
| `<app>/templates/<app>/*.html` (toolbar button, bars, sidebar) | the same fragments, next to the scripts — plain HTML, no template tags |
| `<app>/tool.py` (`@register_tool`, a `PDFTool` subclass), `apps.py` | `plugin.json` |
| `<app>/views.py`, `urls.py`, `logic/*.py` | gone — the work moves into the plugin's JavaScript (see 3) |
| `<app>/tests.py`, `<app>/tests_js/` | `tests/plugins/<app>/*.test.mjs` (node:test, run by `node --test "tests/**/*.test.mjs"`) |

Installing a plugin is putting its folder into `web/plugins/` and reloading; removing it is deleting the folder. The
scan that Django's app autodiscovery did at start-up is `tools/build.mjs` (the dev server runs it on every request for
`index.html`, a deploy runs it once).

## 2. `tool.py` → `plugin.json`

```python
@register_tool
class TextTool(PDFTool):
    name = 'text_tool'
    url_prefix = ''
    url_module = 'text_tool.urls'
    styles = [{'path': 'text_tool/styles.css'}]
    toolbar_button = 'text_tool/toolbar_button.html'
    options_bar = 'text_tool/options_bar.html'
    scripts_after_app = [{'path': 'text_tool/fonts.js', 'version': 'v=4'}, ...]
```

```json
{
  "name": "text_tool",
  "order": 70,
  "styles": ["styles.css"],
  "toolbar_button": "toolbar_button.html",
  "options_bar": "options_bar.html",
  "ribbon_bar": null,
  "sidebar": null,
  "scripts_before_viewer": [],
  "scripts_after_app": ["shaping.js", "fonts.js", "..."]
}
```

- The slots are the same. Paths are relative to the plugin folder. `name` must equal the folder name.
- `url_prefix` / `url_module` have no successor: there are no routes.
- `order` is new. Django loaded plugins in whatever order the file system listed the app folders; now the order is
  declared (ties go by name).
- `version` strings are gone. The build stamps every script, style and fetched file with its content hash; nothing is
  bumped by hand.
- The build refuses a manifest that names a missing file and a fragment that still contains `{% … %}` or `{{ … }}`.

## 3. Endpoints → browser APIs

| the plugin called | it now calls |
|---|---|
| `POST /open-document`, `GET /open-default` | nothing — the core opens documents (`openDocument()` → `Doc.open`). Read `state.docHash`, `state.numPages`, `Doc.info` |
| `GET /page-image/<hash>/<n>` or `state.pageImages[n - 1]` | `await Doc.pageImageURL(n)` (`{ thumb: true }` for the thumbnail). A `blob:` URL from a small cache — ask each time, never keep one. `state.pageImages` no longer exists; "a document is open" is `state.numPages > 0` |
| its own endpoint that read the page's pixels on the server | `await Doc.pagePixels(n, { gray: true })` → `{ width, height, components, samples, source }`, then its own code — in its own Worker when the work is heavy (`web/plugins/webgl_mask/` is the example) |
| its own endpoint that read the PDF's text on the server | `await Doc.structuredText(n, { imageRect: true })` — MuPDF's structured text in PyMuPDF's `rawdict` shape (`web/plugins/embedded_text_viewer/extract.js` is the example) |
| its own endpoint that needed the whole file | `await Doc.bytes()` |
| `POST /widths` | `await Shaping.widths(request)` — same request object, same response object (`text_tool`; guard it from another plugin: `typeof Shaping !== 'undefined'`) |
| `GET /font-metrics?family=…` | `await Shaping.fontMetrics({ family, bold, italic, size_px })`, or `FontCatalog.metrics(...)` |
| `GET /fonts-list` | `FontCatalog` (it reads `generated/fonts.json`, written by the build) |
| a server-side cache keyed by the document hash | IndexedDB, and/or files shipped in the plugin folder and looked up through `window.RECTO_ASSETS` so a miss costs no request (`web/plugins/ocr_tool/ocr-tool.js`, "The read cache") |
| `fetch('/static/<app>/data.json')`, `new Worker('/static/<app>/worker.js?v=3')` | `fetch(assetURL('plugins/<app>/data.json'))`, `new Worker(assetURL('plugins/<app>/worker.js'))`. A URL passed *into* a Worker must be absolute: `new URL(assetURL(p), document.baseURI).href` |

Server logic that has no browser counterpart yet is ported into the plugin. The rule this repository followed: record
what the server returns first (goldens), then hold the port to it — a port is done when its goldens pass, not when it
looks right. Write the port without DOM access and publish it on `globalThis`, and a node test can load the very file
the page loads.

## 4. Lifecycle

The events are the ones the server-based version had, plus one. `document:opening` `{ file, name, isDefault }` is
emitted before a document is replaced. Reset per-document state there, not in `document:loaded`: the new document's
first page now renders (`page:rendered`) before its `document:loaded` arrives, because the fonts-and-body-size pass
finishes behind the first page.

## 5. Checklist

1. Move the folder to `web/plugins/<app>/`; flatten `static/<app>/` and `templates/<app>/` into it.
2. Write `plugin.json` from `tool.py`; delete `tool.py`, `apps.py`, `urls.py`, `views.py`, `__init__.py`.
3. Replace every absolute URL (`/static/...`, your endpoints, the core's) per the table above.
4. Port any `logic/*.py` the plugin still needs; keep heavy work off the main thread.
5. Move the tests to `tests/plugins/<app>/`; make them skip when the plugin folder is absent.
6. `node tools/serve.mjs`, reload, open a document: no console error, no failed request — then drag the folder out,
   reload, and check again. `node tests/smoke/smoke.mjs` does the first half for every test document; give the plugin a
   `tests/plugins/<app>/smoke.mjs` if it has UI of its own to exercise.
7. Document it under `guide/plugins/<app>/` — and nowhere else, if it is an optional plugin.
