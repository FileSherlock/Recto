// Which of the reader's boxes are redactions (web/plugins/ocr_tool/box-rules.js):
// black, and where the text is. The geometry below is the corpus's (line pitch
// 15–18 rows, bands 11–16 rows tall, bars 14–21 rows tall); the cases are what
// the rules were written for. Skipped when the plugin is not installed.
//
//   node --test tests/plugins/ocr_tool/box-rules.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, '..', '..', '..', 'web', 'plugins', 'ocr_tool', 'box-rules.js');
const skip = !fs.existsSync(FILE) && 'plugin not installed';
if (!skip) await import(FILE);                     // a classic script: defines globalThis.OCRBoxRules
const R = globalThis.OCRBoxRules;

// a white page with black (or gray) rectangles painted on it
function page(w, h, rects) {
  const gray = new Uint8Array(w * h).fill(255);
  for (const r of rects) for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) gray[y * w + x] = r.v ?? 0;
  return { w, h, gray };
}
const box = (x0, y0, x1, y1) => ({ type: 'box', x0, y0, x1, y1 });
// text rows every `pitch` rows from `first`: a band 11 rows above the baseline to 3 below
const rows = (n, first = 60, pitch = 18) => Array.from({ length: n }, (_, i) => ({ baseline: first + i * pitch, top: first + i * pitch - 11, bot: first + i * pitch + 3 }));

test('blackness: the interior one pixel in from every side', { skip }, () => {
  const p = page(200, 200, [{ x0: 20, y0: 20, x1: 120, y1: 40 }, { x0: 20, y0: 100, x1: 120, y1: 120, v: 128 }]);
  assert.equal(R.blackness(p, box(20, 20, 120, 40)), 1);
  assert.equal(R.blackness(p, box(20, 100, 120, 120)), 0);                    // grey
  assert.equal(R.blackness(p, box(20, 20, 120, 22)), 1);                     // too thin to have an interior: the reader's word
  const holed = page(200, 200, [{ x0: 20, y0: 20, x1: 120, y1: 40 }, { x0: 60, y0: 25, x1: 80, y1: 35, v: 255 }]);
  assert.ok(R.blackness(holed, box(20, 20, 120, 40)) < 0.9);                 // a white hole: not a redaction
});

test('grid: distinct rows and their pitch, or nothing to trust', { skip }, () => {
  assert.equal(R.grid(rows(7)), null);
  assert.deepEqual(R.grid(rows(8)), { rows: 8, pitch: 18 });
  // a line's segments share a baseline and count once; a baseline a pixel off is the same row
  const segs = rows(10).flatMap(L => [L, { ...L, baseline: L.baseline + 1 }, L]);
  assert.deepEqual(R.grid(segs), { rows: 10, pitch: 18 });
  assert.equal(R.grid([]), null);
});

test('anchoring: overlap with a line band, distance to the nearest one', { skip }, () => {
  const lines = rows(10);                                                     // baselines 60, 78, … bands [49, 63], [67, 81], …
  assert.deepEqual(R.anchoring(lines, box(100, 47, 300, 66)), { onLine: 14 / 19, gap: 0 });   // a bar on the first row
  assert.deepEqual(R.anchoring(lines, box(100, 64, 300, 66)), { onLine: 0, gap: 1 });         // in the gap between rows
  assert.deepEqual(R.anchoring([], box(100, 64, 300, 66)), { onLine: 0, gap: Infinity });
});

