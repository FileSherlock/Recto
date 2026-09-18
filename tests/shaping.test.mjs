// web/plugins/text_tool/shaping.js against the recorded server answers: every
// /widths case and every /font-metrics table is replayed and must come out
// EQUAL — same HarfBuzz (14.4.0) on both sides, so equal to the last digit.
//
//   node --test tests/*.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from '../tools/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GOLDEN = path.join(HERE, 'golden');

const hb = await import('../web/vendor/harfbuzz/index.mjs');
await import('../web/plugins/text_tool/shaping.js');                  // a classic script: defines globalThis.ShapingCore
const catalogue = JSON.parse(build({ write: false }).generated['fonts.json']);
const shaper = globalThis.ShapingCore.createShaper({
  hb, catalogue,
  loadFont: async file => fs.readFileSync(path.join(ROOT, 'web', 'assets', 'fonts', file)),
});

const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const readGz = file => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));

// The largest numeric difference between two JSON values (Infinity when their shapes differ).
function largestDifference(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b);
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b ? 0 : Infinity;
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (JSON.stringify(ka) !== JSON.stringify(kb)) return Infinity;
  return ka.reduce((worst, k) => Math.max(worst, largestDifference(a[k], b[k])), 0);
}

test('the vendored HarfBuzz is the version the goldens were recorded with', () => {
  assert.equal(hb.versionString(), readJSON(path.join(GOLDEN, 'versions.json')).harfbuzz);
});

test('the generated font catalogue equals /fonts-list', () => {
  const golden = readJSON(path.join(GOLDEN, 'fonts-list.json'));
  assert.equal(catalogue.default, golden.default);
  assert.deepEqual(catalogue.families.map(({ hashes, ...f }) => f), golden.families);
});

test('the catalogue names MuPDF\'s faces first, then the Windows faces, each with its regular file', () => {
  const names = catalogue.families.map(f => f.family);
  for (const family of ['Nimbus Roman', 'Nimbus Sans', 'Nimbus Mono PS', 'Times New Roman', 'Courier New', 'Arial'])
    assert.ok(names.includes(family), family);
  assert.equal(names[0], 'Nimbus Roman');
  assert.deepEqual(catalogue.families.filter(f => !f.present.regular).map(f => f.family), []);
});

test('a face resolves through its family\'s styles, then the fallback family', () => {
  assert.equal(shaper.resolve('Nimbus Mono PS', false, false), 'NimbusMonoPS-Regular.otf');
  assert.equal(shaper.resolve('Nimbus Mono PS', true, false), 'NimbusMonoPS-Regular.otf');   // no bold file → the regular
  assert.equal(shaper.resolve('Times New Roman', true, false), 'timesbd.ttf');
  assert.equal(shaper.resolve('No Such Face', false, false), 'times.ttf');
});

for (const name of readJSON(path.join(GOLDEN, 'widths', 'index.json'))) {
  test(`/widths ${name}`, async () => {
    const { request, response } = readGz(path.join(GOLDEN, 'widths', `${name}.json.gz`));
    const answer = JSON.parse(JSON.stringify(await shaper.widths(request)));
    assert.equal(largestDifference(answer, response), 0);
  });
}

for (const row of readJSON(path.join(GOLDEN, 'font-metrics', 'index.json'))) {
  test(`/font-metrics ${row.file}`, async () => {
    const { request, response } = readGz(path.join(GOLDEN, 'font-metrics', row.file));
    const answer = await shaper.fontMetrics(request);
    assert.equal(Object.keys(answer.kern).length, row.kern_pairs, 'kern pair count');
    assert.equal(largestDifference(JSON.parse(JSON.stringify(answer)), response), 0);
  });
}
