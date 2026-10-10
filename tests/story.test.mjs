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

test('OpenType settings name only what differs from the font\'s defaults', { skip }, () => {
  const a = SC.charOf({});
  assert.equal(SC.featureSettings(a), '');
  assert.equal(SC.featureSettings({ ...a, ot_liga: false, ot_dlig: true, ot_numForm: 'onum', ot_ss: 0b101 }),
    '"liga" 0, "dlig" 1, "onum" 1, "ss01" 1, "ss03" 1');
  assert.equal(SC.featureSettings({ ...a, ot_position: 'sups' }), '"sups" 1');
  assert.equal(SC.featureSettings({ ...a, autoKern: false }), '"kern" 0');
});

test('capitals: the font\'s features where it has them, Affinity\'s synthesis where not', { skip }, () => {
  const full = ['smcp', 'c2sc', 'pcap'];
  assert.deepEqual(SC.capsPlan('small', full), { tags: ['smcp'], synth: [] });
  assert.deepEqual(SC.capsPlan('small', []), { tags: [], synth: ['lower'] });
  assert.deepEqual(SC.capsPlan('c2sc', []), { tags: [], synth: ['upper'] });
  assert.deepEqual(SC.capsPlan('allSmall', ['smcp']), { tags: ['smcp'], synth: [] });
  assert.deepEqual(SC.capsPlan('allSmall', []), { tags: [], synth: ['lower', 'upper'] });
  assert.deepEqual(SC.capsPlan('petite', []), { tags: ['pcap'], synth: [] });      // the font's only
  assert.equal(SC.featureSettings({ ...SC.charOf({}), caps: 'allSmall' }, full), '"smcp" 1, "c2sc" 1');
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

test('Change Case rewrites the text and keeps every run and offset', { skip }, () => {
  let s = SC.applyChar(SC.fromText('the quick brown fox. it ran'), { start: { p: 0, o: 4 }, end: { p: 0, o: 9 } }, { bold: true });
  const up = SC.changeCase(s, null, 'upper');
  assert.equal(SC.toText(up), 'THE QUICK BROWN FOX. IT RAN');
  assert.deepEqual(up.paragraphs[0].runs.map(r => r.text), ['THE ', 'QUICK', ' BROWN FOX. IT RAN']);
  assert.equal(SC.toText(SC.changeCase(s, null, 'sentence')), 'The quick brown fox. It ran');
  assert.equal(SC.toText(SC.changeCase(SC.fromText('a tale of two cities'), null, 'title')), 'A Tale of Two Cities');
  assert.equal(SC.toText(SC.changeCase(SC.fromText('straße'), null, 'upper')), 'STRAßE');   // the length holds
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
