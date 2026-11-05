// A stored read says what it was read with (ocrReadStamp, ocr-result.js), and
// the shipped read of the startup document is the site's own: a sync of the
// engine or the bundle makes it stale, and then every visitor reads live.
//
//   node --test "tests/**/*.test.mjs"

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build, WEB } from '../../../tools/build.mjs';

const PLUGIN = path.join(WEB, 'plugins', 'ocr_tool');
const skip = !fs.existsSync(path.join(PLUGIN, 'ocr-result.js')) && 'plugin not installed';
if (!skip) await import(pathToFileURL(path.join(PLUGIN, 'ocr-result.js')).href);   // a classic script: defines globalThis.ocrReadStamp
const stamp = assets => globalThis.ocrReadStamp(assets);

test('the stamp follows the engine, the bundle and the worker, and nothing else', { skip }, () => {
  const assets = {
    'plugins/ocr_tool/engine/blindocr.js': 'aaaaaaaa', 'plugins/ocr_tool/glyphs/glyphs.bin': 'bbbbbbbb',
    'plugins/ocr_tool/ocr-worker.js': 'cccccccc', 'plugins/ocr_tool/ocr-tool.js': 'dddddddd',
    'plugins/ocr_tool/cache/x.json': 'eeeeeeee', 'plugins/text_tool/engine/x.js': 'ffffffff',
  };
  const base = stamp(assets);
  assert.equal(base, 'engine/blindocr.js:aaaaaaaa glyphs/glyphs.bin:bbbbbbbb ocr-worker.js:cccccccc');
  for (const f of ['plugins/ocr_tool/engine/blindocr.js', 'plugins/ocr_tool/glyphs/glyphs.bin', 'plugins/ocr_tool/ocr-worker.js'])
    assert.notEqual(stamp({ ...assets, [f]: '00000000' }), base, f);
  for (const f of ['plugins/ocr_tool/ocr-tool.js', 'plugins/ocr_tool/cache/x.json', 'plugins/text_tool/engine/x.js'])
    assert.equal(stamp({ ...assets, [f]: '00000000' }), base, f);
  assert.equal(stamp(Object.fromEntries(Object.entries(assets).reverse())), base, 'the order of the map does not matter');
});

test('this site\'s stamp names every engine file and the glyph bundle', { skip }, () => {
  const { assets } = build({ write: false });
  const named = stamp(assets).split(' ').map(s => s.split(':')[0]);
  for (const f of fs.readdirSync(path.join(PLUGIN, 'engine'))) assert.ok(named.includes(`engine/${f}`), f);
  assert.ok(named.includes('glyphs/glyphs.bin'));
  assert.ok(named.includes('ocr-worker.js'));
});

test('every shipped read was read with this site\'s engine and bundle', { skip }, () => {
  const { assets } = build({ write: false });
  const want = stamp(assets);
  const dir = path.join(PLUGIN, 'cache');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  assert.ok(files.length, 'no shipped read');
  for (const f of files) {
    const { readWith } = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.equal(readWith, want, `${f} would not replay: every visitor would read it live. Run tol0's node tools/recto-cache.mjs`);
  }
});
