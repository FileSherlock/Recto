// words.txt is the refiner's English dictionary: one lowercase word per line,
// most frequent first (built by redaction_refiner/words_build.py). And the
// geometry fixture is a real page. Skipped when the plugin is not installed.
//
//   node --test "tests/**/*.test.mjs"

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..', '..', '..', 'web', 'plugins', 'redaction_refiner');
const skip = !fs.existsSync(path.join(PLUGIN, 'plugin.json')) && 'plugin not installed';
const words = skip ? [] : fs.readFileSync(path.join(PLUGIN, 'words.txt'), 'utf8').split(/\r?\n/).filter(Boolean);

test('the word list ships with its licence', { skip }, () => {
  assert.ok(fs.existsSync(path.join(PLUGIN, 'words.LICENSE.txt')));
});

test('shape: many words, no duplicates, lowercase ASCII letters, "a" and "i" the only singles', { skip }, () => {
  assert.ok(words.length > 10_000);
  assert.equal(new Set(words).size, words.length, 'duplicates');
  assert.deepEqual(words.filter(w => !/^[a-z]+$/.test(w)), []);
  assert.deepEqual(words.filter(w => w.length === 1).sort(), ['a', 'i']);
});

test('frequency order puts "and" first among the -nd words', { skip }, () => {
  // The refiner ranks fragment completions by list order: "nd" → "and".
  assert.equal(words.find(w => w.endsWith('nd')), 'and');
  assert.ok(words.indexOf('the') < 5);
});

test('web junk is filtered out, real words are in', { skip }, () => {
  for (const junk of ['www', 'http', 'xxx', 'pdf', 'cgi', 'nd']) assert.ok(!words.includes(junk), junk);
  for (const word of ['including', 'and', 'the', 'device', 'financial']) assert.ok(words.includes(word), word);
});

test('the geometry fixture is a real page', () => {
  const fx = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'efta_rows.json'), 'utf8'));
  const texts = fx.spans.map(s => s.text);
  assert.ok(texts.some(t => t.includes('including')));
  assert.ok(texts.some(t => t.startsWith('nd GHISLAINE')));
  assert.equal(fx.bars.length, 2);
});
