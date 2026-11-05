// web/plugins/text_tool/story-core.js — the rich-text model of Artistic and
// Frame text — and the face metrics shaping.js reports for it.
//
//   node --test "tests/**/*.test.mjs"

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from '../tools/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PLUGIN = path.join(ROOT, 'web', 'plugins', 'text_tool');
const skip = !fs.existsSync(path.join(PLUGIN, 'story-core.js')) && 'text_tool not installed';

if (!skip) await import('../web/plugins/text_tool/story-core.js');     // a classic script: defines globalThis.StoryCore
const SC = globalThis.StoryCore;
const LB = String.fromCharCode(0x2028);
const pos = (p, o) => ({ p, o });
const range = (a, b) => ({ start: a, end: b });

test('plain text becomes paragraphs; the story gives the same text back', { skip }, () => {
  const s = SC.fromText(`one\ntwo${LB}two b\n\nfour`, { sizePt: 10 });
  assert.equal(s.paragraphs.length, 4);
  assert.equal(SC.paraText(s.paragraphs[1]), `two${LB}two b`);
  assert.equal(SC.toText(s), 'one\ntwo\ntwo b\n\nfour');
  assert.deepEqual(s.paragraphs[2].runs, [{ text: '', attrs: { sizePt: 10 } }]);
});

test('attributes are stored as overrides of the defaults', { skip }, () => {
  assert.deepEqual(SC.clean({ bold: false, sizePt: 12, tracking: 50, nonsense: 1 }, SC.CHAR_DEFAULTS), { tracking: 50 });
  assert.deepEqual(SC.clean({ tabs: [] }, SC.PARA_DEFAULTS), {});
  assert.deepEqual(SC.clean({ tabs: [{ pos: 72, align: 'right' }] }, SC.PARA_DEFAULTS), { tabs: [{ pos: 72, align: 'right' }] });
});

test('character attributes onto a range split the runs, and merge back', { skip }, () => {
  let s = SC.fromText('Hello world');
  s = SC.applyChar(s, range(pos(0, 6), pos(0, 11)), { bold: true });
  assert.deepEqual(s.paragraphs[0].runs, [{ text: 'Hello ', attrs: {} }, { text: 'world', attrs: { bold: true } }]);
  s = SC.applyChar(s, range(pos(0, 6), pos(0, 11)), { bold: false });
  assert.deepEqual(s.paragraphs[0].runs, [{ text: 'Hello world', attrs: {} }]);
});

test('across paragraphs, and to the whole story including its empty paragraphs', { skip }, () => {
  let s = SC.fromText('ab\n\ncd');
  s = SC.applyChar(s, range(pos(0, 1), pos(2, 1)), { italic: true });
  assert.deepEqual(s.paragraphs.map(p => p.runs.map(r => [r.text, !!r.attrs.italic])),
    [[['a', false], ['b', true]], [['', false]], [['c', true], ['d', false]]]);
  s = SC.applyChar(s, null, { sizePt: 20 });
  assert.ok(s.paragraphs.every(p => p.runs.every(r => r.attrs.sizePt === 20)));
});

test('the attributes over a range, with the keys that are mixed in it', { skip }, () => {
  let s = SC.fromText('Hello world');
  s = SC.applyChar(s, range(pos(0, 0), pos(0, 5)), { bold: true, sizePt: 18 });
  const all = SC.charSummary(s, null);
  assert.equal(all.attrs.bold, true);
  assert.deepEqual(all.mixed.sort(), ['bold', 'sizePt']);
  assert.deepEqual(SC.charSummary(s, range(pos(0, 1), pos(0, 3))).mixed, []);
  // a caret reads the character before it — at a paragraph's start the one after
  assert.equal(SC.charSummary(s, range(pos(0, 5), pos(0, 5))).attrs.bold, true);
  assert.equal(SC.charSummary(s, range(pos(0, 6), pos(0, 6))).attrs.bold, false);
  assert.equal(SC.charSummary(s, range(pos(0, 0), pos(0, 0))).attrs.bold, true);
});

