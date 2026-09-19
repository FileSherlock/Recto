# Production Deployment

Recto is published as a folder of static files. Build it once, put the `web/` folder on any
static file host — a plain file server, a CDN, an object-storage bucket with website
hosting, a static-pages service — and that is the whole deployment.

## Architecture

```
Browser → HTTPS (443) → any static file host → files under web/
   │
   └─ everything else happens here: MuPDF (WebAssembly) opens and rasterizes the
      document in a worker, HarfBuzz (WebAssembly) measures text, plugins analyse
      pixels in their own workers. The opened document never leaves the browser.
```

The host only ever answers `GET` requests for files. It runs no application code, holds no
database and receives no uploads, so there is no upload size limit to configure, no process
to supervise, and no per-visitor state on the server. Load is bandwidth: a first visit
downloads the MuPDF binary (about 10 MB before compression) plus the scripts and fonts it
uses; later visits come from the browser cache.

---

## Build and publish

```bash
# 1. Get the code
git clone <repository> recto && cd recto

# 2. Build: writes web/index.html and web/generated/*.json
node tools/build.mjs

# 3. Publish the web/ folder as the site's document root
#    (copy, sync or upload it with whatever tool your host provides)
```

Node.js (22 or newer) is needed on the machine that runs step 2 — a laptop or a CI job —
and nowhere else. The build has no dependencies and takes well under a second.

### What the build does

| Step | Action |
|------|--------|
| 1 | Finds every folder under `web/plugins/` that holds a `plugin.json`, in `order` |
| 2 | Inlines each plugin's HTML fragments, styles and scripts into `web/core/index.template.html` → `web/index.html` |
| 3 | Appends `?v=<content hash>` to every local URL and writes the hash map the scripts use for the files they fetch themselves (`window.RECTO_ASSETS`, `assetURL()`) |
| 4 | Writes `web/generated/plugins.json`, `fonts.json` (the catalogue plus which face files exist) and `default-document.json` (the startup document) |

It stops with `build failed: …` and a non-zero exit status when a manifest is not valid
JSON, its `name` differs from its folder, or it names a file that does not exist — so a
broken plugin fails the deploy instead of reaching visitors.

Every URL in the page is **relative**, so the site works from a domain root and from a
sub-path (`https://example.org/recto/`) alike. Publish only `web/`: the rest of the
repository (tools, tests, guide) is not part of the site.

---

## What the host must do

### 1. MIME types

| Extension | `Content-Type` | Why |
|-----------|----------------|-----|
| `.wasm` | `application/wasm` | Browsers compile WebAssembly while it downloads only under this type. Under any other, the loaders fall back to download-then-compile (slower start, a console warning). |
| `.js`, `.mjs` | `text/javascript` | The MuPDF worker and HarfBuzz are ES modules, and browsers refuse a module served under a non-JavaScript type. Hosts that know `.js` do not always know `.mjs` (`web/vendor/harfbuzz/index.mjs`). |
| `.json`, `.css`, `.html`, `.ttf`, `.otf`, `.pdf`, `.png`, `.ico` | the usual types | |

### 2. Caching

Every URL the page uses carries the first 8 hex digits of the file's SHA-256 as `?v=…`. A
changed file therefore has a new URL, and an unchanged one keeps its URL across deploys.
That makes long cache lifetimes safe:

| Files | `Cache-Control` | Why |
|-------|-----------------|-----|
| `index.html` | `no-cache` (revalidate every time) | It is the one file that names all the hashes; a stale copy pins a visitor to old scripts |
| `generated/*.json` | `no-cache` | Read without a hash; they say which fonts and which startup document exist |
| `vendor/mupdf/mupdf-wasm.js`, `vendor/harfbuzz/harfbuzz.js`, `vendor/harfbuzz/harfbuzz.wasm` | short lifetime, or `no-cache` | The vendored modules import these by a plain relative URL, so no hash reaches them (see `web/vendor/README.md`). They change only when a vendored library is upgraded; alternatively rename the vendor folder with the version on an upgrade. |
| everything else | `public, max-age=31536000, immutable` | The URL changes when the content does |

If the host cannot set headers per path, `no-cache` for everything is always correct: it
costs one conditional request per file and visitors still get `304 Not Modified`.

The cache key must include the query string. Browsers always do this; a CDN that is
configured to ignore query strings would serve an old file under a new `?v=`.

### 3. HTTPS

