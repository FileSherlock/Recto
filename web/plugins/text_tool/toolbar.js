// toolbar.js — the formatting of a box that is not a story.
//
// A line read from the page (an OCR line, embedded text) or a redaction
// box's label has one face, one size, one colour and — while it is set in
// the face it was measured in — the glyph positions the page gave it. The
// Text panel (text-studio.js) shows and sets its formatting through the
// character attributes of Artistic text (StoryCore's names), and this file
// maps them onto the box's own fields: no branching on box.type.
//
//   utbPlainChar.attrs(box)              → { fontFamily, sizePt, bold, italic, color, opacity,
//                                            underline, strike, tracking, autoKern }
//   utbPlainChar.keys                    the attributes a plain box has
//   utbPlainChar.apply(box, patch, key)  sets them (one undo step; `key`
//                                        collapses repeated changes)
//   utbPlainChar.setSpaceWidth(box, px)  a manual space width (null: the font's)
//
// Plus what every box shares: getNaturalSpaceWidth (the face's own space,
// measured by HarfBuzz), and syncToolbarToBox / syncToolbarToSelection, the
// calls that tell the Text panel the selection changed. (The file keeps the
// name of the ribbon it once drove: the Text panel is where text is
// formatted now.)

(function initToolbar() {

  function el(id) { return document.getElementById(id); }

  // ── a plain box's formatting, as character attributes ─────────

  // the box's kerning: its own choice, or null while it follows the page
  const kernChoice = box => (box.kerningAuto ? null : !!box.kerning);

  function plainAttrs(box) {
    return {
      fontFamily: box.fontFamily, sizePt: box.sizePt, bold: !!box.bold, italic: !!box.italic,
      color: box.color || null, opacity: box.opacity ?? 100,
      underline: box.underline ? 'single' : 'none', strike: box.strikethrough ? 'single' : 'none',
      tracking: Math.round((+box.letterSpacing || 0) * 1000), autoKern: kernChoice(box),
    };
  }

  const PLAIN_WRITE = {
    fontFamily: (b, v) => { if (v) b.fontFamily = v; },
    sizePt: (b, v) => { if (v > 0) b.sizePt = v; },          // never 0, negative or NaN
    bold: (b, v) => { b.bold = !!v; },
    italic: (b, v) => { b.italic = !!v; },
    color: (b, v) => { b.color = v || null; },
    opacity: (b, v) => { if (Number.isFinite(+v)) b.opacity = Math.max(0, Math.min(100, Math.round(+v))); },
    underline: (b, v) => { b.underline = !!v && v !== 'none'; },
    strike: (b, v) => { b.strikethrough = !!v && v !== 'none'; },
    tracking: (b, v) => { b.letterSpacing = (+v || 0) / 1000; },
    // null: follow the page again (svg-renderer.js asks window.utbAutoKerning)
    autoKern: (b, v) => {
      if (v == null) { b.kerningAuto = true; return; }
      b.kerning = !!v;
      b.kerningAuto = false;
    },
  };
  const LABELS = { fontFamily: 'font', sizePt: 'font size', bold: 'bold', italic: 'italic', color: 'colour', opacity: 'opacity',
    underline: 'underline', strike: 'strikethrough', tracking: 'tracking', autoKern: 'kerning' };

  // Changes what a redaction box measures: its candidates' widths again
  // (guarded — the matching plugin supplies it, if installed)
  function remeasure(box) {
    if (box.type === 'redaction' && typeof calculateWidthsForRedaction === 'function') calculateWidthsForRedaction(box.id);
  }

  function applyPlain(box, patch, key = null) {
    if (!box) return;
    const keys = Object.keys(patch).filter(k => PLAIN_WRITE[k]);
    if (!keys.length) return;
    const step = window.utbUndo?.capture([box]);
    for (const k of keys) PLAIN_WRITE[k](box, patch[k]);
    if ('autoKern' in patch && patch.autoKern == null && typeof window.utbAutoKerning === 'function') {
      try { const k = window.utbAutoKerning(box); if (typeof k === 'boolean') box.kerning = k; } catch { /* the plugin's */ }
    }
    window.utbUndo?.commit(step, LABELS[keys[0]] || 'format', key);
    renderBox(box);
    remeasure(box);
  }

  // A manual space width (px), or null: the face's own
  async function setSpaceWidth(box, px, key = null) {
    if (!box) return;
    const step = window.utbUndo?.capture([box]);
    if (px == null) {
      box.defaultSpaceWidth = true;
      box.spaceWidth = null;
    } else {
      if (box.nativeSpaceWidth == null || box.nativeSpaceKey !== nativeSpaceKey(box)) await measureNativeSpace(box);
      box.defaultSpaceWidth = false;
      box.spaceWidth = Math.max(0, +px);
    }
    window.utbUndo?.commit(step, 'space width', key);
    renderBox(box);
    remeasure(box);
  }

  window.utbPlainChar = { attrs: plainAttrs, keys: Object.keys(PLAIN_WRITE), apply: applyPlain, setSpaceWidth,
    nativeSpaceKey, measureNativeSpace };

  // ── the face's own space ──────────────────────────────────────

  /**
   * The HarfBuzz space advance of the box's font at its size (px): what the
   * Text panel's Space width starts from, and what a plugin that measures
   * names in a box's face needs.
   */
  const _naturalSpaceCache = new Map();

  // What a face's space advance depends on: its cache key, and what a box's
  // cached nativeSpaceWidth was measured for (box.nativeSpaceKey) — a box
  // whose font, style, size or kerning changed since has to measure again.
  function nativeSpaceKey(box) {
    return `${box.fontFamily}|${box.bold ? 'b' : ''}${box.italic ? 'i' : ''}|${box.sizePt}|${box.kerning ? 1 : 0}|${GEO.docScale()}`;
  }

  // Measures the box's own space advance for what it is now and caches it on
  // the box (px, or null when the face cannot be shaped).
  async function measureNativeSpace(box) {
    const key = nativeSpaceKey(box);
    const w = await fetchNaturalSpaceWidth(box);
    if (w != null && nativeSpaceKey(box) === key) { box.nativeSpaceWidth = w; box.nativeSpaceKey = key; }
    return w;
  }

  async function fetchNaturalSpaceWidth(box) {
    // HarfBuzz expects the size in POINTS — box.sizePt is already points.
    const size  = box.sizePt;
    const scale = GEO.docScale();  // px-per-pt × 100 for this document
    const key = nativeSpaceKey(box);
    if (_naturalSpaceCache.has(key)) return _naturalSpaceCache.get(key);
    try {
      const data = await Shaping.widths({
        strings: [' '],
        family:  box.fontFamily,     // resolved through the font catalogue (shaping.js)
        bold:    !!box.bold,
        italic:  !!box.italic,
        size:    size,
        scale:   scale,
        kerning:    box.kerning,
      });
      // The width of a single space character = the natural space advance
      const w = data.results?.[0]?.width ?? null;
      if (w != null) _naturalSpaceCache.set(key, w);
      return w;
    } catch { return null; }
  }
  // Exposed for plugins that need a face's natural space width (a guarded global).
  window.getNaturalSpaceWidth = fetchNaturalSpaceWidth;

  // ── the selection changed: the Text panel shows it ────────────

  // Every selection path (a click, a new box, a candidate's row, the undo
  // stack) ends here.
  window.syncToolbarToBox = box => window.TextPanel?.sync(box);
  window.syncToolbarToSelection = () => window.TextPanel?.sync();

  // Toggle-embedded-text button (show/hide embedded text in SVG globally)
  el('toggle-embedded-text')?.classList.add('active');
  el('toggle-embedded-text')?.addEventListener('click', () => {
    const btn = el('toggle-embedded-text');
    const active = btn.classList.toggle('active');
    document.body.classList.toggle('hide-embedded-text', !active);
  });

})();
