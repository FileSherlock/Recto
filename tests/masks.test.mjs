// web/plugins/webgl_mask/mask-core.js, in two halves.
//
// DETECTION: for every golden PDF page the blacked-out regions (or their
// absence) must equal the recorded mask's 255 pixels. One page differs by
// design — scan-tall, whose raster is taller than 8.5x11: the recorded mask
// covers the UNCROPPED embedded image (1000x1320) while the viewer shows the
// cropped raster (1000x1294); mask-core masks the pixels the viewer shows, so
// its regions must equal the golden's top 1294 rows.
//
// The EDGES are not held to the recordings (their two rings left corners,
// overlapping rims and flush boxes behind — guide/frontend/webgl-mask.md).
// They are held to pages built here, where the truth is known: a box's rim
// must come off, and whatever could be text under or beside it must stay.
//
//   node --test tests/*.test.mjs

import assert from 'node:assert/strict';
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
const { buildMask, regions, grayOf } = globalThis.MaskCore;

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
  test(`${d.name}: regions equal the goldens`, { skip }, () => {
    const pages = readJSON(path.join(GOLDEN, d.name, 'pages.json'));
    const pdf = openPdf(mupdf, Module, fs.readFileSync(path.join(ROOT, d.source)));
    try {
      let withMask = 0;
      for (const n of d.pages) {
        const g = pages[n].mask;
        const raster = pdf.pageRaster(n, { gray: true });
        assert.equal(raster.components, 1);
        // A page that carries a scan has a mask; a page shown as a render has none.
        const map = raster.source === 'embedded' ? regions(raster.samples, raster.width, raster.height) : null;
        assert.equal(map ? 200 : 204, g.status, `page ${n}: has a mask`);
        if (!map) continue;
        withMask++;
        const golden = decodeGray(path.join(GOLDEN, d.name, g.file));
        assert.equal(raster.width, golden.width, `page ${n}: width`);
        if (raster.height !== golden.height) {
          assert.equal(d.name, 'scan-tall', `page ${n}: only the tall scan may differ in height`);
          assert.ok(raster.height < golden.height);
        }
        // Region ⇔ 255 in the recording. The recording's rings could reach 255 as well, where a ring ran over
        // black page pixels only: those are not region, and black.
        let strays = 0;
        for (let p = 0; p < raster.width * raster.height; p++) {
          if (map[p]) assert.equal(golden.pixels[p], 255, `page ${n}: region pixel ${p} is 255 in the golden`);
          else if (golden.pixels[p] === 255) { strays++; assert.equal(raster.samples[p], 0, `page ${n}: pixel ${p}, 255 in the golden, is a black ring pixel`); }
        }
        assert.ok(strays <= 4, `page ${n}: ${strays} ring pixels at 255`);
      }
      if (d.name !== 'vector') assert.ok(withMask > 0, 'the document has masks');
    } finally { pdf.close(); }
  });
}

// ── pages built here ──────────────────────────────────────────────────────────
// A white page; boxes are black rectangles [x0, x1) × [y0, y1) with a rim: per
// side the share of the page each rim line hides, outward ({ l: [0.9], t: [0.98, 0.4] }
// is one line left, two on top). A rim covers ax · ay of a corner pixel, and
// boxes multiply — what the corpus pages show. Ink goes under the boxes.
function makePage(w, h) {
  const paper = new Float32Array(w * h).fill(255), t = new Float32Array(w * h).fill(1);
  const ink = (x, y, v = 0) => { paper[y * w + x] = v; };
  const box = (x0, y0, x1, y1, rim = {}) => {
    const cover = (lo, hi, before, after, size) => {
      const c = new Float32Array(size);
      for (let i = lo; i < hi; i++) c[i] = 1;
      (before || []).forEach((a, k) => { if (lo - 1 - k >= 0) c[lo - 1 - k] = a; });
      (after || []).forEach((a, k) => { if (hi + k < size) c[hi + k] = a; });
      return c;
    };
    const cx = cover(x0, x1, rim.l, rim.r, w), cy = cover(y0, y1, rim.t, rim.b, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) t[y * w + x] *= 1 - cx[x] * cy[y];
  };
  const render = () => {
    const gray = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) gray[p] = Math.round(paper[p] * t[p]);
    return gray;
  };
  return { ink, box, render, paper };
}
// The fragment shader at full strength.
function reveal(gray, mask) {
  const out = new Uint8Array(gray.length);
  for (let p = 0; p < gray.length; p++) {
    const m = mask[p] / 255;
    out[p] = m > 0.999 ? 255 : Math.min(255, Math.round(gray[p] / Math.max(1 - m, 0.001)));
  }
  return out;
}
const W = 160, H = 120;
const RIM = { l: [0.91], r: [0.9], t: [0.98, 0.6], b: [0.26] };

