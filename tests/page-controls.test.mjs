// The generated page carries every control the core and each installed plugin
// owns, and the scripts whose order matters load in that order. A plugin that is
// not installed is skipped: dragging its folder out must not fail the suite.
// Optional plugins bring their own page checks (tests/plugins/<name>/page.test.mjs).
//
//   node --test "tests/**/*.test.mjs"

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { build, WEB } from '../tools/build.mjs';

const { html, plugins } = build({ write: false });
const installed = new Set(plugins.map(p => p.name));
const unlessInstalled = name => !installed.has(name) && 'plugin not installed';

const CONTROLS = {
  core: [
    'drag-overlay', 'viewer-container', 'viewer', 'document-title', 'page-count', 'page-input', 'zoom-input',
    'zoom-in', 'zoom-out', 'sidebar', 'toggle-sidebar', 'thumbnail-view', 'prev-page', 'next-page',
    'pdf-file', 'upload-pdf-btn', 'unified-options-bar-container', 'ribbon-more', 'ribbon-overflow',
    'tool-column', 'tool-column-items', 'tool-column-more', 'tool-column-customise', 'tool-column-overflow',
    'toggle-settings', 'settings-panel', 'settings-sections', 'tool-customise', 'tool-customise-list',
  ],
  text_tool: [
    'tt-undo', 'tt-redo', 'toggle-fmt', 'tt-add-text-btn', 'tool-add-box', 'fabric-options-bar',
    'fabric-font-family', 'fabric-font-size', 'fabric-bold', 'fabric-italic', 'fabric-underline',
    'fabric-strikethrough', 'fabric-color', 'kerning', 'fabric-nudge-mode', 'fabric-letter-spacing',
    'fabric-default-sw', 'fabric-space-width', 'fabric-space-width-display', 'toggle-space-labels',
    'utb-delete-box', 'tt-settings', 'tt-match-scope', 'tolerance', 'tt-name-case',
  ],
  webgl_mask: [
    'toggle-webgl', 'webgl-options-bar', 'edge-subtract',
  ],
  embedded_text_viewer: [
    'toggle-embedded-text',
  ],
};

for (const [owner, ids] of Object.entries(CONTROLS)) {
  test(`${owner}: every control is on the page`, { skip: owner !== 'core' && unlessInstalled(owner) }, () => {
    for (const id of ids) assert.ok(html.includes(`id="${id}"`), `#${id} is missing from the generated page`);
  });
}

const inOrder = files => {
  // the <script src> of a file (core/… as it is, a plugin's under plugins/) — not its entry in the asset map
  const at = files.map(file => Math.max(html.indexOf(`src="${file}`), html.indexOf(`src="plugins/${file}`)));
  at.forEach((p, i) => assert.notEqual(p, -1, `${files[i]} is not on the page`));
  assert.deepEqual(at, [...at].sort((a, b) => a - b), `load order: ${files.join(' → ')}`);
};

test('core scripts load in the fixed order, the document service before the viewer', () => {
  inOrder(['core/hooks.js', 'core/geometry.js', 'core/state.js', 'core/doc-service.js', 'core/pdf-viewer.js', 'core/ui-events.js', 'core/app.js']);
});

test('text_tool: the shaper and the catalogue load before the toolbar', { skip: unlessInstalled('text_tool') }, () => {
  inOrder(['text_tool/shaping.js', 'text_tool/fonts.js', 'text_tool/toolbar.js']);
  // Text the user types is a 'harfbuzz' box, never 'embedded'/'ocr': those layers
  // are shown and hidden wholesale, and text just typed must not vanish with them.
  const src = fs.readFileSync(path.join(WEB, 'plugins', 'text_tool', 'text-tool.js'), 'utf8');
  assert.ok(src.slice(src.indexOf('window.handleManualAddText')).includes("type: 'harfbuzz'"));
});

test('embedded_text_viewer: the extractor loads before the fetcher', { skip: unlessInstalled('embedded_text_viewer') }, () => {
  inOrder(['embedded_text_viewer/extract.js', 'embedded_text_viewer/etv-fetch.js']);
});

test('no script, style or fragment of the site calls a server endpoint', () => {
  const dead = /['"`]\/(open-document|open-default|page-image|widths|fonts-list|font-metrics|webgl\/mask|ocr\/cache|embedded-text-viewer\/api)/;
  const offenders = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['vendor', 'assets', 'generated', 'glyphs', 'engine'].includes(e.name)) walk(full); continue; }
      if (!/\.(js|html|css)$/.test(e.name)) continue;
      const code = fs.readFileSync(full, 'utf8').split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
      if (dead.test(code)) offenders.push(path.relative(WEB, full));
    }
  };
  walk(WEB);
  assert.deepEqual(offenders, []);
});
