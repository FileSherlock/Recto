// unified-text-box.js
// Single source-of-truth data model for all text on the page.
// Replaces etvState.spans[] and state.redactions[] with one array.

let _utbIdCounter = 0;
function nextUtbId() { return `utb-${++_utbIdCounter}`; }

// The typography glyph positions depend on: family, style, size and letter
// spacing — what a box's measured positions were measured under.
function utbFaceOf(box) {
  return { fontFamily: box.fontFamily, bold: !!box.bold, italic: !!box.italic, sizePt: +box.sizePt,
    letterSpacing: +box.letterSpacing || 0 };
}
// Are the box's measured per-character positions still the positions of the
// face it is set in? Bold glyphs at regular pens overlap; a larger size at the
// old pens collides. When this is false every renderer lays the text afresh
// from box.x.
function utbFaceChanged(box) {
  const f = box.baseFace;
  if (!f) return false;
  return !(f.fontFamily === box.fontFamily && f.bold === !!box.bold && f.italic === !!box.italic &&
    Math.abs(f.sizePt - box.sizePt) < 0.005 && Math.abs((f.letterSpacing || 0) - (+box.letterSpacing || 0)) < 1e-9);
}
// Did the user choose a kerning that is not the page's? Measured positions
// embody the page's kerning (or its absence); a box that must show the other
// one is laid afresh. The page's kerning comes from the same guarded seam the
// renderer asks (window.utbAutoKerning); unknown counts as "not kerned".
function utbUserKerning(box) {
  if (box.kerningAuto) return false;
  let page = false;
  try { const k = window.utbAutoKerning?.(box); if (typeof k === 'boolean') page = k; } catch { /* plugin's problem */ }
  return !!box.kerning !== page;
}
function utbCharsValid(box) {
  return !!box.baseCharPositions?.length && !utbFaceChanged(box) && !utbUserKerning(box);
}
window.utbFaceOf = utbFaceOf;
window.utbFaceChanged = utbFaceChanged;
window.utbUserKerning = utbUserKerning;
window.utbCharsValid = utbCharsValid;

class UnifiedTextBox {
  constructor(data) {
    this.id = data.id || nextUtbId();
    this.type = data.type || 'embedded'; // 'embedded' | 'ocr' | 'redaction' | 'harfbuzz'
    this.page = data.page || 1;
    this.text = data.text || '';
    this.lineId = data.lineId || null;

    // Spatial (document pixel space — 816×1056 base)
    this.x = data.x || 0;
    this.y = data.y || 0;
    this.w = data.w || 0;
    this.h = data.h || 0;

    // Typography
    this.fontFamily = data.fontFamily || 'Times New Roman';
    // Font size is stored ONLY in points (the canonical unit). It is converted
    // to image px exactly once, at SVG render time (GEO.docPtToPx in
    // svg-renderer.js). There is no separate px field.
    this.sizePt = data.sizePt || 12;
    this.bold = data.bold || false;
    this.italic = data.italic || false;
    this.underline = data.underline || false;
    this.strikethrough = data.strikethrough || false;
    this.letterSpacing = data.letterSpacing || 0;
    this.color = data.color || null;  // null = per-type default

    // Kerning. `kerning` is always the EFFECTIVE boolean every reader uses
    // (SVG fontKerning, width requests, a pixel renderer). `kerningAuto` says
    // nobody chose it yet: an analysis plugin that knows how the page's
    // producer laid its text may then set it (window.utbAutoKerning, see
    // svg-renderer.js); the toolbar's Kerning box clears the flag for good.
    // A caller that passes `kerning` explicitly has chosen.
    this.kerning = !!data.kerning;
    this.kerningAuto = data.kerningAuto ?? (data.kerning === undefined || data.kerning === null);
    this.defaultSpaceWidth = data.defaultSpaceWidth ?? true; // true = use native font spacing
    this.spaceWidth = data.spaceWidth || null;               // manual override (used when defaultSpaceWidth is false)
    this.nativeSpaceWidth = data.nativeSpaceWidth || null;   // cached HarfBuzz natural space advance

    // Per-character positioning: [{c, x, w}] offsets relative to box.x
    this.baseCharPositions = data.baseCharPositions || null;
    // …which were measured under ONE typography. They stop applying the
    // moment the box's family, style, size or letter spacing no longer is that
    // one, or the user asks for a kerning the page did not have
    // (utbCharsValid), and apply again if the user goes back.
    this.baseFace = data.baseFace || utbFaceOf(this);

    // Micro-typography: index → delta px (overrides applied on top of baseCharPositions)
    this.charAdvances = data.charAdvances || {};

    // Redaction-only fields
    this.widths = data.widths || {};  // candidate → pixel width
    this.labelText = data.labelText || '';
    this.tolerance = data.tolerance ?? 3;
    this.manualLabel = data.manualLabel || false;
    this.uppercase = data.uppercase || false;  // force-uppercase display

    // Per-box name-format settings + derived candidate list. Populated by
    // whichever plugin owns matching; null when none is installed (nothing in
    // text_tool or the core reads them).
    this.nameSettings = data.nameSettings || null;
    this.candidates = data.candidates || null;

    // Render font override (e.g. 'times.ttf') — null = use fontFamily
    this.renderFont = data.renderFont || null;

    // Layout: when true the box auto-sizes its width to the rendered text on
    // every render and draws no manual resize handles (used by manually-added
    // text boxes). Server-extracted spans keep their real width (false).
    this.autoWidth = data.autoWidth || false;
  }
}


