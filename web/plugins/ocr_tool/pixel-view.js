// pixel-view.js — MuPDF pixel view (Recto-owned adapter, like ocr-tool.js).
//
// Draws every text box the way mupdf would have rasterized it onto this page:
// the reader's own glyph bitmaps (glyphs.bin — already downloaded for OCR),
// on mupdf's ¼-px pen lattice, on a whole-pixel baseline, composited through
// the certified blend law. The laws live in engine/render.js (synced verbatim
// from tol0, where `npm run certify:render` proves them against real mupdf).
// This file only decides WHICH set draws a box, WHERE its pens are, and how
// the raster is tinted and diffed.
//
// Two toggles in the Auto OCR bar:
//   MuPDF pixels (#ocr-pixel-view, Settings)  raster instead of SVG text, tinted like
//                                   the SVG text would be, alpha = ink darkness
//   Diff         (#ocr-pixel-diff, Settings)  matching ink pixels faint; pixels that
//                                   DIFFER from the page solid red; page ink
//                                   the OCR left UNEXPLAINED solid orange —
//                                   zero red and zero orange means the line
//                                   IS the page
//
// The Diff compares exactly what the reader compared: the viewer's page
// raster through the same PageEngine buffer and colour whitening, through
// the page's palette map when the line was read with a palette pass, and
// NEVER under the reader's object mask or box halos (redaction boxes, rules,
// their padded rows and the ±2-column halo around a box — a descender dipping
// into a box's padding, or a glyph half-swallowed by the redactor, is
// `masked`, not a mismatch). Then it runs the reader's residual the other
// way round: page ink inside the line's band that no drawn glyph explains
// (a quote mark the reader never transcribed) is reported as `unexplained`.
// So "exact" here means what "byte-clean" means in the reader — and an
// orange line the reader was unsure about shows exactly which ink it missed.
//
// Attaches to text_tool through ONE guarded seam: svg-renderer.js calls
// window.utbPixelRender(box, xs, baseline) for every box it draws and shows
// the returned raster instead of its <text>; null means "draw as always".
// Nothing in text_tool or the core knows this file exists.

const pixelView = {
  on: false,
  diff: false,
  loading: false,     // glyph sets being fetched (the cache-hit path never loads them)
  pages: new Map(),   // `${docHash}|${page}` -> { page: whitened {w,h,gray}, mask, rawMask, quant } | null
  results: new Map(), // box.id -> { set, ink, count, within, masked, outside, unexplained, glyphs, phy, tol }
  windows: new Map(), // box.id -> { page, r } — the last render window of every drawn box
  cache: new Map(),   // render key -> { href, x, y, w, h, advanceW, ink, count, … }
  notes: new Map(),   // box.id -> why it fell back to SVG
  dirty: new Set(),   // pages whose residuals must be recomputed
  lastNote: null,
  canvas: null,
  settleTimer: null,
};

const PV_TYPE_TINT = { embedded: [0, 100, 255], redaction: [80, 180, 110], harfbuzz: [255, 140, 0], ocr: [0, 200, 255] };
const PV_DIFF_RGB = [217, 48, 37];       // drawn pixel that differs from the page
const PV_RESIDUAL_RGB = [255, 140, 0];   // page ink no drawn glyph explains
const PV_MATCH_ALPHA = 0.32;             // diff mode: matching ink pixels are drawn this faint
const PV_BAND_REACH = 40;                // residual columns past a box's end (a missed trailing glyph)

// Family/size lookup for boxes that were NOT read by the OCR (embedded text,
// hand-typed text): the face of every set comes from the generated
// engine/set-fonts.js; only `plain` sets (stock face, stock law — not a
// linear-compositor, gray-ink, recreated-law or specific-build variant) are
// picked by family. OCR boxes reach the variants through box.ocr.font.
const PV_SPACE_EM = { 'Times New Roman': 0.25, 'Nimbus Roman': 0.25, 'Courier New': 0.6, 'Nimbus Mono PS': 0.6,
  'Arial': 0.278, 'Nimbus Sans': 0.278, 'Georgia': 0.241, 'Tahoma': 0.313, 'Segoe UI': 0.274, 'Verdana': 0.352,
  'Calibri': 0.226, 'Cambria': 0.22, 'DejaVu Serif': 0.318, 'Century Schoolbook': 0.278 };

function pvSetStyle(name) {
  const f = typeof OCR_SET_FONTS !== 'undefined' ? OCR_SET_FONTS[name] : null;
  return f ? { family: f.family, bold: !!f.bold, italic: !!f.italic, plain: !!f.plain } : null;
}

function pvSetByName(name) {
  return ocrToolState.sets?.find(s => s.name === name) || null;
}

