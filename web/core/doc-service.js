/* =========================================================
   Doc — the document service
   =========================================================
   Opening a document, its pages, pixels and raw text — all in the browser.
   This is the ONLY file that talks to pdf-worker.js (the module worker that owns
   MuPDF and the open PDF); the viewer and every plugin go through `Doc`:

     Doc.open(fileOrBlobOrArrayBuffer, name, { early })
         → { sha256, numPages, pageWidth, pageHeight, pdfFonts,
             suggestedScale, suggestedSize, pageImageType }
         `early(info)` is optional: called once pages can be shown — identity
         and geometry known, the typography fields (pdfFonts, suggestedSize)
         still to come — so a viewer can put page 1 on screen meanwhile.
     Doc.pageImageURL(n, { thumb })  → Promise<string>   blob: URL of the page's lossless raster
     Doc.pagePixels(n, { gray })     → Promise<object>   the same raster as samples, for a plugin that analyses
                                        pixels: { width, height, components, alpha, samples: Uint8Array, source, rect } —
                                        `source` is 'embedded' (the page's scan) or 'render' (a 96-dpi render of a
                                        born-digital page); `gray: true` gives one component per pixel.
                                        null for an image document (decode Doc.pageImageURL(1) instead)
     Doc.structuredText(n, { options, imageRect })
                                     → Promise<object>   RAW MuPDF structured text of one page, in PyMuPDF's
                                        "rawdict" shape: { rect, width, height, blocks → lines → spans → chars }.
                                        `options` is a MuPDF option string (default 'preserve-whitespace');
                                        `imageRect: true` adds .imageRect (as Doc.pageImageRect) in the same trip
     Doc.pageImageRect(n)            → Promise<rect|null> where the page image sits on the page (PDF points)
     Doc.bytes()                     → Promise<ArrayBuffer> the document's bytes, for a plugin's own worker
     Doc.heapMB()                    → Promise<number|null> the worker's wasm heap
     Doc.close()
     Doc.info                        → the last open()'s result, or null
     Doc.timings                     → where that open's time went (ms)

   The document never leaves the browser. The core still runs NO analysis:
   structuredText is a primitive — turning it into spans is a plugin's job.

   Page URLs are created lazily and kept in a small LRU; an evicted URL is
   revoked, so ask for the URL each time one is needed instead of storing it.
   Requests go to the worker one at a time, a shown page ahead of text ahead
   of thumbnails. Doc.close() terminates the worker: a wasm heap never
   shrinks, ending the worker is what returns the memory.
   ========================================================= */
