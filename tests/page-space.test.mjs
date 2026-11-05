// web/core/pdf-document.js on pages the corpus never has: what a page shows
// and the pixel space it shows it in. The pages are built here with MuPDF, so
// the truth is known — and where a page's raster must be what the page looks
// like, it is held to MuPDF's own 96-dpi render of the page, pixel for pixel.
//
//   node --test tests/*.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

const Module = { printErr() {} };
globalThis.$libmupdf_wasm_Module = Module;
const mupdf = await import('../web/vendor/mupdf/mupdf.js');
const { openPdf, pxSize } = await import('../web/core/pdf-document.js');

const LETTER = [0, 0, 612, 792];

// ── building pages ─────────────────────────────────────────────────────────

// An image XObject from raw samples: `value(x, y)` → 0..255 (8-bit gray), or
// with `stencil` → true where an /ImageMask paints (1-bit, Decode [1 0]).
function addImage(doc, w, h, value, { stencil = false, colorKey = null } = {}) {
  const d = doc.newDictionary();
  d.put('Type', doc.newName('XObject'));
  d.put('Subtype', doc.newName('Image'));
  d.put('Width', doc.newInteger(w));
  d.put('Height', doc.newInteger(h));
  let data;
  if (stencil) {
    const stride = (w + 7) >> 3;
    data = new Uint8Array(stride * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (value(x, y)) data[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    d.put('BitsPerComponent', doc.newInteger(1));
    d.put('ImageMask', doc.newBoolean(true));
    const decode = doc.newArray(); decode.push(doc.newInteger(1)); decode.push(doc.newInteger(0));
    d.put('Decode', decode);
  } else {
    data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = value(x, y);
    d.put('BitsPerComponent', doc.newInteger(8));
    d.put('ColorSpace', doc.newName('DeviceGray'));
    if (colorKey) { const m = doc.newArray(); for (const v of colorKey) m.push(doc.newInteger(v)); d.put('Mask', m); }
  }
  return doc.addRawStream(data, d);
}

// A JPEG image XObject (kept as DCTDecode by MuPDF).
function addJpeg(doc, w, h, value) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, w, h], false);
  const s = pix.getPixels();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) s[y * pix.getStride() + x] = value(x, y);
  const image = new mupdf.Image(pix.asJPEG(90));
  pix.destroy();
  return doc.addImage(image);
}

function addPage(doc, box, { rotate = 0, images = {}, text = null, content = '' } = {}) {
  const res = doc.newDictionary();
  const xo = doc.newDictionary();
  for (const [k, v] of Object.entries(images)) xo.put(k, v);
  res.put('XObject', xo);
  if (text) { const f = doc.newDictionary(); f.put('F1', doc.addSimpleFont(new mupdf.Font('Helvetica'))); res.put('Font', f); }
  const ops = content + (text ? ` BT /F1 24 Tf 72 400 Td (${text}) Tj ET` : '');
  doc.insertPage(-1, doc.addPage(box, rotate, res, ops));
}

function build(pages) {
  const doc = new mupdf.PDFDocument();
  for (const p of pages) p(doc);
  const bytes = doc.saveToBuffer('').asUint8Array().slice();
  doc.destroy();
  return bytes;
}

// What MuPDF itself draws: the page at 96 DPI, gray.
function render(bytes, n) {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const page = doc.loadPage(n - 1);
  const pix = page.toPixmap(mupdf.Matrix.scale(96 / 72, 96 / 72), mupdf.ColorSpace.DeviceGray, false, true);
  const w = pix.getWidth(), h = pix.getHeight(), st = pix.getStride(), src = pix.getPixels();
  const samples = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) samples.set(src.subarray(y * st, y * st + w), y * w);
  pix.destroy(); page.destroy(); doc.destroy();
  return { width: w, height: h, samples };
}

