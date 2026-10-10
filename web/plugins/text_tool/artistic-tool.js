// artistic-tool.js — Affinity's Artistic Text Tool, and converting between
// Artistic and Frame text.
//
// "|DRAG| or |CLICK| to create Art text." Armed from the tool column
// (#tt-art-text-btn) it stays armed like the Frame Text Tool:
//
//   - a click puts a new Artistic text's baseline at the point, in the
//     ribbon's font and size;
//   - a drag sets the size: the font's typographic ascent is the drag's
//     height, the baseline its lower edge (Affinity's rule);
//   - a press on Artistic or Frame text puts the caret there (drag-resize.js).
//
// Artistic text has no wrapping — it breaks only at its returns — and its box
// is its text's extent. Its corner handles scale it (drag-resize.js →
// storyScale): every size in the story grows by the same factor.
//
// storyConvert(box, 'frame' | 'artistic') is Affinity's Layer ▸ Convert to
// Text Frame / Convert to Artistic Text: the story stays, the frame of a
// converted Artistic text is its text's extent.
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SC = globalThis.StoryCore;
  const btn = document.getElementById('tt-art-text-btn');
  if (!SC) return;

  const OTHER_TOOLS = ['tool-add-box', 'tt-frame-text-btn'];
  const armed = () => state.activeTool === 'art-text';
  function arm(on) {
    if (on) {
      state.activeTool = 'art-text';
      for (const id of OTHER_TOOLS) document.getElementById(id)?.classList.remove('active');
      els.viewer.style.cursor = 'text';
    } else if (armed()) {
      state.activeTool = null;
      els.viewer.style.cursor = 'default';
    }
    btn?.classList.toggle('active', armed());
  }
  btn?.addEventListener('click', () => arm(!armed()));
  for (const id of OTHER_TOOLS) document.getElementById(id)?.addEventListener('click', () => btn?.classList.remove('active'));
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !armed() || utbState.editingId) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
    if (utbState.selectedId) {
      utbState.selectedId = null;
      deselectAllInSVG();
      document.getElementById('fabric-options-bar')?.classList.add('hidden');
      window.syncToolbarToSelection?.();
      return;
    }
    arm(false);
  });

  const toDoc = (svg, e) => { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };

  els.viewer.addEventListener('mousedown', e => {
    if (!armed() || e.button !== 0) return;
    if (e.target.closest('.utb-group')) return;
    const pageEl = e.target.closest('.page-container');
    const svg = pageEl?.querySelector('svg.text-layer');
    if (!svg) return;
    e.preventDefault();
    window.commitStoryEdit?.();
    const pageNum = parseInt(pageEl.id.replace('pageContainer', ''), 10);
    const a = toDoc(svg, e);
    const draft = document.createElementNS(SVG_NS, 'rect');
    draft.classList.add('tt-frame-draft');
    svg.appendChild(draft);
    let b = a;
    const move = ev => {
      b = toDoc(svg, ev);
      draft.setAttribute('x', Math.min(a.x, b.x)); draft.setAttribute('y', Math.min(a.y, b.y));
      draft.setAttribute('width', Math.abs(b.x - a.x)); draft.setAttribute('height', Math.abs(b.y - a.y));
    };
    const up = () => {
      removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      draft.remove();
      const h = Math.abs(b.y - a.y), min = 4 / (state.currentZoom || 1);
      if (h < min) create(pageNum, a.x, a.y, null, 0, true);
      else create(pageNum, Math.min(a.x, b.x), Math.max(a.y, b.y), h, Math.abs(b.x - a.x), false);
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });

  // A new Artistic text with its first baseline at (x, baseline). `ascentPx`
  // (a drag's height) sets the size so that the typographic ascent fills it.
  // `snap` (a click): beside a line of the page's text, the new text takes
  // that line's face, style, size and baseline
  async function create(pageNum, x, baseline, ascentPx, dragW = 0, snap = false) {
    let family = document.getElementById('fabric-font-family')?.value || 'Times New Roman';
    let sizePt = parseFloat(document.getElementById('fabric-font-size')?.value) || 12;
    let bold = false, italic = false;
    const near = snap ? window.utbFindNearestLine?.(pageNum, { x, y: baseline }) : null;
    if (near) {
      family = near.font || family;
      sizePt = near.sizePt || sizePt;
      bold = !!near.bold;
      italic = !!near.italic;
      baseline = typeof computeBaseline === 'function' ? computeBaseline({ y: near.y, h: near.h }) : near.y + near.h * 0.85;
    }
    if (ascentPx) {
      let m = null;
      try { m = await Shaping.faceMetrics({ family, bold, italic }); } catch { /* the fallback ratio */ }
      // Affinity's typographic ascent: max(top of 'l', cap height)
      const ratio = SC.scaledMetrics(m, 1).typoAscent || 0.75;
      sizePt = Math.max(1, Math.round(ascentPx / ratio / GEO.docPxPerPt() * 10) / 10);
    }
    const box = utbState.addBox(new UnifiedTextBox({
      type: 'harfbuzz', page: pageNum, text: '', x, y: baseline - GEO.docPtToPx(sizePt), w: 8, h: GEO.docPtToPx(sizePt),
      fontFamily: family, bold, italic, sizePt, kerning: true,
      // Affinity's default fill is black
      textMode: 'artistic', story: SC.fromText('', { fontFamily: family, bold, italic, sizePt, color: '#000000' }), frame: {},
    }));
    box._keepBaseline = baseline;
    box._minW = dragW;
    window.storySync?.(box);
    renderBox(box);
    window.utbUndo?.recordAdd([box], 'add artistic text');
    utbState.selectedId = box.id;
    selectBoxInSVG(box.id);
    window.enterStoryEdit?.(box);
  }

  // ── scaling Artistic text by a corner ────────────────────────────────────

  // Every length of a story times k: font sizes, baseline shifts, leading,
  // stroke and decoration weights, indents, spaces, tab stops.
  function scaleStory(story, k) {
    const s = SC.clone(story);
    const mul = v => (v == null ? v : Math.round(v * k * 1000) / 1000);
    for (const p of s.paragraphs) {
      const a = p.attrs;
      for (const key of ['leftIndent', 'rightIndent', 'firstIndent', 'spaceBefore', 'spaceAfter', 'listIndent', 'defaultTabs', 'ruleWeight'])
        if (key in a) a[key] = mul(a[key]);
      if (a.leadingType === 'exact' || a.leadingType === 'atLeast') a.leading = mul(a.leading);
      if (a.tabs) a.tabs = a.tabs.map(t => ({ ...t, pos: mul(t.pos) }));
      for (const r of p.runs) {
        const c = r.attrs;
        c.sizePt = Math.max(0.5, mul(c.sizePt ?? SC.CHAR_DEFAULTS.sizePt));
        for (const key of ['baselineShift', 'leadingOverride', 'strokeWidth', 'underlineWeight', 'underlineOffset', 'strikeWeight', 'strikeOffset'])
          if (c[key] != null) c[key] = mul(c[key]);
      }
    }
    return SC.normalize(s);
  }

  // drag-resize.js hands a corner drag of Artistic text here: the opposite
  // corner stays, the text scales with the drag's height.
  window.storyScaleDrag = function (downEvent, box, svgEl, handle) {
    downEvent.preventDefault();
    downEvent.stopPropagation();
    const start = toDoc(svgEl, downEvent);
    const o = { x: box.x, y: box.y, w: box.w, h: box.h, story: SC.clone(box.story) };
    const step = window.utbUndo?.capture([box]);
    const move = e => {
      const p = toDoc(svgEl, e);
      const dy = handle.includes('n') ? start.y - p.y : p.y - start.y;
      const k = Math.max(0.05, (o.h + dy) / o.h);
      box.story = scaleStory(o.story, k);
      window.storySync?.(box);
      box._baselineOffset = null;          // the corner, not the baseline, stays put
      renderBox(box);
      // the opposite corner stays put
      box.x = handle.includes('w') ? o.x + o.w - box.w : o.x;
      box.y = handle.includes('n') ? o.y + o.h - box.h : o.y;
      renderBox(box);
    };
    const up = () => {
      removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      window.utbUndo?.commit(step, 'scale text', `scale:${box.id}`);
      window.storyNotify?.();
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  };

  // ── Convert to Text Frame / Convert to Artistic Text ─────────────────────

  window.storyConvert = function (box, mode) {
    if (!box || box.type !== 'harfbuzz' || (mode !== 'frame' && mode !== 'artistic')) return;
    const editing = window.storyEditing?.() === box;
    if (editing) window.commitStoryEdit?.();
    const step = window.utbUndo?.capture([box]);
    // a one-line box becomes Artistic text first, its baseline where it was
    if (!box.textMode) { window.ensureStory?.(box); renderBox(box); }
    if (box.textMode !== mode) {
      // the text stays where it is: a frame puts its first baseline at its
      // Initial advance below the top, Artistic text hangs from it — the box
      // moves so that the first line starts and sits where it did
      const was = window.storyFirstLine?.(box);
      if (mode === 'frame') {
        // the frame is the text's extent, a hair wider so that nothing wraps
        box.w = Math.ceil(box.w + 2);
        box.h = Math.ceil(box.h + 1);
        box.textMode = 'frame';
      } else {
        box.textMode = 'artistic';
        box.frame = {};
      }
      box._baselineOffset = null;          // Artistic text measures its first baseline afresh
      renderBox(box);
      const now = was && window.storyFirstLine?.(box);
      if (now && (now.x !== was.x || now.baseline !== was.baseline)) {
        box.x += was.x - now.x;
        box.y += was.baseline - now.baseline;
        renderBox(box);
      }
    }
    window.utbUndo?.commit(step, mode === 'frame' ? 'convert to text frame' : 'convert to artistic text');
    utbState.selectedId = box.id;
    selectBoxInSVG(box.id);
    window.syncToolbarToBox?.(box);
    window.storyNotify?.();
  };
})();
