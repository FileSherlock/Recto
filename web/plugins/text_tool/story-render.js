// story-render.js — draws Artistic and Frame text (boxes with a `story`).
//
// A story box (box.textMode 'artistic' | 'frame', box.story — see
// story-core.js) is drawn as HTML inside its group of the page's SVG text
// layer: a <foreignObject> at the box, holding the paragraphs and runs with
// the CSS StoryCore maps their attributes to. The browser shapes the runs
// with the very face files HarfBuzz measures (fonts.js's @font-face rules);
// what CSS has no word for is laid here, after the browser's layout, from
// the face's own metrics (Shaping.faceMetrics):
//
//   - where the first baseline of a frame sits — Affinity's Initial advance
//     (Default, Leading, Pointsize, Ascent, Cap Height, X Height, Fixed) and
//     its Minimum: the flow is moved so that the first line's measured
//     baseline lands there;
//   - Affinity's synthetic small capitals, where the font lacks them;
//   - vertical alignment (Justify: Max Paragraph Space, then every line gap)
//     and the overflow of a frame: the flow is a
//     multi-column box that fills its columns one after the other, so a line
//     that does not fit moves on to a column beyond the frame — never shown
//     cut — and its being there is the overflow (the red marker);
//   - drop caps (a float sized so its cap height spans the lines),
//     horizontal scale and shear of a run (each word an inline box, scaled /
//     sheared about its baseline), custom tab stops (each tab's width set to
//     reach its stop), list markers, column rules.
//
// The same markup is what story-edit.js edits in place: every text node sits
// alone in a leaf <span data-o> that says where in its paragraph it starts,
// and the paragraph's <p data-p> which paragraph — so a DOM position maps
// back to the model exactly.
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XHTML_NS = 'http://www.w3.org/1999/xhtml';
  const SC = globalThis.StoryCore;

  // ── face metrics ──────────────────────────────────────────────────────────

  const metrics = new Map();          // face key → metrics object (null while loading / unknown)
  const waiting = new Map();          // face key → Set of box ids to draw again
  const faceKey = a => `${a.fontFamily}|${a.bold ? 1 : 0}|${a.italic ? 1 : 0}`;
  function metricsOf(a, box) {
    const key = faceKey(a);
    if (metrics.has(key)) return metrics.get(key);
    if (box) {
      if (!waiting.has(key)) {
        waiting.set(key, new Set());
        Promise.resolve(typeof Shaping !== 'undefined' ? Shaping.faceMetrics({ family: a.fontFamily, bold: a.bold, italic: a.italic }) : null)
          .catch(() => null)
          .then(m => {
            metrics.set(key, m || null);
            const ids = waiting.get(key);
            waiting.delete(key);
            for (const id of ids || []) { const b = utbState.getBox(id); if (b) window.renderBox?.(b); }
          });
      }
      waiting.get(key).add(box.id);
    }
    return null;
  }
  // The scaled metrics of a run's face at its size, in px.
  const scaled = (a, box, pxPerPt) => SC.scaledMetrics(metricsOf(a, box), a.sizePt * pxPerPt);
  window.storyFaceMetrics = (a) => metricsOf(SC.charOf(a), null);

  // ── the box's fields ──────────────────────────────────────────────────────

  // A box set as a story keeps the fields every other reader of a box uses —
  // text, fontFamily, sizePt, bold, italic, colour, decorations — in step
  // with its story (those of its first character).
  function storySync(box) {
    if (!box?.story) return;
    box.story = SC.normalize(box.story);
    box.text = SC.toText(box.story);
    const a = SC.charOf(box.story.paragraphs[0].runs[0].attrs);
    box.fontFamily = a.fontFamily;
    box.sizePt = a.sizePt;
    box.bold = a.bold;
    box.italic = a.italic;
    box.underline = a.underline !== 'none';
    box.strikethrough = a.strike !== 'none';
    box.color = a.color;
    box.opacity = a.opacity;
    box.letterSpacing = (a.tracking || 0) / 1000;
    box.kerning = a.autoKern;
    box.kerningAuto = false;
  }

  // A plain box becomes an Artistic-text story: its text and typography as
  // the story's, its first baseline where it was (the y of the box moves so
  // that it does not jump). Returns the box.
  function ensureStory(box) {
    if (!box || box.textMode) return box;
    const baseline = typeof computeBaseline === 'function' ? computeBaseline(box) : box.y + box.h * 0.85;
    box.textMode = 'artistic';
    box.story = SC.fromText(box.text || '', {
      fontFamily: box.fontFamily, sizePt: box.sizePt, bold: !!box.bold, italic: !!box.italic,
      color: box.color || null, opacity: box.opacity ?? 100, underline: box.underline ? 'single' : 'none', strike: box.strikethrough ? 'single' : 'none',
      tracking: Math.round((+box.letterSpacing || 0) * 1000), autoKern: !!box.kerning,
    });
    box.frame = {};
    box._keepBaseline = baseline;           // renderStoryBox moves y so the first baseline stays here
    box.baseCharPositions = null;
    box.charAdvances = {};
    box.autoWidth = false;
    box.defaultSpaceWidth = true;
    box.spaceWidth = null;
    storySync(box);
    return box;
  }

  // ── markup ────────────────────────────────────────────────────────────────

  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  function leaf(text, o, cls = 'tt-leaf') {
    const s = el('span', cls);
    s.dataset.o = o;
    s.textContent = text.split(SC.LINE_BREAK).join('\n');
    return s;
  }
  const needsWords = a => a.scaleX !== 100 || a.scaleY !== 100 || a.shear !== 0;

  // One run's text into `into`: leaves, words of a scaled / sheared run in
  // inline boxes of their own, tabs of a paragraph with tab stops in boxes the
  // tab pass sizes.
  function emitText(into, text, o, a, m, lead, customTabs) {
    const parts = customTabs ? text.split(/(\t)/) : [text];
    for (const part of parts) {
      if (!part) continue;
      if (part === '\t') {
        const t = leaf('\t', o, 'tt-leaf tt-tab');
        into.appendChild(t);
        o += 1;
        continue;
      }
      if (!needsWords(a)) { into.appendChild(leaf(part, o)); o += part.length; continue; }
      for (const tok of part.split(/(\s+)/)) {
        if (!tok) continue;
        if (/^\s+$/.test(tok)) { into.appendChild(leaf(tok, o)); o += tok.length; continue; }
        const w = el('span', 'tt-word');
        // the inline box's baseline: half the leading above the face's
        // ascender — scaling and shearing about it keep the glyphs on the line
        const base = (lead - (m.ascender - m.descender)) / 2 + m.ascender;
        const t = [];
        if (a.shear) t.push(`skewX(${-a.shear}deg)`);
        if (a.scaleX !== 100 || a.scaleY !== 100) t.push(`scale(${a.scaleX / 100}, ${a.scaleY / 100})`);
        w.style.cssText = `display:inline-block;transform-origin:0 ${+base.toFixed(3)}px;transform:${t.join(' ')}`;
        if (a.scaleX !== 100) w.dataset.sx = a.scaleX / 100;
        w.appendChild(leaf(tok, o));
        into.appendChild(w);
        o += tok.length;
      }
    }
    return o;
  }

  // A run's text with Affinity's synthetic small capitals: where the font
  // lacks the feature its caps mode asks for (StoryCore.capsPlan), the
  // letters it names — lower case, capitals or both — are drawn as capitals
  // at the font's small-caps scale (OS/2 xHeight / capHeight). The DOM text
  // stays the story's (text-transform draws the capitals), so every offset
  // holds.
  function emitRun(into, text, o, a, m, lead, customTabs, ctx) {
    const synth = SC.capsPlan(a.caps, m.features).synth;
    if (!synth.length) return emitText(into, text, o, a, m, lead, customTabs);
    const small = ch => (synth.includes('lower') && /\p{Ll}/u.test(ch)) || (synth.includes('upper') && /\p{Lu}/u.test(ch));
    let i = 0;
    while (i < text.length) {
      const isSmall = small(text[i]);
      let j = i + 1;
      while (j < text.length && small(text[j]) === isSmall) j++;
      const part = text.slice(i, j);
      if (isSmall) {
        const sp = el('span', 'tt-smallcaps');
        sp.style.cssText = `font-size:${+(a.sizePt * ctx.pxPerPt * m.smallCaps).toFixed(4)}px;text-transform:uppercase`;
        emitText(sp, part, o + i, a, m, lead, customTabs);
        into.appendChild(sp);
      } else emitText(into, part, o + i, a, m, lead, customTabs);
      i = j;
    }
    return o + text.length;
  }

  function cssOfParaFont(a, ctx) {
    return {
      'font-family': `"${a.fontFamily}", "Times New Roman", serif`,
      'font-size': `${+(a.sizePt * ctx.pxPerPt).toFixed(4)}px`,
      'font-weight': a.bold ? '700' : '400',
      'font-style': a.italic ? 'italic' : 'normal',
      'color': a.color || ctx.defaultColor,
    };
  }

  // The paragraphs of a story as elements.
  function buildParagraphs(box, flow, ctx) {
    const story = box.story;
    const markers = SC.listMarkers(story);
    let prev = null;
    story.paragraphs.forEach((para, p) => {
      const pa = SC.paraOf(para.attrs);
      const first = SC.charOf(para.runs[0].attrs);
      const fm = scaled(first, box, ctx.pxPerPt);
      const lead = SC.leadingPx(pa, first, fm, ctx.pxPerPt);
      const pe = el('p', 'tt-para');
      pe.dataset.p = p;
      const css = { ...cssOfParaFont(first, ctx), ...SC.paraCSS(pa, lead, prev, ctx, { marker: markers[p], first: p === 0 }) };
      if (markers[p]) {
        pe.dataset.marker = markers[p];
        css['--tt-marker-x'] = `${+(pa.leftIndent * ctx.pxPerPt).toFixed(4)}px`;
        css['--tt-marker-y'] = css['padding-top'] || '0px';
      }
      pe.style.cssText = SC.styleText(css);
      const customTabs = !!pa.tabs?.length;

      // a drop cap: the first characters in a float of their own
      const text = SC.paraText(para);
      let dropEnd = 0, drop = null;
      if (pa.dropLines >= 2 && text.length) {
        dropEnd = Math.min(Math.max(1, pa.dropChars | 0), text.length);
        drop = el('span', 'tt-drop');
        // its size: the cap height spans from the first line's cap to the
        // baseline `dropLines` lines down
        const capFirst = fm.capHeight, ratio = fm.capHeight / (first.sizePt * ctx.pxPerPt) || 0.66;
        const dropPx = (capFirst + (pa.dropLines - 1) * lead) / ratio;
        const dm = SC.scaledMetrics(metricsOf(first, box), dropPx);
        const firstBaseline = (lead - (fm.ascender - fm.descender)) / 2 + fm.ascender;
        const dropLead = dm.ascender - dm.descender;
        const top = firstBaseline + (pa.dropLines - 1) * lead - dm.ascender;
        // the float's margin box is exactly `dropLines` lines tall (a hair
        // less), so those lines — and no more — run beside it
        const bottom = pa.dropLines * lead - 0.5 - top - dropLead;
        drop.style.cssText = SC.styleText({
          float: 'left', 'font-size': `${+dropPx.toFixed(3)}px`, 'line-height': `${+dropLead.toFixed(3)}px`,
          'margin-top': `${+top.toFixed(3)}px`, 'margin-right': `${+(pa.dropDistance * ctx.pxPerPt).toFixed(3)}px`,
          'margin-bottom': `${+bottom.toFixed(3)}px`, 'text-indent': '0',
        });
        drop.dataset.px = dropPx;
        pe.appendChild(drop);
      }

      let o = 0;
      for (const run of para.runs) {
        if (!run.text) continue;
        let a = SC.charOf(run.attrs);
        // kerning nobody chose follows the page, as a typed box's does (the
        // guarded seam an analysis plugin answers)
        if (!('autoKern' in run.attrs) && typeof window.utbAutoKerning === 'function') {
          try {
            const k = window.utbAutoKerning({ ...box, fontFamily: a.fontFamily, bold: a.bold, italic: a.italic, sizePt: a.sizePt, kerningAuto: true });
            if (typeof k === 'boolean') a = { ...a, autoKern: k };
          } catch { /* the plugin's */ }
        }
        const m = scaled(a, box, ctx.pxPerPt);
        const css = SC.runCSS(a, pa, m, ctx);
        // leading that follows the text: every run brings its line height, so
        // a line follows its largest text (Default, Multiple, % Height)
        if (SC.leadingPerRun(pa) && a.leadingOverride == null) css['line-height'] = `${+SC.leadingPx(pa, a, m, ctx.pxPerPt).toFixed(4)}px`;
        if (a.lang) css['-webkit-locale'] = `"${a.lang}"`;
        const strike = SC.strikeCSS(a, m);
        // the part of the run inside the drop cap, then the rest
        const pieces = [];
        if (o < dropEnd) {
          const n = Math.min(run.text.length, dropEnd - o);
          pieces.push({ text: run.text.slice(0, n), into: drop, at: o, dropped: true });
          if (n < run.text.length) pieces.push({ text: run.text.slice(n), into: pe, at: o + n });
        } else pieces.push({ text: run.text, into: pe, at: o });
        for (const piece of pieces) {
          const span = el('span', 'tt-run');
          const rcss = { ...css };
          if (piece.dropped) { delete rcss['font-size']; delete rcss['line-height']; delete rcss.top; delete rcss.position; }
          span.style.cssText = SC.styleText(rcss);
          if (a.lang) span.lang = a.lang;
          let host = span;
          if (strike) { host = el('span', 'tt-strike'); host.style.cssText = SC.styleText(strike); span.appendChild(host); }
          emitRun(host, piece.text, piece.at, a, m, lead, customTabs && !piece.dropped, ctx);
          piece.into.appendChild(span);
        }
        o += run.text.length;
      }
      if (!text.length) pe.appendChild(el('br', 'tt-ph'));
      // a paragraph that ends in a line break needs a line to put the caret on
      else if (text.endsWith(SC.LINE_BREAK)) pe.appendChild(el('br', 'tt-ph'));
      flow.appendChild(pe);
      prev = pa;
    });
  }

  // ── after the browser's layout ────────────────────────────────────────────

  // screen px per local px of an element inside the foreignObject: the
  // foreignObject's own scale on screen. Not a ratio of the element's widths —
  // offsetWidth is a whole number, which put a one-character Artistic text's
  // baseline 1 px off (6.53 px / 7) and moved a line on every keystroke.
  const unitOf = node => {
    const m = node.closest?.('foreignObject')?.getScreenCTM?.();
    return (m && Math.hypot(m.a, m.b)) || 1;
  };

  // A scaled word takes the room of its scaled width.
  function passScale(flow) {
    for (const w of flow.querySelectorAll('.tt-word[data-sx]')) {
      w.style.marginRight = '';
      const sx = +w.dataset.sx;
      w.style.marginRight = `${+(w.offsetWidth * (sx - 1)).toFixed(3)}px`;
    }
  }

  // Tabs of a paragraph with tab stops: each tab grows to reach the next stop
  // after it — a left stop at the stop, a right stop with the text after it
  // ending there, a centre stop centring it, a decimal stop on its first '.'
  // or ','. Past the last stop the default stops apply.
  function passTabs(box, flow, ctx) {
    for (const pe of flow.querySelectorAll('.tt-para')) {
      const tabs = [...pe.querySelectorAll('.tt-tab')];
      if (!tabs.length) continue;
      const pa = SC.paraOf(box.story.paragraphs[+pe.dataset.p]?.attrs);
      const stops = (pa.tabs || []).map(t => ({ ...t, x: t.pos * ctx.pxPerPt })).sort((a, b) => a.x - b.x);
      const every = (pa.defaultTabs || 36) * ctx.pxPerPt;
      const k = unitOf(pe);
      const left = pe.getBoundingClientRect().left / k + parseFloat(getComputedStyle(pe).paddingLeft || 0);
      tabs.forEach(t => { t.style.width = '0px'; });
      tabs.forEach((t, i) => {
        const x = t.getBoundingClientRect().left / k - left;
        // the next stop after the tab; past the last one, the next default stop
        const stop = stops.find(s => s.x > x + 0.5) || { x: (Math.floor(x / every + 1e-6) + 1) * every, align: 'left' };
        const seg = stop.align === 'left' ? 0 : segmentWidth(pe, t, tabs[i + 1], stop.align, k);
        t.style.width = `${Math.max(0, stop.x - x - seg).toFixed(3)}px`;
        t.classList.toggle('tt-tab-leader', !!stop.leader);
        if (stop.leader) t.style.setProperty('--tt-leader', stop.leader === '.' ? 'dotted' : stop.leader === '-' ? 'dashed' : 'solid');
      });
    }
  }

  // How much of the text after a tab must sit before its stop: all of it up
  // to the next tab (Right), half of it (Centre), up to its first decimal
  // sign (Decimal) — in px.
  function segmentWidth(pe, tab, nextTab, align, k) {
    const r = document.createRange();
    r.setStartAfter(tab);
    if (nextTab) r.setEndBefore(nextTab); else r.setEndAfter(pe.lastChild);
    if (align === 'decimal') {
      // walk the text nodes after the tab to the first '.' or ','
      const walker = document.createTreeWalker(pe, NodeFilter.SHOW_TEXT);
      walker.currentNode = tab.lastChild || tab;
      let node;
      while ((node = walker.nextNode())) {
        if (nextTab && !r.intersectsNode(node)) break;
        const d = node.data.search(/[.,]/);
        if (d >= 0) { r.setEnd(node, d); break; }
      }
    }
    const w = r.getBoundingClientRect().width / k;
    return align === 'center' ? w / 2 : w;
  }

  // The first baseline of the flow, measured: px below the flow's top.
  function measureFirstBaseline(flow) {
    const pe = flow.querySelector('.tt-para');
    if (!pe) return 0;
    const probe = el('span', 'tt-probe');
    probe.setAttribute('contenteditable', 'false');
    pe.insertBefore(probe, pe.firstChild);
    const k = unitOf(flow);
    const y = (probe.getBoundingClientRect().top - flow.getBoundingClientRect().top) / k;
    probe.remove();
    return y;
  }

  // ── the box ───────────────────────────────────────────────────────────────

  // ── the pixel-renderer seam (window.utbPixelRender) ───────────────────────

  // What a pixel renderer can draw of a run: the face, size, tracking,
  // kerning, colour and single decorations of a one-line box. A story using
  // anything else stays HTML, all of it.
  const pixelable = a => !a.highlight && !(a.strokeColor && a.strokeWidth > 0) && a.scaleX === 100 && a.scaleY === 100
    && !a.shear && a.position === 'normal' && a.ot_position === 'normal' && (a.caps === 'none' || a.caps === 'all')
    && !(a.opacity < 100) && a.underline !== 'double' && a.strike !== 'double';
  const SOFT_HYPHEN = String.fromCharCode(0xAD);

  // Ask the seam to forget pieces it drew before (an empty text is its "forget").
  function forgetPieces(box, ids) {
    for (const id of ids || []) {
      try { window.utbPixelRender({ id, type: box.type, page: box.page, text: '' }, [0], 0); } catch { /* the plugin's */ }
    }
  }

  // The page positions of a story's layout. They are taken RELATIVE TO THE
  // FLOW, and the flow's origin from the box's own numbers: the browser
  // truncates the foreignObject's position to its 1/64 px layout grid
  // (Artistic text clicked at x 63.2 started at 63.1875), which moves pens on
  // the ¼ px lattice. So the first line of Artistic text starts at box.x on
  // the baseline it was given (box.y + the measured first baseline).
  // → { flow, k (screen px per doc px), docX, docY } | null
  function flowMap(g, box) {
    const flow = g?.querySelector('.tt-flow');
    if (!flow) return null;
    const k = unitOf(flow);
    const fr = flow.getBoundingClientRect();
    const inFrame = box.textMode === 'frame';
    const ox = box.x + (inFrame ? parseFloat(flow.style.left) || 0 : 0);
    const oy = box.y + (inFrame ? parseFloat(flow.style.top) || 0 : 0);
    return { flow, k, docX: x => ox + (x - fr.left) / k, docY: y => oy + (y - fr.top) / k };
  }

  // The spacing of a run as runCSS gives it to the browser, in px at `sizePx`
  // (a drop cap's size, else the run's own): tracking and manual kerning in ‰
  // of an em and the paragraph's desired letter spacing in % of the space,
  // after every glyph; a space is the face's own plus the paragraph's desired
  // word spacing over 100 % of the space at the run's size.
  function spacingOf(a, pa, box, ctx, sizePx) {
    const runSpace = scaled(a, box, ctx.pxPerPt).space;
    const ownSpace = sizePx === a.sizePt * ctx.pxPerPt ? runSpace : SC.scaledMetrics(metricsOf(a, box), sizePx).space;
    return {
      letterPx: ((a.tracking || 0) + (a.manualKern || 0)) / 1000 * sizePx + (pa.letterSpacing || 0) / 100 * runSpace,
      // (to 1e-9 px: a width set in px comes back through a % of the space)
      spacePx: pa.wordSpacing === 100 ? null : Math.round((ownSpace + (pa.wordSpacing - 100) / 100 * runSpace) * 1e9) / 1e9,
      ownSpace,
    };
  }

  // A story drawn by the pixel seam, as one-line boxes: every line of the
  // laid-out story is cut into pieces of one run each; the browser's layout
  // says where a line starts and where its baseline is (flowMap), the seam
  // lays the glyphs of a piece with the run's spacing and its advance places
  // the next piece of the same line (a justified line is cut at its spaces
  // too, which the browser stretched). Every piece drawn → the HTML is hidden
  // and the pieces' images show; any piece declined → the story stays HTML.
  // Not while the story is edited.
  function pixelPass(g, box, ctx) {
    g.querySelectorAll('.utb-pixel').forEach(e => e.remove());
    g.classList.remove('utb-pixel-mode');
    const before = box._pixelIds || [];
    box._pixelIds = [];
    if (typeof window.utbPixelRender !== 'function') return;
    const give_up = () => { forgetPieces(box, before); };
    if (utbState.editingId === box.id) return give_up();
    const map = flowMap(g, box);
    if (!map) return give_up();
    const { flow, docX, docY } = map;
    const clipRight = box.textMode === 'frame' && SC.frameOf(box.frame).hideOverflow ? box.x + box.w + 1 : Infinity;

    // the pieces, in reading order
    const pieces = [];
    for (const pe of flow.querySelectorAll('.tt-para')) {
      const para = box.story.paragraphs[+pe.dataset.p];
      if (!para) continue;
      const pa = SC.paraOf(para.attrs);
      const justified = pa.align.startsWith('justify');
      let last = null;
      for (const lf of pe.querySelectorAll('.tt-leaf')) {
        const node = lf.firstChild;
        if (!node || node.nodeType !== 3) continue;
        const o0 = +lf.dataset.o;
        const stored = SC.runAttrsAt(para, o0 + 1), a = SC.charOf(stored);
        if (!pixelable(a) || lf.closest('.tt-smallcaps')) return give_up();
        const drop = lf.closest('.tt-drop');
        const sizePt = drop ? +drop.dataset.px / ctx.pxPerPt : a.sizePt;
        let cur = null;
        for (let i = 0; i < node.length; i++) {
          const ch = node.data[i];
          if (ch === '\n' || ch === '\t' || ch === SOFT_HYPHEN || (justified && ch === ' ')) { cur = null; last = null; continue; }
          const r = document.createRange();
          r.setStart(node, i); r.setEnd(node, i + 1);
          const q = r.getClientRects()[0];
          if (!q) continue;
          const sameLine = p => p && Math.abs(q.top + q.height / 2 - (p.top + p.height / 2)) < Math.min(q.height, p.height) / 2;
          if (cur && sameLine(cur)) { cur.i1 = i + 1; continue; }
          if (docX(q.left) > clipRight) { cur = null; continue; }
          // a new piece: chained to the one before it while they share a line
          cur = { node, lf, i0: i, i1: i + 1, top: q.top, height: q.height, left: q.left, a, stored, sizePt, pa,
            chain: !!(last && sameLine(last) && !drop && !last.drop), drop: !!drop };
          pieces.push(cur);
          last = cur;
        }
      }
    }
    if (!pieces.length) return give_up();

    // their baselines: a zero-size probe at each piece's start (last first, so
    // the earlier offsets of a split text node still hold), then the leaves'
    // text nodes joined again — every leaf keeps one text node for the editor
    const probes = [];
    for (let n = pieces.length - 1; n >= 0; n--) {
      const p = pieces[n];
      const at = p.i0 ? p.node.splitText(p.i0) : p.node;
      const probe = el('span', 'tt-probe');
      at.parentNode.insertBefore(probe, at);
      probes[n] = probe;
    }
    pieces.forEach((p, n) => { p.baseline = docY(probes[n].getBoundingClientRect().top); });
    for (const probe of probes) probe.remove();
    // Artistic text's first line sits on the baseline it was given, exactly —
    // a measured one is a screen position, some 1e-5 px off at most zooms
    if (box.textMode === 'artistic' && box._baselineOffset != null) {
      const kept = box.y + box._baselineOffset;
      for (const p of pieces) if (Math.abs(p.baseline - kept) < 0.01) p.baseline = kept;
    }
    new Set(pieces.map(p => p.lf)).forEach(lf => lf.normalize());

    // draw them
    const drawn = [];
    let prev = null, spaces = null;
    for (const [n, p] of pieces.entries()) {
      const node = p.lf.firstChild, raw = node.data.slice(p.i0, p.i1);
      const upper = raw.toUpperCase();
      let text = p.a.caps === 'all' && upper.length === raw.length ? upper : raw;
      const sizePx = p.sizePt * ctx.pxPerPt;
      const sp = spacingOf(p.a, p.pa, box, ctx, sizePx);
      // the seam's advance stops at the last glyph; the browser puts the
      // letter spacing after it too (a manual kern on a character of its own
      // is all after it), so the next piece starts beyond it
      let x = p.chain && prev?.res ? prev.x + prev.res.advanceW + prev.letterPx : docX(p.left);
      // a piece of spaces alone (a space formatted on its own — a nudge's
      // kern) draws nothing and the seam lays no glyph of it: it goes in front
      // of the next piece of its line, which lays the spaces at its own
      // spacing, and that piece's start moves by what theirs differs by; at
      // the end of a line it places nothing
      if (/^ +$/.test(text)) {
        const own = text.length * ((sp.spacePx ?? sp.ownSpace) + sp.letterPx);
        spaces = !pieces[n + 1]?.chain ? null
          : spaces && p.chain ? { x: spaces.x, n: spaces.n + text.length, width: spaces.width + own }
          : { x, n: text.length, width: own };
        if (!spaces) prev = null;
        continue;
      }
      if (spaces && p.chain) {
        x = spaces.x + spaces.width - spaces.n * ((sp.spacePx ?? sp.ownSpace) + sp.letterPx);
        text = ' '.repeat(spaces.n) + text;
      }
      spaces = null;
      const piece = {
        id: `${box.id}~${n}`, type: box.type, page: box.page, text,
        fontFamily: p.a.fontFamily, bold: !!p.a.bold, italic: !!p.a.italic, sizePt: p.sizePt,
        letterSpacing: sp.letterPx / sizePx,
        kerning: !!p.a.autoKern, kerningAuto: false,
        color: p.a.color || null, labelColor: null, labelAlign: null,
        underline: p.a.underline === 'single', strikethrough: p.a.strike === 'single',
        defaultSpaceWidth: sp.spacePx == null, spaceWidth: sp.spacePx, baseCharPositions: null, charAdvances: {},
        x, y: p.baseline - sizePx, w: 0, h: sizePx, lineId: null,
      };
      // kerning nobody chose follows the page, as a typed box's does
      if (!('autoKern' in p.stored) && typeof window.utbAutoKerning === 'function') {
        try { const kk = window.utbAutoKerning(piece); if (typeof kk === 'boolean') piece.kerning = kk; } catch { /* the plugin's */ }
      }
      let res = null;
      try { res = window.utbPixelRender(piece, [x], p.baseline); } catch (e) { console.warn('utbPixelRender failed for', piece.id, e); }
      if (!res) { forgetPieces(box, [...before, ...drawn.map(d => d.id)]); return; }
      drawn.push({ id: piece.id, res });
      prev = { x, res, letterPx: sp.letterPx };
    }

    // all of them: show the pixels, hide the HTML (it stays for the layout,
    // and pointer events go to the images)
    for (const { id, res } of drawn) {
      const img = document.createElementNS(SVG_NS, 'image');
      img.classList.add('utb-pixel');
      img.dataset.piece = id;
      img.setAttribute('preserveAspectRatio', 'none');
      img.setAttribute('x', res.x); img.setAttribute('y', res.y);
      img.setAttribute('width', res.w); img.setAttribute('height', res.h);
      img.setAttribute('href', res.href);
      g.insertBefore(img, g.querySelector('.utb-fh, .tt-overflow-marker'));   // under the handles
    }
    g.classList.add('utb-pixel-mode');
    box._pixelIds = drawn.map(d => d.id);
    forgetPieces(box, before.filter(id => !box._pixelIds.includes(id)));
  }

  // ── what the fitting tools read from the layout ───────────────────────────

  // Every character of a story where the layout put it, on the page: [{ p, o,
  // ch, x, y, w, h, lineStart }] in reading order — lineStart: the first
  // character of its line. (The HTML stays laid out under the pixel view.)
  function charBoxes(g, box) {
    const map = flowMap(g, box);
    if (!map) return null;
    const out = [];
    for (const pe of map.flow.querySelectorAll('.tt-para')) {
      const p = +pe.dataset.p;
      let prev = null;
      for (const lf of pe.querySelectorAll('.tt-leaf')) {
        const node = lf.firstChild;
        if (!node || node.nodeType !== 3) continue;
        for (let i = 0; i < node.length; i++) {
          const ch = node.data[i];
          if (ch === '\n') { prev = null; continue; }
          const r = document.createRange();
          r.setStart(node, i); r.setEnd(node, i + 1);
          const q = r.getClientRects()[0];
          if (!q) continue;
          const lineStart = !prev || Math.abs(q.top + q.height / 2 - (prev.top + prev.height / 2)) >= Math.min(q.height, prev.height) / 2;
          out.push({ p, o: +lf.dataset.o + i, ch, x: map.docX(q.left), y: map.docY(q.top), w: q.width / map.k, h: q.height / map.k, lineStart });
          prev = q;
        }
      }
    }
    return out;
  }

  // Space badges (the ribbon's sp# toggle, svg-renderer.js) over every run of
  // spaces inside a line: its width as the seam lays it — the face's space,
  // or the paragraph's desired word spacing of it — and on a justified line
  // as the browser stretched it, less the letter spacing.
  function spaceBadges(g, box, ctx) {
    if (typeof showSpaceWidthLabels === 'undefined' || !showSpaceWidthLabels || typeof _spacebadge !== 'function') return;
    const chars = charBoxes(g, box);
    if (!chars) return;
    for (let n = 0; n < chars.length; n++) {
      if (chars[n].ch !== ' ') continue;
      let end = n;
      while (end + 1 < chars.length && chars[end + 1].ch === ' ' && !chars[end + 1].lineStart) end++;
      const next = chars[end + 1];
      // trailing spaces and a line's last spaces (where it wrapped) get none
      if (next && !next.lineStart && next.p === chars[n].p && next.ch !== '\t') {
        const para = box.story.paragraphs[chars[n].p], pa = SC.paraOf(para.attrs);
        let w = 0;
        for (let m = n; m <= end; m++) {
          const a = SC.charOf(SC.runAttrsAt(para, chars[m].o + 1));
          const sp = spacingOf(a, pa, box, ctx, a.sizePt * ctx.pxPerPt);
          w += pa.align.startsWith('justify') ? chars[m].w - sp.letterPx : (sp.spacePx ?? sp.ownSpace);
        }
        const x0 = chars[n].x, x1 = chars[end].x + chars[end].w;
        _spacebadge(g, (x0 + x1) / 2, chars[n].y - 8, w.toFixed(1), 'rgba(255,210,0,0.92)');
      }
      n = end;
    }
  }

  // Where the first line starts and sits: { x, baseline } on the page.
  function firstLine(g, box) {
    const map = flowMap(g, box);
    const pe = map?.flow.querySelector('.tt-para');
    if (!pe) return null;
    const probe = el('span', 'tt-probe');
    probe.setAttribute('contenteditable', 'false');
    pe.insertBefore(probe, pe.firstChild);
    const q = probe.getBoundingClientRect();
    probe.remove();
    return { x: map.docX(q.left), baseline: map.docY(q.top) };
  }
  const groupOf = box => document.querySelector(`.utb-group[data-id="${box.id}"]`);
  window.storyCharBoxes = box => (box?.textMode ? charBoxes(groupOf(box), box) : null);
  window.storyFirstLine = box => (box?.textMode ? firstLine(groupOf(box), box) : null);
  // the face's own space of a run's attributes, in px (0.25 em while its
  // metrics load — what the renderer uses meanwhile)
  window.storySpacePx = attrs => { const a = SC.charOf(attrs); return SC.scaledMetrics(metricsOf(a, null), a.sizePt * GEO.docPxPerPt()).space; };

  function renderStoryBox(g, box) {
    if (!box.story) return;
    layoutStoryBox(g, box);
    frameHandles(g, box);
    pixelPass(g, box, { pxPerPt: GEO.docPxPerPt() });
    spaceBadges(g, box, { pxPerPt: GEO.docPxPerPt() });
    // an editor's selection lives in the model: put it back on the new markup
    if (utbState.editingId === box.id) window.storyAfterRender?.(box);
  }

  function layoutStoryBox(g, box) {
    storySync(box);
    const ctx = {
      pxPerPt: GEO.docPxPerPt(),
      defaultColor: (typeof UTB_TYPE_COLORS !== 'undefined' && UTB_TYPE_COLORS[box.type]) || '#000',
    };
    const frame = SC.frameOf(box.frame);
    const isFrame = box.textMode === 'frame';
    g.dataset.mode = box.textMode;

    // the frame's own fill and outline, behind the text
    let shape = g.querySelector('.tt-frame-shape');
    if (isFrame && (frame.fill || (frame.stroke && frame.strokeWidth > 0))) {
      if (!shape) { shape = document.createElementNS(SVG_NS, 'rect'); shape.classList.add('tt-frame-shape'); g.insertBefore(shape, g.firstChild); }
      shape.setAttribute('fill', frame.fill || 'none');
      shape.setAttribute('stroke', frame.stroke || 'none');
      shape.setAttribute('stroke-width', frame.stroke ? frame.strokeWidth * ctx.pxPerPt : 0);
    } else shape?.remove();

    let fo = g.querySelector('.tt-story-fo');
    if (!fo) {
      fo = document.createElementNS(SVG_NS, 'foreignObject');
      fo.classList.add('tt-story-fo');
      g.appendChild(fo);
    }
    // keep a live editor's elements (story-edit.js swaps their content)
    let root = fo.querySelector('.tt-story');
    if (!root) {
      root = document.createElementNS(XHTML_NS, 'div');
      fo.appendChild(root);
    }
    root.className = `tt-story tt-${box.textMode}`;
    let flow = root.querySelector('.tt-flow');
    if (!flow) { flow = el('div', 'tt-flow'); root.appendChild(flow); }
    flow.replaceChildren();
    buildParagraphs(box, flow, ctx);

    const pt = v => v * ctx.pxPerPt;
    if (!isFrame) {
      // Artistic text: no wrapping, the box is the text's extent
      fo.setAttribute('x', box.x); fo.setAttribute('y', box.y);
      fo.setAttribute('width', 8000); fo.setAttribute('height', 8000);
      root.style.cssText = '';
      flow.style.cssText = '';
      passScale(flow);
      passTabs(box, flow, ctx);
      // an empty one keeps a width to see and press: the drag's, else half an em
      const empty = !SC.toText(box.story).length;
      const sizePx = SC.charOf(box.story.paragraphs[0].runs[0].attrs).sizePt * ctx.pxPerPt;
      const w = empty ? Math.max(box._minW || 0, sizePx * 0.5, 4) : Math.max(flow.offsetWidth, 4), h = Math.max(flow.offsetHeight, 4);
      // Artistic text hangs from its first baseline, as Affinity's does: a
      // new or converted one puts it where it was asked to be, and a change
      // of its line (a size, a face whose metrics just arrived) keeps it
      // there — the text grows upward from it
      // (box.y + _baselineOffset is the first baseline exactly: the offset
      // changes only with the box's y, never by a measurement's 1e-5 px)
      const base = measureFirstBaseline(flow);
      if (box._keepBaseline != null) {
        box.y = box._keepBaseline - base;
        box._baselineOffset = base;
        delete box._keepBaseline;
      } else if (box._baselineOffset == null) {
        box._baselineOffset = base;
      } else if (Math.abs(box._baselineOffset - base) > 0.01) {
        box.y += box._baselineOffset - base;
        box._baselineOffset = base;
      }
      fo.setAttribute('y', box.y);
      box.w = w; box.h = h;
      fo.setAttribute('width', Math.ceil(w) + 1);
      fo.setAttribute('height', Math.ceil(h) + 1);
      g.querySelector('.tt-col-rules')?.remove();
      g.classList.remove('tt-overflow');
      _overflowMarker(g, box, false);
      return;
    }

    // Frame text
    const W = Math.max(box.w, 8), H = Math.max(box.h, 8);
    // insets never invert the inner box (left = min(x0 + l, x1), as Affinity)
    const insetL = Math.min(pt(frame.insetLeft), W), insetR = Math.min(pt(frame.insetRight), W - insetL);
    const insetT = Math.min(pt(frame.insetTop), H), insetB = Math.min(pt(frame.insetBottom), H - insetT);
    const cols = Math.max(1, frame.columns | 0);
    const innerW = Math.max(4, W - insetL - insetR);
    // gutters keep their width unless they alone are wider than the box
    const gutter = cols > 1 ? Math.min(pt(frame.gutter), (innerW - 1) / (cols - 1)) : 0;
    const colW = (innerW - gutter * (cols - 1)) / cols;
    const auto = frame.autoHeight;
    fo.setAttribute('x', box.x); fo.setAttribute('y', box.y);
    fo.setAttribute('width', W); fo.setAttribute('height', auto ? 8000 : H);
    root.style.cssText = `width:${W}px;height:${auto ? 'auto' : `${H}px`}`;
    // a single column still has a gap: the column beyond it holds what overflows
    const colGap = cols > 1 ? gutter : 24;
    const flowCSS = (top, { show = false } = {}) => SC.styleText({
      left: `${insetL}px`, top: `${+top.toFixed(3)}px`, width: `${innerW}px`,
      ...(auto || (show && cols === 1) ? { height: 'auto' } : { height: `${+Math.max(4, H - top - insetB).toFixed(3)}px` }),
      'column-count': cols, 'column-gap': `${colGap}px`,
      'column-fill': frame.balance || auto ? 'balance' : 'auto',
      // the columns beyond the frame hold what does not fit: hidden unless the
      // frame shows its overflow
      ...(show ? {} : { 'clip-path': `inset(-2000px ${+(-Math.min(colGap / 2, 12)).toFixed(3)}px -2000px -2000px)` }),
    });
    flow.style.cssText = flowCSS(insetT);
    passScale(flow);
    passTabs(box, flow, ctx);

    // the first baseline: Affinity's Initial advance, never above Minimum
    const p0 = box.story.paragraphs[0];
    const a0 = SC.charOf(p0.runs[0].attrs);
    const m0 = scaled(a0, box, ctx.pxPerPt);
    const lead0 = SC.leadingPx(SC.paraOf(p0.attrs), a0, m0, ctx.pxPerPt);
    const want = SC.firstBaselinePx(frame, a0, m0, lead0, ctx.pxPerPt);
    let top = insetT + want - measureFirstBaseline(flow);
    flow.style.cssText = flowCSS(top);

    if (auto) {
      const h = Math.max(8, top + flow.offsetHeight + insetB);
      box.h = h;
      root.style.height = `${h}px`;
      fo.setAttribute('height', h);
      columnRules(g, box, frame, { insetL, insetT, H: h, insetB, cols, colW, gutter, ctx });
      g.classList.remove('tt-overflow');
      _overflowMarker(g, box, false);
      return;
    }

    const overflowing = () => flow.scrollWidth > flow.clientWidth + 1;
    let over = overflowing();
    if (!over && cols === 1 && frame.valign !== 'top') {
      const k = unitOf(flow);
      const flowTop = flow.getBoundingClientRect().top;
      const paras = [...flow.querySelectorAll(':scope > .tt-para')];
      const last = paras[paras.length - 1];
      const bottomOf = pe => (pe.getBoundingClientRect().bottom - flowTop) / k - parseFloat(pe.style.paddingBottom || 0);
      const free = Math.max(0, (H - top - insetB) - (last ? bottomOf(last) : 0));
      if (frame.valign === 'justify') {
        // paragraph gaps first get up to Max Paragraph Space each, the rest is
        // spread evenly over every gap between baselines (Affinity's rule)
        const lines = paras.reduce((n, pe) => n + lineCount(pe, k), 0);
        const pGap = paras.length > 1 ? Math.min(free / (paras.length - 1), pt(frame.maxParaSpace)) : 0;
        const rest = free - pGap * Math.max(0, paras.length - 1);
        const lGap = lines > 1 ? rest / (lines - 1) : 0;
        if (pGap) paras.slice(0, -1).forEach(pe => { pe.style.marginBottom = `${+pGap.toFixed(3)}px`; });
        if (lGap) {
          bumpLeading(flow, lGap);
          top -= lGap / 2;           // the first baseline stays where Initial advance put it
          flow.style.cssText = flowCSS(top);
        }
      } else {
        top += frame.valign === 'center' ? free / 2 : free;
        flow.style.cssText = flowCSS(top);
      }
      over = overflowing();
    }
    if (!frame.hideOverflow && over) flow.style.cssText = flowCSS(top, { show: true });
    columnRules(g, box, frame, { insetL, insetT, H, insetB, cols, colW, gutter, ctx });
    g.classList.toggle('tt-overflow', over);
    _overflowMarker(g, box, over);
  }

  // How many lines a paragraph was broken into: its text's boxes grouped by
  // the line they sit on.
  function lineCount(pe, k) {
    const r = document.createRange();
    r.selectNodeContents(pe);
    const rects = [...r.getClientRects()].filter(q => q.width > 0 || q.height > 0).map(q => ({ top: q.top / k, bottom: q.bottom / k }));
    rects.sort((a, b) => a.top - b.top);
    let n = 0, lineBottom = -Infinity;
    for (const q of rects) {
      if (q.top >= lineBottom - 0.5) { n++; lineBottom = q.bottom; } else lineBottom = Math.max(lineBottom, q.bottom);
    }
    return Math.max(1, n);
  }

  // Every line of the flow `e` px taller: each line height the markup set
  // grows by it (a number becomes that many em plus e).
  function bumpLeading(flow, e) {
    for (const node of [flow, ...flow.querySelectorAll('[style]')]) {
      const lh = node.style.lineHeight;
      if (!lh) continue;
      node.style.lineHeight = lh.endsWith('px') ? `${+(parseFloat(lh) + e).toFixed(4)}px`
        : /^[\d.]+$/.test(lh) ? `calc(${lh}em + ${+e.toFixed(4)}px)` : lh;
    }
  }

  // Affinity's column rules: a line in the middle of every gutter, short of
  // the top and the bottom by the rule's gaps.
  function columnRules(g, box, frame, { insetL, insetT, H, insetB, cols, colW, gutter, ctx }) {
    g.querySelector('.tt-col-rules')?.remove();
    if (cols < 2 || !frame.ruleColor || !(frame.ruleWeight > 0)) return;
    const rules = document.createElementNS(SVG_NS, 'g');
    rules.classList.add('tt-col-rules');
    const y0 = box.y + insetT + frame.ruleTop * ctx.pxPerPt, y1 = box.y + H - insetB - frame.ruleBottom * ctx.pxPerPt;
    const w = frame.ruleWeight * ctx.pxPerPt;
    for (let k = 1; k < cols; k++) {
      const x = box.x + insetL + k * colW + (k - 0.5) * gutter;
      const l = document.createElementNS(SVG_NS, 'line');
      l.setAttribute('x1', x); l.setAttribute('x2', x); l.setAttribute('y1', y0); l.setAttribute('y2', Math.max(y0, y1));
      l.setAttribute('stroke', frame.ruleColor);
      l.setAttribute('stroke-width', w);
      if (frame.ruleStyle === 'dashed') l.setAttribute('stroke-dasharray', `${3 * w} ${2 * w}`);
      if (frame.ruleStyle === 'dotted') { l.setAttribute('stroke-dasharray', `0 ${2 * w}`); l.setAttribute('stroke-linecap', 'round'); }
      rules.appendChild(l);
    }
    const fo = g.querySelector('.tt-story-fo');
    g.insertBefore(rules, fo);
  }

  // A frame's eight handles (drag-resize.js resizes by them); an auto-height
  // frame has only the side ones. Their size is the same on screen at any zoom.
  function frameHandles(g, box) {
    g.querySelectorAll('.utb-fh').forEach(h => h.remove());
    if (!box.textMode) return;
    const art = box.textMode === 'artistic';
    const auto = !art && SC.frameOf(box.frame).autoHeight;
    const s = 7 / (state.currentZoom || 1);
    const X = { w: box.x, c: box.x + box.w / 2, e: box.x + box.w }, Y = { n: box.y, m: box.y + box.h / 2, s: box.y + box.h };
    const all = [['nw', X.w, Y.n], ['n', X.c, Y.n], ['ne', X.e, Y.n], ['e', X.e, Y.m],
      ['se', X.e, Y.s], ['s', X.c, Y.s], ['sw', X.w, Y.s], ['w', X.w, Y.m]];
    const CURSOR = { nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw', n: 'ns', s: 'ns', e: 'ew', w: 'ew' };
    for (const [name, x, y] of all) {
      if (auto && name !== 'e' && name !== 'w') continue;
      if (art && name.length < 2) continue;          // Artistic text scales by its corners
      const r = document.createElementNS(SVG_NS, 'rect');
      r.classList.add('utb-fh');
      r.dataset.handle = name;
      r.setAttribute('x', x - s / 2); r.setAttribute('y', y - s / 2);
      r.setAttribute('width', s); r.setAttribute('height', s);
      r.style.cursor = `${CURSOR[name]}-resize`;
      g.appendChild(r);
    }
  }

  // Affinity's overflow marker: a small red box with a triangle at the
  // frame's bottom right while text does not fit.
  function _overflowMarker(g, box, on) {
    let mk = g.querySelector('.tt-overflow-marker');
    if (!on) { mk?.remove(); return; }
    if (!mk) {
      mk = document.createElementNS(SVG_NS, 'g');
      mk.classList.add('tt-overflow-marker');
      const r = document.createElementNS(SVG_NS, 'rect');
      const t = document.createElementNS(SVG_NS, 'path');
      mk.append(r, t);
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = 'Text overflows the frame — make it larger or turn on Auto height';
      mk.appendChild(title);
      g.appendChild(mk);
    }
    const s = 9, x = box.x + box.w - s / 2, y = box.y + box.h - s / 2;
    const [r, t] = mk.children;
    r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', s); r.setAttribute('height', s);
    t.setAttribute('d', `M${x + 2} ${y + 2.5} L${x + s - 2} ${y + 2.5} L${x + s / 2} ${y + s - 2} Z`);
  }

  // Draw every story box again (fonts or metrics arrived, the zoom changed).
  function renderAllStories() {
    for (const b of utbState.boxes) if (b.textMode) window.renderBox?.(b);
  }

  document.fonts?.addEventListener?.('loadingdone', () => renderAllStories());
  // the handles keep their size on screen
  window.PDFHooks?.on('zoom:changed', () => {
    const b = utbState.selectedId && utbState.getBox(utbState.selectedId);
    if (b?.textMode === 'frame') window.renderBox?.(b);
  });

  window.renderStoryBox = renderStoryBox;
  window.storySync = storySync;
  window.ensureStory = ensureStory;
  window.renderAllStories = renderAllStories;
})();
