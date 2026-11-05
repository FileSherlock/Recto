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

test('a misread "=" at the end of an uncertified line neither splits the file nor shifts its bytes; a certified one closes the body', { skip }, () => {
  const lines = airmail();
  const i = lines.findIndex(l => l.page === 10);                // a body line mid-file
  const planted = l => ({ ...l, text: l.text.slice(0, -1) + '=' });
  assert.equal(C.findBlocks(lines.map((l, k) => (k === i ? planted(l) : l))).length, 2, 'the read certified the "=": it is on the page');
  const bad = lines.map((l, k) => (k === i ? { ...planted(l), tol: 4 } : l));
  const [good] = C.findBlocks(lines), blocks = C.findBlocks(bad);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].damage.some(d => d[2] === 'read at tolerance 4'));
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
    [PNG, 'png', 'inline'], [b(0xFF, 0xD8, 0xFF, 0xE0), 'jpg', 'inline'], [b('GIF89a'), 'gif', 'inline'], [b('BM', ...noise(40)), 'bmp', 'inline'],
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
  assert.equal(C.textShare(s, 512), 1);
});

// ── what a line is to a body, what a body may be called: tol0's rules (its
// test/b64.test.js holds the same cases to tools/b64/). Synthetic throughout.
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const seeded = seed => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const randomB64 = (n, r) => { let s = ''; while (s.length < n) s += ALPHA[Math.floor(r() * 64)]; return s; };
const randomBytes = (n, r) => Buffer.from(Array.from({ length: n }, () => Math.floor(r() * 256)));
const plain = (text, page = 1) => ({ page, text });
const wrapAt = (s, w) => s.match(new RegExp(`.{1,${w}}`, 'g'));
const only = (rows, what) => rows.filter(o => o.what === what);

test('pieceOf: the base64 of a line, the marker and the printer\'s marks taken off', { skip }, () => {
  const r = seeded(11), a = randomB64(76, r), s = randomB64(30, r);
  assert.deepEqual([C.pieceOf(a).t, C.pieceOf(a).soft, C.pieceOf(a).head, C.pieceOf(a).tail], [a, false, null, null]);
  assert.equal(C.pieceOf(`> > ${a}`).t, a, 'quote marks');
  assert.deepEqual([C.pieceOf(`${a}-`).t, C.pieceOf(`${a}-`).soft], [a, true], 'the printer\'s soft hyphen');
  assert.deepEqual([C.pieceOf(`${s}/-`).t, C.pieceOf(`${s}/-`).soft], [`${s}/`, true], 'after the / it also breaks at');
  let q = C.pieceOf(`<my:field1>${a}-`);
  assert.deepEqual([q.t, q.soft, q.head.kind, q.head.name, q.off], [a, true, 'xml', 'my:field1', 11]);
  q = C.pieceOf('Zz=</-');
  assert.deepEqual([q.t, q.tail], ['Zz=', 'close-tag'], 'a closing tag wrapped by the printer');
  q = C.pieceOf(`-----BEGIN SOME BLOCK V3----- ${a}`);
  assert.deepEqual([q.t, q.head.kind, q.head.name], [a, 'armor', 'SOME BLOCK V3']);
  q = C.pieceOf('dGVzdA== -----END SOME BLOCK V3-----');
  assert.deepEqual([q.t, q.tail], ['dGVzdA==', 'armor']);
  q = C.pieceOf('<INPUT TYPE="hidden" NAME="__VIEWSTATE" VALUE="/-');
  assert.deepEqual([q.t, q.soft, q.head.kind, q.head.name, q.head.form], ['/', true, 'attr', 'VALUE', 'VIEWSTATE']);
  q = C.pieceOf(`<img src="data:image/png;base64,${a}">`);
  assert.deepEqual([q.t, q.tail, q.head.kind, q.head.type], [a, 'quote', 'data-uri', 'image/png']);
  q = C.pieceOf(`example.org/2001/XMLSchema-instance">${a}`);
  assert.deepEqual([q.t, q.head.kind, q.off], [a, 'xml', 37], 'the end of a tag the printer wrapped');
  assert.ok(C.pieceOf('EFTA00000001').blank, 'a stamp on the page is not in the file');
});

