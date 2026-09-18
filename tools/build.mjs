#!/usr/bin/env node
// build.mjs — the scan step of the static site. Zero dependencies.
//
//   node tools/build.mjs          write web/index.html and web/generated/*
//
// A static host cannot list directories, so plugin discovery happens here, at
// build time: every folder under web/plugins/ that holds a
// plugin.json is a plugin. Its HTML fragments are inlined into
// web/core/index.template.html at the @plugins:* markers, its styles and
// scripts are emitted in the fixed load order, and every local URL gets the
// first 8 hex digits of the file's sha256 as its cache-buster. Dropping a
// folder in adds the plugin; deleting the folder removes every trace of it.
//
// tools/serve.mjs imports build() and runs it on each request for index.html,
// so in development the scan is always current. Nothing is transpiled or
// bundled.
//
// Outputs:
//   web/index.html                      GENERATED — never edited by hand
//   web/generated/plugins.json          the plugins found, in load order
//   web/generated/fonts.json            the font catalogue + which files exist
//   web/generated/default-document.json the startup document, or { "file": null }

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB = path.join(ROOT, 'web');

const SLOTS_ONE = ['toolbar_button', 'options_bar', 'ribbon_bar', 'sidebar'];
const SLOTS_MANY = ['styles', 'scripts_before_viewer', 'scripts_after_app'];
const FALLBACK_FAMILY = 'Times New Roman';

// ── content hashes (cached by mtime + size: the dev server rebuilds often) ──

const hashCache = new Map();

function hash8(file) {
  const st = fs.statSync(file);
  const key = `${st.mtimeMs}:${st.size}`;
  const have = hashCache.get(file);
  if (have && have.key === key) return have.hash;
  const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 8);
  hashCache.set(file, { key, hash });
  return hash;
}

const posix = p => p.split(path.sep).join('/');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// ── plugins ────────────────────────────────────────────────────────────────

function readPlugins(absent = []) {
  const dir = path.join(WEB, 'plugins');
  const plugins = [];
  if (!fs.existsSync(dir)) return plugins;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || absent.includes(entry.name)) continue;
    const manifest = path.join(dir, entry.name, 'plugin.json');
    if (!fs.existsSync(manifest)) continue;
    let p;
    try { p = JSON.parse(fs.readFileSync(manifest, 'utf8')); }
    catch (e) { throw new Error(`${posix(path.relative(ROOT, manifest))}: ${e.message}`); }
    if (p.name !== entry.name)
      throw new Error(`plugins/${entry.name}/plugin.json: "name" is ${JSON.stringify(p.name)}, the folder is "${entry.name}"`);
    for (const slot of SLOTS_MANY) {
      p[slot] = p[slot] ?? [];
      if (!Array.isArray(p[slot])) throw new Error(`plugins/${p.name}/plugin.json: "${slot}" must be a list`);
    }
    for (const slot of SLOTS_ONE) p[slot] = p[slot] ?? null;
    for (const file of [...SLOTS_MANY.flatMap(s => p[s]), ...SLOTS_ONE.map(s => p[s]).filter(Boolean)])
      if (!fs.existsSync(path.join(dir, p.name, file)))
        throw new Error(`plugins/${p.name}/plugin.json names "${file}", which does not exist`);
    p.order = Number.isFinite(p.order) ? p.order : 1000;
    plugins.push(p);
  }
  return plugins.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

