// web/plugins/base64_tool/b64-core.js — base64 attachments found in read
// text, decoded, typed and named. The real case is EFTA00382083's Airmail.pdf
// as the app's OCR layer reads it (fixtures/efta00382083-ocr-lines.json.gz):
// one block, the PDF its MIME headers name, byte for byte, and MuPDF opens it.
// Skipped when the plugin is not installed.
//
//   node --test "tests/**/*.test.mjs"

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..', '..', '..', 'web', 'plugins', 'base64_tool');
const skip = !fs.existsSync(path.join(PLUGIN, 'plugin.json')) && 'plugin not installed';
if (!skip) await import('../../../web/plugins/base64_tool/b64-core.js');   // a classic script: defines globalThis.B64Core
const C = globalThis.B64Core;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// bytes → MIME-wrapped base64 lines (76 characters), each on `page`
const wrap = (bytes, page = 1, prefix = '') =>
  Buffer.from(bytes).toString('base64').match(/.{1,76}/g).map(text => ({ page, text: prefix + text }));
const prose = (text, page = 1) => ({ page, text });
// deterministic noise
const noise = (n, seed = 7) => Uint8Array.from({ length: n }, () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24);
const PNG = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...noise(300, 3)]);

function airmail() {
  const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(HERE, 'fixtures', 'efta00382083-ocr-lines.json.gz'))));
  return fx.lines.map(([page, text]) => ({ page, text }));
}

test('EFTA00382083: the OCR layer gives one attachment — Airmail.pdf, byte for byte', { skip }, async () => {
  const blocks = C.findBlocks(airmail());
  assert.equal(blocks.length, 1);
  const [b] = blocks;
  assert.deepEqual(b.pages, [3, 24]);
  assert.equal(b.name, 'Airmail.pdf');
  const data = C.decode(b.chars);
  assert.equal(data.length, 81046);
  assert.equal(sha256(data), 'f909dd7c4f77baca9cf5acf77a9d1eb5cf2471e8a32970715c526f49fa112f34');
  const kind = C.sniff(data);
  assert.equal(kind.ext, 'pdf');
  assert.equal(C.viewMime(kind), 'application/pdf');

  const Module = {};
  globalThis.$libmupdf_wasm_Module = Module;
  const mupdf = await import('../../../web/vendor/mupdf/mupdf.js');
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  try { assert.equal(doc.countPages(), 3); } finally { doc.destroy(); }
});

test('a misread "=" at a line end neither splits the file nor shifts its bytes', { skip }, () => {
  const lines = airmail();
  const i = lines.findIndex(l => l.page === 10);                // a body line mid-file
  const bad = lines.map((l, k) => (k === i ? { ...l, text: l.text.slice(0, -1) + '=' } : l));
  const [good] = C.findBlocks(lines), blocks = C.findBlocks(bad);
  assert.equal(blocks.length, 1);
  const a = C.decode(good.chars), b = C.decode(blocks[0].chars);
  assert.equal(b.length, a.length);
  let differ = 0;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) differ++;
  assert.ok(differ >= 1 && differ <= 2, `${differ} bytes differ`);
});

test('decoding: trailing padding is dropped, a mid-stream "=" becomes a placeholder, a stray character goes', { skip }, () => {
  const bytes = noise(120);
  const b64 = Buffer.from(bytes).toString('base64');
  assert.deepEqual([...C.decode(b64)], [...bytes]);
  const misread = b64.slice(0, 40) + '=' + b64.slice(41);
  const out = C.decode(misread);
  assert.equal(out.length, bytes.length);
  assert.deepEqual([...out.slice(32)], [...bytes.slice(32)]);  // everything past the misread is intact
  assert.equal(C.decode(b64 + 'Q').length, bytes.length);       // len % 4 === 1: the stray character is dropped
});

test('a wrapped line\'s overflow (1–3 characters on a line of its own) continues the run', { skip }, () => {
  const lines = wrap(PNG);
  const k = 2;
  const split = [...lines.slice(0, k), { page: 1, text: lines[k].text.slice(0, -2) }, { page: 1, text: lines[k].text.slice(-2) }, ...lines.slice(k + 1)];
  const blocks = C.findBlocks(split);
  assert.equal(blocks.length, 1);
  assert.deepEqual([...C.decode(blocks[0].chars)], [...PNG]);
});

