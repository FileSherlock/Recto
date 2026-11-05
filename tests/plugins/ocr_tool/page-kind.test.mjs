// Which pages the reader reads (web/plugins/ocr_tool/page-kind.js): pages of
// paper and ink, not photographs. Every golden PDF page is one, sampled as
// ocr-tool.js samples it (a nearest-neighbour copy of at most 600 px); the
// golden test image of coloured shapes is not. Skipped when the plugin is not
// installed.
//
//   node --test tests/plugins/ocr_tool/page-kind.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const FILE = path.join(ROOT, 'web', 'plugins', 'ocr_tool', 'page-kind.js');
const skip = !fs.existsSync(FILE) && 'plugin not installed';
if (!skip) await import(pathToFileURL(FILE).href);   // a classic script: defines globalThis.OCRPageKind
const K = globalThis.OCRPageKind;

// a w × h page of one gray level, with rectangles of others: RGBA
function page(w, h, bg, rects = [], alpha = 255) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([bg, bg, bg, alpha], i * 4);
  for (const r of rects) for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) px.set([r.v, r.v, r.v, 255], (y * w + x) * 4);
  return px;
}
// what ocr-tool.js judges: a nearest-neighbour copy of at most 600 px on the long side
function copyOf(samples, w, h, n) {
  const k = Math.min(1, 600 / Math.max(w, h)), cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const i = (Math.min(h - 1, Math.floor(y / k)) * w + Math.min(w - 1, Math.floor(x / k))) * n, o = (y * cw + x) * 4;
    out[o] = samples[i]; out[o + 1] = samples[n >= 3 ? i + 1 : i]; out[o + 2] = samples[n >= 3 ? i + 2 : i]; out[o + 3] = 255;
  }
  return [out, cw, ch];
}

test('paper and ink are a document; a dark picture, a photograph\'s mid-tones and a transparent image are not', { skip }, () => {
  const lines = Array.from({ length: 30 }, (_, i) => ({ x0: 40, x1: 360, y0: 20 + i * 18, y1: 28 + i * 18, v: 0 }));
  assert.equal(K.judge(page(400, 560, 255, lines), 400, 560).document, true, 'a page of text');
  // two-thirds redaction bars (the corpus's most redacted page: 0.365 paper)
  const bars = Array.from({ length: 27 }, (_, i) => ({ x0: 20, x1: 380, y0: 10 + i * 20, y1: 24 + i * 20, v: 0 }));
  assert.equal(K.judge(page(400, 560, 255, bars), 400, 560).document, true, 'a page of redaction bars');
  assert.equal(K.judge(page(400, 560, 218, lines), 400, 560).document, true, 'yellowed paper is paper');
  assert.equal(K.judge(page(400, 560, 0), 400, 560).document, false, 'all black: nothing to read');
  assert.equal(K.judge(page(400, 560, 0, [], 0), 400, 560).document, false, 'transparent: the reader takes it for black');
  const mid = new Uint8ClampedArray(400 * 560 * 4);
  for (let i = 0; i < 400 * 560; i++) { const v = 90 + ((i * 2654435761) >>> 24) % 120; mid.set([v, v * 0.9, v * 0.8, 255], i * 4); }
  assert.equal(K.judge(mid, 400, 560).document, false, 'a photograph\'s mid-tones');
});

test('every golden PDF page is paper and ink; the golden image of coloured shapes is not', { skip }, async () => {
  const Module = { printErr() {} };
  globalThis.$libmupdf_wasm_Module = Module;
  const mupdf = await import(pathToFileURL(path.join(ROOT, 'web', 'vendor', 'mupdf', 'mupdf.js')).href);
  const { openPdf } = await import(pathToFileURL(path.join(ROOT, 'web', 'core', 'pdf-document.js')).href);
  const docs = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'golden', 'documents.json'), 'utf8'));
  let judged = 0;
  for (const d of docs.filter(d => d.source.endsWith('.pdf') && fs.existsSync(path.join(ROOT, d.source)))) {
    const pdf = openPdf(mupdf, Module, fs.readFileSync(path.join(ROOT, d.source)));
    try {
      for (const n of d.pages) {
        const r = pdf.pageRaster(n);
        const v = K.judge(...copyOf(r.samples, r.width, r.height, r.components));
        assert.equal(v.document, true, `${d.name} page ${n}: ${JSON.stringify(v)}`);
        judged++;
      }
    } finally { pdf.close(); }
  }
  assert.ok(judged >= 30, `${judged} pages`);
  const img = new mupdf.Image(fs.readFileSync(path.join(ROOT, 'tests', 'golden', '_inputs', 'image.png')));
  const pix = img.toPixmap();
  try {
    const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents(), stride = pix.getStride(), src = pix.getPixels();
    const s = new Uint8Array(w * h * n);
    for (let y = 0; y < h; y++) s.set(src.subarray(y * stride, y * stride + w * n), y * w * n);
    assert.equal(K.judge(...copyOf(s, w, h, n)).document, false);
  } finally { pix.destroy(); img.destroy(); }
});