function fragment(plugin, file) {
  const text = fs.readFileSync(path.join(WEB, 'plugins', plugin.name, file), 'utf8');
  if (/\{%|\{\{/.test(text))
    throw new Error(`plugins/${plugin.name}/${file} contains a template tag ({% … %} or {{ … }}) — fragments are plain HTML`);
  return text.replace(/\s+$/, '');
}

// ── generated data ─────────────────────────────────────────────────────────

function fontCatalogue() {
  const dir = path.join(WEB, 'assets', 'fonts');
  let catalogue = { families: [] };
  try { catalogue = JSON.parse(fs.readFileSync(path.join(dir, 'fonts.json'), 'utf8')); } catch { /* no catalogue: no fonts */ }
  const families = (catalogue.families || []).map(fam => {
    const files = fam.files || {};
    const present = {}, hashes = {};
    for (const [style, file] of Object.entries(files)) {
      present[style] = fs.existsSync(path.join(dir, file));
      if (present[style]) hashes[style] = hash8(path.join(dir, file));
    }
    return { family: fam.family, class: fam.class || '', note: fam.note || '',
             pdfNames: fam.pdfNames || [], files, present, hashes };
  });
  const usable = f => f && f.present.regular;
  const fallback = families.find(f => f.family === FALLBACK_FAMILY);
  const def = usable(fallback) ? fallback : families.find(usable);
  return { families, default: def ? def.family : FALLBACK_FAMILY, static: 'assets/fonts/' };
}

// The startup document: the PDF directly in web/assets/pdfs/ (alphabetically
// first when there are several; subfolders are ignored on purpose).
function defaultDocument() {
  const dir = path.join(WEB, 'assets', 'pdfs');
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.pdf')).map(e => e.name)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  } catch { /* no folder: no startup document */ }
  if (!names.length) return { file: null };
  const full = path.join(dir, names[0]);
  return { file: `assets/pdfs/${names[0]}`, name: names[0], bytes: fs.statSync(full).size, v: hash8(full) };
}

// Every file of the core, of web/vendor/ and of each plugin → its hash, so a script that
// fetches a sibling itself (a worker, a word list, a glyph bundle) can ask
// assetURL() for a content-hashed URL instead of hand-bumping a version.
function assetMap(plugins) {
  const map = {};
  const roots = [path.join(WEB, 'core'), path.join(WEB, 'vendor'), ...plugins.map(p => path.join(WEB, 'plugins', p.name))];
  for (const root of roots.filter(r => fs.existsSync(r)))
    for (const file of walk(root)) {
      const rel = posix(path.relative(WEB, file));
      if (rel === 'core/index.template.html' || rel.endsWith('/plugin.json')) continue;
      map[rel] = hash8(file);
    }
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

// ── index.html ─────────────────────────────────────────────────────────────

const isLocal = url => !/^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(url);

function render(template, plugins, assets) {
  const url = rel => `${rel}?v=${assets[rel] ?? hash8(path.join(WEB, rel))}`;
  const lines = (p, slot, make) => p[slot].map(f => make(url(`plugins/${p.name}/${f}`)));
  const blocks = {
    styles: plugins.flatMap(p => lines(p, 'styles', u => `<link rel="stylesheet" href="${u}">`)),
    toolbar_buttons: plugins.filter(p => p.toolbar_button).map(p => fragment(p, p.toolbar_button)),
    // Per plugin: its persistent ribbon bar, then its options bar.
    bars: plugins.flatMap(p => [p.ribbon_bar, p.options_bar].filter(Boolean).map(f => fragment(p, f))),
    sidebars: plugins.filter(p => p.sidebar).map(p => fragment(p, p.sidebar)),
    scripts_before_viewer: plugins.flatMap(p => lines(p, 'scripts_before_viewer', u => `<script src="${u}"></script>`)),
    scripts_after_app: plugins.flatMap(p => lines(p, 'scripts_after_app', u => `<script src="${u}"></script>`)),
  };

  const seen = new Set();
  let html = template.replace(/^([ \t]*)<!-- @plugins:(\w+) -->[ \t]*\n/gm, (_, indent, slot) => {
    if (!(slot in blocks)) throw new Error(`index.template.html: unknown marker @plugins:${slot}`);
    seen.add(slot);
    return blocks[slot].map(b => indent + b + '\n').join('');
  });
  for (const slot of Object.keys(blocks))
    if (!seen.has(slot)) throw new Error(`index.template.html: marker @plugins:${slot} is missing`);

  // The asset map, for assetURL() in core/hooks.js.
  if (!html.includes('<!-- @assets -->')) throw new Error('index.template.html: marker @assets is missing');
  html = html.replace('<!-- @assets -->', `<script>window.RECTO_ASSETS = ${JSON.stringify(assets)};</script>`);

  // Content-hash every remaining local src/href (the template's own core files).
  html = html.replace(/\b(src|href)="([^"?#]+)"/g, (m, attr, value) => {
    if (!isLocal(value)) return m;
    const file = path.join(WEB, value);
    return fs.existsSync(file) && fs.statSync(file).isFile() ? `${attr}="${url(posix(value))}"` : m;
  });

  return '<!-- GENERATED by tools/build.mjs from web/core/index.template.html and web/plugins/*/plugin.json — do not edit. -->\n' + html;
}

// ── entry points ───────────────────────────────────────────────────────────

function writeIfChanged(file, text) {
  try { if (fs.readFileSync(file, 'utf8') === text) return; } catch { /* new file */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const json = obj => JSON.stringify(obj, null, 1) + '\n';

// `absent` names plugin folders to treat as not there — how the tests drag a
// plugin out without moving files that other test files are reading.
export function build({ write = true, absent = [] } = {}) {
  const plugins = readPlugins(absent);
  const assets = assetMap(plugins);
  const template = fs.readFileSync(path.join(WEB, 'core', 'index.template.html'), 'utf8');
  const html = render(template, plugins, assets);
  const generated = {
    'plugins.json': json(plugins.map(p => ({ ...p, base: `plugins/${p.name}/` }))),
    'fonts.json': json(fontCatalogue()),
    'default-document.json': json(defaultDocument()),
  };
  if (write) {
    writeIfChanged(path.join(WEB, 'index.html'), html);
    for (const [name, text] of Object.entries(generated))
      writeIfChanged(path.join(WEB, 'generated', name), text);
  }
  return { html, plugins, assets, generated };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { plugins } = build();
    console.log(`web/index.html — ${plugins.length} plugin${plugins.length === 1 ? '' : 's'}: ${plugins.map(p => p.name).join(', ') || '(none)'}`);
  } catch (e) {
    console.error('build failed: ' + e.message);
    process.exit(1);
  }
}
