// redaction_matching on the generated page: its sidebar controls and what api.js must (not) contain.
// Skipped when the plugin is not installed.
//
//   node --test "tests/**/*.test.mjs"

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { build, WEB } from '../../../tools/build.mjs';

const { html, plugins } = build({ write: false });
const skip = !plugins.some(p => p.name === 'redaction_matching') && 'plugin not installed';
const inOrder = files => {
  const at = files.map(file => html.indexOf(`src="plugins/${file}`));
  at.forEach((p, i) => assert.notEqual(p, -1, `${files[i]} is not on the page`));
  assert.deepEqual(at, [...at].sort((a, b) => a - b), `load order: ${files.join(' → ')}`);
};

test('every control is on the page', { skip }, () => {
  for (const id of [
    'ns-starts-with', 'ns-ends-with', 'all-matches-body',
  ]) assert.ok(html.includes(`id="${id}"`), `#${id} is missing from the generated page`);
});

test('redaction_matching: the multi-letter filter replaced the one-letter fields', { skip }, () => {
  assert.ok(!html.includes('ns-first-letter') && !html.includes('maxlength="1"'));
  assert.ok(html.includes('press [ / ]'));
  const src = fs.readFileSync(path.join(WEB, 'plugins', 'redaction_matching', 'api.js'), 'utf8');
  for (const gone of ['firstLetter', 'lastLetter', 'fontFamilyToTtf']) assert.ok(!src.includes(gone), `${gone} is back in api.js`);
  assert.ok(src.includes('ligatures: false'), 'candidate widths are plain advances');
  for (const name of ['matchesLetterFilter', 'getBoxMatchInfo', 'getBoxMatches', 'setBoxMatch', 'cycleBoxMatch',
                      'effectiveTolerance', 'scoreMatches', 'linkFor', 'pairReadings'])
    assert.ok(src.includes(`function ${name}(`), `${name} is defined`);
});