(function () {
  const PAGE_URLS = 24, THUMB_URLS = 600;
  const PRIORITY = { init: 0, open: 0, page: 1, typography: 2, imageRect: 3, text: 3, pixels: 3, heap: 3, thumb: 4 };

  const IMAGE_MIMES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.tif': 'image/tiff',
    '.tiff': 'image/tiff', '.bmp': 'image/bmp', '.webp': 'image/webp',
  };
  const MIME_EXTS = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/tiff': '.tif',
    'image/bmp': '.bmp', 'image/webp': '.webp',
  };

  let worker = null, ready = null;
  let nextId = 1, inflight = null;
  const queue = [];                      // { id, message, transfer, priority, resolve, reject }
  let generation = 0;                    // bumps on open/close: answers for an older document are dropped
  let current = null;                    // { info, blob, isImage, pages: Map, thumbs: Map }

  // ── the worker ───────────────────────────────────────────────────────────

  const absolute = path => new URL(assetURL(path), document.baseURI).href;

  function pump() {
    if (inflight || !queue.length || !worker) return;
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].priority < queue[best].priority) best = i;
    inflight = queue.splice(best, 1)[0];
    worker.postMessage({ id: inflight.id, ...inflight.message }, inflight.transfer || []);
  }

  function request(message, { transfer, priority } = {}) {
    return new Promise((resolve, reject) => {
      queue.push({ id: nextId++, message, transfer, priority: priority ?? PRIORITY[message.type] ?? 2, resolve, reject });
      pump();
    });
  }

  function startWorker() {
    if (ready) return ready;
    worker = new Worker(assetURL('core/pdf-worker.js'), { type: 'module' });
    worker.onmessage = e => {
      const job = inflight;
      if (!job || e.data.id !== job.id) return;
      inflight = null;
      if (e.data.ok) job.resolve(e.data); else job.reject(new Error(e.data.error));
      pump();
    };
    worker.onerror = e => {
      const err = new Error(`document worker: ${e.message || 'failed to load'}`);
      if (inflight) { inflight.reject(err); inflight = null; }
      while (queue.length) queue.shift().reject(err);
    };
    ready = request({ type: 'init', urls: {
      mupdf: absolute('vendor/mupdf/mupdf.js'),
      document: absolute('core/pdf-document.js'),
      wasm: absolute('vendor/mupdf/mupdf-wasm.wasm'),
    } });
    return ready;
  }

  function stopWorker() {
    const err = new Error('the document was closed');
    if (inflight) { inflight.reject(err); inflight = null; }
    while (queue.length) queue.shift().reject(err);
    worker?.terminate();
    worker = null;
    ready = null;
  }

  // ── blob: URLs, least recently used first out ────────────────────────────

  function remember(map, limit, key, entry) {
    map.delete(key);
    map.set(key, entry);
    for (const [k, old] of map) {
      if (map.size <= limit) break;
      map.delete(k);
      Promise.resolve(old).then(url => { if (url && url !== current?.imageURL) URL.revokeObjectURL(url); }, () => {});
    }
    return entry;
  }

  function releaseAll(doc) {
    for (const map of [doc.pages, doc.thumbs])
      for (const entry of map.values())
        Promise.resolve(entry).then(url => { if (url && url !== doc.imageURL) URL.revokeObjectURL(url); }, () => {});
    if (doc.imageURL) URL.revokeObjectURL(doc.imageURL);
  }

  // ── image documents (PNG, JPEG, …): one page, served as stored ───────────

  // Dispatch by the file name's extension; a name without a known one falls
  // back to the declared MIME type, and to PDF when that says nothing either.
  function documentKind(name, mime) {
    const dot = (name || '').lastIndexOf('.');
    let ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
    if (!(ext in IMAGE_MIMES) && ext !== '.pdf')
      ext = MIME_EXTS[(mime || '').toLowerCase()] || '.pdf';
    return { isImage: ext in IMAGE_MIMES, mime: IMAGE_MIMES[ext] || 'application/pdf' };
  }

  // SHA-256 of the document, in a throw-away worker of its own: on a large
  // file digest() copies the bytes before it starts (70 ms for 66 MB), which
  // neither the page nor the MuPDF worker should wait for.
  const HASHER = `onmessage = async e => {
    try {
      const digest = await crypto.subtle.digest('SHA-256', await e.data.arrayBuffer());
      postMessage({ hex: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('') });
    } catch (err) { postMessage({ error: String(err && err.message || err) }); }
  }`;
  function sha256Hex(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([HASHER], { type: 'text/javascript' }));
      const hasher = new Worker(url);
      const done = () => { hasher.terminate(); URL.revokeObjectURL(url); };
      hasher.onmessage = e => { done(); e.data.hex ? resolve(e.data.hex) : reject(new Error(e.data.error)); };
      hasher.onerror = e => { done(); reject(new Error(e.message || 'hashing failed')); };
      hasher.postMessage(blob);
    });
  }

  async function imageThumbURL(blob, info) {
    const w = 180, h = Math.max(1, Math.round(info.pageHeight * w / info.pageWidth));
    if (info.pageWidth <= w) return URL.createObjectURL(blob);
    const bitmap = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    return URL.createObjectURL(png);
  }

  // ── the API ──────────────────────────────────────────────────────────────

  async function open(source, name, { early } = {}) {
    const t0 = performance.now();
    close();
    const gen = ++generation;
    const superseded = () => { if (gen !== generation) throw new Error('another document was opened meanwhile'); };
    const blob = source instanceof Blob ? source : new Blob([source]);
    const kind = documentKind(name || source?.name, blob.type);
    const hashing = sha256Hex(blob);
    hashing.catch(() => {});                                 // reported where it is awaited
    const doc = { info: null, blob, isImage: kind.isImage, imageURL: null, pages: new Map(), thumbs: new Map() };
    let timings = {};

    if (kind.isImage) {
      const bitmap = await createImageBitmap(blob);
      doc.info = { sha256: await hashing, numPages: 1, pageWidth: bitmap.width, pageHeight: bitmap.height,
                   pdfFonts: [], suggestedScale: Math.round(100 * GEO.PT_TO_PX), suggestedSize: 12.0,
                   pageImageType: kind.mime };
      bitmap.close();
      superseded();
      current = doc;
    } else {
      const starting = startWorker();                        // MuPDF initialises while the bytes are read
      const buffer = await blob.arrayBuffer();
      const readMs = performance.now() - t0;
      const init = await starting;
      superseded();
      const opened = await request({ type: 'open', buffer }, { transfer: [buffer] });
      const sha256 = await hashing;
      superseded();
      // Pages can be shown from here on; the typography pass follows, and a
      // page the viewer asks for meanwhile goes ahead of it (PRIORITY).
      doc.info = api.info = { sha256, ...opened.geometry };
      current = doc;
      const readyMs = performance.now() - t0;
      if (early) try { early({ ...doc.info }); } catch (e) { console.error(e); }
      const typed = await request({ type: 'typography' });
      superseded();
      const g = opened.geometry;
      doc.info = { sha256, numPages: g.numPages, pageWidth: g.pageWidth, pageHeight: g.pageHeight,
                   pdfFonts: typed.typography.pdfFonts, suggestedScale: g.suggestedScale,
                   suggestedSize: typed.typography.suggestedSize, pageImageType: g.pageImageType };
      timings = { readMs, initMs: init.initMs, ...opened.timings, readyMs, ...typed.timings };
    }

    api.info = doc.info;
    api.timings = { ...timings, totalMs: performance.now() - t0 };
    return doc.info;
  }

  function pageImageURL(n, { thumb = false } = {}) {
    const doc = current;
    if (!doc) return Promise.reject(new Error('no document is open'));
    if (!Number.isInteger(n) || n < 1 || n > doc.info.numPages) return Promise.reject(new RangeError(`no page ${n}`));
    const map = thumb ? doc.thumbs : doc.pages, limit = thumb ? THUMB_URLS : PAGE_URLS;
    const have = map.get(n);
    if (have) return remember(map, limit, n, have);

    let made;
    if (doc.isImage) {
      // the stored bytes themselves — nothing is re-encoded
      made = thumb ? imageThumbURL(doc.blob, doc.info)
                   : Promise.resolve(doc.imageURL || (doc.imageURL = URL.createObjectURL(doc.blob)));
    } else {
      made = request({ type: 'page', n, thumb }, { priority: thumb ? PRIORITY.thumb : PRIORITY.page })
        .then(answer => {
          const url = URL.createObjectURL(new Blob([answer.png], { type: 'image/png' }));
          if (current !== doc) URL.revokeObjectURL(url);          // the document went away meanwhile
          return url;
        });
    }
    made.catch(() => { if (map.get(n) === made) map.delete(n); });
    return remember(map, limit, n, made);
  }

  const needPdf = () => {
    if (!current) throw new Error('no document is open');
    return !current.isImage;
  };

  async function pagePixels(n, { gray = false } = {}) {
    if (!needPdf()) return null;
    return (await request({ type: 'pixels', n, gray })).raster;
  }

  async function structuredText(n, { options, imageRect = false } = {}) {
    if (!needPdf()) {
      const { pageWidth: w, pageHeight: h } = current.info;
      return { rect: [0, 0, w, h], width: w, height: h, blocks: [], ...(imageRect ? { imageRect: null } : {}) };
    }
    return (await request({ type: 'text', n, options, imageRect })).text;
  }

  async function pageImageRect(n) {
    if (!needPdf()) return null;
    return (await request({ type: 'imageRect', n })).rect;
  }

  function bytes() {
    if (!current) return Promise.reject(new Error('no document is open'));
    return current.blob.arrayBuffer();
  }

  async function heapMB() {
    return worker ? (await request({ type: 'heap' })).heapMB : null;
  }

  function close() {
    generation++;
    if (current) releaseAll(current);
    current = null;
    api.info = null;
    stopWorker();
  }

  const api = { open, pageImageURL, pagePixels, structuredText, pageImageRect, bytes, heapMB, close, info: null, timings: null };
  window.Doc = api;
})();