const open = bytes => openPdf(mupdf, Module, bytes);
// Asymmetric in both axes, so any turn or mirror shows.
const pattern = (x, y) => (x * 7 + y * 13 + (x > y ? 60 : 0)) & 255;

function equalSamples(a, b, what) {
  assert.deepEqual([a.width, a.height], [b.width, b.height], `${what}: size`);
  let diff = 0;
  for (let i = 0; i < a.samples.length; i++) if (a.samples[i] !== b.samples[i]) diff++;
  assert.equal(diff, 0, `${what}: ${diff} samples differ from MuPDF's render`);
}

// ── which image is the page ────────────────────────────────────────────────

test('a logo, a stamp or an image another page paints is not the page: such pages are rendered', () => {
  const bytes = build([
    // a born-digital page with a 64×64 logo in its corner
    doc => addPage(doc, LETTER, { images: { Logo: addImage(doc, 64, 64, pattern) }, text: 'all of this text matters',
                                  content: 'q 64 0 0 64 40 700 cm /Logo Do Q' }),
    // the resources name an image this page never paints
    doc => addPage(doc, LETTER, { images: { Unused: addImage(doc, 816, 1056, () => 128) }, text: 'nothing painted here' }),
    // two images over the whole page: layers of one scan, not a scan
    doc => addPage(doc, LETTER, { images: { A: addImage(doc, 816, 1056, () => 200), B: addImage(doc, 816, 1056, pattern) },
                                  content: 'q 612 0 0 792 0 0 cm /A Do Q q 612 0 0 792 0 0 cm /B Do Q' }),
  ]);
  const pdf = open(bytes);
  try {
    for (const n of [1, 2, 3]) {
      const r = pdf.pageRaster(n);
      assert.equal(r.source, 'render', `page ${n}: rendered`);
      assert.equal(r.rect, null, `page ${n}: no scan placement`);
      assert.equal(pdf.pageImageRect(n), null, `page ${n}: the text transform uses the page`);
      assert.deepEqual(pdf.pageSize(n), { width: r.width, height: r.height }, `page ${n}: the space is the render`);
    }
    // what a render shows: page 1's text is there, not a stretched logo
    equalSamples(pdf.pageRaster(1, { gray: true }), render(bytes, 1), 'page 1');
  } finally { pdf.close(); }
});

test('a scan with a stamp painted over it is still the page; a JPEG scan or inset is rendered', () => {
  const bytes = build([
    doc => addPage(doc, LETTER, { images: { Scan: addImage(doc, 816, 1056, pattern), Stamp: addImage(doc, 40, 20, () => 0) },
                                  content: 'q 612 0 0 792 0 0 cm /Scan Do Q q 40 0 0 20 500 20 cm /Stamp Do Q' }),
    doc => addPage(doc, LETTER, { images: { Photo: addJpeg(doc, 816, 1056, pattern) }, content: 'q 612 0 0 792 0 0 cm /Photo Do Q' }),
    doc => addPage(doc, LETTER, { images: { Inset: addJpeg(doc, 300, 200, pattern) }, text: 'HELLO WORLD',
                                  content: 'q 225 0 0 150 72 72 cm /Inset Do Q' }),
  ]);
  const pdf = open(bytes);
  try {
    const scan = pdf.pageRaster(1);
    assert.equal(scan.source, 'embedded');
    assert.deepEqual([scan.width, scan.height], [816, 1056]);
    assert.deepEqual(scan.rect, LETTER);
    assert.deepEqual(pdf.pageImageRect(1), LETTER);
    for (const n of [2, 3]) {
      assert.equal(pdf.pageRaster(n).source, 'render', `page ${n}: a JPEG is never the raster`);
      assert.equal(pdf.pageImageRect(n), null, `page ${n}: and never the text's rectangle`);
    }
  } finally { pdf.close(); }
});

// ── the whole scan, in a space of its own size ─────────────────────────────

