// web/plugins/webgl_mask/mask-core.js against the recorded server masks: for
// every golden PDF page the mask (or its absence) must equal /webgl/mask's,
// pixel for pixel.
//
// One page differs by design — scan-tall, whose raster is taller than 8.5x11:
// the server masked the UNCROPPED embedded image (1000x1320) while the viewer
// shows the cropped raster (1000x1294), so its overlay was stretched. The port
// masks the pixels the viewer shows; its mask must equal the golden's top
// 1294 rows.
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

const Module = { printErr() {} };
globalThis.$libmupdf_wasm_Module = Module;
const mupdf = await import('../web/vendor/mupdf/mupdf.js');
const { openPdf } = await import('../web/core/pdf-document.js');
await import('../web/plugins/webgl_mask/mask-core.js');             // a classic script: defines globalThis.MaskCore
const { buildMask } = globalThis.MaskCore;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// A golden mask PNG → its gray pixels (decoded by MuPDF).
function decodeGray(file) {
  const image = new mupdf.Image(fs.readFileSync(file));
  const pix = image.toPixmap();
  try {
    assert.equal(pix.getNumberOfComponents(), 1);
    const w = pix.getWidth(), h = pix.getHeight(), stride = pix.getStride(), src = pix.getPixels();
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) out.set(src.subarray(y * stride, y * stride + w), y * w);
    return { width: w, height: h, pixels: out };
  } finally { pix.destroy(); image.destroy(); }
}

const documents = readJSON(path.join(GOLDEN, 'documents.json')).filter(d => d.source.toLowerCase().endsWith('.pdf'));

for (const d of documents) {
  // a sample that is not in this checkout (tests/samples/ holds a 66 MB one) is skipped, never failed
  const skip = !fs.existsSync(path.join(ROOT, d.source)) && `${d.source} is not here`;
  test(`${d.name}: masks equal the goldens`, { skip }, () => {
    const pages = readJSON(path.join(GOLDEN, d.name, 'pages.json'));
    const pdf = openPdf(mupdf, Module, fs.readFileSync(path.join(ROOT, d.source)));
    try {
      let withMask = 0;
      for (const n of d.pages) {
        const g = pages[n].mask;
        const raster = pdf.pageRaster(n, { gray: true });
        assert.equal(raster.components, 1);
        // The server masked pages that carry an image; a page shown as a render has none.
        const mask = raster.source === 'embedded' ? buildMask(raster.samples, raster.width, raster.height) : null;
        assert.equal(mask ? 200 : 204, g.status, `page ${n}: has a mask`);
        if (!mask) continue;
        withMask++;
        if (raster.height === g.height) {
          assert.deepEqual([raster.width, raster.height], [g.width, g.height], `page ${n}: size`);
          assert.equal(sha256(mask), g.sha256_gray, `page ${n}: mask pixels`);
        } else {
          const golden = decodeGray(path.join(GOLDEN, d.name, g.file));
          assert.equal(d.name, 'scan-tall', `page ${n}: only the tall scan may differ in height`);
          assert.equal(raster.width, golden.width);
          assert.ok(raster.height < golden.height);
          assert.equal(sha256(mask), sha256(golden.pixels.subarray(0, raster.width * raster.height)), `page ${n}: the golden's top rows`);
        }
      }
      if (d.name !== 'vector') assert.ok(withMask > 0, 'the document has masks');
    } finally { pdf.close(); }
  });
}

// Nothing is filled: where the bars of adjacent lines touch they are one
// component that encloses the white gaps between them — those stay page.
test('an enclosed gap is not masked', () => {
  const w = 120, h = 80, gray = new Uint8Array(w * h).fill(255);
  const bar = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) gray[y * w + x] = 0; };
  bar(10, 10, 110, 30);                                  // line 1, one bar
  bar(10, 30, 50, 50); bar(60, 30, 110, 50);             // line 2, two bars with a gap
  bar(10, 50, 110, 70);                                  // line 3 closes the gap in
  gray[40 * w + 55] = 40;                                // a semicolon's worth of ink in the gap
  const mask = buildMask(gray, w, h);
  assert.equal(mask[20 * w + 55], 255, 'the bar is masked');
  for (let y = 32; y < 48; y++) for (let x = 52; x < 58; x++) assert.notEqual(mask[y * w + x], 255, `gap pixel ${x},${y}`);
  assert.equal(mask[40 * w + 55], 0, 'the ink in the gap is clear of the mask and its rings');
});

test('grayOf keeps black at 0 and white at 255', () => {
  const gray = globalThis.MaskCore.grayOf(Uint8ClampedArray.from([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255]));
  assert.deepEqual([...gray], [0, 255, 76]);
});