Serve the site over HTTPS. The document's identity is its SHA-256, computed with
`crypto.subtle` inside a worker, and browsers expose `crypto.subtle` only in a secure
context — over plain `http://` on anything but `localhost`, no document opens. How the
certificate is obtained is the host's business; static hosts and CDNs usually provide one.

### 4. Optional: cross-origin isolation

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

These two headers make the page cross-origin isolated, which exposes
`performance.measureUserAgentSpecificMemory()` — a way to measure the wasm heap and the
workers. The app does not need them; the dev server sends them so memory can be checked
during development. Prefer `credentialless` to `require-corp`: the page loads Fabric.js and
web fonts from public CDNs, and `credentialless` keeps those loading without each of them
having to opt in with a `Cross-Origin-Resource-Policy` header.

### 5. Optional: compression

Turn on the host's gzip or Brotli compression for `.wasm`, `.js`, `.mjs`, `.css`, `.json`
and `.html` if it is not on by default. The WebAssembly binaries are the bulk of a first
visit and compress well.

### 6. If you send a Content-Security-Policy

Not required. If the host adds one, it has to allow what the page does: WebAssembly
compilation (`'wasm-unsafe-eval'` in `script-src`), workers from the site itself and from a
`blob:` URL (`worker-src 'self' blob:` — the hashing worker is created from a blob),
`blob:` images (`img-src` — page rasters are blob URLs), the inline asset map in
`index.html`, and the CDN origins the template names.

### Example: the rules in one place

Written for no host in particular — translate it into your host's header or rules syntax:

```
/index.html, /                      Cache-Control: no-cache
/generated/*                        Cache-Control: no-cache
/vendor/mupdf/mupdf-wasm.js         Cache-Control: max-age=3600
/vendor/harfbuzz/harfbuzz.js        Cache-Control: max-age=3600
/vendor/harfbuzz/harfbuzz.wasm      Cache-Control: max-age=3600
/*                                  Cache-Control: public, max-age=31536000, immutable

*.wasm                              Content-Type: application/wasm
*.mjs                               Content-Type: text/javascript

(optional, all paths)               Cross-Origin-Opener-Policy: same-origin
                                    Cross-Origin-Embedder-Policy: credentialless
```

To check a build before publishing, `node tools/serve.mjs` serves the same folder with the
right types on `http://localhost:5000`.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Blank page, `index.html` 404 | `node tools/build.mjs` was not run before publishing — `index.html` and `generated/` are gitignored and exist only after a build |
| Page loads, document never appears | Open the browser console. Usual causes: the site is on plain `http://` (no `crypto.subtle`), `.mjs`/`.js` served under a non-JavaScript type, or a Content-Security-Policy blocking workers or WebAssembly |
| Slow first open, console says `wasm streaming compile failed` | `.wasm` is not served as `application/wasm` |
| Visitors still see the old version after a deploy | `index.html` is being cached; serve it with `no-cache` |
| A plugin's button is missing in production but present locally | The build ran before the plugin folder was added, or only part of `web/` was uploaded — rebuild and publish the whole folder |
| Font widths are wrong / a font is marked *(not installed)* | The face file named in `web/assets/fonts/fonts.json` is missing from `web/assets/fonts/`; add it and rebuild |
| Startup document does not open | No PDF sits directly in `web/assets/pdfs/` at build time, or the file was not uploaded |

More in [Troubleshooting](troubleshooting.md).

## Updating

```bash
git pull
node tools/build.mjs
# publish web/ again
```

Upload `index.html` **last**: once it is replaced, every URL in it points at a file that is
already there. The hash is a query string, not part of the file name, so files are replaced
in place — a visitor who loads the page in the middle of an upload can get a mix of old and
new scripts for that one load, and a reload fixes it. There is nothing to restart and
nothing to migrate.

### The scripted version (rsync over SSH)

`tools/deploy.sh` does exactly that for a host reachable as the SSH alias `unbarpdf`: build, rsync
everything but `index.html` with `--delete`, then `index.html`. It runs on the development machine,
not on the server (the server needs no node and no checkout).

`.github/workflows/deploy.yml` runs the same steps on every push to `main` (and on demand from the
Actions tab). It needs one repository secret, `DEPLOY_SSH_KEY` — the private half of a key made
only for this, whose public half is in the server's `authorized_keys` — and it pins the server's
host key, so that line changes if the server is reinstalled. For another host, change the address,
the host key and the target path in both files.
