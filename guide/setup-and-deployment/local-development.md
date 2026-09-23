# Local Development

## Quick Start

The same on Windows, Linux and macOS — the only requirement is Node.js 22 or newer. There
is nothing to install: no package manager, no dependencies, no database.

```bash
# 1. Enter the project
cd Recto

# 2. Start the dev server
node tools/serve.mjs
```

Open [http://localhost:5000](http://localhost:5000) in your browser.

```bash
node tools/serve.mjs 8080          # another port
node tools/serve.mjs --no-isolate  # without the COOP/COEP headers (see below)
```

The server listens on `127.0.0.1` only, so it is not reachable from other machines.

---

## What the dev server does

`tools/serve.mjs` serves plain files out of `web/`, plus three things a bare file server
lacks:

- **The build runs on every request for `index.html`.** A plugin folder dropped into or
  taken out of `web/plugins/` shows on the next reload, and so does an edited fragment or
  manifest. When the build fails — a manifest names a file that does not exist, say — the
  page shows `build failed: …` with the reason, and the same line is printed in the
  terminal.
- **`.wasm` is served as `application/wasm`**, which streaming compilation needs.
- **COOP/COEP headers** make the page cross-origin isolated. That is what exposes
  `performance.measureUserAgentSpecificMemory()`, the way to measure the wasm heap and the
  workers while developing. COEP is `credentialless`, so the page's cross-origin stylesheets
  and scripts keep loading. `--no-isolate` drops both headers; the app works either way.

Every response carries `Cache-Control: no-cache`, so an edited script or stylesheet is
picked up on reload without clearing anything. (In production the same files can be cached
for a long time, because every URL carries a content hash — see
[Production Deployment](production-deployment.md#2-caching).)

Three development-only mounts map folders outside `web/` into the server, for checks and
smoke tests in the browser: `/_dev/golden/` → `tests/golden/`, `/_dev/samples/` →
`tests/samples/`, `/_dev/lab/` → `lab/` (a local folder, when present). They are not part
of the site; nothing under `web/` refers to them.

## The build

```bash
node tools/build.mjs
```

prints the plugins it found, in load order, and writes:

| Output | Contents |
|--------|----------|
| `web/index.html` | The page: `web/core/index.template.html` with every plugin's fragments, styles and scripts inlined at the `@plugins:*` markers |
| `web/generated/plugins.json` | The plugins found, in load order |
| `web/generated/fonts.json` | The font catalogue plus which face files are present, with their content hashes |
| `web/generated/default-document.json` | The startup document, or `{ "file": null }` |

All four are gitignored and never edited by hand. During development you rarely run the
build yourself — the dev server does — but it is the quickest way to see a build error, and
it is what a deploy runs.

The build appends `?v=<first 8 hex digits of the file's SHA-256>` to every local `src` and
`href`, and writes the same hashes into `window.RECTO_ASSETS` so a script that fetches a
sibling file itself (a worker, a data file, a wasm binary) can ask `assetURL(path)` for the
hashed URL. No version number is bumped by hand anywhere.

## Adding and removing plugins

A plugin is a folder under `web/plugins/` that holds a `plugin.json`. Drag a folder in and
reload: its button, bars, styles and scripts are on the page. Drag it out and reload: every
trace is gone. `index.html`, the template and the build script are never edited to add a
plugin. The manifest format and the hook bus are described in the
[Tool Expansion Guide](../tool-expansion-guide.md).

## The startup document

The PDF directly inside `web/assets/pdfs/` is opened automatically when the page loads
(alphabetically first when there are several; subfolders are ignored). Swap the file and
reload. With no PDF there, the viewer starts empty and waits for an upload.

## Adding Fonts

`web/assets/fonts/fonts.json` is the font catalogue — the one list of faces the text tool
knows — and the face files (`.ttf` / `.otf`) sit beside it. To add a face, copy the file
into `web/assets/fonts/` and give its family an entry in `fonts.json`: the family name, the
PDF font names that map to it (`pdfNames`), and the file for each style (`regular`, `bold`,
`italic`, `bolditalic`).

The build records which of the listed files are actually present. A family whose regular
file is missing stays in the font menu, disabled and marked *(not installed)*; measurement
falls back along bold italic → bold → italic → regular → Times New Roman.

`python3 tools/dev/fonts_setup.py` is a development script that fills the folder from the
catalogue — the URW faces converted from `../tol0`'s CFF outlines, the Windows faces copied
from a Windows font folder; `--check` only lists what is missing. The built files are
committed, so it is run only after the catalogue gains a face. The site itself needs no
Python.

## Running Tests

```bash
node --test "tests/**/*.test.mjs"
```

runs every suite with Node's built-in test runner — nothing to install.

| Suite | What it holds |
|-------|---------------|
| `tests/documents.test.mjs` | `web/core/pdf-document.js`: open metadata, page rasters (decoded-pixel hashes), image placements, thumbnail sizes |
| `tests/spans.test.mjs` | The embedded-text extractor, full and lean spans |
| `tests/shaping.test.mjs` | HarfBuzz widths and font-metrics tables, equal to the last digit |
| `tests/masks.test.mjs` | The redaction-mask builder, pixel for pixel |
| `tests/index-page.test.mjs` | The generated page's markup and script order; a plugin that is absent leaves no trace |
| `tests/page-controls.test.mjs` | Every control the core and each installed baseline plugin owns is on the page, and the scripts whose order matters load in that order |
| `tests/plugins/<name>/` | An optional plugin's own suites (`*.test.mjs`) and its steps for the browser smoke test (`smoke.mjs`); the folder travels with the plugin |

The expected values live in `tests/golden/` (see `tests/golden/README.md`): recorded
outputs for a set of reference documents, which the suites hold the browser code to. A
change that moves a number shows up as a failing golden, not as something that "looks
right".

### Browser smoke test

```bash
node tests/smoke/smoke.mjs [--chrome <exe>] [--only <golden name>]
```

starts the dev server on a free port, opens the app in headless Chrome and, for every
golden document, uploads it through the real file input, selects a text box, clicks every
toolbar toggle, turns a page — and fails on any console error, page error or failed
request. An installed plugin may add its own steps by shipping
`tests/plugins/<name>/smoke.mjs` (exports `switches`, `settle`, `exercise`, `quiesce` — see
the header of `tests/smoke/smoke.mjs`). It is not part of `node --test`: it needs Chrome,
takes about a minute, and borrows `puppeteer-core` from a sibling checkout
(`../tol0/node_modules`), because this repository has no dependencies of its own. Without
it the script says so and exits with status 2.