test('padding closes a run: prose or a short base64-looking word after it is not appended', { skip }, () => {
  const txt = new TextEncoder().encode('Hello there, this attachment is a plain text file of some length.\n'.repeat(3) + 'Bye.');
  assert.ok(Buffer.from(txt).toString('base64').endsWith('='));
  for (const after of ['Thanks', '-- boundary --']) {
    const blocks = C.findBlocks([...wrap(txt), prose(after)]);
    assert.equal(blocks.length, 1, after);
    assert.deepEqual([...C.decode(blocks[0].chars)], [...txt], after);
  }
});

test('two attachments back to back: a new file header after padding starts a second block', { skip }, () => {
  const txt = new TextEncoder().encode('A note long enough to be a block, and it ends with padding in base64 form.');
  assert.ok(Buffer.from(txt).toString('base64').endsWith('='));
  const blocks = C.findBlocks([...wrap(txt), ...wrap(PNG)]);
  assert.equal(blocks.length, 2);
  assert.equal(C.sniff(C.decode(blocks[0].chars)).ext, 'txt');
  assert.equal(C.sniff(C.decode(blocks[1].chars)).ext, 'png');
});

test('runs: quote marks are stripped, blank lines are neutral, pages carry on, short or weak runs are no block', { skip }, () => {
  const lines = wrap(PNG, 4, '> ');
  const half = lines.length >> 1;
  const quoted = [...lines.slice(0, half), prose('>', 4), ...lines.slice(half).map(l => ({ ...l, page: 5 }))];
  const [b] = C.findBlocks(quoted);
  assert.deepEqual(b.pages, [4, 5]);
  assert.deepEqual([...C.decode(b.chars)], [...PNG]);
  assert.equal(C.findBlocks([prose('QUJDRA=='), prose('Some words')]).length, 0);             // short
  assert.equal(C.findBlocks(Array.from({ length: 4 }, () => prose('abcdefghijklmnopqrstuvwxyzabcdefghijklmnop'))).length, 0);   // no strong line
});

test('the name the MIME headers declare: Content-Disposition first, RFC 2231, never a path, never past the previous block', { skip }, () => {
  const body = wrap(PNG);
  const named = (...head) => C.findBlocks([...head.map(t => prose(t)), ...body])[0].name;
  assert.equal(named('Content-Type: image/png; name="a.png"', 'Content-Disposition: attachment;', '   filename="photo one.png"', ''), 'photo one.png');
  assert.equal(named('Content-Type: image/png;', '\tname="only-type.png"'), 'only-type.png');
  assert.equal(named("Content-Disposition: attachment; filename*=UTF-8''Gr%C3%BC%C3%9Fe.png"), 'Grüße.png');
  assert.equal(named('Content-Disposition: attachment; filename="..\\..\\evil/../x:y.png"'), 'x_y.png');
  assert.equal(named('Content-Type: image/png'), null);
  // the second block's headers are its own; the first block's name is not borrowed
  const two = C.findBlocks([prose('filename="first.png"'), ...body, prose('--boundary--'), ...body]);
  assert.deepEqual(two.map(b => b.name), ['first.png', null]);
});

