// ocr_tool's read worker gets the page whitenColored made — the colour law's
// band, the whitened map and the lost ink — not just the grays. Until
// 2026-10-11 only `converted` crossed: on recto-eval's colour pages the
// worker read 203 □ where the same engine on the whole page reads 114.
// Skipped when the plugin is not installed.
//
//   node --test "tests/**/*.test.mjs"

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { WEB } from '../../../tools/build.mjs';

const DIR = path.join(WEB, 'plugins', 'ocr_tool');
const skip = !fs.existsSync(path.join(DIR, 'ocr-worker.js')) && 'plugin not installed';
const FIELDS = ['converted', 'bandLo', 'bandHi', 'whitened', 'lost'];

test('the worker hands the engine every product of whitenColored', { skip }, async () => {
  const seen = [], posted = [];
  const self = { postMessage: m => posted.push(m) };
  const ctx = vm.createContext({
    self, importScripts() {},
    BlindOCR: {
      loadSets: async () => [{}],
      readPageAuto: async page => { seen.push(page); return { res: { lines: [], objects: [] }, pass: {} }; },
    },
    ocrSlimResult: r => r, ocrSlimPass: p => p,
  });
  vm.runInContext(fs.readFileSync(path.join(DIR, 'ocr-worker.js'), 'utf8'), ctx);
  const msg = { type: 'read', id: 1, w: 2, h: 1, gray: new Float32Array(2), setUrls: [], carry: 'none' };
  FIELDS.forEach((k, i) => { msg[k] = new Uint8Array([i, i]); });
  await self.onmessage({ data: msg });
  assert.equal(posted.at(-1).type, 'result', JSON.stringify(posted.at(-1)));
  for (const k of FIELDS) assert.deepEqual(seen[0][k], msg[k], `page.${k}`);
  // a grey page: none of them, and none invented
  await self.onmessage({ data: { type: 'read', id: 2, w: 2, h: 1, gray: new Float32Array(2), setUrls: [], carry: 'none' } });
  for (const k of FIELDS) assert.equal(k in seen[1], false, `page.${k} on a grey page`);
});

test('the adapter posts every product of whitenColored to the worker', { skip }, () => {
  const src = fs.readFileSync(path.join(DIR, 'ocr-tool.js'), 'utf8');
  const start = src.indexOf('function ocrWorkerRead(');
  assert.notEqual(start, -1, 'ocrWorkerRead is in ocr-tool.js');
  let depth = 0, end = src.indexOf('{', start);
  for (let i = end; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const ctx = vm.createContext({ ocrToolState: { workerSeq: 0 } });
  vm.runInContext(src.slice(start, end), ctx);
  const sent = [];
  const page = { w: 2, h: 1, gray: new Float32Array(2) };
  FIELDS.forEach((k, i) => { page[k] = new Uint8Array([i, i]); });
  ctx.ocrWorkerRead({ postMessage: m => sent.push(m) }, page, { setUrls: [], carry: 'none' });
  for (const k of FIELDS) assert.equal(sent[0][k], page[k], `message.${k}`);
});