test('B I U S turn on unless all of the text has them; a size step steps every run its own', { skip }, () => {
  const s = SC.applyChar(SC.fromText('abcd'), range(pos(0, 0), pos(0, 2)), { bold: true, underline: 'double', sizePt: 24 });
  const all = range(pos(0, 0), pos(0, 4)), ab = range(pos(0, 0), pos(0, 2)), cd = range(pos(0, 2), pos(0, 4));
  // Ctrl+B on "**ab**cd": the first run is bold, but not all of it is — on
  assert.deepEqual(SC.togglePatch(SC.charSummary(s, all), 'bold'), { bold: true });
  assert.deepEqual(SC.togglePatch(SC.charSummary(s, ab), 'bold'), { bold: false });
  assert.deepEqual(SC.togglePatch(SC.charSummary(s, cd), 'italic'), { italic: true });
  // a line of any style is a line: double turns off; mixed turns a single one on
  assert.deepEqual(SC.togglePatch(SC.charSummary(s, ab), 'underline'), { underline: 'none' });
  assert.deepEqual(SC.togglePatch(SC.charSummary(s, all), 'underline'), { underline: 'single' });
  assert.deepEqual(SC.togglePatch(SC.charSummary(s, all), 'strike'), { strike: 'single' });
  // at a caret, the attributes of what is typed next
  assert.deepEqual(SC.togglePatch(SC.charSummary(s, range(pos(0, 2), pos(0, 2))), 'bold'), { bold: false });
  // Ctrl+Shift+> on 24 pt "ab" and 12 pt "cd": 25 and 13, not one size for all
  const up = SC.mapChar(s, all, a => SC.stepSize(a, 1));
  assert.deepEqual(up.paragraphs[0].runs.map(r => [r.text, SC.charOf(r.attrs).sizePt]), [['ab', 25], ['cd', 13]]);
  assert.deepEqual(SC.stepSize({ sizePt: 1.5 }, -1), { sizePt: 1 });          // never below 1 pt
  assert.deepEqual(SC.stepSize({ sizePt: 10.333 }, 1), { sizePt: 11.33 });
  assert.deepEqual(SC.stepSize({}, -1), { sizePt: 11 });                      // the default size's step
});

test('deleting across paragraphs joins them under the first one\'s attributes', { skip }, () => {
  let s = SC.fromText('first\nsecond\nthird');
  s = SC.applyPara(s, range(pos(0, 0), pos(0, 0)), { align: 'center' });
  s = SC.applyPara(s, range(pos(1, 0), pos(1, 0)), { align: 'right' });
  const { story, pos: at } = SC.deleteRange(s, range(pos(0, 3), pos(1, 3)));
  assert.equal(SC.toText(story), 'firond\nthird');
  assert.deepEqual(at, pos(0, 3));
  assert.equal(SC.paraOf(story.paragraphs[0].attrs).align, 'center');
});

test('a deleted text keeps its attributes for what is typed next', { skip }, () => {
  let s = SC.applyChar(SC.fromText('abc'), null, { bold: true });
  const d = SC.deleteRange(s, range(pos(0, 0), pos(0, 3)));
  assert.deepEqual(d.story.paragraphs[0].runs, [{ text: '', attrs: { bold: true } }]);
  const t = SC.insertText(d.story, d.pos, 'x');
  assert.deepEqual(t.story.paragraphs[0].runs, [{ text: 'x', attrs: { bold: true } }]);
});

test('Enter splits a paragraph; the new one takes its attributes', { skip }, () => {
  let s = SC.applyPara(SC.fromText('HelloWorld'), null, { spaceAfter: 6 });
  const r = SC.insertText(s, pos(0, 5), '\n');
  assert.equal(SC.toText(r.story), 'Hello\nWorld');
  assert.deepEqual(r.pos, pos(1, 0));
  assert.equal(r.story.paragraphs[1].attrs.spaceAfter, 6);
  const lb = SC.insertText(s, pos(0, 5), LB);
  assert.equal(lb.story.paragraphs.length, 1);
  assert.equal(SC.toText(lb.story), 'Hello\nWorld');
});

test('typing over a selection takes the attributes of its first character', { skip }, () => {
  let s = SC.fromText('one two');
  s = SC.applyChar(s, range(pos(0, 4), pos(0, 7)), { color: '#ff0000' });
  const r = SC.replaceRange(s, range(pos(0, 4), pos(0, 7)), 'six');
  assert.deepEqual(r.story.paragraphs[0].runs, [{ text: 'one ', attrs: {} }, { text: 'six', attrs: { color: '#ff0000' } }]);
});

test('slice and the word under a position', { skip }, () => {
  const s = SC.fromText('alpha beta\ngamma');
  assert.equal(SC.toText(SC.slice(s, range(pos(0, 6), pos(1, 3)))), 'beta\ngam');
  assert.deepEqual(SC.wordAt(s, pos(0, 7)), range(pos(0, 6), pos(0, 10)));
});

