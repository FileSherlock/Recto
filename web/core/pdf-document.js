// pdf-document.js — a PDF, described and rasterized with MuPDF (WebAssembly).
//
// What the core knows about a PDF (a port of the server-based version's
// document_loader.py, held to its recorded outputs in tests/golden/): page count, declared
// fonts, the suggested scale and body size, and any single page's raster —
// the embedded scan cropped to the 8.5x11 ratio, or a 96-dpi render when the
// page has none. Plus the two primitives the text plugins build on: the RAW
// structured text of a page and the placement of its page image. It runs NO
// analysis; turning structured text into spans is a plugin's job.
//
// An ES module with no DOM in it: pdf-worker.js imports it in the browser,
// the node:test suites import it directly (tests/documents.test.mjs checks it
// against tests/golden/). MuPDF comes in from outside:
//
//     const Module = {}; globalThis.$libmupdf_wasm_Module = Module;   // BEFORE the import
//     const mupdf = await import('../vendor/mupdf/mupdf.js');
//     const pdf = openPdf(mupdf, Module, bytes);
//
// Handing the Module object in is what makes the wasm heap readable
// (Module.HEAPU8), which this file needs: mupdf.js 1.28 exposes neither a
// font's ascender/descender nor a character's flags, so both are read from
// MuPDF's structs (layouts checked at run time, see fontMetrics/checkCharLayout).
//
// Every MuPDF wrapper made here is destroy()ed here — left to the garbage
// collector they hold hundreds of MB of wasm heap.
//
// Pixel exactness: a page raster is the embedded image's own samples (never
// resampled), cropped with the same integer arithmetic the server used.
// Coordinates follow geometry.js: image px at 96 DPI, font sizes in points.

export const GEO = {
  IMAGE_DPI: 96,
  POINT_DPI: 72,
  PT_TO_PX: 96 / 72,
  PAGE_WIDTH_PX: 816,
  PAGE_HEIGHT_PX: 1056,
  PAGE_ASPECT: 1056 / 816,
  DEFAULT_SCALE: 133,          // round(100 * PT_TO_PX)
};

const SPAN_SAMPLE_PAGES = 25;  // body-size sample: the leading pages are plenty
export const THUMB_WIDTH = 180;

// MuPDF structured-text options, by PyMuPDF flag set.
export const STEXT = {
  // TEXTFLAGS_DICT (199): what page.get_text("dict") uses
  DICT: 'preserve-ligatures,preserve-whitespace,preserve-images,clip,use-cid-for-unknown-unicode',
  // TEXT_PRESERVE_WHITESPACE alone: what the span extractor uses
  WHITESPACE: 'preserve-whitespace',
  // DICT without the image blocks: the text comes out the same, and MuPDF is
  // spared the images (half the cost of a scanned page) — the body-size sample
  SAMPLE: 'preserve-ligatures,preserve-whitespace,clip,use-cid-for-unknown-unicode',
};

// Python's round(): half to even. Coordinates depend on the crop height and
// the scale being the very integers the server computed.
export function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

// ── rects (MuPDF's float semantics; values are float32-exact doubles) ───────

const EMPTY = [Infinity, Infinity, -Infinity, -Infinity];            // invalid: union returns the other
const isValid = r => r[0] <= r[2] && r[1] <= r[3];
const isEmpty = r => r[0] >= r[2] || r[1] >= r[3];
const union = (a, b) => !isValid(b) ? a : !isValid(a) ? b
  : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const intersect = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
const overlap = (a, b) => !(a[0] >= b[2] || a[1] >= b[3] || a[2] <= b[0] || a[3] <= b[1]);
const isInfinite = r => r[0] <= -2147483520 && r[2] >= 2147483520;   // FZ_MIN/MAX_INF_RECT
const rectFromQuad = q => [Math.min(q[0], q[2], q[4], q[6]), Math.min(q[1], q[3], q[5], q[7]),
                           Math.max(q[0], q[2], q[4], q[6]), Math.max(q[1], q[3], q[5], q[7])];