test('prose is not base64 because its words join up into the alphabet; a printer\'s spaces do not stop base64', { skip }, () => {
  for (const line of ['previously noted to the Board on 03/17/2003 Several newspaper articles',
    'Numerous reports detailing the 24 charges brought against them and 7 others',
    'dated 6/23/2005 detailing how the funds moved through the accounts 1/2/3',
    'THE RECORDS OF BOTH THE DEPARTMENTS 2009 AND THE CORPORATION RECORDS',
    'Page 3', 'Best regards', 'Tel 2125551234', 'Confidential 2009'])
    assert.ok(C.pieceOf(line).prose, line);
  // the whole of it: a page of such lines gives no attachment
  const page = ['I am writing as to the matter of 03/17/2003 and the 24 reports attached', 'Several newspaper articles 12 of them and the other 7 are enclosed here',
    'Numerous reports detailing 24 charges brought against them and others 2009'].map(t => plain(t));
  assert.deepEqual(C.examine(page), { files: [], others: [] });
  const r = seeded(12), body = randomB64(100, r);
  assert.equal(C.pieceOf(`${body.slice(0, 20)} ${body.slice(20, 84)} ${body.slice(84)}`).t, body, 'a space every 64 characters of a re-flowed body');
  const a = randomB64(76, r);
  assert.equal(C.pieceOf(`${a.slice(0, 30)}I I ZI ${a.slice(30, 69)}`).t, `${a.slice(0, 30)}IIZI${a.slice(30, 69)}`, 'the reader\'s own gaps');
  assert.ok(C.pieceOf('some   words of   prose with gaps   where a   few clusters   were lost', 5).prose);
});

test('a body wrapped with the printer\'s hyphen has no width, and the form\'s prose around it stays prose', { skip }, () => {
  const r = seeded(13);
  const body = randomB64(2000, r).replace(/.{300}/g, m => m.slice(0, 299) + '/') + 'QUJD';
  const wrapped = [];                                   // 76 characters, or sooner after a '/'
  for (let i = 0; i < body.length;) {
    let n = Math.min(76, body.length - i);
    const slash = body.slice(i, i + n).indexOf('/');
    if (slash >= 0 && r() < 0.8) n = slash + 1;
    wrapped.push(body.slice(i, i + n)); i += n;
  }
  const lines = [plain('<?xml version="1.0" encoding="UTF-8"?><?mso-infoPathSolution'), plain('href="https://internal.example.org/-'), plain('forms/template.xsn"'),
    plain('<my:title>A title that wraps</-'), plain('my:title>'), plain(`<my:annex>${wrapped[0]}-`),
    ...wrapped.slice(1, -1).map(w => plain(`${w}-`)), plain(`${wrapped.at(-1)}</my:annex>`), plain('<my:other>short</my:other>'), plain('</my:group>')];
  const [b, more] = C.findBlocks(lines);
  assert.ok(b && !more, 'one body');
  assert.equal(b.chars, body);
  assert.deepEqual(b.damage, []);
  assert.deepEqual([b.width, b.softWrapped, b.opened, b.closed, b.declared.element], [0, true, 'marker: xml', 'marker: close-tag', 'my:annex']);
  const [d] = C.findBlocks([...lines.slice(0, 20), { page: 1, unread: true, text: '' }, ...lines.slice(20)]);
  assert.ok(d.damage.some(x => /unread band, its length a guess/.test(x[2])));
});