test('types are sniffed from the bytes, and each type is viewed as it may be', { skip }, () => {
  const b = (...v) => Uint8Array.from(v.flatMap(x => (typeof x === 'string' ? [...x].map(c => c.charCodeAt(0)) : [x])));
  const ftyp = brand => b(0, 0, 0, 0x18, 'ftyp', brand, ...noise(20));
  const zip = member => b('PK', 3, 4, ...noise(26), member, ...noise(20));
  const tar = Uint8Array.from([...noise(257).map(v => v & 0x7f | 0x20), ...[...'ustar'].map(c => c.charCodeAt(0)), ...noise(30)]);
  const cases = [
    [b('%PDF-1.7\n'), 'pdf', 'inline'], [b('{\\rtf1\\ansi'), 'rtf', 'text'], [b(0xD0, 0xCF, 0x11, 0xE0, 0xA1), 'doc', 'none'],
    [PNG, 'png', 'inline'], [b(0xFF, 0xD8, 0xFF, 0xE0), 'jpg', 'inline'], [b('GIF89a'), 'gif', 'inline'], [b('BM', ...noise(20)), 'bmp', 'inline'],
    [b(0, 0, 1, 0, 1, 0), 'ico', 'inline'], [b('II', 0x2A, 0), 'tif', 'none'], [b('MM', 0, 0x2A), 'tif', 'none'],
    [b('RIFF', 0, 0, 0, 0, 'WEBP'), 'webp', 'inline'], [b('RIFF', 0, 0, 0, 0, 'WAVE'), 'wav', 'inline'], [b('RIFF', 0, 0, 0, 0, 'AVI '), 'avi', 'none'],
    [ftyp('M4A '), 'm4a', 'inline'], [ftyp('qt  '), 'mov', 'inline'], [ftyp('heic'), 'heic', 'none'], [ftyp('avif'), 'avif', 'inline'], [ftyp('isom'), 'mp4', 'inline'],
    [b('ID3', 4, 0), 'mp3', 'inline'], [b('OggS', 0), 'ogg', 'inline'], [b('fLaC'), 'flac', 'inline'],
    [b(0x1A, 0x45, 0xDF, 0xA3, ...noise(8), 'webm'), 'webm', 'inline'], [b(0x1A, 0x45, 0xDF, 0xA3, ...noise(8), 'matroska'), 'mkv', 'none'],
    [zip('word/document.xml'), 'docx', 'none'], [zip('xl/workbook.xml'), 'xlsx', 'none'], [zip('ppt/slides/'), 'pptx', 'none'],
    [b('PK', 3, 4, ...noise(26), 'mimetypeapplication/epub+zip'), 'epub', 'none'], [zip('photos/1.jpg'), 'zip', 'none'],
    [b(0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C), '7z', 'none'], [b('Rar!', 0x1A, 7), 'rar', 'none'], [b(0x1F, 0x8B, 8), 'gz', 'none'], [b('BZh91AY'), 'bz2', 'none'], [tar, 'tar', 'none'],
    [b('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'), 'svg', 'text'], [b('<svg onload="alert(1)"/>'), 'svg', 'text'],
    [b('<?xml version="1.0"?><root/>'), 'xml', 'text'], [b('<!DOCTYPE html><script>alert(1)</script>'), 'html', 'text'],
    [b('{"a": [1, 2]}'), 'json', 'text'], [b('{ not json'), 'txt', 'inline'], [b('From: a@b.c\nSubject: hi\n\nbody'), 'eml', 'text'],
    [new TextEncoder().encode('Grüße aus Zürich — naïve café'), 'txt', 'inline'], [noise(400), 'bin', 'none'],
  ];
  for (const [bytes, ext, view] of cases) {
    const k = C.sniff(bytes);
    assert.equal(k.ext, ext, `expected ${ext}, sniffed ${k.ext} (${k.label})`);
    assert.equal(k.view, view, ext);
    assert.ok(k.mime && k.label && k.icon, ext);
  }
});

test('View never hands the browser markup: text types open as UTF-8 plain text, download-only types not at all', { skip }, () => {
  const html = C.sniff(new TextEncoder().encode('<html><body onload="alert(1)">'));
  assert.equal(C.viewMime(html), 'text/plain;charset=utf-8');
  assert.equal(C.viewMime(C.sniff(new TextEncoder().encode('just words'))), 'text/plain;charset=utf-8');
  assert.equal(C.viewMime(C.sniff(PNG)), 'image/png');
  assert.equal(C.viewMime(C.sniff(Uint8Array.from([0x1F, 0x8B, 8]))), null);
});

test('random bytes are never text: lone high bytes do not count, well-formed UTF-8 does', { skip }, () => {
  let worst = 0;
  for (let n = 0; n < 3000; n++) worst = Math.max(worst, C.textShare(noise(60 + n % 500, n + 1)));
  assert.ok(worst < 0.75, `random bytes reached a text share of ${worst}`);
  assert.equal(C.textShare(new TextEncoder().encode('Grüße — 東京 — 🙂 tab\there\r\n')), 1);
  assert.equal(C.textShare(Uint8Array.from([0xC0, 0x80, 0xED, 0xA0, 0x80])), 0);   // overlong, surrogate
  // a sequence cut by the window's end still counts the bytes inside it
  const s = new TextEncoder().encode('a'.repeat(511) + 'é');
  assert.equal(C.textShare(s), 1);
});