const FLT_EPSILON = 1.1920928955078125e-7;
const f32 = Math.fround;

// PyMuPDF span flag bits
const FONT_SUPERSCRIPT = 1, FONT_ITALIC = 2, FONT_SERIFED = 4, FONT_MONOSPACED = 8, FONT_BOLD = 16;
const STEXT_SYNTHETIC = 4;     // fz_stext_char.flags: FZ_STEXT_SYNTHETIC

export function openPdf(mupdf, Module, bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  // A DataView over the wasm heap; re-made only when the heap has grown.
  let heapView = null;
  const view = () => (heapView && heapView.buffer === Module.HEAPU8.buffer) ? heapView : (heapView = new DataView(Module.HEAPU8.buffer));

  // ── struct reads (pinned MuPDF 1.28.0 wasm; every layout is verified) ────

  // fz_font → FT_Face → units_per_EM / ascender / descender, the way
  // fz_font_ascender() computes it: (float)face->ascender / face->units_per_EM,
  // 0.8 / -0.2 when the face has none.
  const FONT_FT_FACE = 76, FACE_UPEM = 68, FACE_ASC = 70, FACE_DESC = 72;
  const metricsByFont = new Map();
  function fontMetrics(fontPtr) {
    let m = metricsByFont.get(fontPtr);
    if (m) return m;
    m = { ascender: f32(0.8), descender: f32(-0.2), exact: false };
    try {
      const dv = view(), face = dv.getUint32(fontPtr + FONT_FT_FACE, true);
      if (face > 1024 && face + FACE_DESC + 2 <= dv.byteLength) {
        const upem = dv.getUint16(face + FACE_UPEM, true);
        const asc = dv.getInt16(face + FACE_ASC, true), desc = dv.getInt16(face + FACE_DESC, true);
        if (upem >= 16 && upem <= 16384 && asc >= 0 && asc < 4 * upem && desc <= 0 && desc > -4 * upem)
          m = { ascender: asc === 0 ? f32(0.8) : f32(asc / upem), descender: desc === 0 ? f32(-0.2) : f32(desc / upem), exact: true };
      }
    } catch { /* keep MuPDF's own defaults */ }
    metricsByFont.set(fontPtr, m);
    return m;
  }

  // fz_stext_char: { int c; uint16 bidi; uint16 flags; uint32 argb; fz_point origin;
  // fz_quad quad; float size; fz_font *font; fz_stext_char *next } — 64 bytes.
  // Reading the struct takes one DataView instead of nine calls into wasm per
  // character, and `flags` has no accessor at all. The layout is checked
  // against every accessor on the first character seen; should it ever not
  // hold (another MuPDF build), the accessors are used and flags read as 0.
  const CH = { c: 0, bidi: 4, flags: 6, argb: 8, origin: 12, quad: 20, size: 52, font: 56, next: 60 };
  let charLayoutOk = null;
  function checkCharLayout(ch) {
    const dv = view(), M = Module, same = (ptr, off, n) => floats(ptr, n).every((v, i) => v === dv.getFloat32(ch + off + 4 * i, true));
    charLayoutOk = dv.getInt32(ch + CH.c, true) === M._wasm_stext_char_get_c(ch)
      && dv.getUint16(ch + CH.bidi, true) === M._wasm_stext_char_get_bidi(ch)
      && dv.getUint32(ch + CH.argb, true) === (M._wasm_stext_char_get_argb(ch) >>> 0)
      && same(M._wasm_stext_char_get_origin(ch), CH.origin, 2) && same(M._wasm_stext_char_get_quad(ch), CH.quad, 8)
      && dv.getFloat32(ch + CH.size, true) === M._wasm_stext_char_get_size(ch)
      && dv.getUint32(ch + CH.font, true) === M._wasm_stext_char_get_font(ch)
      && dv.getUint32(ch + CH.next, true) === M._wasm_stext_char_get_next(ch);
    if (!charLayoutOk) console.warn('MuPDF: fz_stext_char layout differs from the pinned build — reading through accessors');
  }
  // One character: { c, bidi, flags, argb, origin, quad, size, font, next }.
  function readChar(ch) {
    if (charLayoutOk === null) checkCharLayout(ch);
    const M = Module;
    if (!charLayoutOk)
      return { c: M._wasm_stext_char_get_c(ch), bidi: M._wasm_stext_char_get_bidi(ch), flags: 0,
               argb: M._wasm_stext_char_get_argb(ch) >>> 0, origin: floats(M._wasm_stext_char_get_origin(ch), 2),
               quad: floats(M._wasm_stext_char_get_quad(ch), 8), size: M._wasm_stext_char_get_size(ch),
               font: M._wasm_stext_char_get_font(ch), next: M._wasm_stext_char_get_next(ch) };
    const dv = view(), f = o => dv.getFloat32(ch + o, true), q = CH.quad;
    return { c: dv.getInt32(ch + CH.c, true), bidi: dv.getUint16(ch + CH.bidi, true), flags: dv.getUint16(ch + CH.flags, true),
             argb: dv.getUint32(ch + CH.argb, true), origin: [f(CH.origin), f(CH.origin + 4)],
             quad: [f(q), f(q + 4), f(q + 8), f(q + 12), f(q + 16), f(q + 20), f(q + 24), f(q + 28)],
             size: f(CH.size), font: dv.getUint32(ch + CH.font, true), next: dv.getUint32(ch + CH.next, true) };
  }

  // Per fz_font: name (subset prefix ABCDEF+ removed, as PyMuPDF reports it) and style bits.
  const faceByFont = new Map();
  function fontFace(fontPtr) {
    let f = faceByFont.get(fontPtr);
    if (f) return f;
    let name = cstring(Module._wasm_font_get_name(fontPtr));
    if (name.indexOf('+') === 6) name = name.slice(7);
    f = { name, flags: (Module._wasm_font_is_italic(fontPtr) ? FONT_ITALIC : 0) + (Module._wasm_font_is_serif(fontPtr) ? FONT_SERIFED : 0)
                     + (Module._wasm_font_is_monospaced(fontPtr) ? FONT_MONOSPACED : 0) + (Module._wasm_font_is_bold(fontPtr) ? FONT_BOLD : 0) };
    faceByFont.set(fontPtr, f);
    return f;
  }

  const floats = (ptr, n) => { const dv = view(); const out = new Array(n); for (let i = 0; i < n; i++) out[i] = dv.getFloat32(ptr + 4 * i, true); return out; };
  const cstring = ptr => { const h = Module.HEAPU8; let e = ptr; while (h[e]) e++; return new TextDecoder().decode(h.subarray(ptr, e)); };

  // ── page resources, the way PyMuPDF walks them (JM_scan_resources) ───────

  function pageResources(page) {
    let obj = page.getObject();
    for (let depth = 0; obj && !obj.isNull() && depth < 64; depth++) {
      const r = obj.get('Resources');
      if (r && !r.isNull()) return r;
      obj = obj.get('Parent');
    }
    return null;
  }

  // Visit `visit(resources)` for the page's resources and, depth first, the
  // resources of every XObject in them; an XObject stream is entered once.
  function scanResources(rsrc, visit, tracer = new Set()) {
    if (!rsrc || rsrc.isNull()) return;
    visit(rsrc);
    const xobj = rsrc.get('XObject');
    if (!xobj || !xobj.isDictionary()) return;
    xobj.forEach(val => {
      const sub = val.get('Resources');
      if (!sub || sub.isNull()) return;
      const sxref = val.isStream() && val.isIndirect() ? val.asIndirect() : 0;
      if (tracer.has(sxref)) return;
      tracer.add(sxref);
      scanResources(sub, visit, tracer);
    });
  }

  const nameOf = o => (o && o.isName && o.isName()) ? o.asName() : '';
  const either = (dict, a, b) => { const v = dict.get(a); return v && !v.isNull() ? v : dict.get(b); };

  // Document.get_page_images: every image XObject, in resource order.
  function pageImages(page) {
    const list = [];
    scanResources(pageResources(page), rsrc => {
      const xobj = rsrc.get('XObject');
      if (!xobj || !xobj.isDictionary()) return;
      xobj.forEach((val, key) => {
        if (!val.isDictionary() && !val.isStream()) return;
        if (nameOf(val.get('Subtype')) !== 'Image') return;
        let filter = either(val, 'Filter', 'F');
        // the LAST filter decides what MuPDF holds: a compressed JPEG/JPX buffer, or samples
        if (filter && filter.isArray()) filter = filter.length ? filter.get(filter.length - 1) : null;
        list.push({ ref: val, name: String(key), filter: nameOf(filter),
                    width: either(val, 'Width', 'W').asNumber(), height: either(val, 'Height', 'H').asNumber() });
      });
    });
    return list;
  }

  // Document.extract_image keeps a compressed JPEG/JPX stream as it is
  // (ext "jpeg"/"jpx") and turns everything else into a PNG; the loader uses
  // only the PNG kind (`ext in ("png", "tiff", "tif")`).
  const isUsableRaster = im => !['DCTDecode', 'DCT', 'JPXDecode'].includes(im.filter);

  // Page.get_page_fonts: the BaseFont (else Name) of every font resource.
  function pageFontNames(page) {
    const names = [];
    scanResources(pageResources(page), rsrc => {
      const fonts = rsrc.get('Font');
      if (!fonts || !fonts.isDictionary()) return;
      fonts.forEach(val => {
        if (!val.isDictionary()) return;
        const base = val.get('BaseFont');
        names.push(nameOf(base && !base.isNull() ? base : val.get('Name')));
      });
    });
    return names;
  }

  // ── image placement (Page.get_image_rects → the stext image block) ───────

  // Where each image is painted on the page: [{ pointer, width, height, bbox }].
  function imagePlacements(page) {
    const out = [];
    const st = page.toStructuredText('preserve-images');
    try {
      st.walk({ onImageBlock(bbox, _matrix, image) {
        out.push({ pointer: image.pointer, width: image.getWidth(), height: image.getHeight(), bbox });
        image.destroy?.();
      } });
    } finally { st.destroy(); }
    return out;
  }

  // The first placement of one image (PyMuPDF matches by digest; the store
  // hands back the same fz_image while we hold it, size is the fallback).
  function placementOf(placements, image) {
    const hit = placements.find(p => p.pointer === image.pointer)
      || placements.find(p => p.width === image.getWidth() && p.height === image.getHeight());
    return hit ? hit.bbox : null;
  }

  // ── rasters ──────────────────────────────────────────────────────────────

  function copyOut(pix, source, rect) {
    const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents(), stride = pix.getStride();
    const src = pix.getPixels(), samples = new Uint8Array(w * h * n);
    if (stride === w * n) samples.set(src.subarray(0, w * h * n));
    else for (let y = 0; y < h; y++) samples.set(src.subarray(y * stride, y * stride + w * n), y * w * n);
    return { width: w, height: h, components: n, alpha: !!pix.getAlpha(), samples, source, rect };
  }

  // The embedded image's pixmap the way extract_image writes it to a PNG:
  // its own samples for gray and RGB (no colour management), anything else
  // (CMYK, Lab, …) converted to DeviceRGB.
  function imagePixmap(image) {
    let pix = image.toPixmap();
    const cs = pix.getColorSpace();
    if (cs && !cs.isGray() && !cs.isRGB()) {
      const rgb = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, true);
      pix.destroy();
      pix = rgb;
    }
    return pix;
  }

  // crop_to_page_ratio: excess BOTTOM rows go, so the raster has the 8.5x11
  // ratio the pixel coordinate space assumes. Rows are copied, never resampled.
  function cropToPageRatio(raster) {
    const expected = pyRound(raster.width * GEO.PAGE_ASPECT);
    if (raster.height <= expected) return raster;
    const rowBytes = raster.width * raster.components;
    return { ...raster, height: expected, samples: raster.samples.slice(0, expected * rowBytes) };
  }

  // _first_raster: the first usable embedded raster of a page, cropped.
  function firstRaster(page) {
    const images = pageImages(page);
    let placements = null;
    for (const entry of images) {
      if (!isUsableRaster(entry)) continue;
      let image = null, pix = null;
      try {
        image = doc.loadImage(entry.ref);
        pix = imagePixmap(image);
        placements = placements || imagePlacements(page);
        return cropToPageRatio(copyOut(pix, 'embedded', placementOf(placements, image)));
      } catch (e) {
        console.warn(`image ${entry.name}: ${e?.message || e}`);
      } finally {
        pix?.destroy(); image?.destroy();
      }
    }
    return null;
  }

  function renderPage(page) {
    const pix = page.toPixmap(mupdf.Matrix.scale(GEO.PT_TO_PX, GEO.PT_TO_PX), mupdf.ColorSpace.DeviceRGB, false, true);
    try { return copyOut(pix, 'render', null); } finally { pix.destroy(); }
  }

  function withPage(n, fn) {
    if (!Number.isInteger(n) || n < 1 || n > numPages) throw new RangeError(`no page ${n}`);
    const page = doc.loadPage(n - 1);
    try { return fn(page); } finally { page.destroy(); }
  }

  // One page's raster: { width, height, components, alpha, samples, source, rect }.
  // `gray: true` gives one component per pixel, colour converted by MuPDF
  // (what a plugin that analyses the page's pixels wants).
  function pageRaster(n, { gray = false } = {}) {
    const raster = withPage(n, page => firstRaster(page) || renderPage(page));
    return gray ? toGray(raster) : raster;
  }

  function toGray(raster) {
    const { width, height, components: n, alpha, samples } = raster;
    if (n === 1) return raster;
    const colors = n - (alpha ? 1 : 0);
    if (colors === 1) {                                           // gray + alpha: drop the alpha
      const out = new Uint8Array(width * height);
      for (let i = 0; i < out.length; i++) out[i] = samples[i * n];
      return { ...raster, components: 1, alpha: false, samples: out };
    }
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], alpha);
    let grayPix = null;
    try {
      const dst = pix.getPixels(), stride = pix.getStride();
      for (let y = 0; y < height; y++) dst.set(samples.subarray(y * width * n, (y + 1) * width * n), y * stride);
      grayPix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceGray, false);
      return { ...copyOut(grayPix, raster.source, raster.rect) };
    } finally { grayPix?.destroy(); pix.destroy(); }
  }

  // _thumbnail: 180 px wide, height round(h * 180 / w). The server used
  // Pillow's LANCZOS; this is an area average — same size, not the same bytes.
  function thumbnail(raster) {
    if (raster.width <= THUMB_WIDTH) return raster;
    const { width: w, height: h, components: n, samples } = raster;
    const tw = THUMB_WIDTH, th = Math.max(1, pyRound(h * THUMB_WIDTH / w));
    const out = new Uint8Array(tw * th * n);
    for (let ty = 0; ty < th; ty++) {
      const y0 = Math.floor(ty * h / th), y1 = Math.max(y0 + 1, Math.floor((ty + 1) * h / th));
      for (let tx = 0; tx < tw; tx++) {
        const x0 = Math.floor(tx * w / tw), x1 = Math.max(x0 + 1, Math.floor((tx + 1) * w / tw));
        for (let c = 0; c < n; c++) {
          let sum = 0;
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += samples[(y * w + x) * n + c];
          out[(ty * tw + tx) * n + c] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
        }
      }
    }
    return { ...raster, width: tw, height: th, samples: out };
  }

  // Lossless PNG of a raster, encoded by MuPDF.
  function rasterPNG(raster) {
    const { width, height, components: n, alpha, samples } = raster;
    const colors = n - (alpha ? 1 : 0);
    const cs = colors === 1 ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB;
    const pix = new mupdf.Pixmap(cs, [0, 0, width, height], alpha);
    try {
      const dst = pix.getPixels(), stride = pix.getStride();
      if (stride === width * n) dst.set(samples);
      else for (let y = 0; y < height; y++) dst.set(samples.subarray(y * width * n, (y + 1) * width * n), y * stride);
      return pix.asPNG().slice();
    } finally { pix.destroy(); }
  }

  function pagePNG(n, { thumb = false } = {}) {
    const raster = pageRaster(n);
    return rasterPNG(thumb ? thumbnail(raster) : raster);
  }

  // extract.py _page_image_rect: the placement of the page's LARGEST image
  // (by placed area), or null — the text transform then uses the page rect.
  const pageImageRect = n => withPage(n, page => {
    const images = pageImages(page);
    if (!images.length) return null;
    const placements = imagePlacements(page);
    let best = null, bestArea = -1;
    for (const entry of images) {
      let image = null;
      try {
        image = doc.loadImage(entry.ref);
        const r = placementOf(placements, image);
        if (!r) continue;
        const area = (r[2] - r[0]) * (r[3] - r[1]);
        if (area > bestArea) { bestArea = area; best = r; }
      } catch { /* an unreadable image has no placement */ } finally { image?.destroy(); }
    }
    return best;
  });

  const pageRect = n => withPage(n, page => page.getBounds());

  // ── raw structured text (PyMuPDF's "rawdict" shape) ──────────────────────

  // JM_char_quad: MuPDF's quad, recomputed only when the face's ascender and
  // descender make no sense (their span under 1 — a glyphless OCR font, say).
  function charQuad(ch, line) {
    const quad = ch.quad, size = ch.size;
    if (line.wmode) return quad;
    let { ascender: asc, descender: dsc } = fontMetrics(ch.font);
    let ascDsc = f32(asc - dsc + FLT_EPSILON);
    if (ascDsc >= 1) return quad;
    if (asc < 1e-3) { dsc = -0.1; asc = 0.9; ascDsc = 1.0; }
    if (ascDsc < 1) { dsc = f32(dsc / ascDsc); asc = f32(asc / ascDsc); }
    ascDsc = f32(asc - dsc);
    asc = f32(asc * size / ascDsc);
    dsc = f32(dsc * size / ascDsc);

    const c = line.dir[0], s = line.dir[1];
    const origin = ch.origin;
    const d1 = c === -1 ? 1 : c, d2 = d1;                           // left-right flip keeps d = 1
    const xf = (x, y, m) => [f32(x * m[0] + y * m[2]), f32(x * m[1] + y * m[3])];
    const derot = [c, -s, s, d1], rot = [c, s, -s, d2];
    const q = [];
    for (let i = 0; i < 8; i += 2) q.push(...xf(f32(quad[i] - origin[0]), f32(quad[i + 1] - origin[1]), derot));
    // q: ul(0,1) ur(2,3) ll(4,5) lr(6,7)
    if (c === 1 && q[1] > 0) { q[1] = q[3] = asc; q[5] = q[7] = dsc; }
    else { q[1] = q[3] = -asc; q[5] = q[7] = -dsc; }
    if (q[4] < 0) { q[4] = 0; q[0] = 0; }
    // a zero-width quad would take the glyph's advance here; mupdf.js offers no
    // advance for a font pointer, and the width of such a char stays 0.
    const back = [];
    for (let i = 0; i < 8; i += 2) { const p = xf(q[i], q[i + 1], rot); back.push(f32(p[0] + origin[0]), f32(p[1] + origin[1])); }
    return back;
  }

  // The page's structured text as PyMuPDF's TextPage.extractRAWDICT() gives
  // it: blocks → lines → spans → chars, a span being a run of one style.
  // `options` is a MuPDF option string (STEXT.*). Image blocks carry their
  // bbox only. Note PyMuPDF runs annotations into the text page too; this is
  // the page contents (the corpus has no annotation text).
  const structuredText = (n, options = STEXT.WHITESPACE) => withPage(n, page => {
    const st = page.toStructuredText(options);
    try {
      const M = Module, sp = st.pointer;
      const tpRect = floats(M._wasm_stext_page_get_mediabox(sp), 4);
      const clipAll = !isInfinite(tpRect);
      const blocks = [];
      let number = -1;
      for (let b = M._wasm_stext_page_get_first_block(sp); b; b = M._wasm_stext_block_get_next(b)) {
        number++;
        const type = M._wasm_stext_block_get_type(b);
        const bbox = floats(M._wasm_stext_block_get_bbox(b), 4);
        if (clipAll && isEmpty(intersect(tpRect, bbox))) continue;
        if (type === 1) {
          if (clipAll && !(bbox[0] >= tpRect[0] && bbox[1] >= tpRect[1] && bbox[2] <= tpRect[2] && bbox[3] <= tpRect[3])) continue;
          blocks.push({ number, type, bbox });
          continue;
        }
        if (type !== 0) continue;

        const lines = [];
        let blockRect = EMPTY;
        for (let l = M._wasm_stext_block_get_first_line(b); l; l = M._wasm_stext_line_get_next(l)) {
          const lineBox = floats(M._wasm_stext_line_get_bbox(l), 4);
          if (clipAll && isEmpty(intersect(tpRect, lineBox))) continue;
          const line = { wmode: M._wasm_stext_line_get_wmode(l), dir: floats(M._wasm_stext_line_get_dir(l), 2) };
          const firstCh = M._wasm_stext_line_get_first_char(l);
          const firstOriginY = firstCh ? readChar(firstCh).origin[1] : 0;

          const spans = [];
          let span = null, spanRect = EMPTY, lineRect = EMPTY, style = null;
          const flush = last => {
            if (!span) return;
            span.bbox = spanRect;
            if (!last || !isEmpty(spanRect)) { spans.push(span); lineRect = union(lineRect, spanRect); }
            span = null;
          };
          for (let ptr = firstCh, ch; ptr; ptr = ch.next) {
            ch = readChar(ptr);
            const fontPtr = ch.font, size = ch.size;
            let r = rectFromQuad(charQuad(ch, line));
            if (line.wmode && r[3] < r[1] + size) r = [r[0], r[3] - size, r[2], r[3]];
            if (clipAll && !overlap(tpRect, r)) continue;

            const origin = ch.origin;
            const superscript = line.wmode === 0 && line.dir[0] === 1 && line.dir[1] === 0
              && origin[1] < f32(firstOriginY - f32(size * f32(0.1)));
            const face = fontFace(fontPtr);
            const flags = (superscript ? FONT_SUPERSCRIPT : 0) + face.flags;
            const rawFlags = ch.flags;
            const charFlagsSpan = rawFlags & ~STEXT_SYNTHETIC;
            const argb = ch.argb, bidi = ch.bidi;
            const font = face.name;

            if (!style || style.size !== size || style.flags !== flags || style.charFlags !== charFlagsSpan
                || style.argb !== argb || style.font !== font || style.bidi !== bidi) {
              flush(false);
              const fm = fontMetrics(fontPtr);
              const tiny = fm.ascender < 1e-3;
              span = { size, flags, bidi, char_flags: charFlagsSpan, font, color: argb & 0xffffff, alpha: argb >>> 24,
                       ascender: tiny ? 0.9 : fm.ascender, descender: tiny ? -0.1 : fm.descender,
                       origin, bbox: null, chars: [] };
              style = { size, flags, charFlags: charFlagsSpan, argb, font, bidi };
              spanRect = r;
            }
            spanRect = union(spanRect, r);
            span.chars.push({ origin, bbox: r, c: String.fromCodePoint(ch.c),
                              synthetic: !!(rawFlags & STEXT_SYNTHETIC) });
          }
          flush(true);
          blockRect = union(blockRect, lineRect);
          lines.push({ spans, wmode: line.wmode, dir: line.dir, bbox: lineRect });
        }
        blocks.push({ number, type, bbox: blockRect, lines });
      }
      const bounds = page.getBounds();
      return { rect: bounds, width: bounds[2] - bounds[0], height: bounds[3] - bounds[1], blocks };
    } finally { st.destroy(); }
  });

  // ── load_pdf_meta ────────────────────────────────────────────────────────

  // _span_size: the span's font size in points. MuPDF's `size` is the text
  // matrix expansion, which an OCR layer's per-word horizontal scaling (Tz)
  // inflates by sqrt(Tz); bbox height over (ascender − descender) is the
  // unscaled size.
  function spanSize(span) {
    const b = span.bbox, extent = span.ascender - span.descender;
    if (b && extent > 0 && b[3] > b[1]) return (b[3] - b[1]) / extent;
    return span.size;
  }

  // _suggested_size: mode of the body-text span sizes, to the nearest 0.5 pt.
  // Long spans (>= 20 chars) are the body signal; every span is the fallback.
  function suggestedSize(sample) {
    const sizesOf = minLen => sample.filter(s => s.length >= minLen && s.size > 0).map(s => pyRound(s.size * 2) / 2);
    let sizes = sizesOf(20);
    if (!sizes.length) sizes = sizesOf(1);
    if (!sizes.length) return 12.0;
    const counts = new Map();
    for (const s of sizes) counts.set(s, (counts.get(s) || 0) + 1);
    let best = null, bestCount = 0;
    for (const [s, c] of counts) if (c > bestCount) { best = s; bestCount = c; }   // first seen wins a tie
    return best;
  }

  const numPages = doc.countPages();

  // load_pdf_meta, in two passes so a viewer can show the first page before
  // the slower one has run.

  // Pass 1 — geometry: page count, the page size of the pixel space, and the
  // pt→px scale measured from the first placed raster of the document
  // (suggestedScale, px-per-pt as a percentage).
  function geometry() {
    let ratio = null;
    for (let i = 0; i < numPages && ratio === null; i++) {
      const page = doc.loadPage(i);
      try {
        const entry = pageImages(page).find(isUsableRaster);
        if (!entry) continue;
        let image = null;
        try {
          image = doc.loadImage(entry.ref);
          const r = placementOf(imagePlacements(page), image);
          ratio = r && r[2] - r[0] > 0 ? image.getWidth() / (r[2] - r[0]) : undefined;
        } catch { ratio = undefined; } finally { image?.destroy(); }
      } catch { /* a page that cannot be read has no raster */ } finally { page.destroy(); }
    }
    return {
      pageImageType: 'image/png',
      pageWidth: GEO.PAGE_WIDTH_PX,
      pageHeight: GEO.PAGE_HEIGHT_PX,
      numPages,
      suggestedScale: pyRound(100 * (ratio ?? GEO.PT_TO_PX)),
    };
  }

  // Pass 2 — typography: the declared fonts of every page (most used first)
  // and the body size sampled from the leading pages.
  function typography() {
    const fontPages = new Map();      // basefont → occurrences, in first-seen order
    const sample = [];
    for (let i = 0; i < numPages; i++) {
      const page = doc.loadPage(i);
      try {
        for (const name of pageFontNames(page))
          if (name && name !== 'unknown') fontPages.set(name, (fontPages.get(name) || 0) + 1);
      } catch (e) { console.warn(`declared fonts, page ${i + 1}: ${e?.message || e}`); } finally { page.destroy(); }

      if (i < SPAN_SAMPLE_PAGES) {
        try {
          for (const block of structuredText(i + 1, STEXT.SAMPLE).blocks)
            for (const line of block.lines || [])
              for (const span of line.spans)
                sample.push({ length: [...span.chars.map(c => c.c).join('').trim()].length, size: spanSize(span) });
        } catch (e) { console.warn(`text sample, page ${i + 1}: ${e?.message || e}`); }
      }
    }
    // most used first; equal counts keep first-seen order (a stable sort)
    const pdfFonts = [...fontPages.keys()].sort((a, b) => fontPages.get(b) - fontPages.get(a));
    return { pdfFonts, suggestedSize: suggestedSize(sample) };
  }

  const meta = () => ({ ...geometry(), ...typography() });

  function close() {
    metricsByFont.clear();
    faceByFont.clear();
    doc.destroy();
    mupdf.emptyStore?.();
  }

  return { numPages, meta, geometry, typography, pageRaster, pagePNG, pageImageRect, pageRect, structuredText, close };
}
