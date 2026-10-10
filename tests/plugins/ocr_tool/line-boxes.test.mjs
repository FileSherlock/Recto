// A page's read becomes text boxes (web/plugins/ocr_tool/line-boxes.js): one
// box per line segment at the reader's pens, a □ marker per unread band, a
// redaction box per detected bar — replayed here from the startup document's
// shipped read (web/plugins/ocr_tool/cache/), the boxes every visitor sees,
// and from small lines made up for the cases that document does not have.
// Skipped when the plugin is not installed.
//
//   node --test tests/plugins/ocr_tool/line-boxes.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, '..', '..', '..', 'web', 'plugins', 'ocr_tool');
const FILE = path.join(PLUGIN, 'line-boxes.js');
const CACHE = path.join(PLUGIN, 'cache', '2da97a0ae0a3285da3f28712ee17123ddd4b7754a971277575c8c64e6e417957.json');
const skip = !fs.existsSync(FILE) && 'plugin not installed';
let X, SET_FONTS, boxBetween;
if (!skip) {
  await import(pathToFileURL(FILE).href);           // a classic script: defines globalThis.OCRLineBoxes
  X = globalThis.OCRLineBoxes;
  const require = createRequire(import.meta.url);
  SET_FONTS = require(path.join(PLUGIN, 'engine', 'set-fonts.js'));
  ({ boxBetween } = require(path.join(PLUGIN, 'engine', 'blindocr.js')));
}
const opts = () => ({ setFonts: SET_FONTS, boxBetween });
const cached = () => JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const allBoxes = data => data.pages.flatMap(pg => X.pageBoxes(pg.page, pg.res, pg.pass, opts()).boxes);

test('the startup document: a box per segment at the pens, the bars split the lines', { skip }, () => {
  const data = cached();
  const p1 = data.pages[0];
  const { boxes, tally } = X.pageBoxes(1, p1.res, p1.pass, opts());
  assert.deepEqual(tally, { lines: 54, clean: 54, unread: 0, boxes: 3 });
  // line 1, `From: "[bar]"`: two boxes, no separator space, the bold Times header face
  const [a, b] = boxes;
  assert.deepEqual([a.data.text, b.data.text], ['From: "', '"']);
  assert.deepEqual([a.data.fontFamily, a.data.bold, a.data.italic, a.data.sizePt], ['Times New Roman', true, false, 12]);
  assert.equal(a.data.lineId, b.data.lineId);
  assert.equal(a.data.x, 76.75);                                      // the first pen, as measured
  assert.equal(a.data.color, null);                                   // clean: the type's own colour
  assert.deepEqual([a.ocr.clean, a.ocr.trusted, a.ocr.font, a.ocr.baseline], [true, true, 'timesbd16', 68]);
  // the box is placed so the renderer's baseline (y + h·0.85 − 1.3) is the measured one
  assert.ok(Math.abs(a.data.y + a.data.h * 0.85 - 1.3 - 68) < 1e-9);
  const bars = boxes.filter(s => s.data.type === 'redaction');
  assert.equal(bars.length, 3);
  for (const s of bars) assert.deepEqual(s.ink, { x0: s.data.x, x1: s.data.x + s.data.w });
});

test('every segment: one position per character, rising, the text its line\'s', { skip }, () => {
  const data = cached();
  for (const pg of data.pages) {
    const { boxes } = X.pageBoxes(pg.page, pg.res, pg.pass, opts());
    const lines = new Map();
    for (const s of boxes.filter(s => s.data.type === 'ocr')) {
      const cps = s.data.baseCharPositions;
      assert.equal(cps.length, s.data.text.length, `${s.data.lineId}: ${s.data.text}`);
      for (let i = 1; i < cps.length; i++) assert.ok(cps[i].x >= cps[i - 1].x, `${s.data.lineId} rises at ${i}`);
      assert.equal(cps[0].x, 0);
      // the segments of a line, joined by the one separator the transcript has per bar, are the line
      lines.set(s.data.lineId, [...(lines.get(s.data.lineId) || []), s.data.text]);
    }
    pg.res.lines.forEach((L, i) => assert.equal(lines.get(`ocr_p${pg.page}_l${i + 1}`).join(' '), L.text));
  }
});

test('the document names its face: Courier New 9.75 pt, the body', { skip }, () => {
  const boxes = allBoxes(cached()).map(s => ({ ...s.data, ocr: s.ocr }));
  assert.equal(X.readIsWeak(boxes), false);
  assert.deepEqual(X.dominantTypography(boxes), { fontFamily: 'Courier New', sizePt: 9.75 });
});