// ── sets rasterized on demand ─────────────────────────────────
// The bundle holds the faces, styles and sizes the corpus needed. A typed box
// is set in whatever the toolbar says — Times bold italic, Arial 9.5 pt — so
// when no bundled set is that face at that size the glyphs are rasterized
// here, from the catalogue's own font file, by the engine's certified port of
// mupdf's glyph pipeline (engine/ftraster.js — the code that generated the
// bundle). Nothing is synthesized: a family with no bold italic file has none.
const pvFaces = new Map();      // font url -> face | null (unreadable) | Promise
const pvDynSets = new Map();    // `${url}|${sizePx}` -> set   (insertion order = LRU)
const PV_DYN_MAX = 32;
let pvRefreshTimer = null;
function pvRefreshSoon() {       // something a box was waiting for has arrived
  clearTimeout(pvRefreshTimer);
  pvRefreshTimer = setTimeout(() => { if (pixelView.on) window.renderAllTextLayers?.(); }, 0);
}
// the face behind a font file: loaded once, null while loading (the caller
// declines this render; the box is drawn again when it arrives)
function pvFace(url) {
  if (!url || typeof FTRaster === 'undefined') return null;
  const have = pvFaces.get(url);
  if (have !== undefined) return have instanceof Promise ? null : have;
  pvFaces.set(url, (async () => {
    let face = null;
    try {
      const r = await fetch(url);
      if (r.ok) face = FTRaster.loadFace(await r.arrayBuffer());
    } catch (e) { console.warn('pixel view: font', url, e); }
    pvFaces.set(url, face);
    pvRefreshSoon();
    return face;
  })());
  return null;
}
function pvFaceUrl(family, bold, italic) {
  return window.FontCatalog?.fileUrl?.(family, bold, italic) || null;
}
// {set} | {pending: true} | {why}
function pvDynamicSet(box) {
  const url = pvFaceUrl(box.fontFamily, !!box.bold, !!box.italic);
  const styleName = `${box.fontFamily}${box.bold ? ' bold' : ''}${box.italic ? ' italic' : ''}`;
  if (!url) return { why: `${styleName} is not an installed face (nothing is synthesized)` };
  const sizePx = box.sizePt * GEO.docPxPerPt();
  if (!(sizePx >= 2 && sizePx <= 400)) return { why: `${sizePx.toFixed(2)} px is outside the size a page is set in` };
  const face = pvFace(url);
  if (face === null) return pvFaces.get(url) === null ? { why: `${url.split('/').pop()} could not be read` } : { pending: true };
  const key = `${url}|${sizePx}`;
  let set = pvDynSets.get(key);
  if (set) { pvDynSets.delete(key); pvDynSets.set(key, set); return { set }; }
  set = FTRaster.makeSet(face, { name: `${url.split('/').pop()}@${+sizePx.toFixed(4)}`, sizePx });
  set.family = box.fontFamily; set.bold = !!box.bold; set.italic = !!box.italic;
  pvDynSets.set(key, set);
  while (pvDynSets.size > PV_DYN_MAX) pvDynSets.delete(pvDynSets.keys().next().value);
  return { set };
}
// family / style of any set: the bundle's through set-fonts.js, a dynamic
// set's own
function pvStyleOf(set) {
  return set.dynamic ? { family: set.family, bold: set.bold, italic: set.italic, plain: true } : pvSetStyle(set.name);
}
// the face behind ANY set (decorations need its metrics): null while loading
function pvFaceOfSet(set) {
  if (set.dynamic) return set.face;
  const st = pvSetStyle(set.name);
  return st ? pvFace(pvFaceUrl(st.family, st.bold, st.italic)) : null;
}

// Is the box still in the face the reader read it in? The reader's sets (and
// its measured pens) are that face's; once the user makes the line bold or
// another size it is typed text like any other.
function pvAsRead(box) {
  return !!box.ocr?.font && !(typeof utbFaceChanged === 'function' && utbFaceChanged(box));
}

// The set(s) that draw a box: the reader's pick for OCR lines still in the
// face they were read in (a union-pool line reports one font label but each
// glyph carries the set that drew it — src, from the engine's L.glyphs), else
// a bundled set of the box's family, style and size, else one rasterized on
// demand. Returns {primary, byName, label} | {pending} | {why}.
function pvSetsForBox(box) {
  const sets = ocrToolState.sets;
  if (!sets) return null;
  if (pvAsRead(box)) {
    const names = new Set(box.ocr.font.split('+'));
    for (const cp of box.baseCharPositions || []) if (cp.src) names.add(cp.src);
    const found = [...names].map(pvSetByName).filter(Boolean);
    if (!found.length) return { why: `set ${box.ocr.font} is not loaded` };
    const primary = pvSetByName(box.ocr.font.split('+')[0]) || found[0];
    return { primary, byName: new Map(found.map(s => [s.name, s])),
      label: found.length > 1 ? found.map(s => s.name).join('+') : found[0].name };
  }
  const sizePx = box.sizePt * GEO.docPxPerPt();
  const want = { family: box.fontFamily, bold: !!box.bold, italic: !!box.italic };
  const hit = sets.find(s => {
    const st = pvSetStyle(s.name);
    return st && st.plain && st.family === want.family && st.bold === want.bold &&
      st.italic === want.italic && Math.abs(s.sizePx - sizePx) < 0.02;
  });
  const asHit = () => ({ primary: hit, byName: new Map([[hit.name, hit]]), label: hit.name });
  // The bundle carries the corpus's glyphs, not a face's whole repertoire —
  // no diacritics ("Lajčák" in courbd16). A box whose text the bundled set
  // cannot draw is rasterized from the installed face at the same size
  // instead of falling back to SVG (measured 2026-09-22: a bar labelled from
  // the candidates list lost its pixels every time the list was recomputed).
  if (hit && !pvLacking(hit, box.text).length) return asHit();
  const dyn = pvDynamicSet(box);
  if (!dyn.set) return hit && !dyn.pending ? asHit() : dyn;   // no face to draw from: the set with its gap
  return { primary: dyn.set, byName: new Map([[dyn.set.name, dyn.set]]), label: dyn.set.name };
}
// the characters of a text a set has no record for (spaces and the unread
// marker are never drawn)
function pvLacking(set, text) {
  return [...new Set([...(text || '')].filter(c => c !== ' ' && c !== '□'))]
    .filter(c => OCRRender.advanceOf(set, c) == null);
}

