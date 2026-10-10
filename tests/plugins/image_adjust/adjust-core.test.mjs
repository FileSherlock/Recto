// web/plugins/image_adjust/adjust-core.js — Affinity's adjustments of the
// page view as numbers: the curve Affinity evaluates, the other kernels, a
// stack compiled into stages, and the stages applied to a raster's samples.
// The expected values come from Affinity 3.3.1's own code and data: its
// shipped presets' stored second derivatives, its kernels' formulas (see
// guide/plugins/image-adjust/README.md). Skipped when the plugin is not
// installed.
//
//   node --test "tests/**/*.test.mjs"

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..', '..', '..', 'web', 'plugins', 'image_adjust');
const skip = !fs.existsSync(path.join(PLUGIN, 'plugin.json')) && 'plugin not installed';
if (!skip) await import('../../../web/plugins/image_adjust/adjust-core.js');   // a classic script: defines globalThis.AdjustCore
const AC = globalThis.AdjustCore;

const S_CURVE = [[0, 0], [0.25, 0.2], [0.75, 0.8], [1, 1]];
const lutOf = stack => { const st = AC.compile(stack); return st.length ? st[0] : null; };
const withRounding = (mode, fn) => { const was = AC.rounding; AC.rounding = mode; try { return fn(); } finally { AC.rounding = was; } };

test('no adjustment, or only neutral or disabled ones, changes nothing', { skip }, () => {
  assert.ok(AC.isIdentity(AC.compile([])));
  assert.ok(AC.isIdentity(AC.compile([{ ...AC.create('invert'), enabled: false }])));
  assert.ok(AC.isIdentity(AC.compile([AC.create('curves'), AC.create('levels'), AC.create('brightnessContrast')])));
  withRounding('cpu', () => assert.ok(AC.isIdentity(AC.compile([AC.create('curves'), AC.create('levels'), AC.create('brightnessContrast')]))));
});

test('Invert is 255 − value on every channel', { skip }, () => {
  const t = lutOf([AC.create('invert')]);
  for (const ch of AC.CHANNELS) assert.deepEqual([...t[ch]], Array.from({ length: 256 }, (_, v) => 255 - v));
});