test('markers: the first and last characters on their lines are the body\'s; quoted-printable, a DKIM list and short values are no bodies', { skip }, () => {
  const r = seeded(14);
  const data = randomBytes(1500, r), chars = data.toString('base64');
  const flowed = chars.match(/.{1,64}/g).join(' ').match(/.{1,100}/g);
  const [v] = C.findBlocks([plain('some prose above it, with punctuation'), plain(`-----BEGIN A BLOCK----- ${flowed[0]}`), ...flowed.slice(1, -1).map(x => plain(x)),
    plain(`${flowed.at(-1)} -----END A BLOCK-----`), plain('<after.html>')]);
  assert.equal(v.chars, chars);
  assert.deepEqual(v.damage, []);
  assert.deepEqual([v.opened, v.declared.armor], ['marker: armor', 'A BLOCK']);
  // padding the printer wrapped onto a line of its own
  const whole = Buffer.from('Some text for a body that wraps and wraps and goes on for a while, then stops: ' + 'x'.repeat(73)).toString('base64');
  assert.ok(whole.endsWith('='));
  const [e] = C.findBlocks([...wrapAt(whole.replace(/=+$/, ''), 76).map(l => plain(l)), plain('='), plain('Some prose, with commas.')]);
  assert.deepEqual([e.chars, e.padded, e.closed], [whole, true, 'padding']);
  // quoted-printable: every line ends in '='
  const qp = () => `${randomB64(75, r)}=`;
  assert.deepEqual(C.findBlocks([plain('Some words, then more.'), plain(qp()), plain(qp()), plain(qp()), plain('<a href=3D"x">words</a>=')]), []);
  assert.deepEqual(C.findBlocks([plain('Content-Transfer-Encoding: quoted-printable'), plain(''), ...wrapAt(randomB64(300, r), 76).map(l => plain(l))]), []);
  const [k] = C.findBlocks([plain('h=mime-version:content-transfer-encoding:message-id:subject;'), plain(`b=${randomB64(70, r)}`), ...wrapAt(randomB64(280, r), 70).map(l => plain(l))]);
  assert.equal(k.declared.encoding, undefined, 'the name of a header in a signature\'s list declares nothing');
});

test('what the read did not certify keeps its place and is damage: a cluster, a band, a tolerant line, an edit, a glyph wider than read', { skip }, () => {
  const r = seeded(15);
  const data = randomBytes(5700, r), body = data.toString('base64').match(/.{1,76}/g);   // enough lines that one wide step is no habit of its glyph
  const head = [plain('Content-Type: application/octet-stream'), plain('Content-Transfer-Encoding: base64'), plain('')];
  const tail = [plain('--boundary-string--')];
  const run = mid => C.examine([...head, ...mid, ...tail]).files;
  const whole = body.map(l => plain(l));
  assert.deepEqual(run(whole).map(f => [f.status, Buffer.from(f.data).equals(data)]), [['exact', true]]);

  // a cluster: the □ is where the character was, and every later byte is in place
  const at = 5, cut = body[at].slice(0, 20) + '□' + body[at].slice(21);
  const [c] = run(whole.map((l, i) => (i === at ? { page: 1, text: cut, fails: 1 } : l)));
  assert.equal(c.status, 'damaged');
  assert.equal(c.data.length, data.length);
  const bytePos = Math.floor((at * 76 + 20) / 4) * 3;
  assert.deepEqual(Buffer.from(c.data.subarray(bytePos + 3)), data.subarray(bytePos + 3));
  assert.deepEqual(Buffer.from(c.data.subarray(0, bytePos)), data.subarray(0, bytePos));

  // a band nobody read is a line of its own, kept as a line's length
  const [u] = run(whole.map((l, i) => (i === at ? { page: 1, unread: true, text: '' } : l)));
  assert.deepEqual([u.status, u.data.length], ['damaged', data.length]);
  assert.deepEqual(Buffer.from(u.data.subarray((at + 1) * 57)), data.subarray((at + 1) * 57));

  // the same characters, read at a tolerance or edited: nothing to certify them
  assert.match(run(whole.map((l, i) => (i === at ? { ...l, tol: 6 } : l)))[0].why, /read at tolerance 6/);
  assert.match(run(whole.map((l, i) => (i === at ? { ...l, edited: true } : l)))[0].why, /edited by hand/);

  // an 'I' inside an 'L': the pen steps wider than an I's advance, by an L's
  const ADV = c => (c === 'I' ? 5 : c === 'L' ? 8.25 : 7 + ALPHA.indexOf(c) % 3);
  const penned = (text, widen = -1) => {
    let pen = 10;
    const pens = [...text].map((c, k) => { const p = [c, pen]; pen += k === widen ? ADV('L') : ADV(c); return p; });
    return { page: 1, text, pens };
  };
  const row = body.findIndex(l => l.slice(0, -1).includes('I'));
  assert.ok(row >= 0);
  assert.equal(run(whole.map(l => penned(l.text)))[0].status, 'exact', 'pens that step as they should say nothing');
  const [w] = run(whole.map((l, i) => (i === row ? penned(l.text, l.text.slice(0, -1).indexOf('I')) : penned(l.text))));
  assert.equal(w.status, 'damaged');
  assert.match(w.why, /1 glyph wider than read/);
});

