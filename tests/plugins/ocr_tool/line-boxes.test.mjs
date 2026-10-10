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
  // line 1, `From: "[bar]"`: the bold label, then the regular quotes either
  // side of the bar — a box per face and per side, no separator space
  const [a, b, c] = boxes;
  assert.deepEqual([a.data.text, b.data.text, c.data.text], ['From:', '"', '"']);
  assert.deepEqual([a.data.fontFamily, a.data.bold, a.data.italic, a.data.sizePt], ['Times New Roman', true, false, 12]);
  assert.deepEqual([b.data.fontFamily, b.data.bold, c.data.bold], ['Times New Roman', false, false]);
  assert.equal(a.data.lineId, c.data.lineId);
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

test('an underline is a rule from the baseline to the descent: the line splits where it starts and stops', { skip }, () => {
  // "see the link here": "the link" underlined by a rule 2 px under the baseline
  const L = line('see the link here', [{ ch: 's' }, { ch: 'e' }, { ch: 'e' }, { ch: 't', pen: 136 }, { ch: 'h' }, { ch: 'e' },
    { ch: 'l', pen: 168 }, { ch: 'i' }, { ch: 'n' }, { ch: 'k' }, { ch: 'h', pen: 208 }, { ch: 'e' }, { ch: 'r' }, { ch: 'e' }]);
  const rule = { type: 'rule', x0: 136, y0: 202, x1: 199, y1: 202 };
  const below = { type: 'rule', x0: 100, y0: 212, x1: 240, y1: 212 };           // a separator under the line: not an underline
  const { boxes } = X.pageBoxes(1, { lines: [L], objects: [rule, below] }, { tol: 0 }, opts());
  assert.deepEqual(boxes.map(b => [b.data.text, !!b.data.underline]), [['see', false], ['the link', true], ['here', false]]);
  // the page's rule rides on the box for the pixel view
  assert.deepEqual(boxes[1].ocr.underline, { x0: 136, x1: 200, y0: 202, y1: 202 });
  // a thin slice of a redaction box is the box's, not an underline
  const bar = { type: 'box', x0: 136, y0: 188, x1: 199, y1: 201 };
  const slice = { type: 'rule', x0: 136, y0: 202, x1: 199, y1: 203 };
  assert.equal(X.underlinedEntries(L, [bar, slice]).size, 0);
  // the glyphs' own feet along the baseline row ('ZzZE') are a rule to detectObjects, not an underline
  assert.equal(X.underlinedEntries(L, [{ type: 'rule', x0: 136, y0: 199, x1: 199, y1: 200 }]).size, 0);
  // a rule running on across the column under a heading is a separator
  assert.equal(X.underlinedEntries(L, [{ type: 'rule', x0: 100, y0: 202, x1: 700, y1: 202 }]).size, 0);
});

test('ink: a glyph read through a pen takes the pen\'s colour; one pen\'s run is one colour', { skip }, () => {
  // a 40 × 10 page: glyphs at 0, 8, 16 (red, the third only a lighter stroke) and 24 (black)
  const w = 40, h = 10, rgba = new Uint8ClampedArray(w * h * 4).fill(255), converted = new Uint8Array(w * h);
  const ink = (x, y, c, conv) => { const i = y * w + x; rgba.set(c, i * 4); converted[i] = conv ? 1 : 0; };
  for (let y = 2; y < 8; y++) {
    ink(2, y, [192, 0, 0], 1); ink(3, y, [192, 0, 0], 1);           // fully covered red
    ink(10, y, [192, 0, 0], 1);
    ink(18, y, [208, 64, 64], 1);                                   // the red pen at three quarters coverage
    ink(26, y, [0, 0, 0], 0); ink(27, y, [0, 0, 0], 0);            // black: never converted
  }
  ink(24, 5, [220, 120, 120], 1);                                   // a red overhang into the black glyph's cell
  const L = { text: 'abcd', baseline: 7, top: 0, bot: 9, clean: true, entries: [0, 8, 16, 24].map((pen, i) => ({ i, ch: 'abcd'[i], pen, adv: 8 })) };
  const res = { lines: [L], objects: [] };
  assert.equal(X.inkColours(res, { w, h, converted }, rgba), 3);
  assert.deepEqual(L.entries.map(e => e.ink ?? null), ['#c00000', '#c00000', '#c00000', null]);
  // a black page (nothing converted) inks nothing
  assert.equal(X.inkColours({ lines: [{ ...L, entries: L.entries.map(e => ({ ...e, ink: undefined })) }] }, { w, h, converted: null }, rgba), 0);
});

