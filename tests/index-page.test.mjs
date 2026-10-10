// The generated index.html against the recorded page (tests/golden/index.html):
// the same script order, once URLs are normalised. Also the drag-out property
// of the scan: a plugin that is not there leaves no trace.
//
//   node --test tests/*.test.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build, WEB } from '../tools/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The recorded page's /static/<app>/… URLs and the build's relative,
// content-hashed URLs name the same files; bring both to one form without a version.
function normalise(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')                                      // comments are not DOM
    .replace(/<script>window\.RECTO_ASSETS = .*?<\/script>/, '')          // the build's asset map (new)
    .replace(/<script src="core\/doc-service\.js[^"]*"><\/script>/, '')   // the document service (new)
    .replace(/<script src="plugins\/embedded_text_viewer\/extract\.js[^"]*"><\/script>/, '')   // the extractor (new)
    .replace(/<script src="plugins\/text_tool\/shaping\.js[^"]*"><\/script>/, '')             // HarfBuzz measurement (new)
    .replace(/<script src="plugins\/text_tool\/undo\.js[^"]*"><\/script>/, '')                // the undo stack (new)
    .replace(/<script src="plugins\/text_tool\/(story-core|story-render|story-edit|frame-tool|artistic-tool|text-studio)\.js[^"]*"><\/script>/g, '')   // Artistic and Frame text, the Text panel (new)
    .replace(/<script src="plugins\/image_adjust\/[^"]*"><\/script>/g, '')                     // view adjustments: Curves, Invert, … (a new plugin)
    .replace(/<script src="plugins\/ocr_tool\/box-rules\.js[^"]*"><\/script>/, '')             // which boxes are redactions (new)
    // Fabric.js (gone): the recorded page loaded it from cdnjs, with a polyfill for a warning it
    // caused, long after the last call into it had been removed — the page loads no outside script
    .replace(/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/fabric\.js\/[^"]*"><\/script>/, '')
    .replace(/<script>\s*const originalTextBaseline =[\s\S]*?<\/script>/, '')
    .replace(/\/static\/text_tool\/geometry\.js/g, 'core/geometry.js')    // geometry.js moved into the core
    .replace(/\/static\/pdf_core\//g, 'core/')
    .replace(/\/static\/(\w+)\//g, 'plugins/$1/')
    .replace(/((?:src|href)="(?:core|plugins)\/[^"?]*)\?v=[^"]*"/g, '$1"')
    .split('\n').map(line => line.trim()).filter(Boolean).join('\n');
}

const scripts = html => [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map(m => m[1]);

test('the scripts load in the recorded order', () => {
  // The recorded page (tests/golden/index.html) is the record of the script
  // order the plugins were written against; the markup itself has since moved
  // on by design (no Fabric.js, a tool column, a settings panel) and is not
  // compared any more.
  const golden = normalise(fs.readFileSync(path.join(HERE, 'golden', 'index.html'), 'utf8'));
  const built = normalise(build({ write: false }).html);
  assert.deepEqual(scripts(built), scripts(golden), 'script order');
});

test('every plugin fragment is inlined once, at its slot, in plugin order', () => {
  const { html, plugins } = build({ write: false });
  const squash = s => s.replace(/\s+/g, ' ').trim();
  const page = squash(html);
  for (const slot of ['toolbar_button', 'ribbon_bar', 'options_bar', 'sidebar', 'settings']) {
    let last = -1;
    for (const p of plugins) {
      if (!p[slot]) continue;
      const frag = squash(fs.readFileSync(path.join(WEB, 'plugins', p.name, p[slot]), 'utf8'));
      const at = page.indexOf(frag);
      assert.notEqual(at, -1, `${p.name}/${p[slot]} is not on the page`);
      assert.equal(page.indexOf(frag, at + 1), -1, `${p.name}/${p[slot]} is on the page twice`);
      assert.ok(at > last, `${p.name}/${p[slot]} is out of plugin order`);
      last = at;
    }
  }
});

test('the page loads no script from another origin', () => {
  // a document never leaves the browser — and no third party is handed the means to change that
  const outside = scripts(build({ write: false }).html).filter(src => /^([a-z][a-z0-9+.-]*:)?\/\//i.test(src));
  assert.deepEqual(outside, []);
});

test('every local URL of the page carries the content hash of an existing file', () => {
  const { html } = build({ write: false });
  const local = [...html.matchAll(/\b(?:src|href)="((?:core|plugins)\/[^"]+)"/g)].map(m => m[1]);
  assert.ok(local.length > 20);
  for (const url of local) {
    const [file, query] = url.split('?');
    assert.match(query || '', /^v=[0-9a-f]{8}$/, url);
    assert.ok(fs.existsSync(path.join(WEB, file)), url);
  }
});

test('a plugin that is not there leaves no trace on the page', () => {
  // The folders stay where they are (other test files read them, in parallel):
  // build({ absent }) scans as if the folder had been dragged out. The real
  // drag-out — folder moved, page reloaded, console clean — is the browser check.
  const plugins = build({ write: false }).plugins.map(p => p.name);
  assert.ok(plugins.length > 0);
  for (const name of plugins) {
    const without = build({ write: false, absent: [name] });
    assert.ok(!without.plugins.some(p => p.name === name));
    assert.ok(!without.html.includes(`plugins/${name}/`), `${name} is still referenced by the page`);
    assert.ok(!Object.keys(without.assets).some(k => k.startsWith(`plugins/${name}/`)));
    assert.equal(without.plugins.length, plugins.length - 1);
  }
  const none = build({ write: false, absent: plugins });
  assert.ok(!/(src|href)="plugins\/|"plugins\//.test(none.html), 'the core alone refers to no plugin file');
});

test('a plugin overlaid from a folder of its own is built from that folder', () => {
  // How a plugin developed in a repository of its own runs in the site before it
  // is synced in (build({ overlay }), tools/serve.mjs --plugin): a copy of an
  // installed plugin with one fragment marked stands in for web/plugins/<name>/.
  const p = build({ write: false }).plugins.find(q => q.toolbar_button);
  assert.ok(p, 'some plugin has a toolbar button');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recto-overlay-'));
  try {
    const folder = path.join(tmp, p.name);
    fs.cpSync(path.join(WEB, 'plugins', p.name), folder, { recursive: true });
    const marked = path.join(folder, p.toolbar_button);
    fs.appendFileSync(marked, '\n<span id="overlay-probe"></span>\n');
    const { html, assets, generated } = build({ write: false, overlay: { [p.name]: folder } });
    assert.ok(html.includes('id="overlay-probe"'), 'the fragment is read from the overlay');
    assert.ok(!build({ write: false }).html.includes('overlay-probe'), 'and only with it');
    assert.equal(assets[`plugins/${p.name}/${p.toolbar_button}`],
                 createHash('sha256').update(fs.readFileSync(marked)).digest('hex').slice(0, 8), 'hashes are the overlay files\'');
    assert.ok(!generated['plugins.json'].includes(tmp), 'no local path reaches plugins.json');

    // a plugin web/plugins/ does not hold joins the page; its name must be its folder's
    const extra = path.join(tmp, 'overlay_probe');
    fs.mkdirSync(extra);
    fs.writeFileSync(path.join(extra, 'plugin.json'), JSON.stringify({ name: 'overlay_probe', scripts_after_app: ['probe.js'] }));
    fs.writeFileSync(path.join(extra, 'probe.js'), '// probe\n');
    const more = build({ write: false, overlay: { overlay_probe: extra } });
    assert.ok(more.plugins.some(q => q.name === 'overlay_probe'));
    assert.match(more.html, /<script src="plugins\/overlay_probe\/probe\.js\?v=[0-9a-f]{8}"><\/script>/);
    assert.throws(() => build({ write: false, overlay: { other_name: extra } }), /"name" is "overlay_probe"/);
    assert.throws(() => build({ overlay: { overlay_probe: extra } }), /never written/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