test('verdict: exact only when a check passed or both ends are proven; a cut body is never exact, and an unknown one says so', { skip }, () => {
  const body = over => ({ chars: 'QUJD'.repeat(25), padded: false, opened: null, closed: null, ...over });
  const bin = { ext: 'bin' }, txt = { ext: 'txt' }, pdf = { ext: 'pdf' }, jpg = { ext: 'jpg' };
  const none = { ok: null, tool: null, note: '' }, der = { ok: true, tool: 'der', note: 'nests' };
  const st = a => C.verdict({ bytes: 75, c: none, ...a }).status;
  assert.equal(st({ b: body(), kind: bin }), 'unproven');
  assert.equal(st({ b: body(), kind: txt }), 'unproven');
  assert.equal(st({ b: body({ opened: 'mime header' }), kind: txt }), 'unproven', 'one end');
  assert.equal(st({ b: body({ closed: 'padding' }), kind: bin }), 'unproven', 'the other end');
  assert.equal(st({ b: body({ opened: 'mime header', closed: 'mime boundary' }), kind: txt }), 'exact');
  assert.equal(st({ b: body(), kind: { ext: 'p7m' }, c: der }), 'exact', 'a check covers it');
  assert.equal(st({ b: body(), kind: jpg, c: { ok: false, tool: 'jpeg', note: 'no end marker' } }), 'incomplete');
  assert.equal(st({ b: body({ chars: 'QUJDQQ' }), kind: txt }), 'incomplete', 'the last group not whole');
  assert.equal(st({ b: body({ opened: 'marker: xml', closed: 'marker: close-tag' }), kind: { ext: 'jpgpart' } }), 'incomplete', 'a fragment says so itself');
  assert.equal(st({ b: body({ opened: 'marker: xml' }), kind: pdf, wrap: { size: 2000 } }), 'incomplete', 'shorter than declared, never exact');
  assert.equal(st({ b: body({ opened: 'marker: xml' }), kind: txt, wrap: { size: 75 } }), 'exact', 'a declared size that is met');
  assert.equal(st({ b: body({ opened: 'marker: xml' }), kind: txt, wrap: { size: 75 }, surplus: 12 }), 'unproven', 'more than it declared');
  assert.equal(st({ b: body(), kind: bin, damaged: true }), 'damaged');
});

const len = n => (n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]);
const tl = (tag, ...v) => { const b = Buffer.concat(v); return Buffer.concat([Buffer.from([tag, ...len(b.length)]), b]); };
const cms = (n, payload) => tl(0x30, Buffer.from([0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07, n]), tl(0xA0, tl(0x30, tl(0x02, Buffer.from([0])), tl(0x04, payload))));
const crc = (b, seed = 0xFFFFFFFF) => { let c = seed; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type), n = Buffer.alloc(4), k = Buffer.alloc(4); n.writeUInt32BE(data.length); k.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([n, t, data, k]); };

test('the format\'s own word: CMS lengths and OID, a PNG\'s CRCs, a JPEG\'s end marker, a PDF\'s %%EOF, a ZIP\'s end record', { skip }, () => {
  const r = seeded(16), env = cms(3, randomBytes(900, r));
  const k = C.sniff(env);
  assert.deepEqual([k.ext, k.label, k.encrypted, k.view], ['p7m', 'CMS EnvelopedData, encrypted', true, 'none']);
  assert.equal(C.sniff(cms(2, randomBytes(100, r))).label, 'CMS SignedData');
  assert.equal(C.derInfo(env).total, env.length);
  assert.equal(C.derInfo(Buffer.from('0 is how this text starts, and it goes on for a while.')), null);
  assert.equal(C.check(env, k).ok, true);
  assert.equal(C.check(env.subarray(0, 400), k).ok, false, 'cut short');
  const hurt = Buffer.from(env); hurt[hurt.indexOf(0xA0) + 3] = 0xFF;
  assert.equal(C.check(hurt, k).ok, false, 'lengths that do not nest');

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', randomBytes(13, r)), chunk('IDAT', randomBytes(300, r)), chunk('IEND', Buffer.alloc(0))]);
  const P = C.sniff(png);
  assert.equal(C.check(png, P).ok, true);
  assert.equal(C.check(png.subarray(0, 200), P).ok, false, 'cut short');
  const bad = Buffer.from(png); bad[60] ^= 1;
  assert.equal(C.check(bad, P).ok, false, 'one wrong byte');

  assert.deepEqual(C.check(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]), { ext: 'jpg' }).note, 'no end marker');
  assert.equal(C.check(Buffer.from('%PDF-1.4 and nothing more'), { ext: 'pdf' }).ok, false);
  assert.equal(C.check(Buffer.from('PK\x03\x04 and nothing more'), { ext: 'zip' }).ok, false);
  assert.equal(C.sniff(Uint8Array.from([0xFF, 0xFB, 0x90, 0x00, ...noise(60)])).ext, 'bin', 'one frame header is no MP3');
  const jpegMiddle = Uint8Array.from(Array.from({ length: 900 }, (_, i) => (i % 40 === 0 ? 0xFF : i % 40 === 1 ? 0 : (i * 7) % 250)));
  assert.equal(C.sniff(jpegMiddle).ext, 'jpgpart');
});

