// geometry.js
// Single source of truth for the page geometry and DPI relationship on the
// page. (web/core/pdf-document.js carries the same constants for the worker.)
//
// Canonical geometry space = the page's pixel space at 96 DPI: box x/y/w/h, all
// widths, the SVG viewBox and state.pageWidth/Height. Every page has its own
// (Doc.pageSize — what its raster shows: 816 × 1056 for a US-Letter scan,
// 794 × 1123 for an A4 page, 1056 × 816 for a landscape one); state.pageWidth/
// Height are the shown page's. Canonical typography unit = points (box.sizePt).
// Points are converted to image pixels exactly once, at the SVG render boundary
// (svg-renderer.js). Read these constants instead of re-deriving 0.75 / 816 /
// 1056 / 612 anywhere else.

const GEO = {
  IMAGE_DPI: 96,
  POINT_DPI: 72,

  PT_TO_PX: 96 / 72,   // 1.3333… — multiply points to get image px
  PX_TO_PT: 72 / 96,   // 0.75    — multiply image px to get points

  // Standard US-Letter page in each space.
  PAGE_WIDTH_PT: 612,
  PAGE_WIDTH_PX: 816,
  PAGE_HEIGHT_PX: 1056,

  // px-per-pt for the CURRENTLY loaded document (Doc.open's pxPerPt): PT_TO_PX
  // (4/3) on every page of a PDF, whatever its size — its pixel space is 96
  // DPI; an image document is taken as 8.5 in wide (its width / 612).
  docPxPerPt() {
    if (typeof state !== 'undefined' && state.pxPerPt) return state.pxPerPt;
    const pw = (typeof state !== 'undefined' && state.pageWidth) || this.PAGE_WIDTH_PX;
    return pw / this.PAGE_WIDTH_PT;
  },

  // Convert a point size to image px in the current document's space. This is
  // the only pt -> px conversion in the app (used at SVG render time).
  docPtToPx(pt) {
    return pt * this.docPxPerPt();
  },

  // The `scale` value text measurement expects (px-per-pt as a percentage).
  docScale() {
    return this.docPxPerPt() * 100;
  },
};

window.GEO = GEO;