function pvSpaceAdv(box, set) {
  if (box.ocr?.spaceAdv) return box.ocr.spaceAdv;
  // another OCR line on this page read with the same set carries the
  // page-calibrated space
  for (const b of utbState.boxes)
    if (b.page === box.page && b.ocr?.spaceAdv && b.ocr.font === set.name) return b.ocr.spaceAdv;
  const face = pvFaceOfSet(set);
  if (face?.gidFor) { const g = face.gidFor(0x20); if (g) return face.advance(g) * set.sizePx / face.unitsPerEm; }
  const family = pvStyleOf(set)?.family || box.fontFamily;
  return (PV_SPACE_EM[family] ?? 0.25) * set.sizePx;
}

// ── the producer's law ────────────────────────────────────────
// the law the pixel view lays a box with: the one learned for its set on its
// page from the certified pens (window.ocrProducerFor). A set the page never
// certified gets the least assumption — the PDF's 1/1000-em advances at the
// set's size, no kerning — and the status line says it is assumed.
const PV_DEFAULT_LAW = { quant: 1000, scale: 1, kerned: false, kern: new Map(), adv: new Map(), assumed: true };
// The page's law for a box's set — and when the page certified nothing in
// that exact set (a bold italic nobody wrote, another size), the STRUCTURE of
// the law its family was laid with there: the advance quantization, the laid
// scale and whether the producer kerned are properties of the producer, the
// tables are the face's.
function pvPageLaw(box, set) {
  const own = window.ocrProducerFor?.(box.page, set.name);
  if (own) return own;
  const st = pvStyleOf(set), family = st?.family || box.fontFamily;
  const kin = (window.ocrProducerList?.(box.page) || []).filter(m => m.family === family);
  if (!kin.length) return null;
  const sameStyle = m => { const ms = pvSetStyle(m.set); return ms && st && ms.bold === st.bold && ms.italic === st.italic; };
  kin.sort((a, b) => (sameStyle(b) ? 1 : 0) - (sameStyle(a) ? 1 : 0) || (b.words || 0) - (a.words || 0));
  const L = kin[0];
  return { quant: L.quant, scale: L.scale, kerned: L.kerned, tableKnown: L.tableKnown, kern: new Map(), adv: new Map(),
    borrowed: L.set, words: null };
}
// the face's own kern pairs at the set's size under a law (quantized and
// scaled like every advance): Map pair → px, empty while the table loads
const pvKernTables = new Map();   // `${family}|b|i|sizePx` -> {pairs} | Promise
const PV_NO_KERN = new Map();
function pvKernMap(set, law) {
  const st = pvStyleOf(set);
  if (!st || !window.FontCatalog?.metrics) return PV_NO_KERN;
  const key = `${st.family}|${st.bold ? 1 : 0}|${st.italic ? 1 : 0}|${set.sizePx}`;
  let t = pvKernTables.get(key);
  if (t === undefined) {
    t = window.FontCatalog.metrics(st.family, st.bold, st.italic, set.sizePx)
      .then(m => { pvKernTables.set(key, { pairs: m?.kern || {}, maps: new Map() }); pixelView.cache.clear(); pvRefreshSoon(); })
      .catch(() => pvKernTables.set(key, { pairs: {}, maps: new Map() }));
    pvKernTables.set(key, t);
  }
  if (t instanceof Promise) return PV_NO_KERN;
  const lk = `${law.quant}|${law.scale}`;
  let m = t.maps.get(lk);
  if (!m) {
    m = new Map();
    for (const [pair, v] of Object.entries(t.pairs)) { const lv = OCRRender.lawAdv(v, set.sizePx, law); if (lv) m.set(pair, lv); }
    t.maps.set(lk, m);
  }
  return m;
}
// The law a box is LAID with: the page's, with kerning as the box says — it
// follows the page until the user chooses (UnifiedTextBox.kerningAuto), and
// then the Kerning box wins in both directions.
function pvLaw(box, set) {
  const page = pvPageLaw(box, set) || PV_DEFAULT_LAW;
  const kerned = !!box.kerning;
  const kern = !kerned ? PV_NO_KERN : (page.kerned && page.kern?.size && !page.borrowed) ? page.kern : pvKernMap(set, page);
  return { ...page, kerned, kern, userKerning: !box.kerningAuto && kerned !== !!page.kerned };
}
// text_tool's seam: whether the page's producer kerned this box's family —
// boolean, or undefined while nothing is known (the box keeps what it has)
window.utbAutoKerning = function (box) {
  const laws = (window.ocrProducerList?.(box.page) || []).filter(m => m.family === box.fontFamily && m.tableKnown);
  if (!laws.length) return undefined;
  const st = { bold: !!box.bold, italic: !!box.italic };
  const same = laws.find(m => { const ms = pvSetStyle(m.set); return ms && ms.bold === st.bold && ms.italic === st.italic; });
  return !!(same || laws.sort((a, b) => (b.words || 0) - (a.words || 0))[0]).kerned;
};
// A box laid through the law (render.js layoutLine). A reader line is laid
// the way lineLayout says it was: every word from its own solved sub-lattice
// start (the producer's starts were floats the page shows snapped) and each
// break's width solved between the laid words — so an unedited line returns
// its pens, and an edit keeps the words before it. Each glyph carries the set
// that drew it on the page (a union line mixes a bold label with a regular
// value) for as long as the text still lines up with the reader's entries;
// new text draws with the primary set. Returns {glyphs:[{ch, pen, set}],
// advanceW, missing}.
function pvLayout(box, primary, byName, law) {
  const ents = pvAsRead(box) ? (box.ocr?.entries || []).filter(e => e.ch !== '□') : [];
  // the set and law of every glyph the reader read (union lines), while the
  // text still lines up with the entries
  const text = [...box.text].filter(c => c !== ' ');
  const same = ents.length === text.length && ents.every((e, k) => e.ch === text[k] || e.ch === 'ﬁ' || e.ch === 'ﬂ');
  const setOf = src => (src && byName.get(src)) || primary;
  const bySrc = new Map(), metricsBySet = new Map();
  for (const e of ents) if (e.src && !bySrc.has(e.src)) {
    const st = setOf(e.src), m = window.ocrProducerFor?.(box.page, st.name) || law;
    bySrc.set(e.src, { sizePx: st.sizePx, m });
    metricsBySet.set(st.name, m);
  }
  // the toolbar's own spacing: a manual space width replaces every space of
  // the line (the measured gaps included), letter spacing is em → px
  const manualSpace = box.spaceWidth != null && !box.defaultSpaceWidth ? +box.spaceWidth : null;
  const letterSpacing = (+box.letterSpacing || 0) * primary.sizePx;
  let start = box.x, spaceWidths = null;
  if (ents.length && typeof OCRRender.lineLayout === 'function') {
    const ll = OCRRender.lineLayout({ entries: ents }, primary.sizePx, law, box.ocr?.spaceAdv, bySrc);
    start = box.x + ll.delta;
    spaceWidths = manualSpace == null ? ll.spaceWidths : null;
  }
  const opts = { spaceAdv: manualSpace ?? pvSpaceAdv(box, primary), spaceWidths, metrics: law,
    letterSpacing, glyphSets: same ? ents.map(e => setOf(e.src)) : null, metricsBySet };
  let lay = OCRRender.layoutLine(primary, box.text, start, opts);
  // a label its owner aligns to the box's right edge (text_tool's
  // labelAlign): laid again from the start that ends it there
  if (box.labelAlign === 'right' && !ents.length && lay.advanceW > 0) {
    start = box.x + box.w - lay.advanceW;
    lay = OCRRender.layoutLine(primary, box.text, start, opts);
  }
  const glyphs = lay.glyphs.map(g => ({ ch: g.ch, pen: g.pen, set: g.set || primary }));
  return { glyphs, advanceW: lay.advanceW, missing: lay.missing, start };
}
const pvLawLabel = law => !law ? '' :
  `${law.quant ? `1/${law.quant} em` : 'hmtx'} × ${(+law.scale).toFixed(5)}` +
  (law.kerned ? ', kerned' : law.tableKnown || law.userKerning ? ', no kerning' : '') +
  (law.userKerning ? ' (your Kerning setting, not the page\'s)' : '') +
  (law.borrowed ? ` (the page's law for ${law.borrowed})` : '') +
  (law.assumed ? ' (assumed — nothing certified in this set on the page)' : law.words != null ? ` (${law.exact}/${law.words} words written back)` : '');