test('list markers count on, restart and end like Affinity\'s', { skip }, () => {
  let s = SC.fromText('a\nb\nc\nd\ne\nf');
  s = SC.applyPara(s, range(pos(0, 0), pos(2, 0)), { list: 'decimal' });
  s = SC.applyPara(s, range(pos(4, 0), pos(5, 0)), { list: 'upper-roman', listStart: 0 });
  s = SC.applyPara(s, range(pos(5, 0), pos(5, 0)), { listStart: 4 });
  assert.deepEqual(SC.listMarkers(s), ['1.', '2.', '3.', '', 'I.', 'IV.']);
  s = SC.applyPara(s, range(pos(3, 0), pos(3, 0)), { list: 'bullet' });
  assert.equal(SC.listMarkers(s)[3], '•');
  s = SC.applyPara(SC.fromText('x\ny'), null, { list: 'lower-alpha', listSuffix: ')' });
  assert.deepEqual(SC.listMarkers(s), ['a)', 'b)']);
});

test('OpenType settings name only what differs from the browser\'s defaults', { skip }, () => {
  // Recto's own: no ligatures, no contextual alternates — as Word sets text
  const a = SC.charOf({});
  assert.equal(SC.featureSettings(a), '"liga" 0, "clig" 0, "calt" 0');
  // with the browser's three on, nothing else is named
  const on = { ...a, ot_liga: true, ot_clig: true, ot_calt: true };
  assert.equal(SC.featureSettings(on), '');
  assert.equal(SC.featureSettings({ ...on, ot_liga: false, ot_dlig: true, ot_numForm: 'onum', ot_ss: 0b101 }),
    '"liga" 0, "dlig" 1, "onum" 1, "ss01" 1, "ss03" 1');
  assert.equal(SC.featureSettings({ ...on, ot_position: 'sups' }), '"sups" 1');
  assert.equal(SC.featureSettings({ ...on, autoKern: false }), '"kern" 0');
  assert.equal(SC.featureSettings({ ...on, autoKern: true }), '');
});

test('pair kerning: the run\'s choice, else the page\'s, else off — and a choice of On is kept', { skip }, () => {
  assert.equal(SC.CHAR_DEFAULTS.autoKern, null);                      // as the page
  const a = SC.charOf({});
  assert.equal(SC.resolveKern(a, undefined).autoKern, false);         // nobody read the page: as Word sets text
  assert.equal(SC.resolveKern(a, true).autoKern, true);               // the page's producer kerned this face
  assert.equal(SC.resolveKern(a, false).autoKern, false);
  assert.equal(SC.resolveKern({ ...a, autoKern: true }, false).autoKern, true);   // the user's choice wins
  assert.equal(SC.resolveKern({ ...a, autoKern: false }, true).autoKern, false);
  // On is not the default any more: choosing it is stored, so it overrides an unkerned page
  const s = SC.applyChar(SC.fromText('Yo AV'), null, { autoKern: true });
  assert.deepEqual(s.paragraphs[0].runs[0].attrs, { autoKern: true });
  assert.deepEqual(SC.applyChar(s, null, { autoKern: null }).paragraphs[0].runs[0].attrs, {});   // back to the page
  assert.equal(SC.runCSS(SC.charOf({ autoKern: true }), SC.paraOf({}), SC.scaledMetrics(null, 16), { pxPerPt: 1 })['font-kerning'], 'normal');
  assert.equal(SC.runCSS(a, SC.paraOf({}), SC.scaledMetrics(null, 16), { pxPerPt: 1 })['font-kerning'], 'none');
});

test('what a pixel renderer can draw of a run: face, size, spacing, kerning, colour, single lines', { skip }, () => {
  const a = SC.charOf({});
  assert.ok(SC.pixelable(a));
  assert.ok(SC.pixelable({ ...a, tracking: 40, manualKern: -20, autoKern: true, color: '#2e75b6', underline: 'single', caps: 'all' }));
  for (const bad of [{ highlight: '#ffff00' }, { opacity: 50 }, { strokeColor: '#000000', strokeWidth: 1 }, { scaleX: 90 }, { scaleY: 110 },
    { shear: 12 }, { position: 'super' }, { ot_position: 'sups' }, { caps: 'small' }, { underline: 'double' }, { strike: 'double' }])
    assert.equal(SC.pixelable({ ...a, ...bad }), false, JSON.stringify(bad));
  // an outline needs both a colour and a width
  assert.ok(SC.pixelable({ ...a, strokeColor: '#000000', strokeWidth: 0 }));
  // what it lays past is named, for the Text panel's locks
  assert.ok(SC.PIXEL_IGNORES.keys.includes('ot_liga'));
  assert.deepEqual(SC.PIXEL_LIMITS.find(l => l.key === 'caps').allow, ['none', 'all']);
});

