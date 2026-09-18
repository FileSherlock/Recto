/* =========================================================
   PDFHooks — plugin lifecycle bus
   =========================================================
   The core (pdf_core) never calls a plugin function by name.
   Instead it *emits* lifecycle events; plugins *subscribe* with
   PDFHooks.on(event, handler). Deleting a plugin folder removes its
   subscriptions, so the core keeps emitting into the void with zero
   dangling references — "delete the folder, done" actually holds.

   Events emitted by the core
   --------------------------------------------------------------
   'ui:ready'        ()                              — toolbar/DOM is wired; safe to attach plugin buttons
   'viewer:clear'    ()                              — viewer is about to be torn down for a page change
   'page:rendered'   ({ pageContainer, pageNum })    — a page container was added to the DOM
   'pages:refresh'   ()                              — re-sync any per-page overlays
   'document:opening' ({ file, name, isDefault })   — a document is about to be opened; state still describes the
                      previous one. Reset per-document plugin state here: pages of the new document show
                      (page:rendered) before its 'document:loaded' arrives
   'document:loaded' ({ file, isDefault, pdfFonts, sizePt }) — a document finished loading (file === null on auto-load;
                      pdfFonts = declared BaseFont names, most used first; sizePt = sampled body size)
   'typography:detected' ({ fontFamily, sizePt, source }) — emitted by a plugin that MEASURED the page's face
                      (an OCR read); the text tool selects it as the default for new boxes
   'zoom:changed'    ({ zoom })                       — the viewer zoom factor changed

   Handlers may be async; emit() awaits them in registration order and
   never lets one plugin's error break another (or the core).
   ========================================================= */
(function () {
  const handlers = new Map(); // event -> Set<fn>

  function on(event, fn) {
    if (typeof fn !== 'function') return () => {};
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(fn);
    return () => off(event, fn);
  }

  function off(event, fn) {
    handlers.get(event)?.delete(fn);
  }

  async function emit(event, payload) {
    const fns = handlers.get(event);
    if (!fns || fns.size === 0) return [];
    const results = [];
    for (const fn of [...fns]) {
      try {
        results.push(await fn(payload));
      } catch (e) {
        console.error(`[PDFHooks] handler for "${event}" failed:`, e);
      }
    }
    return results;
  }

  window.PDFHooks = { on, off, emit };
})();

/* =========================================================
   assetURL — content-hashed URLs for files a script fetches itself
   =========================================================
   The build (tools/build.mjs) hashes every file of the core and of each
   plugin into window.RECTO_ASSETS, and stamps the page's own <script> and
   <link> tags. A script that loads a sibling on its own — a worker, a word
   list, a glyph bundle — asks here, so that URL carries the content hash too
   and no version is bumped by hand:

       fetch(assetURL('plugins/my_plugin/data.json'))

   `path` is relative to the site root. An unknown path comes back unchanged.
   ========================================================= */
window.assetURL = function (path) {
  const v = window.RECTO_ASSETS && window.RECTO_ASSETS[path];
  return v ? `${path}?v=${v}` : path;
};
