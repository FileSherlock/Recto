// web/core/pdf-document.js against the goldens: open metadata, page rasters
// (decoded-pixel hashes), image placement and thumbnail sizes, for every
// golden PDF page. Image documents are browser-only (createImageBitmap) and
// are checked in the browser smoke test.
//
//   node --test tests/*.test.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GOLDEN = path.join(HERE, 'golden');

const Module = {};
globalThis.$libmupdf_wasm_Module = Module;
const mupdf = await import('../web/vendor/mupdf/mupdf.js');
const { openPdf } = await import('../web/core/pdf-document.js');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// The golden hash forms (tests/golden/README.md): gray samples as they are,
// anything else expanded to R G B A.
function pixelHashes(r) {
  const colors = r.components - (r.alpha ? 1 : 0), px = r.width * r.height;
  const rgba = new Uint8Array(px * 4);
  let achromatic = true;
  for (let i = 0; i < px; i++) {
    const o = i * r.components;
    const R = r.samples[o], G = colors === 1 ? R : r.samples[o + 1], B = colors === 1 ? R : r.samples[o + 2];
    const A = r.alpha ? r.samples[o + colors] : 255;
    rgba.set([R, G, B, A], i * 4);
    if (R !== G || G !== B || A !== 255) achromatic = false;
  }
  let gray = null;
  if (achromatic) { const g = new Uint8Array(px); for (let i = 0; i < px; i++) g[i] = rgba[i * 4]; gray = sha256(g); }
  return { sha256_rgba: sha256(rgba), sha256_gray: gray };
}

const documents = readJSON(path.join(GOLDEN, 'documents.json')).filter(d => d.source.toLowerCase().endsWith('.pdf'));

// Where the core departs from a recording on purpose (tests/golden/README.md,
// "Departures"): the recording cropped every scan to the 8.5 × 11 ratio; the
// core keeps the whole scan in a pixel space of the scan's own size. scan-tall's
// raster has all 1320 rows (the recorded 1294 are its top rows, exactly), its
// space is its placement at 96 DPI, 816 × 1078, and its thumbnail 180 × 238.
const UNCROPPED = { 'scan-tall': { rows: 1320, pageHeight: 1078, thumbHeight: 238 } };

// The first `rows` rows of a raster (what a cropping recording kept).
const topRows = (r, rows) => ({ ...r, height: rows, samples: r.samples.subarray(0, rows * r.width * r.components) });

for (const d of documents) {
  // a sample that is not in this checkout (tests/samples/ holds a 66 MB one) is skipped, never failed
  const skip = !fs.existsSync(path.join(ROOT, d.source)) && `${d.source} is not here`;
  test(`${d.name}: metadata, rasters and placements equal the goldens`, { skip }, () => {
    const bytes = fs.readFileSync(path.join(ROOT, d.source));
    assert.equal(sha256(bytes), d.sha256, 'the source file is the recorded one');
    const golden = readJSON(path.join(GOLDEN, d.name, 'open-document.json'));
    const pages = readJSON(path.join(GOLDEN, d.name, 'pages.json'));

    const uncropped = UNCROPPED[d.name];
    const pdf = openPdf(mupdf, Module, bytes);
    try {
      const m = pdf.meta();
      assert.deepEqual({
        page_image_type: m.pageImageType, page_width: m.pageWidth, page_height: m.pageHeight,
        num_pages: m.numPages, pdf_fonts: m.pdfFonts, suggested_scale: m.suggestedScale,
        suggested_size: m.suggestedSize, sha256: d.sha256,
      }, uncropped ? { ...golden, page_height: uncropped.pageHeight } : golden);

      for (const n of d.pages) {
        const g = pages[n];
        const raster = pdf.pageRaster(n);
        assert.equal(raster.source, g.raster.source, `page ${n}: source`);
        assert.deepEqual([raster.width, raster.height], [g.image.width, uncropped ? uncropped.rows : g.image.height], `page ${n}: size`);
        assert.deepEqual(pixelHashes(uncropped ? topRows(raster, g.image.height) : raster),
                         { sha256_rgba: g.image.sha256_rgba, sha256_gray: g.image.sha256_gray }, `page ${n}: pixels`);
        assert.deepEqual(raster.rect, g.raster.rect, `page ${n}: rect`);
        assert.deepEqual(pdf.pageImageRect(n), g.raster.text_rect, `page ${n}: text_rect`);
        assert.deepEqual(pdf.pageRect(n), g.raster.page_rect, `page ${n}: page_rect`);
        // the pixel space every page reports: the recorded 816-wide space, as tall as the page's raster shows
        assert.deepEqual(pdf.pageSize(n), { width: golden.page_width, height: uncropped ? uncropped.pageHeight : golden.page_height },
                         `page ${n}: pixel space`);
      }

      // Thumbnails: the golden's size (its pixels are Pillow's LANCZOS — see the README). A PNG that decodes.
      const n = d.pages[0], g = pages[n];
      const png = pdf.pagePNG(n, { thumb: true });
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      const dv = new DataView(png.buffer, png.byteOffset);
      assert.deepEqual([dv.getUint32(16), dv.getUint32(20)], [g.thumb.width, uncropped ? uncropped.thumbHeight : g.thumb.height], 'thumbnail size');

      assert.throws(() => pdf.pageRaster(0), RangeError);
      assert.throws(() => pdf.pageRaster(d.num_pages + 1), RangeError);
    } finally {
      pdf.close();
    }
  });
}

test('the full-size PNG of a page decodes to the golden pixels', () => {
  // MuPDF reads its own PNG back: what the browser will decode from the blob: URL.
  const d = documents.find(x => x.name === 'scan-tall');
  const g = readJSON(path.join(GOLDEN, d.name, 'pages.json'))['1'];
  const pdf = openPdf(mupdf, Module, fs.readFileSync(path.join(ROOT, d.source)));
  try {
    const image = new mupdf.Image(pdf.pagePNG(1));
    const pix = image.toPixmap();
    const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents();
    assert.deepEqual([w, h], [g.image.width, UNCROPPED[d.name].rows]);
    const samples = new Uint8Array(pix.getPixels().subarray(0, w * h * n));
    const shown = topRows({ width: w, height: h, components: n, alpha: false, samples }, g.image.height);
    assert.equal(pixelHashes(shown).sha256_rgba, g.image.sha256_rgba);
    pix.destroy(); image.destroy();
  } finally { pdf.close(); }
});

test('every golden document is in the checkout; only the large samples of tests/samples/ may be left out', () => {
  // a missing document skips its tests: a misspelt `source` skipped 12 of them without a word
  const all = readJSON(path.join(GOLDEN, 'documents.json'));
  const missing = all.filter(d => !fs.existsSync(path.join(ROOT, d.source)));
  assert.deepEqual(missing.filter(d => !d.source.startsWith('tests/samples/')).map(d => d.source), []);
  for (const d of missing) console.log(`# ${d.name}: ${d.source} is not in this checkout — its tests are skipped`);
});