test('capitals: the font\'s features where it has them, Affinity\'s synthesis where not', { skip }, () => {
  const full = ['smcp', 'c2sc', 'pcap'];
  assert.deepEqual(SC.capsPlan('small', full), { tags: ['smcp'], synth: [] });
  assert.deepEqual(SC.capsPlan('small', []), { tags: [], synth: ['lower'] });
  assert.deepEqual(SC.capsPlan('c2sc', []), { tags: [], synth: ['upper'] });
  assert.deepEqual(SC.capsPlan('allSmall', ['smcp']), { tags: ['smcp'], synth: [] });
  assert.deepEqual(SC.capsPlan('allSmall', []), { tags: [], synth: ['lower', 'upper'] });
  assert.deepEqual(SC.capsPlan('petite', []), { tags: ['pcap'], synth: [] });      // the font's only
  assert.equal(SC.featureSettings({ ...SC.charOf({ ot_liga: true, ot_clig: true, ot_calt: true }), caps: 'allSmall' }, full), '"smcp" 1, "c2sc" 1');
  assert.equal(SC.runCSS(SC.charOf({ caps: 'all' }), SC.paraOf({}), SC.scaledMetrics(null, 16), { pxPerPt: 1 })['text-transform'], 'uppercase');
});

test('face metrics as Affinity reads them, with its fallbacks', { skip }, () => {
  // Times New Roman's tables, at 2048 units per em, set at 20.48 px: one unit = 0.01 px
  const times = { upem: 2048, hheaAscender: 1825, hheaDescender: -443, hheaLineGap: 87, topH: 1356, topX: 916, topL: 1422,
    postUnderlinePosition: -223, postUnderlineThickness: 100, os2StrikeoutPosition: 530, os2StrikeoutSize: 102, space: 512 };
  const m = SC.scaledMetrics(times, 20.48);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
  near(m.idealLeading, 23.55);                     // (1825 + 443 + 87) / 100
  near(m.capHeight, 13.56); near(m.xHeight, 9.16); near(m.typoAscent, 14.22);
  near(m.underlinePos, 2.23); near(m.underlineSize, 1); near(m.strikePos, 5.3);
  near(m.smallCaps, 0.5 / 0.7);                    // no OS/2 v2 heights: Affinity's 0.5 / 0.7
  // a face without hhea leads at 1.1 × its size; without post its underline is 0.1 / 0.05 em
  const bare = SC.scaledMetrics({ upem: 1000 }, 10);
  near(bare.idealLeading, 11); near(bare.underlinePos, 1); near(bare.underlineSize, 0.5); near(bare.strikePos, 2);
});

test('leading: Default, Multiple, % Height, At Least, Exactly — and the override', { skip }, () => {
  const m = SC.scaledMetrics({ upem: 1000, hheaAscender: 900, hheaDescender: -200, hheaLineGap: 100 }, 20);
  const a = SC.charOf({ sizePt: 15 }), pxPerPt = 4 / 3;
  const pa = t => SC.paraOf(t);
  assert.equal(SC.leadingPx(pa({}), a, m, pxPerPt), 24);
  assert.equal(SC.leadingPx(pa({ leadingType: 'multiple', leading: 1.5 }), a, m, pxPerPt), 36);
  assert.equal(SC.leadingPx(pa({ leadingType: 'percent', leading: 150 }), a, m, pxPerPt), 30);
  assert.equal(SC.leadingPx(pa({ leadingType: 'atLeast', leading: 30 }), a, m, pxPerPt), 40);
  assert.equal(SC.leadingPx(pa({ leadingType: 'atLeast', leading: 9 }), a, m, pxPerPt), 24);
  assert.equal(SC.leadingPx(pa({ leadingType: 'exact', leading: 18 }), a, m, pxPerPt), 24);
  assert.equal(SC.leadingPx(pa({}), { ...a, leadingOverride: 9 }, m, pxPerPt), 12);
  assert.ok(SC.leadingPerRun(pa({})) && !SC.leadingPerRun(pa({ leadingType: 'exact' })));
});

