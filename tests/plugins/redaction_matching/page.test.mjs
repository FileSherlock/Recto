// redaction_matching on the generated page: its panel and what api.js must (not) contain.
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

test('the panel is on the page', { skip }, () => {
  for (const id of [
    'tools-sidebar', 'toggle-tools', 'rm-bar', 'name-input', 'rm-try', 'rm-format', 'rm-format-sum',
    'ns-starts-with', 'ns-ends-with', 'rm-names', 'rm-names-sum',
  ]) assert.ok(html.includes(`id="${id}"`), `#${id} is missing from the generated page`);
  // the old candidates table and All Matches card are gone, and no control is wired inline
  for (const gone of ['names-body', 'all-matches-body', 'paste-input', 'onclick=']) {
    const panel = html.slice(html.indexOf('<aside id="tools-sidebar"'), html.indexOf('</aside>', html.indexOf('<aside id="tools-sidebar"')));
    assert.ok(!panel.includes(gone), `${gone} is back in the panel`);
  }
});

test('redaction_matching: api.js keeps its seams and measures plain advances', { skip }, () => {
  const src = fs.readFileSync(path.join(WEB, 'plugins', 'redaction_matching', 'api.js'), 'utf8');
  for (const gone of ['firstLetter', 'lastLetter', 'fontFamilyToTtf']) assert.ok(!src.includes(gone), `${gone} is back in api.js`);
  assert.ok(src.includes('ligatures: false'), 'candidate widths are plain advances');
  assert.ok(src.includes('press [ / ]'), 'the panel says how to cycle a bar\'s names');
  for (const name of ['matchesLetterFilter', 'getBoxMatchInfo', 'getBoxMatches', 'setBoxMatch', 'cycleBoxMatch',
                      'effectiveTolerance', 'scoreMatches', 'linkFor', 'pairReadings',
                      // called by name from Recto (text_tool, embedded_text_viewer, ocr_tool, redaction_refiner)
                      'createNewRedaction', 'calculateWidthsForRedaction', 'calculateAllWidths', 'selectRedaction',
                      'updateAllMatchesView', 'renderCandidates', 'syncNameSettingsUI', 'handleManualAddBox'])
    assert.ok(new RegExp(`function ${name}\\(`).test(src), `${name} is defined`);
});