// ── Global State ──────────────────────────────────────────────

const utbState = {
  boxes: [],          // UnifiedTextBox[]
  selectedId: null,   // id of currently selected box
  microTypoId: null,  // id of box in micro-typography mode
  microTypoCharIdx: null,
  editingId: null,    // id of box in inline-text-edit mode

  addBox(data) {
    const box = data instanceof UnifiedTextBox ? data : new UnifiedTextBox(data);
    this.boxes.push(box);
    return box;
  },

  getBox(id) {
    return this.boxes.find(b => b.id === id) || null;
  },

  removeBox(id) {
    const idx = this.boxes.findIndex(b => b.id === id);
    if (idx !== -1) this.boxes.splice(idx, 1);
  },

  updateBox(id, patch) {
    const box = this.getBox(id);
    if (box) Object.assign(box, patch);
    return box;
  },

  getPageBoxes(pageNum) {
    return this.boxes.filter(b => b.page === pageNum);
  },

  reset() {
    this.boxes = [];
    this.selectedId = null;
    this.microTypoId = null;
    this.microTypoCharIdx = null;
    this.editingId = null;
  },
};


// ── Conversion helpers ────────────────────────────────────────

/**
 * Convert an embedded-text span (embedded_text_viewer's extract.js) to UnifiedTextBox.
 * Span schema: {page, text, x, y, w, h, fontSize, sizePt, font, flags,
 *               lineId, chars:[{c,x,w}], fontWeight, fontStyle, ...}
 */
function spanToUnified(span) {
  const font = span.font || '';
  const isBold = /bold/i.test(font) || span.fontWeight === 'bold' || !!(span.flags & 16);
  const isItalic = /italic|oblique/i.test(font) || span.fontStyle === 'italic' || !!(span.flags & 2);

  return new UnifiedTextBox({
    type: 'embedded',
    page: span.page,
    text: span.text,
    lineId: span.lineId || null,
    x: span.x, y: span.y, w: span.w, h: span.h,
    fontFamily: normUtbFont(font) || 'Times New Roman',
    sizePt: span.sizePt || span.fontSize || 12,
    bold: isBold,
    italic: isItalic,
    letterSpacing: parseFloat(span.letterSpacing) || 0,
    color: span.color || null,
    baseCharPositions: span.chars?.length ? span.chars : null,
  });
}

// redactionToUnified() removed — redactions are now created natively as
// UnifiedTextBox instances; there is no legacy state.redactions[] to convert from.

