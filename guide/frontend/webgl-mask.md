# WebGL Mask — `webgl-mask.js`

`web/plugins/webgl_mask/webgl-mask.js` renders GPU-accelerated mask overlays over blacked-out page regions. The masks themselves are detected in the browser too — by the plugin's own worker (`mask-worker.js` running `mask-core.js`), from the very pixels the viewer shows.

| File (`web/plugins/webgl_mask/`) | Role |
|------|------|
| `plugin.json` | Declares the toolbar button, the options bar, `webgl-mask.css`, and `webgl-mask.js` in `scripts_before_viewer` |
| `webgl-mask.js` | Overlay canvases, WebGL setup, mask cache, toolbar wiring |
| `mask-worker.js` | The plugin's worker: gray pixels in, mask PNG out |
| `mask-core.js` | `MaskCore.buildMask` — the detection, pure loops with no DOM |

## Integration — fully hook-driven

`webgl-mask.js` is a self-contained plugin: it touches the core only through the [`PDFHooks`](../api-reference/api-reference.md#pdfhooks-events) bus and the document service (`Doc.pagePixels`), and owns its own DOM. Deleting the `web/plugins/webgl_mask/` folder removes every webgl reference from the running app.

| PDFHooks event | Handler does |
|----------------|--------------|
| `ui:ready` | wires the `#toggle-webgl` button + `#edge-subtract` slider; calls `registerSubtoolbar(toggleBtn)` |
| `page:rendered` | **creates** the `.webgl-overlay` `<canvas>` for that page and appends it (the core owns no overlay DOM), then `setupWebGLOverlay(...)` when the document is a PDF (`state.hasPdf`) |
| `pages:refresh` | `refreshWebGLCanvases()` |
| `viewer:clear` | `clearWebGLContexts()` |

There is no `document:loaded` work: a mask is built when a page's overlay
initializes, and the blob cache invalidates itself the moment `state.docHash` changes.

## Architecture

```mermaid
flowchart TD
    A["page becomes visible<br/>IntersectionObserver"] --> B["initWebGLOverlay(canvas, pageNum)"]
    B --> C{"maskBlobCache<br/>has pageNum?"}
    C -- yes --> H
    C -- no --> D["Doc.pagePixels(pageNum, { gray: true })<br/>document service → MuPDF worker"]
    D --> E{"raster.source"}
    E -- "'render' (born-digital page)" --> N["null — no mask"]
    E -- "'embedded' (a scan)" --> F["mask-worker.js<br/>MaskCore.buildMask(gray, w, h)"]
    F --> G["PNG Blob, or null = no redaction"]
    G --> H["maskBlobCache: pageNum → Blob | null<br/>kept for the whole document"]
    N --> H
    H --> I["Two textures: uPage (RGBA, LINEAR) + uMask (LUMINANCE, NEAREST)"]
    I --> J["Fragment shader: multiplicative alpha recovery"]
    J --> K["canvas composited directly over the page image"]
```

Nothing is fetched and nothing leaves the browser: the page's pixels come from the document service, the detection runs in the plugin's worker, and the result is cached in `maskBlobCache` (a `null` entry remembers "no mask here", so page revisits skip the detection entirely). The cache is owned by the document identified by `maskCacheHash` and is validated against `state.docHash` on every use — a page overlay can initialize before any document-change event lands in the plugin. A mask that finishes after another document was opened is dropped.

**Only pages whose raster is the embedded scan get a mask.** A born-digital page, shown as a 96-DPI render, carries no scan to analyse, so `buildPageMask` answers `null` without starting the worker. An image document gets no mask either: `Doc.pagePixels` answers `null` for it.

## Mask detection — `mask-core.js`

`MaskCore.buildMask(gray, width, height)` takes one byte per pixel and returns a gray mask of the same size, or `null` when the page has no blacked-out region:

| Mask value | Meaning |
|------------|---------|
| `255` | Inside a blacked-out region |
| `0` | Clear page |
| mid-gray | On the two pixel rings around a region: the paper's brightness along that edge, which the shader un-blends the anti-aliased border with |

The steps, all written out as plain loops — no image-processing library is involved:

1. **Threshold.** A pixel counts as black only when its gray value is `0`.
2. **Drop discs** (`removeDiscs`). Punched holes and bullet discs are black and solid too. A component is a disc when its bounding box is square within 2 px, 16–44 px across, and filled to about π/4 of the box (70–85 %).
3. **Open** with a 5 × 5 element (erode, then dilate; pixels outside the image never erode the edge). Thin text protrusions and hairlines disappear, solid blocks survive.
4. **Keep the solid external components** (`filterComponents`). Components are 8-connected; one lying inside another's hole is ignored. A component must be at least 17 × 10 px, and its `area / perimeter` — measured over its outer border, followed the way Suzuki's border-following algorithm does — must be at least 2: for a thin stroke that ratio is about half the thickness, for a block far more.
5. **Fill.** Each kept component is filled together with everything it encloses.
6. **Edge lines.** The region is dilated twice by one pixel (4-connected). Each ring pixel is "horizontal" when the region lies above or below it, else "vertical"; each run of ring pixels takes `255 −` the brightest page pixel along it. That value is the mask alpha the shader divides by.

`tests/masks.test.mjs` runs the same `mask-core.js` in Node over every recorded page and requires each mask — or its absence — to equal the recorded masks in `tests/golden/` pixel for pixel. One page differs by design: a scan taller than 8.5 × 11 is masked over the cropped raster the viewer shows, so its mask equals the recording's top rows.

### The worker — `mask-worker.js`

```
→ { type: 'init', core }                       the absolute, content-hashed URL of mask-core.js (importScripts)
→ { id, gray: Uint8Array, width, height }      one page's gray pixels (transferred)
← { id, png: Blob | null, ms }                 the mask as a lossless PNG; null = no redaction on the page
← { id, error }                                on failure — the overlay treats it as "no mask"
```

The worker is started on first use (`maskWorkerReady`) from `assetURL('plugins/webgl_mask/mask-worker.js')`; the URL of `mask-core.js` is made absolute before it is handed over, because a worker resolves relative URLs against its own script. The `samples` buffer `Doc.pagePixels` returned is transferred straight on to the worker — the pixels are never copied on the main thread.

The mask comes back as a PNG blob because that is what the overlay loads into its texture. Gray `v` is written as `(v, v, v, 255)`, so nothing is premultiplied away and the texture's red channel is the mask.

## Functions

### `setupWebGLOverlay(pageContainer, canvas, pageNum)`
Registers a page container with the `IntersectionObserver`. When a page becomes visible, `initWebGLOverlay(canvas, pageNum)` is called, which builds that page's mask on demand; a page that scrolls out of view has its context destroyed (`destroyWebGLOverlay`).

**Texture setup:**
- Page texture (`uPage`): `gl.RGBA`, `gl.LINEAR` filtering, uploaded from the page's `<img id="page<n>">` — the page stays in color
- Mask texture (`uMask`): `gl.LUMINANCE` (single-channel), `gl.NEAREST` filtering (preserves hard pixel boundaries)
- Wrapping: `gl.CLAMP_TO_EDGE`

The canvas takes the mask's pixel size (the scan's own resolution); `webgl-mask.css` stretches it over the page container like the image beneath it, and the inline `mix-blend-mode: normal` composites it directly over the page.