test('Initial advance: max(metric, Minimum)', { skip }, () => {
  const m = SC.scaledMetrics({ upem: 1000, hheaAscender: 900, hheaDescender: -200, topH: 700, topX: 500, topL: 720 }, 10);
  const a = SC.charOf({ sizePt: 10 }), fr = t => SC.frameOf(t);
  const near = (x, y) => assert.ok(Math.abs(x - y) < 1e-9, `${x} != ${y}`);
  near(SC.firstBaselinePx(fr({}), a, m, 12, 1), 7.2);                       // max(top of l, cap height)
  near(SC.firstBaselinePx(fr({ baseline: 'cap' }), a, m, 12, 1), 7);
  near(SC.firstBaselinePx(fr({ baseline: 'x' }), a, m, 12, 1), 5);
  near(SC.firstBaselinePx(fr({ baseline: 'ascent' }), a, m, 12, 1), 9);
  near(SC.firstBaselinePx(fr({ baseline: 'leading' }), a, m, 12, 1), 12);
  near(SC.firstBaselinePx(fr({ baseline: 'pointsize' }), a, m, 12, 1), 10);
  near(SC.firstBaselinePx(fr({ baseline: 'fixed', baselineMin: 4 }), a, m, 12, 1), 4);
  near(SC.firstBaselinePx(fr({ baseline: 'x', baselineMin: 8 }), a, m, 12, 1), 8);
});

test('a page line\'s space: the mean of its single spaces between words, the pieces of a row together', { skip }, () => {
  // a line's measured characters, [{ c, x, w }]: a space's w is the room it takes
  const line = spec => { let x = 0; return spec.map(([c, w]) => { const cp = { c, x, w }; x += w; return cp; }); };
  const toBeOr = line([['T', 6], ['o', 8], [' ', 5.5], ['b', 8], ['e', 7], [' ', 5.25], ['o', 8], ['r', 5]]);
  assert.deepEqual(SC.lineWords(toBeOr), [{ text: 'To', i: 0, j: 1, x: 0, end: 14, gap: 1 }, { text: 'be', i: 3, j: 4, x: 19.5, end: 34.5, gap: 1 },
    { text: 'or', i: 6, j: 7, x: 39.75, end: 52.75, gap: 0 }]);
  assert.deepEqual(SC.lineSpace([toBeOr]), { space: 5.375, n: 2 });
  // spaces at either end and runs of spaces say nothing about the line's space
  assert.deepEqual(SC.lineSpace([line([[' ', 9], ['a', 7], [' ', 4.5], ['b', 7], [' ', 9]])]), { space: 4.5, n: 1 });
  assert.deepEqual(SC.lineSpace([line([['a', 7], [' ', 4], [' ', 4], ['b', 7], [' ', 5], ['c', 7]])]), { space: 5, n: 1 });
  assert.equal(SC.lineSpace([line([['a', 7], [' ', 0], ['b', 7]])]), null);
  assert.equal(SC.lineSpace([line([['W', 12], ['o', 8], ['r', 5], ['d', 8]])]), null);
  assert.equal(SC.lineSpace([[]]), null);
  assert.equal(SC.lineSpace(null), null);
  // the pieces of a row cut by a redaction bar count together, never across the cut
  assert.deepEqual(SC.lineSpace([line([['a', 7], [' ', 5], ['b', 7], [' ', 9]]), line([['c', 7], [' ', 7], ['d', 7]])]), { space: 6, n: 2 });
  // as the face sets the line: the page's distance between two word starts
  // less the face's, plus the face's own space — here the face sets "To" a
  // quarter px wider than the page's glyphs take (14.25) and kerns its space
  // before "be" by −0.5: the typed spaces must be 19.5 − 14.25 + 0.5 = 5.75
  // and 39.75 − 34.5 = 5.25
  const laid = { x: [0, 6, 14.25, 17.75, 25.75, 32.75, 36.75, 44.75], own: 4 };
  assert.deepEqual(SC.lineSpace([toBeOr], chars => (chars === toBeOr ? laid : null)), { space: 5.5, n: 2 });
  // a piece the face does not say how it sets keeps the page's own room
  assert.deepEqual(SC.lineSpace([toBeOr], () => null), { space: 5.375, n: 2 });
  // …and so does a word the face sets more than WORD_FIT off the page's (an
  // OCR layer's invisible text, stretched to the scan's words): "To" laid
  // 1.25 px narrower is not this face — its space is the page's 5.5
  assert.equal(SC.WORD_FIT, 0.5);
  const narrow = { x: [0, 5, 12.75, 16.25, 24.25, 31.25, 35.25, 43.25], own: 4 };
  assert.deepEqual(SC.lineSpace([toBeOr], () => narrow), { space: (5.5 + (39.75 - 19.5 - (35.25 - 16.25) + 4)) / 2, n: 2 });
  // …as the desired word spacing, in % of the face's space — the face's own
  // when it lands the line's spaces within a pen step (¼ px) of the page's
  assert.equal(SC.PEN_STEP, 0.25);
  assert.equal(SC.wordSpacingFor(5.5, 4, 8), 137.5);
  assert.equal(SC.wordSpacingFor(5, 3, 1), 166.666667);
  assert.equal(SC.wordSpacingFor(4.02, 4, 12), 100);               // 12 × 0.02 = 0.24 px: the face's own
  assert.equal(SC.wordSpacingFor(4.03, 4, 12), 100.75);            // 0.36 px: the line's
  assert.equal(SC.wordSpacingFor(3.9, 4, 4), 97.5);                // a tight line too
  assert.equal(SC.wordSpacingFor(null, 4, 3), 100);
  assert.equal(SC.wordSpacingFor(5, 0, 3), 100);
  // which the run's CSS lays: the face's space + the difference
  const m = SC.scaledMetrics({ upem: 1000, space: 250 }, 16);
  assert.equal(SC.runCSS(SC.charOf({ sizePt: 12 }), SC.paraOf({ wordSpacing: SC.wordSpacingFor(5.375, m.space, 2) }), m, { pxPerPt: 4 / 3 })['word-spacing'], '1.375px');
});

