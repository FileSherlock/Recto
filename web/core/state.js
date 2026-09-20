/* =========================================================
       State & Application Setup
       ========================================================= */
const state = {
  // PDF Viewer State
  numPages: 0,
  pageWidth: GEO.PAGE_WIDTH_PX,
  pageHeight: GEO.PAGE_HEIGHT_PX,
  currentPage: 1,
  currentZoom: 1.0,
  minZoom: 0.5,
  maxZoom: 8.0,
  renderQueue: [],

  // Document
  hasPdf: false,
  currentFile: null,      // the File the user opened — plugins may re-post it
  docHash: null,          // SHA-256 of the document bytes (Doc.open) —
                          // stable identity plugins key per-document caches off

  activeTool: null, // 'add-box' or null
};

const els = {
  // Viewer
  dragOverlay: document.getElementById('drag-overlay'),
  viewerContainer: document.getElementById('viewer-container'),
  viewer: document.getElementById('viewer'),
  titleElem: document.getElementById('document-title'),
  pageCountElem: document.getElementById('page-count'),
  pageInputElem: document.getElementById('page-input'),
  zoomInputElem: document.getElementById('zoom-input'),
  zoomInBtn: document.getElementById('zoom-in'),
  zoomOutBtn: document.getElementById('zoom-out'),
  sidebar: document.getElementById('sidebar'),
  toggleSidebarBtn: document.getElementById('toggle-sidebar'),
  thumbnailView: document.getElementById('thumbnail-view'),
  prevPageBtn: document.getElementById('prev-page'),
  nextPageBtn: document.getElementById('next-page'),

  // The "nothing open" screen. The first page to render empties #viewer and
  // detaches it; these references keep it, so a failed open can put it back.
  placeholder: document.getElementById('viewer-placeholder'),
  placeholderText: document.getElementById('placeholder-text'),
  loader: document.getElementById('analysis-loader'),

  toolAddBoxBtn: document.getElementById('tool-add-box'),
  toolTextBtn: document.getElementById('tool-text'),
  // Plugin-owned controls (including the right-panel "tools sidebar" and its
  // toggle) are looked up by the plugins themselves — the core never
  // references a plugin's DOM.

  // Data
  pdfFile: document.getElementById('pdf-file'),
};