// smoke.mjs — the whole static site in a real browser, once per golden document.
//
//   node tests/smoke/smoke.mjs [--chrome <exe>] [--only <golden name>]
//
// Starts tools/serve.mjs on a free port, opens the app headless and, for every
// document of tests/golden/documents.json, uploads it through the real file
// input and then: waits for the page and its text, selects a text box, clicks
// every toolbar toggle and every formatting switch, turns a page — and fails on
// ANY console error, page error or failed request. An installed plugin may add
// its own steps: tests/plugins/<name>/smoke.mjs exporting any of
//   switches           ids to click on and off along with the core's
//   settle(page, doc)  wait until the plugin is done with a freshly opened document
//   exercise(page, doc, note)   drive the plugin's own UI; push remarks onto note
//   quiesce(page)      stop background work before the next document
// Not part of `node --test`: it needs Chrome and takes a minute.
//
// puppeteer-core is not a dependency of this repository (it has none); the
// harness borrows tol0's (../tol0/node_modules), where the OCR engine's own
// browser tests live. Without it the smoke test says so and exits 2.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

const CHROME = option('--chrome') || process.env.CHROME || [
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/snap/bin/chromium', '/usr/bin/microsoft-edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(p => fs.existsSync(p));
const PUPPETEER = [path.join(ROOT, 'node_modules'), path.join(ROOT, '..', 'tol0', 'node_modules')]
  .map(dir => path.join(dir, 'puppeteer-core', 'lib', 'esm', 'puppeteer', 'puppeteer-core.js')).find(p => fs.existsSync(p));
if (!PUPPETEER || !CHROME) {
  console.error(!PUPPETEER ? 'puppeteer-core not found (looked in ./node_modules and ../tol0/node_modules)' : 'no Chrome found — pass --chrome <exe>');
  process.exit(2);
}
const { default: puppeteer } = await import(pathToFileURL(PUPPETEER).href);

const SWITCHES = ['fabric-bold', 'fabric-italic', 'fabric-underline', 'fabric-strikethrough', 'kerning', 'fabric-nudge-mode',
                  'fabric-default-sw', 'toggle-space-labels', 'force-uppercase', 'edge-subtract'];

// the smoke steps of the plugins that are installed and bring some
async function pluginSteps() {
  const steps = [];
  const dir = path.join(ROOT, 'web', 'plugins');
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const file = path.join(ROOT, 'tests', 'plugins', name, 'smoke.mjs');
    if (fs.existsSync(path.join(dir, name, 'plugin.json')) && fs.existsSync(file)) steps.push({ name, ...(await import(pathToFileURL(file).href)) });
  }
  return steps;
}

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function main() {
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join('tools', 'serve.mjs'), String(port)], { cwd: ROOT, stdio: 'ignore' });
  const steps = await pluginSteps();
  let browser, failures = 0;
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(base)).ok) break; } catch { /* not up yet */ }
      if (i > 100) throw new Error('tools/serve.mjs did not come up');
      await new Promise(r => setTimeout(r, 100));
    }
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(120000);
    const problems = [];
    page.on('pageerror', e => problems.push(`page error: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('requestfailed', r => { if (!r.url().startsWith('blob:')) problems.push(`request failed: ${r.url()}`); });
    page.on('response', r => { if (r.status() >= 400) problems.push(`${r.status()}: ${r.url()}`); });

    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof Doc !== 'undefined' && Doc.info && Doc.info.pdfFonts && state.numPages > 0);
    console.log(`startup document: ${await page.evaluate(() => `${Doc.info.numPages} pages, ${Math.round(Doc.timings.totalMs)} ms`)}`);

    const only = option('--only');
    const documents = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'golden', 'documents.json'), 'utf8'))
      .filter(d => !only || d.name === only)
      .filter(d => fs.existsSync(path.join(ROOT, d.source)) || (console.log(`skip ${d.name.padEnd(14)} ${d.source} is not here`), false));

    for (const d of documents) {
      const before = problems.length, t0 = Date.now();
      const note = [];
      await (await page.$('#pdf-file')).uploadFile(path.join(ROOT, d.source));
      await page.waitForFunction(hash => state.docHash === hash && Doc.info?.pdfFonts && document.getElementById('page1')?.naturalWidth > 0, {}, d.sha256);
      note.push(`${await page.evaluate(() => state.numPages)} p`);

      // the text of page 1, once every plugin is done with the new document
      for (const step of steps) await step.settle?.(page, d);
      await page.waitForFunction(() => typeof _utbFetchState === 'undefined' || _utbFetchState.hydrated.has(1) || !_utbFetchState.anyText || state.numPages === 1, { timeout: 30000 }).catch(() => {});
      const boxes = await page.evaluate(() => typeof utbState === 'undefined' ? 0 : utbState.boxes.filter(b => b.page === 1).length);
      note.push(`${boxes} boxes on page 1`);

      // select a box the way a user does
      const group = await page.$('.utb-group');
      if (group) { await group.click().catch(() => {}); note.push('box selected'); }

      // every toolbar toggle twice (open, close), every formatting switch twice (on, off)
      const clicked = await page.evaluate((ids) => {
        const toolbar = [...document.querySelectorAll('header button[id^="toggle-"]')].map(b => b.id);
        let n = 0;
        for (const id of [...toolbar, ...ids]) for (let k = 0; k < 2; k++) { const el = document.getElementById(id); if (el) { el.click(); n++; } }
        return n;
      }, [...SWITCHES, ...steps.flatMap(step => step.switches || [])]);
      note.push(`${clicked} clicks`);

      for (const step of steps) await step.exercise?.(page, d, note);

      // the next page, where there is one
      if (d.num_pages > 1) {
        await page.evaluate(() => document.getElementById('next-page').click());
        await page.waitForFunction(() => state.currentPage === 2 && document.getElementById('page2')?.naturalWidth > 0);
        note.push('page 2');
      }
      await new Promise(r => setTimeout(r, 500));
      for (const step of steps) await step.quiesce?.(page);

      const found = problems.slice(before);
      failures += found.length;
      console.log(`${found.length ? 'FAIL' : 'ok  '} ${d.name.padEnd(14)} ${note.join(' · ')} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      for (const p of found.slice(0, 8)) console.log(`       ${p}`);
    }
  } finally {
    await browser?.close();
    server.kill();
  }
  console.log(failures ? `FAIL — ${failures} problem(s)` : 'PASS');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
