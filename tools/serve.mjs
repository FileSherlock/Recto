#!/usr/bin/env node
// serve.mjs — the development server of the static site. Zero dependencies.
//
//   node tools/serve.mjs [port]          default 5000 → http://localhost:5000
//   node tools/serve.mjs --no-isolate    without the COOP/COEP headers
//
// Plain files out of web/, with three things a bare file server lacks:
//   - the build (tools/build.mjs) runs on every request for index.html, so a
//     plugin folder dropped into or taken out of web/plugins/ shows on reload;
//   - .wasm is served as application/wasm (streaming compilation needs it);
//   - COOP/COEP make the page cross-origin isolated, which is what exposes
//     performance.measureUserAgentSpecificMemory() (the wasm heap and the
//     workers). Optional in production. COEP is `credentialless`, so the
//     cross-origin stylesheets and scripts of the page keep loading.
//
// Development only: /_dev/golden/, /_dev/samples/ and /_dev/lab/ map to
// tests/golden/, tests/samples/ and lab/ — the documents the goldens were
// recorded from, for checks and smoke tests in the browser. They are not part
// of the site (nothing under web/ refers to them).
//
// Every URL the page uses carries a content hash, so files are sent with
// no-cache (revalidate) here; a production host may cache them forever.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { build, WEB } from './build.mjs';

const ROOT = path.resolve(WEB, '..');
const DEV_MOUNTS = {
  '/_dev/golden/': path.join(ROOT, 'tests', 'golden'),
  '/_dev/samples/': path.join(ROOT, 'tests', 'samples'),
  '/_dev/lab/': path.join(ROOT, 'lab'),
};

const args = process.argv.slice(2);
const isolate = !args.includes('--no-isolate');
const port = Number(args.find(a => /^\d+$/.test(a))) || 5000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.bin': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-cache',
    ...(isolate ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' } : {}),
    ...headers,
  });
  res.end(body);
}

const escapeHtml = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' });

  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain' }); }
  if (pathname.endsWith('/')) pathname += 'index.html';

  let base = WEB, rel = pathname;
  for (const [prefix, dir] of Object.entries(DEV_MOUNTS))
    if (pathname.startsWith(prefix)) { base = dir; rel = pathname.slice(prefix.length - 1); }
  const file = path.join(base, path.normalize(rel));
  if (file !== base && !file.startsWith(base + path.sep))
    return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });

  // The scan: index.html and generated/* are rebuilt when the page is asked for.
  if (pathname === '/index.html') {
    try {
      return send(res, 200, req.method === 'HEAD' ? '' : build().html, { 'Content-Type': MIME['.html'] });
    } catch (e) {
      console.error('build failed: ' + e.message);
      return send(res, 500, `<!DOCTYPE html><meta charset="utf-8"><title>Build failed</title><pre>build failed: ${escapeHtml(e.message)}</pre>`,
                  { 'Content-Type': MIME['.html'] });
    }
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Last-Modified': st.mtime.toUTCString(),
    };
    const since = Date.parse(req.headers['if-modified-since'] || '');
    if (!Number.isNaN(since) && Math.floor(st.mtimeMs / 1000) * 1000 <= since)
      return send(res, 304, '', { 'Last-Modified': headers['Last-Modified'] });
    if (req.method === 'HEAD') return send(res, 200, '', headers);
    res.writeHead(200, {
      'Cache-Control': 'no-cache',
      ...(isolate ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' } : {}),
      ...headers,
    });
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(port, '127.0.0.1', () => {
  try {
    const { plugins } = build();
    console.log(`Recto (static) → http://localhost:${port}   plugins: ${plugins.map(p => p.name).join(', ') || '(none)'}`);
  } catch (e) {
    console.error(`Recto (static) → http://localhost:${port}   build failed: ${e.message}`);
  }
});