test('the spline is Affinity\'s: the second derivatives its presets store', { skip }, () => {
  // Affinity's presets store these: S-Curve y2 = [0, 2.4, −2.4, 0]; Matte Black [0, 1.2, 0]
  const near = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${a} vs ${b}`));
  near(AC.secondDerivatives(S_CURVE), [0, 2.4, -2.4, 0]);
  near(AC.secondDerivatives([[0, 0.1], [0.25, 0.25], [1, 1]]), [0, 1.2, 0]);
  near(AC.secondDerivatives([[0, 0], [0.25, 0.25], [0.75, 0.75], [1, 0.85]]), [0, 0.9, -2.7, 0]);    // Reduce Highlights
});

test('the spline\'s rules: through its points, flat beyond them, identity outside 0…1, linear with two', { skip }, () => {
  const f = AC.spline(S_CURVE);
  for (const [x, y] of S_CURVE) assert.ok(Math.abs(f(x) - Math.fround(y)) < 1e-7);
  const g = AC.spline([[0.2, 0.1], [0.5, 0.6], [0.8, 0.9]]);
  assert.equal(g(0.1), Math.fround(0.1)); assert.equal(g(0.95), Math.fround(0.9));
  assert.equal(g(-0.5), -0.5); assert.equal(g(1.5), 1.5);
  const two = AC.spline([[0, 1], [1, 0]]);
  assert.ok(Math.abs(two(0.25) - 0.75) < 1e-12);
  const lin = AC.spline(S_CURVE, true);
  assert.ok(Math.abs(lin(0.5) - 0.5) < 1e-7 && Math.abs(lin(0.125) - 0.1) < 1e-7);
  // it may overshoot between points, and is clamped only at the end
  const o = AC.spline([[0, 0], [0.04, 0.45], [0.15, 0.85], [1, 1]]);
  assert.ok(Array.from({ length: 101 }, (_, i) => o(i / 100)).some(v => v > 1));
});

test('the S-Curve preset, as 8-bit tables, both of Affinity\'s roundings', { skip }, () => {
  const s = [0, 32, 64, 96, 128, 160, 192, 224, 255];
  assert.deepEqual(s.map(v => lutOf([{ ...AC.create('curves'), master: S_CURVE }]).r[v]), [0, 23, 51, 87, 128, 169, 205, 233, 255]);
  withRounding('cpu', () => {
    const t = lutOf([{ ...AC.create('curves'), master: S_CURVE }]).r;
    // the CPU truncates: never above the GPU's rounding, at most one below
    const g = withRounding('gpu', () => lutOf([{ ...AC.create('curves'), master: S_CURVE }]).r);
    for (let v = 0; v < 256; v++) assert.ok(g[v] - t[v] === 0 || g[v] - t[v] === 1, `${v}`);
  });
});

test('a channel curve acts first, then Master; the input range maps around both', { skip }, () => {
  const t = lutOf([{ ...AC.create('curves'), r: [[0, 1], [1, 0]], master: [[0, 0], [0.5, 0], [1, 1]] }]);
  assert.equal(t.r[0], 255); assert.equal(t.r[255], 0);
  assert.equal(t.g[64], 0); assert.equal(t.g[255], 255);
  // Min / Max: (v − min)/(max − min) into the curves, back out after them
  const ranged = lutOf([{ ...AC.create('curves'), master: [[0, 1], [1, 0]], inputMin: 0.5, inputMax: 1 }]);
  assert.equal(ranged.r[255], 128);              // 1 → 0 → 0.5
  assert.equal(ranged.r[0], 0);                  // −1 is outside the curve: passes, then clamps
});

test('Brightness / Contrast: Affinity\'s exponents and kernels', { skip }, () => {
  const e = AC.bcExponents(0.25, 1.25);
  assert.ok(Math.abs(e.pB - (2 / (1 - 0.15) - 1)) < 1e-12 && Math.abs(e.pC - 1.25) < 1e-12);
  assert.ok(Math.abs(AC.bcExponents(-0.25, 0.75).pB - 1 / (2 / 0.85 - 1)) < 1e-12);
  assert.ok(Math.abs(AC.bcExponents(0, 0.75).pC - 0.8) < 1e-12);
  const inc = lutOf([{ ...AC.create('brightnessContrast'), contrast: 0.25 }]).r;   // "Increase Contrast": C = 1.25
  assert.deepEqual([0, 64, 128, 192, 255].map(v => inc[v]), [0, 54, 128, 202, 255]);
  // the CPU's integer kernel, worked by hand at v = 64: t = 64; 128·(64/128)^1.25 = 53.82 → round → 54
  withRounding('cpu', () => assert.equal(lutOf([{ ...AC.create('brightnessContrast'), contrast: 0.25 }]).r[64], 54));
  const lin = lutOf([{ ...AC.create('brightnessContrast'), contrast: 0.5, brightness: 0.1, linear: true }]).r;
  assert.equal(lin[128], Math.floor(128 + 25.5 + 0.5));                         // (v − 128)·1.5 + 128 + 25.5
  assert.equal(lin[0], 0);
});

test('Levels: per channel, then master; gamma is the exponent (above 1 darkens)', { skip }, () => {
  const t = lutOf([{ ...AC.create('levels'), master: { black: 0.2, white: 0.8, gamma: 1, outBlack: 0, outWhite: 1 } }]).r;
  assert.equal(t[51], 0); assert.equal(t[204], 255); assert.equal(t[128], 128);
  const g = lutOf([{ ...AC.create('levels'), master: { black: 0, white: 1, gamma: 2, outBlack: 0, outWhite: 1 } }]).r;
  assert.equal(g[128], 64);                                                       // 255·(128/255)² = 64.25
  const o = lutOf([{ ...AC.create('levels'), master: { black: 0, white: 1, gamma: 1, outBlack: 0.1, outWhite: 0.9 } }]).r;
  assert.equal(o[0], 26); assert.equal(o[255], 230);
  const ch = lutOf([{ ...AC.create('levels'), r: { black: 0, white: 0.5, gamma: 1, outBlack: 0, outWhite: 1 } }]);
  assert.equal(ch.r[128], 255); assert.equal(ch.g[128], 128);
});

test('Threshold reads the intensity: black at or below, white above', { skip }, () => {
  const st = AC.compile([AC.create('threshold')]);
  assert.equal(st[0].kind, 'gray');
  assert.equal(st[0].y[127], 0); assert.equal(st[0].y[128], 255);
  assert.equal(AC.luma(255, 255, 255), 255);
  assert.equal(AC.luma(255, 0, 0), 76);                                          // 0.299·255, truncated
  const out = AC.applyToSamples(Uint8Array.of(255, 0, 0, 0, 255, 0), 3, st);
  assert.deepEqual([...out], [0, 0, 0, 255, 255, 255]);                         // red 76 ≤ 127.5, green 149 above
});

test('the stack acts top to bottom, each at its opacity; tables fuse, gray stages stay', { skip }, () => {
  const lift = { ...AC.create('levels'), master: { black: 0, white: 1, gamma: 1, outBlack: 0.5, outWhite: 1 } };
  assert.equal(lutOf([AC.create('invert'), lift]).r[0], 255);   // invert first: 0 → 255 → stays
  assert.equal(lutOf([lift, AC.create('invert')]).r[0], 127);   // lift first: 0 → 128 → 127
  const half = lutOf([{ ...AC.create('invert'), opacity: 0.5 }]).r;
  assert.ok(half.every(v => v === 127 || v === 128));
  const st = AC.compile([AC.create('invert'), { ...AC.create('curves'), master: S_CURVE }, { ...AC.create('threshold'), opacity: 0.5 }]);
  assert.deepEqual(st.map(s => s.kind), ['lut', 'gray']);
  assert.equal(st[1].opacity, 0.5);
  // "invert + more contrast": because the invert is exact, the fused table is the curve read backwards
  const s = lutOf([{ ...AC.create('curves'), master: S_CURVE }]).r;
  const both = lutOf([AC.create('invert'), { ...AC.create('curves'), master: S_CURVE }]).r;
  for (let v = 0; v < 256; v++) assert.equal(both[v], s[255 - v]);
});

test('the stages applied to gray, RGB and RGBA samples (alpha kept)', { skip }, () => {
  const st = AC.compile([{ ...AC.create('curves'), r: [[0, 1], [1, 0]] }]);
  assert.deepEqual([...AC.applyToSamples(Uint8Array.of(0, 10, 20), 3, st)], [255, 10, 20]);
  assert.deepEqual([...AC.applyToSamples(Uint8Array.of(0, 10, 20, 77), 4, st)], [255, 10, 20, 77]);
  const inv = AC.compile([AC.create('invert')]);
  assert.deepEqual([...AC.applyToSamples(Uint8Array.of(0, 200), 1, inv)], [255, 55]);
});

test('an feFunc table: 256 values, entry i the output for i/255', { skip }, () => {
  const v = AC.tableValues(lutOf([AC.create('invert')]).r).split(' ').map(Number);
  assert.equal(v.length, 256);
  assert.equal(v[0], 1); assert.equal(v[255], 0); assert.equal(v[51], 0.8);
});

test('histogram of channels and intensity', { skip }, () => {
  const h = AC.histogram(Uint8Array.of(255, 0, 0, 0, 255, 0), 3);
  assert.equal(h.r[255], 1); assert.equal(h.g[255], 1); assert.equal(h.b[0], 2);
  assert.equal(h.l[76], 1); assert.equal(h.l[149], 1);
});

test('every preset is a valid stack that changes the page; Affinity\'s knots kept exactly', { skip }, () => {
  for (const p of AC.PRESETS) {
    const stack = p.stack();
    assert.ok(stack.length && stack.every(a => a && a.type), p.key);
    assert.ok(!AC.isIdentity(AC.compile(stack)), `${p.key} changes the page`);
  }
  assert.deepEqual(AC.PRESETS.find(p => p.key === 's-curve-stronger').stack()[0].master[1], [0.249609375, 0.15]);
});