test('infoPath: the header of an attachment in a form gives the name and the size', { skip }, () => {
  const name = Buffer.from('note.txt\0', 'utf16le'), head = Buffer.alloc(24);
  head.writeUInt32LE(0x414649C7, 0); head.writeUInt32LE(20, 4); head.writeUInt32LE(1, 8); head.writeUInt32LE(5, 16); head.writeUInt32LE(9, 20);
  assert.deepEqual(C.infoPath(Buffer.concat([head, name, Buffer.from('hello')])), { offset: 42, size: 5, name: 'note.txt' });
  assert.equal(C.infoPath(Buffer.from('hello, not an attachment, not at all')), null);
});

test('examine: a form\'s attachments named and sized by their headers, a short one incomplete, more base64 inside found and judged the same way', { skip }, () => {
  const r = seeded(17);
  const attach = (name, declared, body) => {
    const n = Buffer.from(`${name}\0`, 'utf16le'), head = Buffer.alloc(24);
    head.writeUInt32LE(0x414649C7, 0); head.writeUInt32LE(20, 4); head.writeUInt32LE(1, 8); head.writeUInt32LE(declared, 16); head.writeUInt32LE(name.length + 1, 20);
    return Buffer.concat([head, n, body]);
  };
  const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), randomBytes(1200, r).map(x => (x === 0xFF ? 0 : x))]);
  const xml = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><?mso-infoPathSolution name="urn:not-a-file-name" ?><my:form xmlns:my="urn:example"><my:title>A title</my:title><my:photo>${jpeg.toString('base64')}`);
  const textFile = Buffer.from('A whole little file, every byte of it, line after line.\n'.repeat(12));
  const soft = (tag, data, tail) => wrapAt(data.toString('base64'), 76).map((l, i, all) => plain(`${i ? '' : `<${tag}>`}${l}${i === all.length - 1 ? tail : '-'}`));
  const { files, others } = C.examine([plain('<?xml version="1.0"?><?mso-infoPathSolution solutionVersion="1.0" href="https://-'), plain('internal.example.org/x.xsn"?>'),
    ...soft('my:field1', attach('form.xml', 500000, xml), '-'), { page: 1, unread: true, text: '' }, plain('<my:next>value</my:next>'),
    ...soft('my:field2', attach('note.txt', textFile.length, textFile), '</my:field2>'), plain('</my:form>')]);
  assert.deepEqual(others, []);
  const [x, j, t] = files;
  assert.deepEqual([x.name, x.status, x.data.length, x.declaredSize], ['form.xml', 'incomplete', xml.length, 500000]);
  assert.ok(Buffer.from(x.data).equals(xml));
  assert.deepEqual([j.name, j.status, j.why, j.kind.ext, j.parent], ['my-photo.jpg', 'incomplete', 'no end marker', 'jpg', 'form.xml']);
  assert.deepEqual(Buffer.from(j.data.subarray(0, 1200)), jpeg.subarray(0, 1200));
  assert.deepEqual([t.name, t.status, t.end], ['note.txt', 'exact', 'declared size']);
  assert.ok(Buffer.from(t.data).equals(textFile));
});

test('examine: an armored CMS body whole and labelled; nothing to prove it, unproven; cut mid-group, incomplete; a form\'s field and a header\'s value no files', { skip }, () => {
  const r = seeded(18);
  const env = cms(3, randomBytes(1400, r));
  const flowed = env.toString('base64').match(/.{1,64}/g).join(' ').match(/.{1,100}/g);
  const [a] = C.examine([plain('Subject: something'), plain(`-----BEGIN A SECURE BLOCK V3----- ${flowed[0]}`), ...flowed.slice(1, -1).map(l => plain(l)), plain(`${flowed.at(-1)} -----END A SECURE BLOCK V3-----`), plain('<message.html>')]).files;
  assert.ok(Buffer.from(a.data).equals(env), 'first and last characters kept');
  assert.deepEqual([a.status, a.kind.label, a.encrypted, a.kind.ext], ['exact', 'CMS EnvelopedData, encrypted', true, 'p7m']);

  const safe = n => randomBytes(n, r).map(x => (x === 0xFF || x === 0x30 ? 1 : x)).toString('base64');
  const bin = wrapAt(safe(1500), 76).map(l => plain(l));
  const [n] = C.examine([plain('Some prose, with commas.'), ...bin, plain('Some prose, with commas.')]).files;
  assert.deepEqual([n.status, n.kind.ext], ['unproven', 'bin']);
  assert.match(n.why, /nothing shows where it starts/);

  const cut = wrapAt(safe(1500), 76);
  const [c] = C.examine([plain('Some prose, with commas.'), ...cut.slice(0, -2).map(l => plain(l)), plain(cut.at(-2).slice(0, 37))]).files;
  assert.equal(c.status, 'incomplete');
  assert.match(c.why, /last base64 group is not whole/);

  const form = C.examine([plain('<INPUT TYPE="hidden" NAME="__VIEWSTATE" VALUE="/-'), ...wrapAt(randomB64(300, r), 76).map((l, i, all) => plain(i === all.length - 1 ? `${l}">` : `${l}-`))]);
  assert.deepEqual([form.files.length, only(form.others, 'form data').map(o => o.field)], [0, ['VIEWSTATE']]);
  const state = C.examine(wrapAt(`/wEPDw${randomB64(234, r)}`, 76).map(l => plain(l)));
  assert.deepEqual([state.files.length, only(state.others, 'form data').map(o => o.field)], [0, ['ASP.NET state']]);
  const dkim = C.examine(wrapAt(safe(120), 76).map(l => plain(l)));
  assert.deepEqual([dkim.files.length, only(dkim.others, 'header value').length], [0, 1]);
});

