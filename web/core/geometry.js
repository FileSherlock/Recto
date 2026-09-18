// geometry.js
// Single source of truth for the page geometry and DPI relationship on the
// page. (web/core/pdf-document.js carries the same constants for the worker.)
//
// Canonical geometry space = source-PNG image pixels (96 DPI): box x/y/w/h, all
// widths, the SVG viewBox and state.pageWidth/Height. Canonical typography unit
// = points (box.sizePt). Points are converted to image pixels exactly once, at
// the SVG render boundary (svg-renderer.js). Read these constants instead of
// re-deriving 0.75 / 816 / 1056 / 612 anywhere else.

const GEO = {
  IMAGE_DPI: 96,
  POINT_DPI: 72,

  PT_TO_PX: 96 / 72,   // 1.3333… — multiply points to get image px
  PX_TO_PT: 72 / 96,   // 0.75    — multiply image px to get points

  // Standard US-Letter page in each space.
  PAGE_WIDTH_PT: 612,
  PAGE_WIDTH_PX: 816,
  PAGE_HEIGHT_PX: 1056,

  // px-per-pt for the CURRENTLY loaded document. Equals PT_TO_PX (4/3) for a
  // standard 816-px page, but tracks the real image resolution for larger
  // scans (pageWidth / 612), so font size stays correct on any page.
  docPxPerPt() {
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
