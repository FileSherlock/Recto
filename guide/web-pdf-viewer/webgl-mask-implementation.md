# WebGL Mask: Implementation Overview

The WebGL mask system provides a high-performance 60FPS overlay for visualizing the blacked-out regions of a PDF dynamically. All of it lives in one plugin folder, `web/plugins/webgl_mask/`, and all of it runs in the browser: the mask is built in the plugin's own worker, the overlay is drawn on the GPU.

```
web/plugins/webgl_mask/
├── plugin.json           # manifest: webgl-mask.js is a scripts_before_viewer entry
├── toolbar_button.html   # #toggle-webgl
├── options_bar.html      # #webgl-options-bar with the Reveal Strength slider (#edge-subtract)
├── webgl-mask.css        # .webgl-overlay
├── webgl-mask.js         # overlay lifecycle, mask cache, worker client, shaders
├── mask-worker.js        # the worker: runs mask-core.js, returns the mask as a PNG blob
└── mask-core.js          # MaskCore.buildMask — the detection and mask synthesis, no DOM
```

## 1. Mask Generation (`mask-core.js`, in `mask-worker.js`)

The input is the page's gray pixels from the core's document service:
`Doc.pagePixels(pageNum, { gray: true })` → `{ width, height, samples, source, … }`.

- **Which pages:** only a page whose raster is its embedded scan (`source === 'embedded'`) is masked. A born-digital page, shown as a 96-dpi render, is not analysed and gets no overlay. For an image document `Doc.pagePixels` yields `null`: the plugin's worker decodes `Doc.pageImageURL(n)` itself (over white, gray by `MaskCore.grayOf`) and masks that.
- **Black-bar detection** (`MaskCore.regions`):
  1. Threshold pixels ≤ 0 → the black image
  2. A shape rule removes hole punches and bullet discs (square box, 16–44 px across, filled to about π/4)
  3. A 5×5 opening removes text strokes that touch a bar
  4. External 8-connected components are kept when their box is at least 17 × 10 px and `area / perimeter ≥ 2` (thin lines go), and written back as they are — nothing a component encloses is filled, so the gaps between touching bars keep their text
- **Mask synthesis** (`MaskCore.transmission` → `buildMask`):
  - Interior pixels → `255` (fully masked, shown white)
  - Every box has a soft rim of 1–3 px through which the page shows as `page × t`. The region's outline is cut into straight sides; per side and rim line the level is read off the page as the brightest vouched-for pixel (text only darkens), per *piece* of the side where two boxes end in one pixel column; convex corners get `1 − (1 − tx)(1 − ty)`, crossing rims multiply
  - Rim pixels → `255 · (1 − t)`, which the shader divides out again; a pixel darker than its line's level is text and stays that much darker
  - The rules, their text-safety and the measurements behind them: [frontend/webgl-mask.md](../frontend/webgl-mask.md#edges--maskcoretransmission-this-plugins-own)
- **Sparse optimization:** Pages with no masked regions return `null` — no PNG is encoded and no GL context is created.

The algorithm is described step by step in [Artifact Visualizer](artifact-visualizer.md).

## 2. The Worker Boundary (`mask-worker.js`)

Detection takes about 150 ms for a full-page scan — too long for the main thread while the user scrolls — so `webgl-mask.js` hands each page to a dedicated worker:

- The worker is created on first use from `assetURL('plugins/webgl_mask/mask-worker.js')` and told where `mask-core.js` is (`{ type: 'init', core }`, an absolute content-hashed URL, because a worker resolves relative URLs against its own script).
- `{ id, gray, width, height }` — the gray buffer is **transferred**, not copied.
- The answer is `{ id, png, ms }`: the mask as a lossless PNG `Blob` (encoded with `OffscreenCanvas.convertToBlob`), or `png: null` when the page has no redaction. A failure answers `{ id, error }` and is logged; the page then simply has no overlay.

Detection runs on demand per page, so opening a huge document costs nothing here, and nothing about the document ever leaves the browser.

## 3. Frontend: GPU Rendering (`webgl-mask.js`)

A secondary `<canvas class="webgl-overlay">` is positioned over the page image. The plugin creates it itself in its `page:rendered` handler; the core knows nothing about it.

### Lazy Instantiation
Browsers limit ~16 simultaneous WebGL contexts. An `IntersectionObserver` (one viewport of margin above and below) ensures contexts are only created for pages near the viewport and are released (`WEBGL_lose_context`) when a page scrolls away. `initWebGLOverlay` builds the page's mask on first sight and caches it (or the "no mask" answer) in `maskBlobCache` for the rest of the document's lifetime. The cache belongs to one document: it is checked against `state.docHash` on every use and cleared when the hash differs, and a mask that arrives after the document changed is dropped.

### Textures
- **`uPage`** — the page image (the viewer's `<img id="page<N>">`), `RGBA`, `LINEAR` filtering. RGBA rather than luminance: the page raster can be in colour (letterhead art, hyperlink blue) and the overlay must not desaturate it.
- **`uMask`** — the generated mask PNG, `LUMINANCE`, `NEAREST` filtering (no blur on edges)

### Fragment Shader
```glsl
vec3 page = texture2D(uPage, vTexCoord).rgb;
float mask = texture2D(uMask, vTexCoord).r;
float alpha = mask * uStrength;
if (mask > 0.999) {
  result = vec3(uStrength);                           // interior: show white
} else {
  result = min(page / max(1.0 - alpha, 0.001), 1.0);  // border: multiplicative recovery, per channel
}
```

Anti-aliasing blends edge pixels as `P_edge = (1 - α) × P_orig`. Dividing by `(1 - α)` recovers `P_orig` exactly — dark text stays dark, white background returns to white. The additive approach (`page + mask`) would wash out dark pixels.

The canvas is drawn opaque with blending disabled, so it replaces the page image underneath it rather than tinting it.

### Real-Time Updates
`updateWebGLUniforms()` pipes the **Reveal Strength** slider (`#edge-subtract`, `value / 255.0`) into the `uStrength` uniform — no texture re-upload, instant 60fps response.

### Lifecycle hooks

| Hook | What the plugin does |
|------|----------------------|
| `page:rendered` | Creates the overlay canvas for that page and starts observing the page container |
| `viewer:clear` | Releases every GL context before the viewer swaps pages |
| `pages:refresh` | Re-initializes missing overlays and redraws the existing ones |
| `ui:ready` | Wires `#toggle-webgl` (registered with `registerSubtoolbar`, opens `#webgl-options-bar` through `openSubtoolbar`) and the slider |

No `document:loaded` handler is needed: masks are built lazily, and the cache invalidates itself the moment `state.docHash` changes.

## 4. Tests

`tests/masks.test.mjs` runs `mask-core.js` under Node over every reference PDF page and requires the mask — or its absence — to equal the recorded one pixel for pixel. `tests/page-controls.test.mjs` checks that `#toggle-webgl`, `#webgl-options-bar` and `#edge-subtract` are on the generated page.
