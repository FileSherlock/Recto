---
home: true
heroImage: null
actions:
  - text: Get Started
    link: /architecture/architecture-overview.html
    type: primary
  - text: API Reference
    link: /api-reference/api-reference.html
    type: secondary
features:
  - title: Core + Plugins
    details: The core opens and renders a document, then gets out of the way. Every feature is a drop-in folder with a manifest that the build scan discovers on its own.
  - title: Real Typography
    details: HarfBuzz text shaping measures and places text with true font metrics, so what you add matches what was already there.
  - title: Runs in the Browser
    details: A static site. MuPDF and HarfBuzz run as WebAssembly, analysis runs in workers, and the document you open never leaves your machine.
footer: AGPL-3.0 Licensed | Copyright © 2026
---

# Recto Documentation

Recto is an extensible PDF editor that runs entirely in the browser. This guide covers its
architecture, its plugin API, and how to run, test and deploy it.

## Core concepts

Recto is built on a **core + plugin** architecture backed by **two mechanisms**, one for
assembling the page and one for the running app, so the core never references a plugin by
name.

- **Core (`web/core/`)** — opens the document, rasterizes its pages, reports its typography,
  and hosts the viewer. That is *all* it does: the core runs no analysis of its own. It
  provides the page template the build fills in, the `Doc` document service (page rasters,
  page pixels, raw structured text — all from a MuPDF worker inside the browser), and the
  `PDFHooks` event bus (lifecycle wiring).
- **Plugins (`web/plugins/<name>/`)** — every actual feature. Text editing (`text_tool`),
  embedded-text inspection (`embedded_text_viewer`) and GPU masking (`webgl_mask`) are each an
  independent folder. Each holds a `plugin.json` that declares the slots it fills — styles,
  toolbar button, options or ribbon bar, sidebar, scripts. Plugin JavaScript subscribes to
  lifecycle events with `PDFHooks.on(...)` rather than being called by name.
- **Adding a tool** — create the folder with a `plugin.json`, its HTML fragments, scripts and
  styles. `tools/build.mjs` scans `web/plugins/` and writes `web/index.html`; the development
  server runs that scan on every reload. No changes to the page template, the build, or
  any core script.
- **Removing a tool** — drag the folder out. Its markup, styles, scripts, workers, data files
  and event subscriptions all disappear together, leaving nothing dangling in the core.

The document lifecycle makes the boundary concrete: the core's `Doc.open()` parses the file
in a worker and returns metadata and nothing else; pages are produced one at a time by
`Doc.pageImageURL(n)`, and the viewer emits `document:loaded`. A plugin that wants to analyse
the document listens for the lifecycle events and reads what it needs through `Doc`.
`webgl_mask` is the reference example — for each page it overlays it takes
`Doc.pagePixels(n, { gray: true })`, finds the masked regions in its own worker and tints
them on the GPU. Delete it, and the core is unchanged: it never knew the plugin existed.

Running it takes one command and no install step — `node tools/serve.mjs`, then
<http://localhost:5000>. The tests are `node --test "tests/**/*.test.mjs"`.

## Navigation

- **[Architecture Overview](./architecture/architecture-overview.md)** — the high-level system design: the static layout, the document service, the data flow.
  - [Scale & Size Detection](./architecture/scale-and-size-detection.md) — how the pt→px scale and the body font size of a document are found.
  - [Unified Text Box](./architecture/unified-text-box.md) — the one data model and rendering pipeline behind every piece of text on a page.
- **[Tool Expansion Guide](./tool-expansion-guide.md)** — how to write a plugin: `plugin.json`, the `PDFHooks` bus, the `Doc` service, `assetURL()`, workers, tests, removal.
- **[UI Map](./ui-map.md)** — every visible control: label → owning plugin → fragment → handler script.
- **[Frontend Implementation](./frontend/javascript-module-reference.md)** — the vanilla JS and WebGL rendering engine, module by module.
- **[API Reference](./api-reference/api-reference.md)** — the JavaScript APIs of the core and the baseline plugins.
- **[Setup & Deployment](./setup-and-deployment/setup-deployment.md)** — local development, static deployment, troubleshooting.
- **[Optional Plugins](./plugins/)** — plugins that ship separately from the baseline. Nothing above depends on anything in there.
