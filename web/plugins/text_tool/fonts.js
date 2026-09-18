// fonts.js — the font catalogue on the browser side.
//
// Fetches generated/fonts.json (assets/fonts/fonts.json + which files are
// installed, written by the build),
// then does the three things every face needs done once:
//   1. @font-face rules for every installed style, so SVG text in
//      font-family "Nimbus Roman" is drawn with the actual URW file — the
//      face MuPDF rendered the scan with — instead of whatever the OS picks;
//   2. the toolbar's font menu (#fabric-font-family), one option per family,
//      MuPDF's own faces first;
//   3. window.FontCatalog for everyone else: has(), familyForPdfName(),
//      select(family, sizePt), metrics(), fileUrl().
//
// Two generic events choose the default face, so no plugin is named here:
//   document:loaded   — the core's declared PDF fonts (pdfFonts) and sampled
//                       body size (sizePt) set the initial selection;
//   typography:detected ({ fontFamily, sizePt, source }) — an analysis plugin
//                       that measured the page (an OCR read, say) overrides it.
(function () {
  const catalog = { families: [], byFamily: new Map(), default: 'Times New Roman', staticBase: 'assets/fonts/', ready: null };

  const WEIGHT = { regular: 400, bold: 700, italic: 400, bolditalic: 700 };
  const STYLE = { regular: 'normal', bold: 'normal', italic: 'italic', bolditalic: 'italic' };
  const format = f => /\.otf$/i.test(f) ? 'opentype' : 'truetype';
  // A face file's URL; the catalogue carries each present file's content hash.
  const faceUrl = (fam, style) => catalog.staticBase + fam.files[style] + (fam.hashes?.[style] ? `?v=${fam.hashes[style]}` : '');

  function injectFontFaces() {
    let css = '';
    for (const fam of catalog.families)
      for (const [style, file] of Object.entries(fam.files))
        if (fam.present[style])
          css += `@font-face { font-family: "${fam.family}"; src: url("${faceUrl(fam, style)}") format("${format(file)}"); ` +
                 `font-weight: ${WEIGHT[style]}; font-style: ${STYLE[style]}; font-display: block; }\n`;
    let el = document.getElementById('tt-font-faces');
    if (!el) { el = document.createElement('style'); el.id = 'tt-font-faces'; document.head.appendChild(el); }
    el.textContent = css;
  }

  function fillMenu() {
    const sel = document.getElementById('fabric-font-family');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '';
    for (const fam of catalog.families) {
      const opt = document.createElement('option');
      opt.value = fam.family;
      opt.textContent = fam.present.regular ? fam.family : `${fam.family} (not installed)`;
      opt.disabled = !fam.present.regular;
      if (fam.class === 'mupdf') opt.title = fam.note || 'one of MuPDF\'s own faces';
      sel.appendChild(opt);
    }
    if (current && catalog.byFamily.has(current)) sel.value = current;
    else sel.value = catalog.default;
  }

  function has(family) { return catalog.byFamily.has(family); }

  // 'ABCDEF+TimesNewRomanPSMT-Bold' → 'Times New Roman'; longest alias wins
  function familyForPdfName(name) {
    if (!name) return null;
    const key = String(name).split('+').pop().replace(/[\s,-]/g, '').toLowerCase();
    let best = null, bestLen = 0;
    for (const fam of catalog.families)
      for (const alias of fam.pdfNames || []) {
        const a = alias.replace(/[\s,-]/g, '').toLowerCase();
        if (key.startsWith(a) && a.length > bestLen) { best = fam.family; bestLen = a.length; }
      }
    return best;
  }

  // set the toolbar's font (and size) — the default for the next added box.
  // source ranks the claim for this document: 'detected' (a plugin measured
  // the page's face from its pixels) outranks 'declared' (the PDF's font
  // names) and 'layer' (the text layer's most used face), which are what a
  // producer wrote, not what the page shows; a weaker claim arriving after a
  // stronger one is ignored, so the reader's face is not undone by the
  // layer's spans landing later. Unranked calls (the user's own choice) win.
  const RANK = { layer: 1, declared: 1, detected: 2 };
  let chosen = 0;
  function select(family, sizePt, source) {
    const rank = source ? (RANK[source] || 1) : 3;
    if (rank < chosen) return false;
    if (source) chosen = rank;
    const sel = document.getElementById('fabric-font-family');
    if (sel && family) {
      if (!Array.from(sel.options).some(o => o.value === family)) {
        const opt = document.createElement('option');
        opt.value = family; opt.textContent = `${family} (not installed)`;
        sel.appendChild(opt);
      }
      sel.value = family;
      if (typeof textOptions !== 'undefined') textOptions.fontFamily = family;
    }
    const size = document.getElementById('fabric-font-size');
    if (size && sizePt > 0) size.value = Math.round(sizePt * 100) / 100;
    return true;
  }

  catalog.ready = (async () => {
    try {
      // The catalogue with its `present` map, written by the build (tools/build.mjs).
      const r = await fetch('generated/fonts.json', { cache: 'no-cache' });
      const data = await r.json();
      catalog.families = Array.isArray(data) ? [] : (data.families || []);
      catalog.default = data.default || catalog.default;
      catalog.staticBase = data.static || catalog.staticBase;
      catalog.byFamily = new Map(catalog.families.map(f => [f.family, f]));
      injectFontFaces();
      fillMenu();
    } catch (e) {
      console.warn('font catalogue unavailable:', e);
    }
    return catalog;
  })();

  PDFHooks.on('document:loaded', async e => {
    chosen = 0;                                   // a new document: every claim is open again
    await catalog.ready;
    const declared = (e?.pdfFonts || []).map(familyForPdfName).find(Boolean);
    select(declared || catalog.default, e?.sizePt, 'declared');
  });
  PDFHooks.on('typography:detected', async e => {
    await catalog.ready;
    if (e?.fontFamily) select(e.fontFamily, e.sizePt, 'detected');
  });

  // The face's own advances and kern pairs at a pixel size, from HarfBuzz
  // (shaping.js): {space, adv: {ch: px}, kern: {pair: px}} or null. A
  // plugin that learned from a page's pens whether its producer kerned lays
  // pairs the page never wrote with this table.
  const metricsCache = new Map();
  function metrics(family, bold, italic, sizePx) {
    const key = `${family}|${bold ? 1 : 0}|${italic ? 1 : 0}|${+sizePx}`;
    if (!metricsCache.has(key)) metricsCache.set(key, (async () => {
      try {
        return await Shaping.fontMetrics({ family, bold: !!bold, italic: !!italic, size_px: +sizePx });
      } catch { return null; }
    })());
    return metricsCache.get(key);
  }

  // The installed file of one style of a family, as a URL — what a renderer
  // that draws glyphs itself loads. null when that style is not installed (a
  // family without a bold italic has none to draw; nothing is synthesized).
  function fileUrl(family, bold, italic) {
    const fam = catalog.byFamily.get(family);
    if (!fam) return null;
    const style = bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'regular';
    return fam.files?.[style] && fam.present?.[style] ? faceUrl(fam, style) : null;
  }

  window.FontCatalog = { has, familyForPdfName, select, metrics, fileUrl,
    families: () => catalog.families, get ready() { return catalog.ready; }, get default() { return catalog.default; } };
})();