test('the law is learned per set, from the clean lines\' own glyphs', { skip }, () => {
  const p1 = cached().pages[0];
  const inputs = X.lawInputs(p1.res);
  assert.deepEqual([...inputs.keys()].sort(), ['cour13', 'times16', 'timesbd16']);
  for (const [name, { sizePx, lines }] of inputs) {
    assert.ok(sizePx > 0 && lines.length > 0, name);
    for (const L of lines) for (const e of L.entries) assert.ok((e.src || name) === name && e.ch !== '□');
  }
});

// a made-up line: entries {i, ch, pen, adv, src?} and the text lineEntries wrote for them
const set = { maxAsc: 13, maxDesc: 4, sizePx: 16 };
function line(text, glyphs, more = {}) {
  let i = 0, pen = 100;
  const entries = [];
  for (const g of glyphs) {
    const at = text.indexOf(g.ch === 'ﬁ' ? 'fi' : g.ch, i);
    entries.push({ i: at, ch: g.ch, pen: g.pen ?? pen, adv: g.adv ?? 8, ...(g.src ? { src: g.src } : {}) });
    i = at + (g.ch === 'ﬁ' ? 2 : 1); pen = (g.pen ?? pen) + (g.adv ?? 8);
  }
  return { text, font: 'times16', baseline: 200, top: 186, bot: 204, phy: 0, clean: true, residual: 0, fails: [], boxes: [], set, entries, ...more };
}

test('an unread band is a red □ at its ink; an unclean line is orange', { skip }, () => {
  const res = { lines: [
    { text: '', font: null, baseline: 300, top: 290, bot: 305, fails: [120], boxes: [], set: null, entries: [] },
    line('ab', [{ ch: 'a' }, { ch: 'b' }], { clean: false, fails: [140] }),
  ], objects: [] };
  const { boxes, tally } = X.pageBoxes(3, res, { tol: 0 }, opts());
  assert.deepEqual(tally, { lines: 1, clean: 0, unread: 1, boxes: 0 });
  assert.deepEqual([boxes[0].data.text, boxes[0].data.x, boxes[0].data.y, boxes[0].data.color], ['□', 120, 290, X.UNREAD_COLOR]);
  assert.deepEqual(boxes[0].ocr, { clean: false, unread: true });
  assert.deepEqual([boxes[1].data.color, boxes[1].ocr.clean, boxes[1].ocr.trusted, boxes[1].ocr.fails], [X.UNCLEAN_COLOR, false, false, 1]);
});

test('a ligature is one glyph and two letters; a union line takes its majority face', { skip }, () => {
  const res = { lines: [
    line('fit', [{ ch: 'ﬁ', adv: 9 }, { ch: 't' }]),
    line('Re: ok', [{ ch: 'R', src: 'timesbd16' }, { ch: 'e', src: 'timesbd16' }, { ch: ':', src: 'timesbd16' },
      { ch: 'o', pen: 140, src: 'times16' }, { ch: 'k', src: 'times16' }], { font: 'timesbd16+times16' }),
  ], objects: [] };
  const { boxes } = X.pageBoxes(1, res, { tol: 0, union: true }, opts());
  // the text keeps the letters; the positions mark the pair for a pixel renderer
  assert.equal(boxes[0].data.text, 'fit');
  const [f, i] = boxes[0].data.baseCharPositions;
  assert.deepEqual([f.c, f.lig, f.w, i.c, i.ligTail, i.x], ['f', 'ﬁ', 4.5, 'i', true, 4.5]);
  assert.deepEqual([boxes[1].data.fontFamily, boxes[1].data.bold], ['Times New Roman', true]);   // 3 of 5 glyphs bold
  assert.equal(boxes[1].ocr.union, true);
});

test('trusted: one letter at ±2 or better, three on a looser rung', { skip }, () => {
  const res = { lines: [line('a .', [{ ch: 'a' }, { ch: '.', pen: 120 }]), line('abc', [{ ch: 'a' }, { ch: 'b' }, { ch: 'c' }])], objects: [] };
  const at = tol => X.pageBoxes(1, res, { tol }, opts()).boxes.map(s => s.ocr.trusted);
  assert.deepEqual(at(2), [true, true]);
  assert.deepEqual(at(10), [false, true]);
});

test('a weak read names no face', { skip }, () => {
  const box = (lineId, trusted) => ({ type: 'ocr', lineId, text: 'abc', fontFamily: 'Cambria', sizePt: 12, ocr: { clean: trusted, trusted } });
  assert.equal(X.dominantTypography([box('a', true), box('b', true)]), null);                     // under 3 certified lines
  assert.equal(X.dominantTypography([box('a', true), box('b', true), box('c', true), ...['d', 'e', 'f', 'g'].map(l => box(l, false))]), null);
  assert.deepEqual(X.dominantTypography([box('a', true), box('b', true), box('c', true), box('d', false)]), { fontFamily: 'Cambria', sizePt: 12 });
});