test('linesFromBoxes: the OCR layer only, a line\'s segments joined, its certificate carried, an edit noticed', { skip }, () => {
  const entries = text => [...text].filter(c => c !== ' ').map((ch, i) => ({ ch, pen: 10 + i * 8, adv: 8, i }));
  const ocr = (text, over = {}, extra = {}) => ({ type: 'ocr', page: 1, y: 10, x: 0, lineId: 'ocr_p1_l1', text, ocr: { clean: true, tol: 0, fails: 0, entries: entries(text), ...over }, ...extra });
  const embedded = { type: 'embedded', page: 1, y: 10, x: 0, text: 'QUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJD' };
  assert.deepEqual(C.linesFromBoxes([embedded]), [], 'the embedded layer is never read');

  const lines = C.linesFromBoxes([embedded,
    ocr('second part', {}, { x: 200 }), ocr('first part'),
    ocr('below', { tol: 4 }, { lineId: 'ocr_p1_l2', y: 30 }),
    ocr('with□a hole', { fails: 1 }, { lineId: 'ocr_p1_l3', y: 50 }),
    { type: 'ocr', page: 1, y: 70, x: 0, lineId: 'ocr_p1_l4', text: '□', ocr: { clean: false, unread: true } },
    { ...ocr('after the edit'), lineId: 'ocr_p1_l5', y: 90, text: 'after an edit' },
    { type: 'ocr', page: 2, y: 5, x: 0, text: 'no certificate at all' },
  ]);
  assert.equal(lines[0].text, 'first part second part');
  assert.deepEqual([lines[0].fails, lines[0].tol, lines[0].edited, lines[0].pens.length, lines[0].pens[0]], [0, 0, undefined, 19, ['f', 10]]);
  assert.equal(lines[1].tol, 4);
  assert.deepEqual([lines[2].text, lines[2].fails, lines[2].pens.some(p => p[0] === '□')], ['with□a hole', 1, false]);
  assert.deepEqual([lines[3].unread, lines[3].page], [true, 1]);
  assert.equal(lines[4].edited, true);
  assert.equal(lines[5].edited, true);
});