test('A4 and Legal scans keep every row; the pixel space is the scan at 96 DPI', () => {
  const dark = rows => (x, y) => (y >= rows ? 0 : 255);
  const bytes = build([
    // A4 at 100 dpi: the last 100 rows are a signature block
    doc => addPage(doc, [0, 0, 595.28, 841.89], { images: { S: addImage(doc, 827, 1170, dark(1070)) },
                                                  content: 'q 595.28 0 0 841.89 0 0 cm /S Do Q' }),
    // US Legal at 100 dpi, the bottom 300 rows dark
    doc => addPage(doc, [0, 0, 612, 1008], { images: { S: addImage(doc, 850, 1400, dark(1100)) },
                                             content: 'q 612 0 0 1008 0 0 cm /S Do Q' }),
    // a 612 × 810 page whose scan covers its top 792 pt (the corpus' pages)
    doc => addPage(doc, [0, 0, 612, 810], { images: { S: addImage(doc, 816, 1056, pattern) },
                                            content: 'q 612 0 0 792 0 18 cm /S Do Q' }),
  ]);
  const pdf = open(bytes);
  try {
    const a4 = pdf.pageRaster(1), legal = pdf.pageRaster(2), corpus = pdf.pageRaster(3);
    assert.deepEqual([a4.width, a4.height], [827, 1170], 'A4: no row cropped');
    assert.equal(a4.samples[1169 * 827], 0, 'A4: the last row is there');
    assert.deepEqual(pdf.pageSize(1), { width: 794, height: 1123 });
    assert.deepEqual([legal.width, legal.height], [850, 1400], 'Legal: no row cropped');
    assert.equal(legal.samples[1399 * 850], 0, 'Legal: the last row is there');
    assert.deepEqual(pdf.pageSize(2), { width: 816, height: 1344 });
    assert.deepEqual(pdf.pageSize(3), { width: 816, height: 1056 }, 'the corpus layout: the scan, not the page');
    assert.deepEqual(corpus.rect, [0, 0, 612, 792]);
    assert.deepEqual(pdf.geometry().pageHeight, 1123, "the document's first page");
  } finally { pdf.close(); }
});

test('a rendered page is its pixel space: landscape, A4 and odd sizes, rounded as MuPDF rounds a render', () => {
  const sizes = [[792, 612], [595.28, 841.89], [612, 1008], [419.53, 595.28], [500.4, 300.25], [1000.2, 750.75], [595, 842]];
  const bytes = build(sizes.map(([w, h]) => doc => addPage(doc, [0, 0, w, h], { text: 'O' })));
  const pdf = open(bytes);
  try {
    sizes.forEach(([w, h], i) => {
      const r = pdf.pageRaster(i + 1);
      assert.equal(r.source, 'render');
      assert.deepEqual(pdf.pageSize(i + 1), { width: r.width, height: r.height }, `${w}×${h} pt`);
      assert.deepEqual(pxSize([0, 0, w, h]), { width: r.width, height: r.height }, `${w}×${h} pt: pxSize`);
    });
    assert.deepEqual(pdf.pageSize(1), { width: 1056, height: 816 }, 'Letter landscape');
  } finally { pdf.close(); }
});

// ── turned, mirrored, masked: what the page looks like ─────────────────────