function pvTint(box) {
  const c = box.color || box.labelColor;
  if (typeof c === 'string') {
    let m = c.match(/^#([0-9a-f]{6})$/i);
    if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
    m = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) return [+m[1], +m[2], +m[3]];
  }
  return PV_TYPE_TINT[box.type] || [0, 0, 255];
}

// A layer the user (or the auto layer choice) hid is not drawn — its groups
// are display:none anyway, and a hidden box must not count in the verdicts.
function pvLayerHidden(box) {
  const cl = document.body.classList;
  return (box.type === 'embedded' && cl.contains('hide-embedded-text')) ||
         (box.type === 'ocr' && cl.contains('hide-ocr-text'));
}

// The page the Diff compares against: the viewer's own <img> for the page,
// through the same PageEngine buffer + colour whitening the reader used, plus
// the reader's object mask (with box halos for the glyph diff, without them
// for the residual — the reader counts residue inside a halo too).
function pvPageInfo(pageNum) {
  const key = `${state.docHash}|${pageNum}`;
  if (pixelView.pages.has(key)) return pixelView.pages.get(key);
  const img = document.getElementById(`page${pageNum}`);
  if (!img) return null;
  if (!img.complete || !img.naturalWidth) {
    if (!img._pvHooked) {                                  // draw again once the raster is in
      img._pvHooked = true;
      img.addEventListener('load', () => { if (pixelView.on) window.renderAllTextLayers?.(); }, { once: true });
    }
    return null;
  }
  if (img.naturalWidth !== state.pageWidth || img.naturalHeight !== state.pageHeight) {
    pixelView.pages.set(key, null);                        // raster not 1:1 with the viewBox
    return null;
  }
  if (typeof PageEngine === 'undefined' || typeof BlindOCR === 'undefined') return null;
  ocrToolState.engine ??= new PageEngine();
  const raw = ocrToolState.engine._pageFor(img);
  const page = BlindOCR.whitenColored(raw, ocrToolState.engine.pageRGBA(img));
  const info = { page, mask: null, rawMask: null, det: null, quant: null };
  try {
    const det = BlindOCR.detectObjects(page);
    info.det = det;                                        // objects + edge model (hypothesis-view.js)
    info.rawMask = det.mask;
    info.mask = OCRRender.objectMask(det, page.w, page.h);
  } catch (e) { console.warn('pixel view: detectObjects', e); }
  pixelView.pages.set(key, info);
  return info;
}
function pvQuant(info) {
  if (!info.quant) {
    // the same map the reader built: converted colour pixels are left out of
    // the available grays, because they are compared through their acceptance
    // band instead (tol0 LAWS §9 — diffLine reads page.bandLo/bandHi)
    info.quant = BlindOCR.quantMap(info.page);
  }
  return info.quant;
}