test('a page line\'s tabs: a run of spaces, or one space wider than the line\'s by TAB_GAP — and where the line goes on', { skip }, () => {
  const line = spec => { let x = 0; return spec.map(([c, w]) => { const cp = { c, x, w }; x += w; return cp; }); };
  assert.equal(SC.TAB_GAP, 1);
  // "2." and a tab the reader wrote as four spaces, then "Ev of" at 8 px spaces:
  // the text goes on at x 45; the run says nothing about the line's space
  const listed = line([['2', 6], ['.', 3], [' ', 9], [' ', 9], [' ', 9], [' ', 9], ['E', 7], ['v', 6], [' ', 8], ['o', 6], ['f', 4]]);
  assert.deepEqual([...SC.lineTabGaps(SC.lineWords(listed))], [1]);
  assert.deepEqual(SC.lineTabs(listed), [{ x: 45, i: 6 }]);
  assert.deepEqual(SC.lineSpace([listed]), { space: 8, n: 1 });
  // "w." and a tab to a stop just beyond it, written as one space 8.5 px wide
  // on a line of 6.5–7 px spaces (the lower middle 6.75): a tab, which the
  // line's space leaves out
  const wide = line([['w', 9], ['.', 3], [' ', 8.5], ['A', 9], [' ', 6.75], ['L', 7], [' ', 6.5], ['t', 4], [' ', 7], ['m', 9]]);
  assert.deepEqual(SC.lineTabs(wide), [{ x: 20.5, i: 3 }]);
  assert.deepEqual(SC.lineSpace([wide]), { space: 6.75, n: 3 });
  // within TAB_GAP of the line's spaces it is one of them
  const near = line([['w', 9], ['.', 3], [' ', 7.5], ['A', 9], [' ', 6.75], ['L', 7], [' ', 6.5], ['t', 4], [' ', 7], ['m', 9]]);
  assert.deepEqual(SC.lineTabs(near), []);
  assert.deepEqual(SC.lineSpace([near]), { space: 6.9375, n: 4 });
  // of two spaces the wider is the tab; of one, nothing can be told
  const two = line([['z', 6], ['.', 3], [' ', 13], ['A', 9], [' ', 10.5], ['U', 9]]);
  assert.deepEqual(SC.lineTabs(two), [{ x: 22, i: 3 }]);
  assert.deepEqual(SC.lineSpace([two]), { space: 10.5, n: 1 });
  assert.deepEqual(SC.lineTabs(line([['a', 7], [' ', 20], ['b', 7]])), []);
  assert.deepEqual(SC.lineTabs([]), []);
});