test('a scan placed turned or mirrored is set upright — the very pixels MuPDF draws', () => {
  // [page box, /Rotate, image w × h, cm] — every one shows a portrait Letter page at 96 dpi
  const cases = {
    'upright':            [LETTER, 0, 816, 1056, '612 0 0 792 0 0'],
    '/Rotate 90':         [[0, 0, 792, 612], 90, 1056, 816, '792 0 0 612 0 0'],
    '/Rotate 180':        [LETTER, 180, 816, 1056, '612 0 0 792 0 0'],
    '/Rotate 270':        [[0, 0, 792, 612], 270, 1056, 816, '792 0 0 612 0 0'],
    'mirrored':           [LETTER, 0, 816, 1056, '-612 0 0 792 612 0'],
    'upside down':        [LETTER, 0, 816, 1056, '612 0 0 -792 0 792'],
    'turned by its cm':   [LETTER, 0, 1056, 816, '0 792 -612 0 612 0'],
    'turned and flipped': [LETTER, 0, 1056, 816, '0 -792 612 0 0 792'],
  };
  const names = Object.keys(cases);
  const bytes = build(names.map(name => {
    const [box, rotate, w, h, cm] = cases[name];
    return doc => addPage(doc, box, { rotate, images: { S: addImage(doc, w, h, pattern) }, content: `q ${cm} cm /S Do Q` });
  }));
  const pdf = open(bytes);
  try {
    names.forEach((name, i) => {
      const r = pdf.pageRaster(i + 1, { gray: true });
      assert.equal(r.source, 'embedded', name);
      assert.deepEqual(pdf.pageSize(i + 1), { width: 816, height: 1056 }, name);
      equalSamples(r, render(bytes, i + 1), name);
    });
  } finally { pdf.close(); }
});

test('a stencil scan paints black, a colour-keyed one shows paper: every raster is opaque', () => {
  const bytes = build([
    doc => addPage(doc, LETTER, { images: { M: addImage(doc, 816, 1056, (x, y) => (x * x + y) % 7 === 0 || (y > 100 && y < 140), { stencil: true }) },
                                  content: '0 g q 612 0 0 792 0 0 cm /M Do Q' }),
    doc => addPage(doc, LETTER, { images: { K: addImage(doc, 816, 1056, pattern, { colorKey: [100, 140] }) },
                                  content: 'q 612 0 0 792 0 0 cm /K Do Q' }),
  ]);
  const pdf = open(bytes);
  try {
    for (const [n, what] of [[1, 'stencil'], [2, 'colour key']]) {
      const r = pdf.pageRaster(n);
      assert.equal(r.source, 'embedded', what);
      assert.equal(r.alpha, false, `${what}: opaque`);
      assert.equal(r.components, 1, `${what}: gray`);
      equalSamples(r, render(bytes, n), what);
    }
  } finally { pdf.close(); }
});

// ── documents that cannot be shown as they claim ───────────────────────────

test('a password-protected PDF, and one without pages, are refused with a reason', () => {
  const locked = new mupdf.PDFDocument();
  addPage(locked, LETTER, { text: 'secret' });
  const lockedBytes = locked.saveToBuffer('encrypt=aes-256,user-password=abc,owner-password=abc').asUint8Array().slice();
  locked.destroy();
  assert.throws(() => open(lockedBytes), /password-protected/);

  const empty = new TextEncoder().encode('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n');
  assert.throws(() => open(empty), /no pages/);

  // an owner password alone: MuPDF opens it with the empty one
  const owned = new mupdf.PDFDocument();
  addPage(owned, LETTER, { text: 'readable' });
  const ownedBytes = owned.saveToBuffer('encrypt=aes-256,owner-password=abc').asUint8Array().slice();
  owned.destroy();
  const pdf = open(ownedBytes);
  try { assert.equal(pdf.numPages, 1); } finally { pdf.close(); }
});

test('a page that cannot be read fails alone: the document opens, its other pages show', () => {
  // the page tree claims 3 pages and holds 2
  const bytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
    + '2 0 obj<</Type/Pages/Count 3/Kids[3 0 R 4 0 R]>>endobj\n'
    + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n'
    + '4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n');
  const pdf = open(bytes);
  try {
    const m = pdf.meta();
    assert.equal(m.numPages, 3);
    assert.deepEqual([m.pageWidth, m.pageHeight], [816, 1056]);
    for (const n of [1, 2]) assert.equal(pdf.pageRaster(n).source, 'render', `page ${n}`);
    assert.throws(() => pdf.pageRaster(3));
    assert.throws(() => pdf.pageSize(3));
  } finally { pdf.close(); }
});