test('a coloured run is its own box, in its colour; an uncertified line keeps the reader\'s orange', { skip }, () => {
  const L = line('a red word', [{ ch: 'a' }, { ch: 'r', pen: 116 }, { ch: 'e' }, { ch: 'd' }, { ch: 'w', pen: 148 }, { ch: 'o' }, { ch: 'r' }, { ch: 'd' }]);
  for (const e of L.entries.slice(1, 4)) e.ink = '#c00000';
  const { boxes } = X.pageBoxes(1, { lines: [L], objects: [] }, { tol: 0 }, opts());
  assert.deepEqual(boxes.map(b => [b.data.text, b.data.color]), [['a', null], ['red', '#c00000'], ['word', null]]);
  const unclean = X.pageBoxes(1, { lines: [{ ...L, clean: false }], objects: [] }, { tol: 0 }, opts()).boxes;
  assert.ok(unclean.every(b => b.data.color === X.UNCLEAN_COLOR));
});

// a page of OCR boxes for the paragraph detector: [text, x0, x1, baseline, sizePt?, more?] — a 7 px glyph a character
const page = rows => rows.map(([text, x0, x1, bl, sizePt = 12, more = {}], k) => {
  const h = 17, cps = [...text].map((c, i) => ({ c, x: i * 7, w: c === ' ' ? 4 : 7 }));
  return { type: 'ocr', page: 1, lineId: `l${k + 1}`, text, x: x0, w: x1 - x0, y: bl - (h * 0.85 - 1.3), h, sizePt, fontFamily: 'Times New Roman',
    baseCharPositions: cps, ocr: { baseline: bl, spaceAdv: 4 }, ...more };
});

test('paragraphs: word wrap joins full lines, a short line ends one; a list item hangs; a centred line', { skip }, () => {
  // a justified paragraph with a first-line indent (lines at the margin, stretched spaces), then a list item, then a centred line
  const boxes = page([
    ['Title', 380, 436, 100],
    ['aaa bbb ccc ddd', 144, 720, 140], ['eee fff ggg hhh', 96, 720, 158.4], ['iii jj', 96, 300, 176.8],
    ['• kkk lll', 120, 400, 210],
  ]);
  // the justified lines' gaps are wider than the last line's: spread their words over the line
  for (const b of boxes.slice(1, 3)) {
    let x = 0;
    b.baseCharPositions = [...b.text].map(c => { const cp = { c, x, w: c === ' ' ? 0 : 7 }; x += c === ' ' ? 60 : 7; return cp; });
  }
  // the bullet's text starts a tab further
  boxes[4].baseCharPositions = [{ c: '•', x: 0, w: 7 }, { c: ' ', x: 7, w: 17 }, ...[...'kkk lll'].map((c, i) => ({ c, x: 24 + i * 7, w: 7 }))];
  const P = X.paragraphs(boxes, { page: 1, w: 816 });
  assert.deepEqual(P.map(p => p.lines), [['l1'], ['l2', 'l3', 'l4'], ['l5']]);
  assert.deepEqual(P.map(p => p.align), ['center', 'justify', 'left']);
  assert.deepEqual([P[1].leftIndentPt, P[1].firstIndentPt], [0, 36]);
  assert.deepEqual([P[2].list, P[2].leftIndentPt, P[2].firstIndentPt], ['bullet', 36, -18]);
  // 18.4 px between baselines: 13.8 pt (two gaps pooled)
  assert.equal(P[1].leadingPt, 13.8);
});

test('paragraphs: one-line paragraphs with space after stay apart; a line in another face is another paragraph', { skip }, () => {
  // short lines on a page whose column a long line shows (within an inch of the mirrored margin)
  const boxes = page([['short one', 96, 300, 100], ['short two', 96, 280, 124], ['and three', 96, 290, 148], ['a long line further down the page', 96, 700, 300]]);
  assert.equal(X.paragraphs(boxes, { page: 1, w: 816 }).length, 4);
  // two full lines, the second bold: two paragraphs
  const two = page([['a full line of text here', 96, 716, 100], ['another full line', 96, 716, 118.4, 12, { bold: true }]]);
  assert.equal(X.paragraphs(two, { page: 1, w: 816 }).length, 2);
});