test('a run\'s CSS: tracking in ‰ of an em, baseline shift up, decorations from the face', { skip }, () => {
  const m = SC.scaledMetrics({ upem: 1000, hheaAscender: 900, hheaDescender: -200, postUnderlinePosition: -100, postUnderlineThickness: 50 }, 16);
  const css = SC.runCSS(SC.charOf({ sizePt: 12, tracking: 50, baselineShift: 3, underline: 'double' }), SC.paraOf({}), m, { pxPerPt: 4 / 3 });
  assert.equal(css['font-size'], '16px');
  assert.equal(css['letter-spacing'], '0.05em');
  assert.equal(css.top, '-4px');
  assert.equal(css['text-decoration-line'], 'underline');
  assert.equal(css['text-decoration-style'], 'double');
  assert.equal(css['text-decoration-thickness'], '0.8px');
  assert.equal(css['text-underline-offset'], '1.6px');
  // Super/Subscript: Affinity's synthesis, the same for every font
  const sup = SC.runCSS(SC.charOf({ sizePt: 12, position: 'super' }), SC.paraOf({}), m, { pxPerPt: 4 / 3 });
  assert.equal(sup['font-size'], '9.328px');                // 16 × 0.583
  assert.equal(sup.top, '-5.328px');                        // 16 × 0.333 up
  const sub = SC.runCSS(SC.charOf({ sizePt: 12, position: 'sub' }), SC.paraOf({}), m, { pxPerPt: 4 / 3 });
  assert.equal(sub.top, '5.328px');
  // opacity is the fill colour's alpha (not the run's: a highlight stays solid)
  const half = SC.runCSS(SC.charOf({ color: '#ff0000', opacity: 50, highlight: '#ffff00' }), SC.paraOf({}), m, { pxPerPt: 1 });
  assert.equal(half.color, 'color-mix(in srgb, #ff0000 50%, transparent)');
  assert.equal(half.opacity, undefined);
  assert.equal(half['background-color'], '#ffff00');
});

test('space between paragraphs: the larger of after and before, or both with Sum', { skip }, () => {
  const ctx = { pxPerPt: 1 };
  const prev = SC.paraOf({ spaceAfter: 6 });
  assert.equal(SC.paraCSS(SC.paraOf({ spaceBefore: 10 }), 12, prev, ctx)['padding-top'], '4px');
  assert.equal(SC.paraCSS(SC.paraOf({ spaceBefore: 4 }), 12, prev, ctx)['padding-top'], undefined);
  assert.equal(SC.paraCSS(SC.paraOf({ spaceBefore: 4, sumSpacing: true }), 12, prev, ctx)['padding-top'], '4px');
  assert.equal(SC.paraCSS(SC.paraOf({ spaceBefore: 9 }), 12, null, ctx, { first: true })['padding-top'], undefined);
  const j = SC.paraCSS(SC.paraOf({ align: 'justify-center' }), 12, null, ctx);
  assert.deepEqual([j['text-align'], j['text-align-last']], ['justify', 'center']);
});

test('Use space before, Start in next column, keep with previous', { skip }, () => {
  const ctx = { pxPerPt: 1 };
  assert.equal(SC.paraCSS(SC.paraOf({ spaceBefore: 9, spaceBeforeMode: 'always' }), 12, null, ctx, { first: true })['padding-top'], '9px');
  assert.equal(SC.paraCSS(SC.paraOf({ spaceBefore: 9, spaceBeforeMode: 'columnTop' }), 12, null, ctx, { first: true })['padding-top'], '9px');
  assert.equal(SC.paraCSS(SC.paraOf({ spaceBefore: 9, spaceBeforeMode: 'columnTop' }), 12, SC.paraOf({}), ctx)['padding-top'], undefined);
  assert.equal(SC.paraCSS(SC.paraOf({ startAt: 'column' }), 12, SC.paraOf({}), ctx)['break-before'], 'column');
  assert.equal(SC.paraCSS(SC.paraOf({ keepWithPrevious: true }), 12, SC.paraOf({}), ctx)['break-before'], 'avoid');
  const spine = SC.paraCSS(SC.paraOf({ align: 'away-spine' }), 12, null, ctx);
  assert.equal(spine['text-align'], 'right');
});

test('list types: zero-padded numbers', { skip }, () => {
  const s = SC.applyPara(SC.fromText('a\nb'), null, { list: 'decimal-3' });
  assert.deepEqual(SC.listMarkers(s), ['001.', '002.']);
});

