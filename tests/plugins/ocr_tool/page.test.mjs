// ocr_tool on the generated page: its controls, and the engine loading before the adapters.
// Skipped when the plugin is not installed.
//
//   node --test "tests/**/*.test.mjs"

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { build, WEB } from '../../../tools/build.mjs';

const { html, plugins } = build({ write: false });
const skip = !plugins.some(p => p.name === 'ocr_tool') && 'plugin not installed';
const inOrder = files => {
  const at = files.map(file => html.indexOf(`src="plugins/${file}`));
  at.forEach((p, i) => assert.notEqual(p, -1, `${files[i]} is not on the page`));
  assert.deepEqual(at, [...at].sort((a, b) => a - b), `load order: ${files.join(' → ')}`);
};

test('every control is on the page', { skip }, () => {
  for (const id of [
    'toggle-ocr-tool', 'ocr-tool-bar', 'ocr-run-page', 'ocr-run-all', 'ocr-toggle-text', 'ocr-cancel',
    'ocr-pixel-view', 'ocr-pixel-diff', 'ocr-status',
  ]) assert.ok(html.includes(`id="${id}"`), `#${id} is missing from the generated page`);
});

test('ocr_tool: the engine loads before the adapters that use it', { skip }, () => {
  inOrder(['ocr_tool/engine/core.js', 'ocr_tool/engine/ocr.js', 'ocr_tool/engine/ocr-engine.js', 'ocr_tool/engine/blindocr.js',
           'ocr_tool/engine/render.js', 'ocr_tool/engine/set-fonts.js', 'ocr_tool/ocr-tool.js', 'ocr_tool/pixel-view.js']);
});
