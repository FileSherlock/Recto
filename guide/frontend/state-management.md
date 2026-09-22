# State Management — `state.js`

`web/core/state.js` defines two global objects used by all other frontend modules. It loads third — after `hooks.js` and `geometry.js`, whose `GEO` constants give the page size its defaults.

Both hold **core state only**. Plugin state lives in the plugin — the core object graph
contains nothing that would dangle if a plugin folder were deleted.

## `state` — Application State

```javascript
const state = {
  // PDF Viewer
  numPages: 0,            // 0 = no document is open
  pageWidth: 816,         // GEO.PAGE_WIDTH_PX  — pixel width of the page space
  pageHeight: 1056,       // GEO.PAGE_HEIGHT_PX — pixel height of the page space
  currentPage: 1,
  currentZoom: 1.0,
  minZoom: 0.5,
  maxZoom: 8.0,

  // Document
  hasPdf: false,          // the open document is a PDF (not an image)
  currentFile: null,      // the File the user opened; stays null for the startup document
  docHash: null,          // SHA-256 of the document bytes (from Doc.open)

  activeTool: null,       // 'add-box', 'text' or null
};
```

There is no list of page images. A page's raster is asked from the document service at
the moment it is shown — `Doc.pageImageURL(n)` — because the service keeps only a small
LRU of `blob:` URLs and revokes the ones it evicts. "A document is open" is
`state.numPages > 0`; `Doc.info` holds the full description of the open document.

`docHash` is the field plugins reach for. It is the document's identity: a plugin keys
its per-document cache off it, and compares it before and after every `await` to notice
that the user opened another document meanwhile:

```javascript
const hash = state.docHash;
const raw = await Doc.structuredText(pageNum);
if (hash !== state.docHash) return;          // the document changed underway
```

A plugin that analyses the open document never needs the file again — it asks the
document service for the page's pixels (`Doc.pagePixels`), its raw structured text
(`Doc.structuredText`) or, for a worker of its own, the bytes (`Doc.bytes()`). That also
covers the startup document, for which `currentFile` is `null`.

`showDocument()` in `pdf-viewer.js` writes `numPages`, `pageWidth`, `pageHeight` and
`docHash`; `goToPage()` writes `currentPage`; `handleFileUpload()` writes `currentFile` and
`hasPdf`.

### `utbState` — Unified Text Box State

All text on the page — embedded PDF text, manually added boxes, HarfBuzz recreations — is managed
through the global `utbState` object defined in `web/plugins/text_tool/unified-text-box.js`:

```javascript
const utbState = {
  boxes: [],              // UnifiedTextBox[] — single array for all text
  selectedId: null,       // id of currently selected box
  microTypoId: null,      // id of box in micro-typography nudge mode
  microTypoCharIdx: null, // index of the character being nudged
  editingId: null,        // id of box in inline-text-edit mode
  // addBox / getBox / removeBox / updateBox / getPageBoxes / reset
};
```

A box carries a `type`, and plugins may contribute their own — a plugin adds its boxes on
`document:loaded` or `page:rendered` and `text_tool` renders and edits them like any other
box. This is how a plugin puts content on the page without the core knowing it exists.

`utbState` is plugin state, not core state: the core touches it in exactly one place,
`showDocument()`, which calls `utbState.reset()` behind a `typeof` guard when a new
document comes on screen.

See [SVG Text Layer](embedded-text-viewer.md) for the full `UnifiedTextBox` data model.

## `els` — DOM Element Cache

Core DOM elements are cached at load time to avoid repeated `getElementById` calls:

| Group | Elements |
|-------|----------|
| **Viewer** | `dragOverlay`, `viewerContainer`, `viewer`, `titleElem`, `pageCountElem`, `pageInputElem`, `zoomInputElem`, `zoomInBtn`, `zoomOutBtn`, `sidebar`, `toggleSidebarBtn`, `thumbnailView`, `prevPageBtn`, `nextPageBtn` |
| **Tools** | `toolAddBoxBtn` |
| **Data** | `pdfFile` |

The **Tools** entry is looked up by id (`#tool-add-box`) and is `null` when no plugin's
fragment supplies the element — it comes from `text_tool`'s bar. `app.js` checks before wiring it.

> **Plugin-owned controls are not in `els`.** The core cache holds no plugin elements — not the
> webgl mask toggle (`#toggle-webgl`), the reveal-strength slider (`#edge-subtract`), nor the
> add-text button (`#tt-add-text-btn`). Each plugin looks up its own DOM with
> `document.getElementById(...)` and optional chaining (`?.`), typically from a
> `PDFHooks.on('ui:ready', …)` handler — see the
> [`PDFHooks` events](../api-reference/api-reference.md#pdfhooks-events).
