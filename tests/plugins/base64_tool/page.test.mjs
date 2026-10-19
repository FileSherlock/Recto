// base64_tool on the generated page: its tool, its docked Attachments panel,
// and the core loading before the panel's script. Skipped when the plugin is
// not installed.
//
//   node --test "tests/**/*.test.mjs"

import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from '../../../tools/build.mjs';

const { html, plugins } = build({ write: false });
const skip = !plugins.some(p => p.name === 'base64_tool') && 'plugin not installed';

test('every control is on the page', { skip }, () => {
  for (const id of ['toggle-b64-tool', 'b64-badge', 'b64-panel', 'b64-scan', 'b64-close', 'b64-status', 'b64-cards'])
    assert.ok(html.includes(`id="${id}"`), `#${id} is missing from the generated page`);
  assert.ok(!html.includes('id="b64-tool-bar"'), 'the old options bar is gone');
});

test('the panel is a docked side panel, after the page', { skip }, () => {
  const tag = html.match(/<aside id="b64-panel"[^>]*>/)?.[0];
  assert.ok(tag && /\bdata-side-panel\b/.test(tag) && /\bclass="[^"]*\bhidden\b/.test(tag), tag);
  assert.ok(html.indexOf('id="b64-panel"') > html.indexOf('id="viewer-container"'));
});

test('the core loads before the panel\'s script', { skip }, () => {
  const at = ['base64_tool/b64-core.js', 'base64_tool/base64-tool.js'].map(f => html.indexOf(`src="plugins/${f}`));
  assert.ok(at[0] > 0 && at[1] > at[0]);
});
