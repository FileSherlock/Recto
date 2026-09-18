# UI Events — `ui-events.js`

`web/core/ui-events.js` handles the zoom controls and thumbnail rendering. It loads after `pdf-viewer.js` and before `app.js`, which wires its functions to the toolbar.

## Zoom

### `updateZoomLevelText()`
Syncs the zoom input display (`#zoom-input`) with `state.currentZoom`.

### `updateCSSZoom()`
Applies the current zoom by setting the `--scale-factor` CSS custom property on the viewer (and the `zoom-in` class above 100 %), then emits the `zoom:changed` PDFHooks event (`{ zoom }`) so any plugin that needs a zoom-aware redraw can subscribe. The core calls no plugin function by name.

### `processZoomFromText(newZoom, mouseX?, mouseY?)`
Constrains the zoom to `[minZoom, maxZoom]`, updates `state.currentZoom`, and applies. When mouse coordinates are provided (Ctrl+Wheel), preserves the document position under the cursor by adjusting scroll offsets.

`app.js` feeds it from three places: the zoom buttons (`#zoom-in` / `#zoom-out`, a factor of 1.1 per click), the zoom input's `change` event, and Ctrl+Wheel over the viewer.

**Zoom is CSS-only** — nothing is re-rendered and no page raster is asked for again, because pages are `<img>` elements that scale via CSS and the SVG text layers have a fixed `viewBox`.

## Box Resizing & Dragging

> `ui-events.js` holds no box handlers. Boxes are SVG elements, and drag/resize is handled entirely by SVG-native event delegation in [`text_tool`'s `drag-resize.js`](text-tool.md). See [SVG Text Layer](embedded-text-viewer.md).

## Thumbnails

### `renderThumbnails()`
Builds the sidebar thumbnail strip (`#thumbnail-view`): one `.thumbnail-container` per page, holding a 180 px wide `<img>` of fixed height and a page number label. Clicking navigates to that page via `goToPage()`. The active page gets the `.active` class.

The images start empty. An `IntersectionObserver` (root: the strip, 400 px margin) asks the document service for a thumbnail — `Doc.pageImageURL(n, { thumb: true })`, a 180 px downscale of the page raster — only when the thumbnail scrolls into view, so on a multi-thousand-page document only the thumbnails the user looks at are ever made. The fixed height, computed from `state.pageHeight / state.pageWidth`, keeps the strip's layout stable while they arrive.

Each call replaces the previous observer, and a URL that arrives after the user opened another document (`state.docHash` changed) is dropped.
