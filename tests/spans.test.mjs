// web/plugins/embedded_text_viewer/extract.js against the recorded reference
// spans: for every golden PDF page the spans — full (per-character positions)
// and lean — equal the recording's to within 1e-6.
//
//   node --test tests/*.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GOLDEN = path.join(HERE, 'golden');

const Module = { printErr() {} };
globalThis.$libmupdf_wasm_Module = Module;
const mupdf = await import('../web/vendor/mupdf/mupdf.js');
const { openPdf } = await import('../web/core/pdf-document.js');
await import('../web/plugins/embedded_text_viewer/extract.js');      // a classic script: defines globalThis.EtvExtract
const { extractSpans, leanSpan, pyRound } = globalThis.EtvExtract;

const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const readGz = file => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));

// Deep equality with a numeric tolerance; returns the first difference as a path, or null.
function firstDifference(a, b, where = '') {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-6 ? null : `${where}: ${a} != ${b}`;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b ? null : `${where}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${where}: array vs object`;
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.join() !== kb.join()) return `${where}: keys [${ka}] != [${kb}]`;
  for (const k of ka) { const d = firstDifference(a[k], b[k], `${where}.${k}`); if (d) return d; }
  return null;
}

test('pyRound rounds the exact binary value, ties to even — like Python', () => {
  assert.equal(pyRound(0.125, 2), 0.12);
  assert.equal(pyRound(0.375, 2), 0.38);
  assert.equal(pyRound(2.675, 2), 2.67);      // 2.675 is below the tie in binary
  assert.equal(pyRound(1.005, 2), 1.0);
  assert.equal(pyRound(-0.125, 2), -0.12);
  assert.equal(pyRound(11.46, 4), 11.46);
  assert.equal(pyRound(0.5, 0), 0);
  assert.equal(pyRound(1.5, 0), 2);
  assert.equal(pyRound(2.5, 0), 2);
});

const documents = readJSON(path.join(GOLDEN, 'documents.json')).filter(d => d.source.toLowerCase().endsWith('.pdf'));

for (const d of documents) {
  // a sample that is not in this checkout (tests/samples/ holds a 66 MB one) is skipped, never failed
  const skip = !fs.existsSync(path.join(ROOT, d.source)) && `${d.source} is not here`;
  test(`${d.name}: spans equal the goldens, full and lean`, { skip }, () => {
    const full = readGz(path.join(GOLDEN, d.name, 'spans-full.json.gz'));
    const lean = readJSON(path.join(GOLDEN, d.name, 'spans-lean.json'));
    const pdf = openPdf(mupdf, Module, fs.readFileSync(path.join(ROOT, d.source)));
    try {
      let count = 0;
      for (const n of d.pages) {
        const rect = pdf.pageImageRect(n) || pdf.pageRect(n);
        const spans = extractSpans(pdf.structuredText(n), n, rect);
        count += spans.length;
        assert.equal(spans.length, full[n].spans.length, `page ${n}: span count`);
        assert.equal(firstDifference(spans, full[n].spans, `page ${n}`), null);
        assert.equal(firstDifference(spans.map(leanSpan), lean[n].spans, `page ${n} (lean)`), null);
        assert.equal(full[n].num_pages, pdf.numPages);
      }
      assert.ok(count > 0, 'the document has text');
    } finally { pdf.close(); }
  });
}