function pvNote(box, why) {
  pixelView.notes.set(box.id, why);
  if (why !== pixelView.lastNote) {
    pixelView.lastNote = why;
    setOcrStatus(`MuPDF pixels: ${why} — box drawn as SVG`);
  }
}

// Paint a window as RGBA: tint with alpha = ink darkness; in Diff mode
// matching (and masked) ink faint, mismatching solid red, unexplained page
// ink (residual pixels, page coordinates) solid orange. The canvas covers the
// glyph window extended to hold every residual pixel; returns {href, x, y, w, h}.
function pvPaint(r, d, tint, diffMode, residual) {
  let x0 = r.x0, y0 = r.y0, x1 = r.x0 + r.w, y1 = r.y0 + r.h;
  const res = diffMode && residual?.pixels?.length ? residual.pixels : [];
  for (const [x, y] of res) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x + 1 > x1) x1 = x + 1; if (y + 1 > y1) y1 = y + 1; }
  const w = x1 - x0, h = y1 - y0;
  const c = pixelView.canvas ??= document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h), px = id.data;
  for (let yy = 0; yy < r.h; yy++)
    for (let xx = 0; xx < r.w; xx++) {
      const i = yy * r.w + xx, g = r.gray[i];
      if (g === 255) continue;
      const o = ((r.y0 - y0 + yy) * w + (r.x0 - x0 + xx)) * 4;
      if (diffMode && d && d.mism[i]) {
        px[o] = PV_DIFF_RGB[0]; px[o + 1] = PV_DIFF_RGB[1]; px[o + 2] = PV_DIFF_RGB[2]; px[o + 3] = 255;
      } else {
        px[o] = tint[0]; px[o + 1] = tint[1]; px[o + 2] = tint[2];
        px[o + 3] = diffMode ? Math.round((255 - g) * PV_MATCH_ALPHA) : 255 - g;
      }
    }
  for (const [x, y] of res) {
    const o = ((y - y0) * w + (x - x0)) * 4;
    px[o] = PV_RESIDUAL_RGB[0]; px[o + 1] = PV_RESIDUAL_RGB[1]; px[o + 2] = PV_RESIDUAL_RGB[2]; px[o + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return { href: c.toDataURL('image/png'), x: x0, y: y0, w, h };
}

// ── the seam ──────────────────────────────────────────────────
// svg-renderer.js: utbPixelRender(box, xs, baseline) → {href, x, y, w, h,
// advanceW} | null. xs are the SVG's absolute per-character x positions
// (measured pens + nudges + space overrides) or [box.x] without per-char data.
function utbPixelRender(box, xs, baseline) {
  if (!pixelView.on || typeof OCRRender === 'undefined') return null;
  if (!ocrToolState.sets) { pvEnsureSets(); return null; }
  if (!box.text || box.ocr?.unread || pvLayerHidden(box)) { pvForget(box.id); return null; }
  const setInfo = pvSetsForBox(box);
  if (!setInfo?.primary) {
    pvForget(box.id);
    // a face still loading is not a failure: the box is drawn again when it arrives
    if (setInfo?.why) pvNote(box, setInfo.why);
    return null;
  }
  const { primary, byName } = setInfo;
  if (primary.dynamic) {
    const lacks = primary.ensure(box.text);
    if (lacks.length) {
      pvForget(box.id);
      pvNote(box, `${primary.name.split('@')[0]} has no glyph for "${lacks.join('')}"`);
      return null;
    }
  }

  // pens: the measured ones while they are this face's and nothing the user
  // set asks for another layout, else a fresh layout
  const law = pvLaw(box, primary);
  const glyphs = [];
  let advanceW = 0, runX0 = box.x, runX1 = box.x;
  // (svg-renderer's xs are the measured positions only while utbCharsValid)
  const measured = box.baseCharPositions?.length && xs.length === box.baseCharPositions.length;
  if (measured) {
    for (let i = 0; i < xs.length; i++) {
      const cp = box.baseCharPositions[i];
      if (cp.ligTail) continue;
      const ch = cp.lig || cp.c;
      if (ch === ' ' || ch === '□') continue;
      glyphs.push({ ch, pen: xs[i], set: (cp.src && byName.get(cp.src)) || primary });
    }
    runX0 = xs[0];
    runX1 = xs[xs.length - 1] + (box.baseCharPositions[xs.length - 1].w || 0);
  } else {
    // a fresh layout under the producer's law for this set on this page
    // (ocr-tool.js ocrLearnProducer), from the start the line was laid from
    // when the box is a reader line, with the line's own measured gaps for
    // its spaces: an unedited line comes back at its pens, an edit continues
    // under the same law, and a typed box is laid as this document's
    // producer would have laid it — kerned or not as the box says
    const lay = pvLayout(box, primary, byName, law);
    if (lay.missing.length) {
      pvForget(box.id);
      pvNote(box, `no glyph for "${lay.missing.join('')}" in ${primary.name}`);
      return null;
    }
    glyphs.push(...lay.glyphs);
    advanceW = lay.advanceW;
    runX0 = lay.start; runX1 = lay.start + lay.advanceW;
  }
  if (!glyphs.length && !(box.underline || box.strikethrough)) { pvForget(box.id); return null; }

  const yb = OCRRender.snapY(baseline);
  // underline / strikethrough: filled rectangles from the face's own metrics,
  // under mupdf's path rasterizer (engine/ftraster.js rectCoverage)
  const rects = [];
  if ((box.underline || box.strikethrough) && runX1 > runX0 && typeof FTRaster !== 'undefined') {
    const face = pvFaceOfSet(primary);
    if (!face) {
      // the face is on its way (drawn again when it arrives) — or the set has none
      if (!pvSetStyle(primary.name) && !primary.dynamic) pvNote(box, `set ${primary.name} has no face to take an underline from`);
    } else for (const kind of ['underline', 'strikethrough']) {
      if (!box[kind]) continue;
      const q = FTRaster.decoration(face, primary.sizePx, kind, runX0, runX1, yb);
      const cov = q && FTRaster.rectCoverage(q.x0, q.y0, q.x1, q.y1);
      if (cov) rects.push(cov);
    }
  }
  if (!glyphs.length && !rects.length) { pvForget(box.id); return null; }
  const info = pvPageInfo(box.page);
  const tint = pvTint(box);
  // the reader's own terms for this line: which y-phase records it pinned
  // the line to, and the per-pixel tolerance of the rung it was read on
  const phy = box.ocr?.phy || 0, tol = box.ocr?.tol || 0;
  const key = [setInfo.label, box.text, glyphs.map(g => Math.round(g.pen * 4)).join(','), yb, phy, tol,
    pixelView.diff ? 'd' : 'p', info ? 'pg' : 'nopg', tint.join('.'), box.ocr?.quant ? 'q' : '',
    rects.map(q => `${q.x0},${q.y0},${q.w},${q.h},${q.cov[0]},${q.cov[q.cov.length - 1]}`).join(';')].join('|');
  let out = pixelView.cache.get(key);
  if (!out) {
    const r = OCRRender.renderLine(primary, glyphs, yb, { phy, rects });
    if (r.missing.length) {
      pvForget(box.id);
      pvNote(box, `no glyph for "${r.missing.join('')}" in ${setInfo.label}${phy ? ` at y-phase ${phy}` : ''}`);
      return null;
    }
    const d = info ? OCRRender.diffLine(r, info.page, box.ocr?.quant ? pvQuant(info) : null, info.mask, tol) : null;
    out = { r, d, tint, ...pvPaint(r, d, tint, pixelView.diff, null), advanceW,
      ink: d?.ink ?? null, count: d?.count ?? null, within: d?.within ?? 0, masked: d?.masked ?? 0,
      outside: d?.outside ?? 0, glyphs: r.glyphs };
    pixelView.cache.set(key, out);
  }
  pixelView.notes.delete(box.id);
  pixelView.windows.set(box.id, { page: box.page, r: out.r, d: out.d, tint: out.tint, key });
  pixelView.results.set(box.id, { set: setInfo.label, ink: out.ink, count: out.count, within: out.within,
    masked: out.masked, outside: out.outside, unexplained: null, glyphs: out.glyphs, phy, tol });
  // the residual (page ink no glyph explains) needs every box of the page
  // drawn first — settle it once this render pass is over
  pixelView.dirty.add(box.page);
  clearTimeout(pixelView.settleTimer);
  pixelView.settleTimer = setTimeout(pvSettle, 0);
  return { href: out.href, x: out.x, y: out.y, w: out.w, h: out.h, advanceW };
}
window.utbPixelRender = utbPixelRender;

function pvForget(id) {
  pixelView.results.delete(id);
  pixelView.windows.delete(id);
}

// ── the residual pass ─────────────────────────────────────────
// For every reader-certified line on a dirty page: page ink in the line's
// band (rows the reader judged, columns of the box plus a reach past its end
// up to the next box) that no drawn window on the page inks and no object
// mask covers. Recomputed after each render pass; in Diff mode the box's
// image is repainted with those pixels in orange.
function pvSettle() {
  clearTimeout(pixelView.settleTimer);
  pixelView.settleTimer = null;
  if (!pixelView.on) { pixelView.dirty.clear(); return; }
  for (const pageNum of pixelView.dirty) {
    const info = pvPageInfo(pageNum);
    const wins = [...pixelView.windows.entries()].filter(([, w]) => w.page === pageNum);
    if (!info) continue;
    const boxes = wins.map(([id]) => utbState.getBox(id)).filter(Boolean);
    // the residual's don't-care zone: the object mask plus every redaction
    // rectangle the reader detected (its per-line box detection sees slices
    // the page-level pass misses), padded 2 px like the reader's line boxes
    let resMask = info.rawMask;
    const rects = utbState.boxes.filter(b => b.type === 'redaction' && b.ocrSource && b.page === pageNum);
    if (rects.length && resMask) {
      resMask = new Uint8Array(resMask);
      const W = info.page.w, H = info.page.h;
      for (const b of rects) {
        const x0 = Math.max(0, Math.floor(b.x) - 2), x1 = Math.min(W, Math.ceil(b.x + b.w) + 2);
        for (let y = Math.max(0, Math.floor(b.y) - 2); y < Math.min(H, Math.ceil(b.y + b.h) + 2); y++)
          resMask.fill(1, y * W + x0, y * W + x1);
      }
    }
    for (const [id, w] of wins) {
      const box = utbState.getBox(id), res = pixelView.results.get(id);
      if (!box || !res) continue;
      if (!box.ocr || box.ocr.top == null || box.ocr.baseline == null) { res.unexplained = null; continue; }
      // the reader certifies this half itself: a clean line has residual 0 by
      // its own bookkeeping (skip rules around box edges that only the scan
      // knows), so the residual is located only on lines it marked unclean
      res.residual = box.ocr.residual ?? 0;
      if (box.ocr.clean || !(box.ocr.residual > 0)) { res.unexplained = 0; continue; }
      // rows: exactly the ones the reader judged — from the band top (never
      // above it: ink up there is the previous line's) down to baseline +
      // maxDesc of the line's set(s), the scan window's bottom (a redaction
      // box's bottom AA row one pixel further down is not this line's ink)
      const sets = [...(pvSetsForBox(box)?.byName?.values() || [])];
      const asc = Math.max(0, ...sets.map(s => s.maxAsc)), desc = Math.max(0, ...sets.map(s => s.maxDesc));
      const yb = box.ocr.baseline;
      // columns: this box, plus a reach past its end that stops at the next
      // box sharing its rows
      let x1 = box.x + box.w + PV_BAND_REACH;
      for (const b of boxes)
        if (b !== box && b.x > box.x + box.w - 1 && b.y < box.y + box.h && b.y + b.h > box.y) x1 = Math.min(x1, b.x);
      const band = { top: Math.max(box.ocr.top, yb - asc), bot: yb + desc, x0: box.x - 2, x1 };
      const residual = OCRRender.residualInk(info.page, resMask, band, wins.map(([, o]) => o.r));
      const changed = res.unexplained !== residual.count;
      res.unexplained = residual.count;
      if (pixelView.diff && (residual.count || changed)) {
        const p = pvPaint(w.r, w.d, w.tint, true, residual);
        const img = document.querySelector(`.utb-group[data-id="${id}"] .utb-pixel`);
        if (img) {
          img.setAttribute('x', p.x); img.setAttribute('y', p.y);
          img.setAttribute('width', p.w); img.setAttribute('height', p.h);
          img.setAttribute('href', p.href);
        }
      }
    }
  }
  pixelView.dirty.clear();
  if (pixelView.on && utbState.selectedId && pixelView.results.has(utbState.selectedId)) pvReportSelection();
  else if (pixelView.on) pvReportPage();
}

// ── toggles, status, lifecycle ────────────────────────────────

async function pvEnsureSets() {
  if (ocrToolState.sets || pixelView.loading) return;
  pixelView.loading = true;
  setOcrStatus('MuPDF pixels: loading glyph sets…');
  try {
    await ocrLoadSets();
    setOcrStatus(`MuPDF pixels: ${ocrToolState.sets.length} glyph sets loaded`);
  } catch (e) {
    setOcrStatus(`MuPDF pixels: ${e.message}`);
    pvSetOn(false);
  } finally {
    pixelView.loading = false;
  }
  if (pixelView.on) { window.renderAllTextLayers?.(); pvSettle(); }
}

function pvInvalidate() {
  pixelView.cache.clear();
  pixelView.results.clear();
  pixelView.windows.clear();
  pixelView.notes.clear();
  pixelView.dirty.clear();
  pixelView.lastNote = null;
}

function pvSetOn(on) {
  pixelView.on = !!on;
  if (!pixelView.on) pixelView.diff = false;
  pvInvalidate();
  const viewCb = document.getElementById('ocr-pixel-view');
  if (viewCb) viewCb.checked = pixelView.on;
  const diffCb = document.getElementById('ocr-pixel-diff');
  if (diffCb) { diffCb.disabled = !pixelView.on; diffCb.checked = pixelView.diff; }
  if (pixelView.on && !ocrToolState.sets) pvEnsureSets();
  window.renderAllTextLayers?.();
  if (pixelView.on && ocrToolState.sets) pvSettle();
  else if (!pixelView.on) setOcrStatus('MuPDF pixels off');
}

function pvSetDiff(diff) {
  if (!pixelView.on) return;
  pixelView.diff = !!diff;
  pvInvalidate();
  const diffCb = document.getElementById('ocr-pixel-diff');
  if (diffCb) diffCb.checked = pixelView.diff;
  window.renderAllTextLayers?.();
  pvSettle();
}

// verdicts for the current page, split the way they should be read: lines
// the reader certified byte-clean must reproduce the page exactly AND leave
// no page ink unexplained; anything else (embedded text, hand-added boxes,
// tolerant reads, the reader's own unclean lines) is drawn where its box
// says and compared, but a difference there is information, not a fault
const pvExact = r => r.count === 0 && r.ink > 0 && !r.unexplained;
function pvPageVerdict(pageNum) {
  if (pixelView.dirty.size) pvSettle();
  const rows = [...pixelView.results.entries()]
    .map(([id, r]) => ({ box: utbState.getBox(id), r }))
    .filter(x => x.box && x.box.page === pageNum);
  const cert = rows.filter(x => x.box.ocr?.clean), other = rows.filter(x => !x.box.ocr?.clean);
  const exact = xs => xs.filter(x => pvExact(x.r)).length;
  const fallbacks = [...pixelView.notes.keys()].filter(id => utbState.getBox(id)?.page === pageNum).length;
  return { drawn: rows.length, cert: cert.length, certExact: exact(cert),
    other: other.length, otherExact: exact(other), fallbacks };
}

function pvReportPage() {
  const v = pvPageVerdict(state.currentPage);
  setOcrStatus(`MuPDF pixels: ${v.drawn} boxes as pixels` +
    (v.cert ? ` · OCR lines ${v.certExact}/${v.cert} exact` : '') +
    (v.other ? ` · other boxes ${v.otherExact}/${v.other} exact` : '') +
    (v.fallbacks ? ` · ${v.fallbacks} as SVG (no set)` : '') +
    (pixelView.diff ? ' · diff on' : ''));
}

function pvReportSelection() {
  const id = utbState.selectedId;
  const box = id && utbState.getBox(id);
  if (!box) return;
  const short = (box.text || '').length > 28 ? box.text.slice(0, 28) + '…' : box.text;
  const r = pixelView.results.get(id);
  if (!r) { setOcrStatus(`MuPDF pixels: "${short}" drawn as SVG (${pixelView.notes.get(id) || 'no glyph set'})`); return; }
  const si = pvSetsForBox(box);
  const law = si?.primary ? pvLaw(box, si.primary) : null;
  setOcrStatus(`MuPDF pixels: "${short}" · ${r.set} · ${r.ink ?? '?'} ink px · ` +
    (r.count === null ? 'page raster not loaded'
      : r.count === 0 ? (r.tol ? `drawn glyphs match the page within ±${r.tol}` : 'drawn glyphs match the page exactly')
      : `${r.count} drawn px differ${r.tol ? ` beyond ±${r.tol}` : ''}`) +
    (r.residual ? ` · the reader left ${r.residual} px of page ink unexplained — it missed something here` +
      (r.unexplained ? ` (${r.unexplained} px located, orange in Diff)` : '') : '') +
    (r.within ? ` · ${r.within} within tolerance` : '') +
    (r.masked ? ` · ${r.masked} under a box/rule` : '') +
    (r.phy ? ` · y-phase ${r.phy}` : '') +
    (r.outside ? ` · ${r.outside} off page` : '') +
    (law ? ` · law ${pvLawLabel(law)}` : ''));
}

(function wirePixelView() {
  // the two switches in the Settings panel (settings.html)
  document.getElementById('ocr-pixel-view')?.addEventListener('change', e => pvSetOn(e.target.checked));
  document.getElementById('ocr-pixel-diff')?.addEventListener('change', e => pvSetDiff(e.target.checked));
  // selection → per-box verdict (drag-resize sets utbState.selectedId on
  // mousedown; report after the click settles)
  document.addEventListener('click', e => {
    if (!pixelView.on || !e.target.closest?.('.utb-group')) return;
    setTimeout(pvReportSelection, 0);
  });
  // a layer shown or hidden (the OCR/embedded toggles, the auto layer choice)
  // changes which boxes are drawn: redraw when the body classes flip
  new MutationObserver(() => {
    if (!pixelView.on) return;
    pixelView.results.clear();
    pixelView.windows.clear();
    window.renderAllTextLayers?.();
    pvSettle();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
})();

PDFHooks.on('document:loaded', () => {
  pixelView.pages.clear();
  pvInvalidate();
});

// Programmatic entry point (headless tests): report() lists every box drawn
// as pixels with its diff verdict; verdict(page) sums them up per page. Both
// settle the residual pass first, so their numbers are final.
window.PixelView = {
  state: pixelView, setOn: pvSetOn, setDiff: pvSetDiff, verdict: pvPageVerdict, settle: pvSettle, invalidate: pvInvalidate,
  // the laws learned on a page (ocr-tool.js), and a box laid AGAIN through
  // the layout path — ignoring its measured pens — with the pens that come
  // back, whether they are the reader's, and the pixel diff of that layout:
  // the test that typed text is the page
  laws: pageNum => (window.ocrProducerList?.(pageNum) || []).map(m => ({ set: m.set, family: m.family, quant: m.quant, scale: m.scale, kerned: m.kerned, tableKnown: !!m.tableKnown, words: m.words, exact: m.exact, glyphs: m.glyphs, hit: m.hit })),
  relayout(id) {
    const box = utbState.getBox(id);
    if (!box || !ocrToolState.sets || typeof OCRRender === 'undefined') return null;
    const setInfo = pvSetsForBox(box);
    if (!setInfo?.primary) return null;
    const { primary } = setInfo;
    const { byName } = setInfo;
    if (primary.dynamic) primary.ensure(box.text);
    const law = pvLaw(box, primary);
    const lay = pvLayout(box, primary, byName, law);
    const ents = (box.ocr?.entries || []).filter(e => e.ch !== '□');
    const pens = lay.glyphs.map(g => g.pen);
    const penExact = ents.length === pens.length && ents.every((e, k) => Math.abs(e.pen - pens[k]) < 1e-9);
    let count = null, ink = null;
    const info = pvPageInfo(box.page);
    if (info && !lay.missing.length && typeof window.computeBaseline === 'function') {
      const r = OCRRender.renderLine(primary, lay.glyphs, OCRRender.snapY(window.computeBaseline(box)), { phy: box.ocr?.phy || 0 });
      const d = OCRRender.diffLine(r, info.page, box.ocr?.quant ? pvQuant(info) : null, info.mask, box.ocr?.tol || 0);
      count = d.count; ink = d.ink;
    }
    return { id, page: box.page, text: box.text, set: primary.name, clean: box.ocr?.clean ?? null,
      law: { quant: law.quant, scale: law.scale, kerned: law.kerned, assumed: !!law.assumed, borrowed: law.borrowed || null, userKerning: !!law.userKerning },
      pens, penExact, count, ink, missing: lay.missing, dynamic: !!primary.dynamic };
  },
  report() {
    if (pixelView.dirty.size) pvSettle();
    return [...pixelView.results.entries()].map(([id, r]) => {
      const b = utbState.getBox(id);
      return { id, page: b?.page ?? null, text: b?.text ?? '', clean: b?.ocr?.clean ?? null,
        quant: !!b?.ocr?.quant, union: !!b?.ocr?.union, ...r };
    });
  },
  fallbacks(pageNum) {
    return [...pixelView.notes.entries()]
      .filter(([id]) => pageNum == null || utbState.getBox(id)?.page === pageNum)
      .map(([id, why]) => ({ id, why }));
  },
};
