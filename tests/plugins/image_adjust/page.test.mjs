// image_adjust on the generated page: its controls, and that its filter
// reaches only the page view. Skipped when the plugin is not installed.
//
//   node --test "tests/**/*.test.mjs"

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { build, WEB } from '../../../tools/build.mjs';

const { html, plugins } = build({ write: false });
const skip = !plugins.some(p => p.name === 'image_adjust') && 'plugin not installed';

test('every control is on the page', { skip }, () => {
  for (const id of ['ia-toggle', 'ia-options-bar', 'ia-invert', 'ia-contrast', 'ia-contrast-value', 'ia-brightness',
    'ia-brightness-value', 'ia-preset', 'ia-open-panel', 'ia-bypass', 'ia-reset', 'ia-panel', 'ia-panel-head',
    'ia-panel-close', 'ia-add', 'ia-stack', 'ia-editor', 'ia-rounding', 'ia-export'])
    assert.ok(html.includes(`id="${id}"`), `#${id} is missing from the generated page`);
});

test('the core adjusts before the UI script', { skip }, () => {
  const at = ['image_adjust/adjust-core.js', 'image_adjust/image-adjust.js'].map(f => html.indexOf(`src="plugins/${f}`));
  assert.ok(at[0] > 0 && at[1] > at[0]);
});

test('the filter acts on the page image and the mask overlay only, in sRGB', { skip }, () => {
  const css = fs.readFileSync(path.join(WEB, 'plugins', 'image_adjust', 'styles.css'), 'utf8');
  const bare = css.split('/*').map((part, i) => (i ? part.slice(part.indexOf('*/') + 2) : part)).join('');
  const rule = bare.match(/([^{}]+)\{\s*filter:\s*url\(#ia-filter\)/);
  assert.ok(rule, 'the filter rule');
  const selectors = rule[1].split(',').map(s => s.trim()).filter(Boolean);
  assert.deepEqual(selectors, ['body.ia-on .page-container > img', 'body.ia-on .page-container > canvas.webgl-overlay']);
  const js = fs.readFileSync(path.join(WEB, 'plugins', 'image_adjust', 'image-adjust.js'), 'utf8');
  assert.ok(js.includes('color-interpolation-filters="sRGB"'));
});