### `clearWebGLContexts()`
Destroys all active WebGL contexts (`WEBGL_lose_context`) and disconnects the observer. Subscribed to the `viewer:clear` event (fired before each page change).

### `updateWebGLUniforms(specificPage?)`
Reads `#edge-subtract` value `/ 255.0` → `uStrength` uniform and redraws. No texture re-upload needed — instant 60fps updates. (The slider element is looked up directly by the plugin; the core `els` cache does not hold it.)

### `refreshWebGLCanvases()`
For every page container on screen: initializes an overlay that has no context yet, otherwise redraws it and shows or hides the canvas according to the toggle.

## Shaders

### Vertex Shader
Draws a full-screen quad; maps clip-space coords to UV with Y-flip.

### Fragment Shader
```glsl
vec3 page = texture2D(uPage, vTexCoord).rgb;
float mask = texture2D(uMask, vTexCoord).r;
float alpha = mask * uStrength;
vec3 result;
if (mask > 0.999) {
  // Interior: fully covered, original unrecoverable — show white
  result = vec3(uStrength);
} else {
  // Border/clear: invert anti-aliasing multiplication, per channel
  result = min(page / max(1.0 - alpha, 0.001), 1.0);
}
gl_FragColor = vec4(result, 1.0);
```

**Three pixel cases:**

| Pixel type | `mask` | Behaviour |
|---|---|---|
| Interior | 1.0 | Outputs `uStrength` (white at full slider) |
| Border | 0 < m < 1 | `page / (1 - mask × strength)` — recovers original via division |
| Clear | 0.0 | `page / 1.0` — passes through unchanged |

The multiplicative recovery correctly reverses anti-aliasing: dark text under a border pixel stays dark; a white background pixel is scaled back to white.

## UI Controls

| Control | ID | Effect |
|---------|-----|--------|
| WebGL toggle | `toggle-webgl` | Shows/hides all `.webgl-overlay` canvases and opens the plugin's options bar (`#webgl-options-bar`) through `openSubtoolbar` |
| Reveal strength | `edge-subtract` | 0–255 → `uStrength` uniform |

Both come from the plugin's own fragments (`toolbar_button.html`, `options_bar.html`), which the build inlines into the page.

## Context Limits

Browsers enforce ~16 simultaneous WebGL contexts. The lazy `IntersectionObserver` strategy ensures contexts are only allocated for pages with actual masked regions, preventing `CONTEXT_LOST_WEBGL` crashes on large documents.