test('a list started at 5 goes on 6, 7: Enter does not restart it, nor does a start set over several items', { skip }, () => {
  const s = SC.applyPara(SC.fromText('first'), null, { list: 'decimal', listStart: 5 });
  let r = SC.insertText(s, { p: 0, o: 5 }, '\n');
  r = SC.insertText(r.story, r.pos, 'second');
  r = SC.insertText(r.story, r.pos, '\nthird');
  assert.deepEqual(SC.listMarkers(r.story), ['5.', '6.', '7.']);
  assert.deepEqual(SC.listMarkers(SC.applyPara(SC.fromText('a\nb\nc'), null, { list: 'decimal', listStart: 5 })), ['5.', '6.', '7.']);
  // a start set on a later item alone restarts there
  const later = SC.applyPara(SC.applyPara(SC.fromText('a\nb\nc'), null, { list: 'decimal' }),
    { start: { p: 2, o: 0 }, end: { p: 2, o: 0 } }, { listStart: 9 });
  assert.deepEqual(SC.listMarkers(later), ['1.', '2.', '9.']);
});

test('Change Case rewrites the text and keeps every run and offset', { skip }, () => {
  let s = SC.applyChar(SC.fromText('the quick brown fox. it ran'), { start: { p: 0, o: 4 }, end: { p: 0, o: 9 } }, { bold: true });
  const up = SC.changeCase(s, null, 'upper');
  assert.equal(SC.toText(up), 'THE QUICK BROWN FOX. IT RAN');
  assert.deepEqual(up.paragraphs[0].runs.map(r => r.text), ['THE ', 'QUICK', ' BROWN FOX. IT RAN']);
  assert.equal(SC.toText(SC.changeCase(s, null, 'sentence')), 'The quick brown fox. It ran');
  assert.equal(SC.toText(SC.changeCase(SC.fromText('a tale of two cities'), null, 'title')), 'A Tale of Two Cities');
  assert.equal(SC.toText(SC.changeCase(SC.fromText('straße'), null, 'upper')), 'STRAßE');   // the length holds
});

test('an emoji is one character: Title Case after it, where characters start, No break keeps spaces', { skip }, () => {
  assert.equal(SC.caseMapped('😀 hello world', 'title'), '😀 Hello World');
  assert.equal(SC.caseMapped('𝐀 b 😀😀 the end', 'title'), '𝐀 B 😀😀 the End');
  assert.deepEqual(SC.charStarts('a😀b'), [0, 1, 3]);
  assert.deepEqual(SC.charStarts('😀'), [0]);
  assert.deepEqual(SC.charStarts(''), []);
  // a letter and its combining accent are one character (graphemes)
  assert.deepEqual(SC.charStarts('éx'), [0, 2]);
  // No break keeps a run of spaces as typed ('nowrap' collapses them)
  assert.equal(SC.runCSS(SC.charOf({ noBreak: true }), SC.paraOf({}), SC.scaledMetrics({}, 16), { pxPerPt: 4 / 3 })['white-space'], 'pre');
});

test('shaping.js: the face metrics of Times New Roman and Calibri', { skip }, async () => {
  const hb = await import('../web/vendor/harfbuzz/index.mjs');
  await import('../web/plugins/text_tool/shaping.js');
  const catalogue = JSON.parse(build({ write: false }).generated['fonts.json']);
  const shaper = globalThis.ShapingCore.createShaper({ hb, catalogue, loadFont: async f => fs.readFileSync(path.join(ROOT, 'web', 'assets', 'fonts', f)) });
  const t = await shaper.faceMetrics({ family: 'Times New Roman' });
  assert.deepEqual([t.upem, t.hheaAscender, t.hheaDescender, t.hheaLineGap, t.topH, t.topX, t.topL, t.space], [2048, 1825, -443, 87, 1356, 916, 1422, 512]);
  assert.deepEqual([t.postUnderlinePosition, t.postUnderlineThickness, t.os2StrikeoutPosition, t.os2StrikeoutSize, t.typoAscender], [-223, 100, 530, 102, 1420]);
  assert.equal(t.os2XHeight, null);                   // OS/2 version 1: no x / cap height
  const c = await shaper.faceMetrics({ family: 'Calibri' });
  assert.deepEqual([c.os2XHeight, c.os2CapHeight], [951, 1294]);
  for (const tag of ['smcp', 'c2sc', 'onum', 'tnum', 'frac', 'ss01', 'sups']) assert.ok(c.features.includes(tag), tag);
});