test('verdicts on a text page', { skip }, () => {
  const lines = rows(12);                                                     // pitch 18: rows at 60 … 258
  const rects = [
    { x0: 100, y0: 47, x1: 300, y1: 66 },       // a bar on the first row (its other words read)
    { x0: 100, y0: 137, x1: 400, y1: 156 },     // a bar over the whole sixth row (i = 5, band 139–153; nothing read there)
    { x0: 100, y0: 155, x1: 400, y1: 210 },     // a block over rows 7–9 (i = 6…8)
    { x0: 40, y0: 64, x1: 500, y1: 70 },        // a 6-row black rule between two rows
    { x0: 100, y0: 320, x1: 300, y1: 470 },     // a black plate 60 rows below the last row
    { x0: 10, y0: 40, x1: 20, y1: 260 },        // a page border along the text
    { x0: 300, y0: 137, x1: 330, y1: 156 },     // a one-word bar, narrow but one line tall
    { x0: 100, y0: 300, x1: 300, y1: 320, v: 96 }, // a grey cell
  ];
  const p = page(600, 500, rects);
  const lineRows = lines.filter((_, i) => i < 5 || i > 8);                  // rows 6–9 (i = 5…8) went under the bars
  const v = (r, l = lineRows) => R.verdict(p, l, box(r.x0, r.y0, r.x1, r.y1));
  assert.equal(v(rects[0]).keep, true);
  assert.equal(v(rects[1]).keep, true);                                       // grid: a line 3 rows below, one line tall
  assert.equal(v(rects[2]).keep, true);                                       // grid: a block of lines
  // the rule touches the second row's band by half its height — a bar is never this short
  assert.deepEqual([v(rects[3]).keep, v(rects[3]).why], [false, 'shorter than a line']);
  assert.deepEqual([v(rects[4]).keep, v(rects[4]).why], [false, 'away from the text']);
  assert.deepEqual([v(rects[5]).keep, v(rects[5]).why], [false, 'narrow and taller than a line']);
  assert.equal(v(rects[6]).keep, true);
  assert.deepEqual([v(rects[7]).keep, v(rects[7]).why], [false, 'not black']);
  // without a grid every black box stays — a page the reader could not read, an image
  assert.equal(v(rects[4], rows(3)).keep, true);
  assert.equal(v(rects[3], []).keep, true);
  assert.equal(v(rects[7], []).keep, false);
});

test('the corpus bars stay: measured overlaps, gaps and heights', { skip }, () => {
  // (onLine, gap, height / pitch) of every real bar on the corpus pages, 2026-09-22
  const measured = [[0.63, 6, 1.27], [0.67, 1, 1.0], [0.47, 0, 1.27], [0.79, 3, 1.27], [0.84, 0, 1.27], [0.8, 3, 1.0],
    [0.84, 2, 1.06], [0.74, 2, 1.06], [0.71, 21, 0.94], [0.57, 3, 1.17], [0.75, 4, 1.11], [0.52, 4, 1.17],
    [0.59, 6, 0.94], [0.5, 10, 0.89], [0.55, 2, 1.11], [0.55, 3, 1.11], [0.57, 0, 0.78], [0.47, 0, 0.94]];
  const pitch = 18;
  for (const [onLine, gap, hPitch] of measured) {
    const h = Math.round(hPitch * pitch), y0 = 200, y1 = y0 + h;
    // one line band placed to give this overlap, the nearest other band `gap` rows below
    const lines = [...rows(10, 20), { top: y0 - Math.round(h * (1 - onLine)) - 0, bot: y0 + Math.round(h * onLine), baseline: y0 + Math.round(h * onLine) - 3 },
      { top: y1 + gap, bot: y1 + gap + 14, baseline: y1 + gap + 11 }];
    const p = page(600, 500, [{ x0: 100, y0, x1: 300, y1 }]);
    const v = R.verdict(p, lines, box(100, y0, 300, y1));
    assert.equal(v.keep, true, `bar with onLine ${onLine}, gap ${gap}, h/pitch ${hPitch}: ${v.why}`);
  }
});

test('filter: the boxes of a read, the rest untouched, the dropped ones explained', { skip }, () => {
  const p = page(600, 500, [{ x0: 100, y0: 47, x1: 300, y1: 66 }, { x0: 40, y0: 64, x1: 500, y1: 70 }]);
  const objects = [box(100, 47, 300, 66), { type: 'rule', x0: 0, y0: 400, x1: 600, y1: 402 }, box(40, 64, 500, 70)];
  const { kept, dropped } = R.filter(p, rows(12), objects);
  assert.deepEqual(kept, [objects[0], objects[1]]);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].why, 'shorter than a line');
  assert.deepEqual([dropped[0].x0, dropped[0].y0, dropped[0].x1, dropped[0].y1, dropped[0].black], [40, 64, 500, 70, 1]);
});