/**
 * Normalize a raw PDF font name to a catalogue family (a CSS family the
 * @font-face rules from fonts.js draw with). The catalogue's aliases decide
 * ('TimesNewRomanPSMT' is Times New Roman, 'DejaVuSerif' is DejaVu Serif),
 * with one exception: the base-14 names — 'Times-Roman', 'Helvetica',
 * 'Courier' — map to the Windows faces set to their metrics (Times New
 * Roman, Arial, Courier New), not to MuPDF's URW faces the catalogue lists
 * them under. An OCR producer's text layer names those base-14 substitutes
 * for a page that was set in the Windows face (every scan of the corpus:
 * the reader finds Times New Roman and Courier New under a layer that says
 * Times-Roman and Courier), and the layer's boxes, and a box added beside
 * them, must show and measure in the page's face. MuPDF's own faces stay a
 * toolbar choice for a page MuPDF drew. The substring guesses fill in
 * before the catalogue has loaded or for a name it does not list. The
 * single implementation.
 */
const UTB_BASE14_TWIN = { 'Nimbus Roman': 'Times New Roman', 'Nimbus Sans': 'Arial', 'Nimbus Mono PS': 'Courier New' };
function normUtbFont(name) {
  if (!name) return '';
  const fromCatalog = window.FontCatalog?.familyForPdfName?.(name);
  if (fromCatalog) {
    const twin = UTB_BASE14_TWIN[fromCatalog];
    return twin && window.FontCatalog.has(twin) ? twin : fromCatalog;
  }
  const n = name.replace(/^[A-Z]{6}\+/, '').split(',')[0].trim();
  const lc = n.toLowerCase().replace(/[\s\-_]/g, '');
  if (lc.includes('times')) return 'Times New Roman';
  if (lc.includes('helvetica') || lc.includes('arial')) return 'Arial';
  if (lc.includes('courier')) return 'Courier New';
  if (lc.includes('verdana')) return 'Verdana';
  if (lc.includes('calibri')) return 'Calibri';
  if (lc.includes('segoe')) return 'Segoe UI';
  return n;
}

// Expose globals
window.UnifiedTextBox = UnifiedTextBox;
window.utbState = utbState;
window.spanToUnified = spanToUnified;
window.normUtbFont = normUtbFont;


// ── Adapter functions for legacy consumers ────────────────────

/**
 * Find the nearest text line (embedded span or OCR-read line) to a Y
 * coordinate on a page. Drop-in replacement for findNearestETVLine().
 * Returns { y, h, lineId, font, fontSize } or null.
 */
function utbFindNearestLine(pageNum, y, threshold = 2.0) {
  // a line on a hidden layer is not what the user clicked beside: when the
  // OCR layer is shown and the embedded one hidden, the embedded line's face
  // (the text layer's declared substitute) must not become the new box's
  const cl = document.body.classList;
  const shown = b => !(b.type === 'embedded' && cl.contains('hide-embedded-text')) &&
                     !(b.type === 'ocr' && cl.contains('hide-ocr-text'));
  const pageBoxes = utbState.boxes.filter(b => b.page === pageNum &&
    (b.type === 'embedded' || b.type === 'ocr') && shown(b));
  if (!pageBoxes.length) return null;

  let nearest = null;
  let minDist = Infinity;
  for (const b of pageBoxes) {
    const cy = b.y + b.h / 2;
    const d = Math.abs(cy - y);
    if (d < minDist) { minDist = d; nearest = b; }
  }
  if (!nearest || minDist > nearest.h * threshold) return null;

  return {
    y: nearest.y,
    h: nearest.h,
    lineId: nearest.lineId,
    font: nearest.fontFamily,
    sizePt: nearest.sizePt,
  };
}

/**
 * Get an etvState.spans-compatible array for legacy consumers.
 * Returns embedded boxes in the span schema.
 */
function utbGetSpansCompat() {
  return utbState.boxes
    .filter(b => b.type === 'embedded' || b.type === 'ocr')
    .map(b => ({
      page: b.page,
      text: b.text,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      lineId: b.lineId,
      chars: b.baseCharPositions,
      sizePt: b.sizePt,
      font: b.fontFamily,
    }));
}

window.utbFindNearestLine = utbFindNearestLine;
window.utbGetSpansCompat = utbGetSpansCompat;