test('a box and its rim come off: sides, the second top line, the corner blocks', () => {
  const page = makePage(W, H);
  page.box(30, 40, 130, 60, RIM);
  const gray = page.render(), out = reveal(gray, buildMask(gray, W, H));
  assert.ok(gray[38 * W + 80] < 110 && gray[39 * W + 80] < 8, 'the page has a two-line rim on top');
  for (let p = 0; p < W * H; p++) assert.ok(out[p] >= 250, `pixel ${p % W},${(p / W) | 0} is white (${out[p]})`);
});

test('ink under a rim and beside it stays', () => {
  const page = makePage(W, H);
  page.box(30, 40, 130, 60, RIM);
  const marks = [];
  for (const x of [50, 51, 90]) for (const y of [36, 37, 38, 39]) marks.push([x, y]);      // strokes running into the top rim
  for (const y of [45, 46, 47]) for (const x of [26, 27, 28, 29]) marks.push([x, y]);      // … and into the left one
  marks.push([131, 50], [132, 50], [133, 50]);                                             // a semicolon's worth right of the box
  for (const [x, y] of marks) page.ink(x, y, 20);
  const gray = page.render(), out = reveal(gray, buildMask(gray, W, H));
  for (const [x, y] of marks) {
    if (gray[y * W + x] === 0 && page.paper[y * W + x] > 0 && y === 39) continue;          // under the 98 % line ink and rim both read 0..4
    assert.ok(out[y * W + x] <= 60, `ink at ${x},${y} stays dark (${out[y * W + x]})`);
  }
  assert.ok(out[38 * W + 70] >= 250 && out[50 * W + 29] >= 250, 'the rim between the strokes is white');
});

test('two boxes flush in one column: each piece of the side loses its own rim', () => {
  const page = makePage(W, H);
  page.box(30, 20, 120, 40, { l: [0.06], t: [0.3], r: [0.5], b: [0.2] });
  page.box(30, 39, 100, 60, { l: [0.98, 0.41], t: [0.6], r: [0.5], b: [0.2] });
  const gray = page.render(), out = reveal(gray, buildMask(gray, W, H));
  for (let y = 22; y < 58; y++) for (const x of [28, 29]) assert.ok(out[y * W + x] >= 250, `left rim at ${x},${y} is white (${out[y * W + x]})`);
});

test('a flat stroke under a rim is not taken for a second box', () => {
  const page = makePage(W, H);
  page.box(30, 40, 130, 60, RIM);
  for (let x = 70; x < 79; x++) page.ink(x, 60, 90);                                       // the bar of a T, flat along the bottom rim
  const gray = page.render(), out = reveal(gray, buildMask(gray, W, H));
  for (let x = 70; x < 79; x++) assert.ok(out[60 * W + x] <= 100, `the bar at ${x} stays (${out[60 * W + x]})`);
  assert.ok(out[60 * W + 50] >= 250 && out[60 * W + 110] >= 250, 'the rim beside it is white');
});

test('a stem standing against the box is not taken for a rim', () => {
  const page = makePage(W, H);
  page.box(30, 40, 130, 60, RIM);
  for (let y = 40; y < 52; y++) { page.ink(130, y, 120); page.ink(131, y, 0); page.ink(132, y, 120); }   // an l, flush right, from the box's top down
  const gray = page.render(), out = reveal(gray, buildMask(gray, W, H));
  for (let y = 41; y < 51; y++) {
    assert.ok(out[y * W + 131] <= 10, `the stem at row ${y} stays black (${out[y * W + 131]})`);
    assert.ok(out[y * W + 130] <= 140, `its fringe under the rim stays (${out[y * W + 130]})`);
  }
  assert.ok(out[56 * W + 130] >= 250, 'the rim below the stem is white');
});

test('one pixel is no evidence: a single-pixel step keeps what lies on it', () => {
  const page = makePage(W, H);
  page.box(30, 40, 130, 60, { t: [0.5], l: [0.5] });
  page.box(29, 50, 60, 70, { l: [0.5] });                                                  // one column further left: a 1-px step at (29, 49)
  page.ink(29, 49, 40);                                                                    // (black ink there would be the boxes' own notch, filled)
  const gray = page.render(), out = reveal(gray, buildMask(gray, W, H));
  assert.ok(out[49 * W + 29] <= 60, `the ink on the step stays (${out[49 * W + 29]})`);
});

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
  for (let y = 32; y < 48; y++) for (let x = 52; x < 58; x++) assert.equal(mask[y * w + x], 0, `gap pixel ${x},${y}`);
});

test('grayOf keeps black at 0 and white at 255', () => {
  const gray = grayOf(Uint8ClampedArray.from([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255]));
  assert.deepEqual([...gray], [0, 255, 76]);
});
