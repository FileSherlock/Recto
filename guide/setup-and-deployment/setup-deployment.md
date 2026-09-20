# Setup & Deployment

Recto is a static website. Every piece of work — opening the PDF, rasterizing pages,
extracting text, measuring text, building masks — runs in the visitor's browser, so there
is nothing to install on a server and nothing to keep running. This section covers running
it locally, publishing it, and what to check when it does not load.

## Contents

| Document | Description |
|----------|-------------|
| [Local Development](local-development.md) | The dev server, the build, the startup document, fonts, tests |
| [Production Deployment](production-deployment.md) | Build once, publish the `web/` folder on any static host; MIME types, caching, optional headers |
| [Troubleshooting](troubleshooting.md) | What to check when the page, a worker, or a document does not load |

## Prerequisites

- **Node.js 22 or newer** (any current LTS) — only to run the two scripts in `tools/` and
  the test suites. There is no package manager, no `node_modules`, and no install step: both
  scripts use nothing but Node's standard library.
- **A current browser** with module workers, WebAssembly, `OffscreenCanvas` and
  `crypto.subtle` (see [Troubleshooting](troubleshooting.md#browser-support)).

The published site needs neither Node nor anything else at run time — only a host that
serves files.

## The two scripts

| Script | What it does |
|--------|--------------|
| `node tools/serve.mjs [port]` | Development server on `http://localhost:5000` (or the given port). Serves `web/` with correct MIME types and rebuilds the page on every request for it. |
| `node tools/build.mjs` | The build: scans `web/plugins/*/plugin.json` and writes `web/index.html` and `web/generated/*.json`. A deploy runs it once; the dev server runs it for you. |

Nothing is transpiled or bundled. The build only assembles the page from the core template
and the plugins' HTML fragments, and stamps every local URL with a content hash.

## What the site is made of

Everything the site serves lives under `web/`:

| Path | Contents |
|------|----------|
| `web/index.html`, `web/generated/` | **Generated** by the build (gitignored) — never edited by hand |
| `web/core/` | The core: page template, viewer, hook bus, document service, the MuPDF worker |
| `web/plugins/<name>/` | One self-contained folder per plugin: `plugin.json`, HTML fragments, scripts, styles, data |
| `web/vendor/mupdf/` | MuPDF 1.28.0 as WebAssembly (AGPL-3.0) — opens and rasterizes documents |
| `web/vendor/harfbuzz/` | harfbuzzjs 1.6.1 (HarfBuzz 14.4.0, MIT) — text shaping and measurement |
| `web/assets/fonts/` | The font catalogue (`fonts.json`) and the face files |
| `web/assets/pdfs/` | The startup document |

The vendored binaries are pinned copies; `web/vendor/README.md` records their versions,
origins and licences, and what to check before upgrading one. The page additionally loads
two icon/text web fonts from a public font CDN; every script comes from `web/`.
