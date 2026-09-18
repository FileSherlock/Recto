// render.js — the reader's laws run FORWARDS: given a glyph set, a string and
// a pen, produce the page bytes mupdf would have produced. Everything in
// ocr-engine.js inverts these laws one glyph at a time; this file is the only
// place that applies them in the drawing direction, so a rendered line is
// something the reader can certify (render → readPage → clean, transcript
// equal) and something a page can be diffed against pixel by pixel.
//
// DOM-free and asset-free like ocr-engine.js: works as a browser global
// (root.OCRRender) and as a Node module. Glyph records are the exact shape
// tools/glyph-bundle.mjs / blindocr.js materializeSet produce ({ch, adv, phx,
// w, h, dx, dy, bytes, alpha, ink, …}); sets are {byPhy, linear, sizePx, …}.
//
// The laws, each measured rather than assumed (docs/LAWS.md):
//   §1 pen lattice   x snaps to the nearest ¼ px, y to the nearest whole px,
//                    both rounding half up — certified against mupdf fillText
//                    at every 1/64 phase by ftclone/certify-render.mjs
//   §2 blend         e = cov + (cov>>7); dst = (dst·(256−e))>>8, applied once
//                    per glyph in drawing order (repeated draws compose)
//   §4 linear law    raw bytes composite multiplicatively in 255-space with
//                    floor; the page byte carries +1 per contributing light
//                    pixel — the same arithmetic scanLine's accept step uses
//   y-phase          mupdf rounds y to an integer (phy 0). Some legacy sets
//                    also carry ½-phase rasters and the reader may pin a line
//                    to them (L.phy = 0.5; docs/FONTS.md) — pass that phy in
//                    so the line is re-drawn with the records the reader
//                    matched; placement is the same, row = baseline + dy
//
// Pixel placement is scanLine's, verbatim: a glyph accepted at pen p sits at
// column floor(p) + dx + col, row baseline + dy + row, with phx = p − floor(p).
(function (root) {
  'use strict';

  // ---- the lattice (LAWS §1) ----
  // mupdf holds the pen as a 32-bit float (fz_matrix), so the value that gets
  // rounded is fround(x), not x: a double just under a tie (45.87499999999999,
  // reached by accumulating a non-dyadic advance) IS the tie in mupdf and
  // rounds up. certify-render.mjs caught exactly that on Nimbus Mono at 791.
  // In float32 the arithmetic fround(x)·4 + 0.5 is exact for any page-sized
  // pen, so computing it in doubles on fround(x) reproduces mupdf bit for bit.
  const snapX = x => Math.floor(Math.fround(x) * 4 + 0.5) / 4;   // nearest ¼ px, half up
  const snapY = y => Math.floor(Math.fround(y) + 0.5);           // nearest whole px, half up

  // ---- set index: (ch, ¼-px phase) -> record, per y-phase (phy 0 default) ----
  function glyphIndex(set, phy = 0) {
    const cache = set._rix ??= new Map();
    let m = cache.get(phy);
    if (m) return m;
    m = new Map();
    for (const g of set.byPhy.get(phy) ?? []) {
      const k = g.ch + '|' + (Math.round(g.phx * 4) & 3);
      if (!m.has(k)) m.set(k, g);                     // first record wins (bundle order)
    }
    cache.set(phy, m);
    return m;
  }

  // advance of a character in px, from any phase record (the advance is per
  // char, phase-independent); null when the set has no record for it
  function advanceOf(set, ch) {
    for (const phy of set.byPhy.keys()) {
      const idx = glyphIndex(set, phy);
      for (let p = 0; p < 4; p++) {
        const g = idx.get(ch + '|' + p);
        if (g) return g.adv;
      }
    }
    return null;
  }

  // ---- layout ----
  // Accumulates advances in FLOAT from x0 — PDF glyph positions are absolute,
  // the producer never snapped between glyphs — and snaps each pen to the
  // lattice only for drawing. Returns {glyphs:[{ch, pen, penRaw, adv}],
  // advanceW, missing:[ch]}. Spaces take opts.spaceAdv (the sets carry no
  // space glyph; the reader calibrates it from the page — spaceCalib). A
  // missing space advance or a character the set does not have is reported in
  // `missing` and contributes nothing; the caller decides what that means.
  // opts.metrics: the PRODUCER's law, measured from a page's pens —
  // {quant, scale, kern: Map pair → px, adv: Map ch → px} from producerMetrics
  // (below), or the older {adv, kern} of pageMetrics. quant rounds every
  // advance the set knows to 1/quant em (1000: the PDF's /Widths), scale is
  // the size the producer laid at over the set's sizePx, kern is added
  // between two glyphs of a word, and an adv entry overrides a glyph
  // outright. The set's advances are the generating font's; a document set
  // in another build of the same face draws the same glyphs at other
  // advances (a 2008 Times has the current Times' outlines and a different
  // hmtx), and a kerned pair is 1–2 px off the plain advance (Times "AT" at
  // 16 px: −1.75). Where the page shows the law, the law wins; the set fills
  // in every glyph the page never wrote. opts.spaceWidths: one width per
  // space in text order (a certified line's own gaps), falling back to
  // spaceAdv — re-laying an unedited line then returns its pens.
  function layoutLine(set, text, x0, opts) {
    const spaceAdv = opts?.spaceAdv ?? null, m = opts?.metrics ?? null;
    const spaceWidths = opts?.spaceWidths ?? null;   // per space, in text order (a line's own measured gaps)
    // a union line mixes faces (a bold label, a regular value): opts.glyphSets
    // names the set of each glyph (spaces excluded, in order) and
    // opts.metricsBySet the law learned for each set; a glyph without one
    // takes `set` and `metrics`
    const glyphSets = opts?.glyphSets ?? null, bySet = opts?.metricsBySet ?? null;
    // opts.letterSpacing: px added after every character, spaces included —
    // the PDF's Tc and CSS letter-spacing both work that way
    const ls = +opts?.letterSpacing || 0;
    const glyphs = [], missing = [];
    let x = x0, prev = null, prevSet = null, si = 0, gi = 0;
    for (const ch of text) {
      if (ch === ' ') {
        const w = spaceWidths?.[si] ?? spaceAdv;
        si++;
        if (w == null) { if (!missing.includes(' ')) missing.push(' '); continue; }
        x += w + ls; prev = null;
        continue;
      }
      const gs = glyphSets?.[gi] || set;
      const gm = (bySet && gs !== set ? bySet.get(gs.name) : null) ?? m;
      gi++;
      let adv = gm?.adv?.get(ch) ?? null;
      if (adv == null) {
        adv = advanceOf(gs, ch);
        if (adv == null) { if (!missing.includes(ch)) missing.push(ch); continue; }
        adv = lawAdv(adv, gs.sizePx, gm);
      }
      if (gm?.kern && prev !== null && prevSet === gs) { const k = gm.kern.get(prev + ch); if (k) x += k; }
      glyphs.push({ ch, pen: snapX(x), penRaw: x, adv, set: gs });
      x += adv + ls; prev = ch; prevSet = gs;
    }
    return { glyphs, advanceW: x - x0 - (ls && (glyphs.length || si) ? ls : 0), missing };
  }

  // The metrics a page's pens imply. For every pair of consecutive glyphs
  // within a word (gap under half a space) the page shows next.pen − pen,
  // which is the advance plus the pair's kern plus the difference of two
  // ¼-px snaps. Snap noise is symmetric, so MEANS cancel it and medians do
  // not (on a monospace page the median of 7.4077-px advances is 7.5, and
  // ten of those drift a name by a pixel). A glyph's ADVANCE is the mean of
  // its occurrences, and it replaces the set's only when it differs by more
  // than a lattice step (¼ px: another build's hmtx, not noise); a pair
  // KERNS when the mean of (next.pen − pen − adv) over its occurrences is
  // at least ⅜ px — more than a snap and its rounding (Times' real pairs
  // are ½ px and more: Tr −0.50, WA −0.88, AT −1.75). Measured spacing,
  // never a font table. lines: [{glyphs: [{ch, pen, adv}]}] — the reader's
  // lines, or Recto's boxes, whose adv is the set's. Returns {adv, kern}.
  function pageMetrics(lines, spaceAdv) {
    const gapMax = 0.55 * (spaceAdv || 4);
    const advObs = new Map(), pairs = [];
    for (const L of lines) {
      const g = L.glyphs || [];
      for (let i = 1; i < g.length; i++) {
        const d = g[i].pen - g[i - 1].pen;
        if (d - g[i - 1].adv >= gapMax || d <= 0) continue;        // a space, not a pair
        const ch = g[i - 1].ch;
        if (!advObs.has(ch)) advObs.set(ch, { sum: 0, n: 0, set: g[i - 1].adv });
        const o = advObs.get(ch); o.sum += d; o.n++;
        pairs.push([ch + g[i].ch, d, ch]);
      }
    }
    const advOf = new Map(), adv = new Map();
    for (const [ch, o] of advObs) {
      const mean = o.sum / o.n;
      const use = o.n >= 4 && Math.abs(mean - o.set) > 0.25 ? mean : o.set;
      advOf.set(ch, use);
      if (use !== o.set) adv.set(ch, use);
    }
    const kernObs = new Map();
    for (const [pair, d, ch] of pairs) {
      const a = advOf.get(ch);
      if (a == null) continue;
      if (!kernObs.has(pair)) kernObs.set(pair, { sum: 0, n: 0 });
      const o = kernObs.get(pair); o.sum += d - a; o.n++;
    }
    const kern = new Map();
    for (const [pair, o] of kernObs) { const k = o.sum / o.n; if (Math.abs(k) >= 0.375) kern.set(pair, k); }
    return { adv, kern };
  }

  // ---- the producer's law, from a page's certified pens ----
  // A certified line fixes the face and every pen; it does not say how the
  // pens were ARRIVED at. Three producers of one corpus lay the same face
  // three ways (measured in Recto's lab, 2026-09): advances at 1/1000 em —
  // the PDF's /Widths — where the set carries hmtx at 1/2048 (Courier New at
  // 13 px: 7.8 px on the page, 7.80127 in the set; one lattice step by the
  // 30th glyph); an advance size the set's em64-truncated sizePx does not
  // carry (Nimbus Mono: 12.36 px against 12.359375, LAWS §6); and, on one
  // email client's header, the font's kern table applied — on the body of
  // the same document, not. A writer who knows only the pairs the page
  // shows cannot lay "Yo" on a page that never wrote it, so the law is
  // learned as STRUCTURE — quantization, scale, kerned-or-not — and every
  // glyph or pair the set and the font's table know then follows it.
  //
  // The test is exact, not statistical. Under a hypothesis, glyph k of a
  // word with accumulated advance S_k and measured pen p_k demands
  //   start + S_k ∈ [p_k − ⅛, p_k + ⅛)          (mupdf's snap, LAWS §1)
  // and the starts that satisfy every glyph of the word are an interval
  // intersection — non-empty iff the hypothesis writes the word. The
  // producer's start pen was a float the page only shows snapped, which is
  // why a start is solved, never assumed.
  const HALF = 0.125, EPS = 1e-7;
  const txLen = ch => (ch === 'ﬁ' || ch === 'ﬂ') ? 2 : 1;

  // the start that satisfies the most glyphs of one word: items = [{S, p}]
  // (advance accumulated from the first glyph, measured pen), base = the
  // first glyph's measured pen; start = base + delta. grid: restrict the
  // start to the 1/grid-px lattice (a producer that quantized positions).
  // Returns {delta, hit, feasible} — feasible when every glyph is satisfied.
  function solveStart(items, base, grid) {
    const iv = items.map(({ S, p }) => [p - HALF - base - S, p + HALF - base - S]);
    let best = { delta: 0, hit: -1 };
    const cands = new Set();
    if (grid) { for (let n = Math.ceil((base - 0.5) * grid); n <= Math.floor((base + 0.5) * grid); n++) cands.add(n / grid - base); }
    else { cands.add(0); for (const [lo] of iv) cands.add(lo + EPS); }
    for (const d of cands) {
      let hit = 0;
      for (const [lo, hi] of iv) if (d >= lo - EPS && d < hi) hit++;
      if (hit > best.hit || (hit === best.hit && Math.abs(d) < Math.abs(best.delta))) best = { delta: d, hit };
    }
    return { delta: best.delta, hit: best.hit, feasible: best.hit === items.length };
  }

  // a line's words: runs of glyphs with no space between them, drawn by one
  // set. Entries with text offsets (the reader's) say where the spaces are;
  // bare glyphs fall back to the gap test pageMetrics uses.
  function wordsOf(L, spaceAdv) {
    const g = (L.entries || L.glyphs || []).filter(e => e.ch !== '□');
    const gapMax = 0.55 * (spaceAdv || 4);
    const words = [];
    let w = [];
    for (let k = 0; k < g.length; k++) {
      const a = g[k - 1], b = g[k];
      const brk = !a ? false
        : (a.src || null) !== (b.src || null) ? true
        : (b.i != null && a.i != null) ? b.i - a.i - txLen(a.ch) !== 0
        : (b.pen - a.pen - a.adv >= gapMax || b.pen <= a.pen);
      if (brk && w.length) { words.push(w); w = []; }
      w.push(b);
    }
    if (w.length) words.push(w);
    return words;
  }

  // an advance under a law: quantized to 1/quant em of the set's size, then
  // scaled to the size the producer laid at
  const lawAdv = (adv, sizePx, m) => (m?.quant && sizePx ? Math.round(adv / sizePx * m.quant) / m.quant * sizePx : adv) * (m?.scale || 1);
  const asMap = t => t instanceof Map ? t : new Map(Object.entries(t || {}));

  // the accumulated advances of a word under a law, as solveStart items
  function wordItems(w, sizePx, m) {
    const items = [{ S: 0, p: w[0].pen }];
    let S = 0;
    for (let k = 1; k < w.length; k++) {
      S += lawAdv(w[k - 1].adv, sizePx, m);
      if (m?.kern) { const kv = m.kern.get(w[k - 1].ch + w[k].ch); if (kv) S += kv; }
      items.push({ S, p: w[k].pen });
    }
    return items;
  }

  // The law that writes the most of a page's certified pens back. lines: the
  // certified lines of ONE set ({entries: [{i, ch, pen, adv, src}]} — the
  // reader's — or {glyphs}); opts: {sizePx: the set's, kernTable: the FONT's
  // kern pairs at sizePx in px, unrounded (HarfBuzz's; null when unknown),
  // spaceAdv, scaleRange}. Hypotheses: advances at 1/1000 em (a PDF's
  // /Widths) or the set's own (hmtx), each at a scale searched to 5e-6 — the
  // size the producer laid at — and, when the font's table is known and the
  // page has pairs it kerns, kerned with that table or not. Ties go to the
  // PDF's quantization, to no kerning, to the scale nearest 1: the page
  // decides, and where it cannot, the least assumption does. Returns
  // {quant, scale, kerned, kern: Map pair → px as laid, adv: Map (empty —
  // reserved for per-glyph overrides), sizePx: the laid size, words, glyphs,
  // hit: pens some start writes, exact: words written entirely, kernable,
  // alternatives: every hypothesis with its hit}.
  function producerMetrics(lines, opts) {
    const sizePx = opts?.sizePx ?? null;
    const table = opts?.kernTable ? asMap(opts.kernTable) : null;
    const ws = [];
    for (const L of lines || []) for (const w of wordsOf(L, opts?.spaceAdv)) if (w.length >= 2) ws.push(w);
    const glyphs = ws.reduce((n, w) => n + w.length, 0);
    const empty = { quant: 1000, scale: 1, kerned: false, kern: new Map(), adv: new Map(), sizePx, words: 0, glyphs: 0, hit: 0, exact: 0, kernable: 0, alternatives: [] };
    if (!ws.length || !sizePx) return empty;
    let kernable = 0;
    if (table) for (const w of ws) for (let k = 1; k < w.length; k++) if (table.get(w[k - 1].ch + w[k].ch)) kernable++;
    const lawKern = (quant, scale) => {
      const m = new Map();
      for (const [pair, v] of table) { const lv = lawAdv(v, sizePx, { quant, scale }); if (lv) m.set(pair, lv); }
      return m;
    };
    const score = m => {
      let hit = 0, exact = 0;
      for (const w of ws) { const s = solveStart(wordItems(w, sizePx, m), w[0].pen); hit += s.hit; if (s.feasible) exact++; }
      return { hit, exact };
    };
    const better = (a, b) => !b || a.hit > b.hit || (a.hit === b.hit && Math.abs(a.scale - 1) < Math.abs(b.scale - 1) - 1e-12);
    const combos = [];
    for (const quant of [1000, null]) { combos.push({ quant, kerned: false }); if (kernable) combos.push({ quant, kerned: true }); }
    const range = opts?.scaleRange ?? 0.005;
    const results = [];
    for (const c of combos) {
      const ev = scale => ({ quant: c.quant, kerned: c.kerned, scale, ...score({ quant: c.quant, scale, kern: c.kerned ? lawKern(c.quant, scale) : null }) });
      let best = ev(1);
      if (best.hit < glyphs) {
        for (let sc = 1 - range; sc <= 1 + range + 1e-12; sc += 2e-4) { const r = ev(+sc.toFixed(6)); if (better(r, best)) best = r; }
        const c0 = best.scale;
        for (let sc = c0 - 2e-4; sc <= c0 + 2e-4 + 1e-12; sc += 5e-6) { const r = ev(+sc.toFixed(7)); if (better(r, best)) best = r; }
      }
      results.push(best);
    }
    const rank = r => (r.quant === 1000 ? 0 : 1) + (r.kerned ? 2 : 0);
    results.sort((a, b) => b.hit - a.hit || rank(a) - rank(b) || Math.abs(a.scale - 1) - Math.abs(b.scale - 1));
    let win = results[0];
    // a kerned reading must beat the plain one, never tie it
    if (win.kerned) { const plain = results.find(r => r.quant === win.quant && !r.kerned); if (plain && plain.hit >= win.hit) win = plain; }
    return { quant: win.quant, scale: win.scale, kerned: win.kerned, kern: win.kerned ? lawKern(win.quant, win.scale) : new Map(), adv: new Map(),
      sizePx: sizePx * win.scale, words: ws.length, glyphs, hit: win.hit, exact: win.exact, kernable,
      alternatives: results.map(r => ({ quant: r.quant, kerned: r.kerned, scale: r.scale, hit: r.hit, exact: r.exact })) };
  }

  // the start a certified line's first word was laid from under a law:
  // {delta, hit, feasible}. See lineLayout for the whole line.
  function lineStart(L, sizePx, m, spaceAdv) {
    const w = wordsOf(L, spaceAdv)[0];
    if (!w) return { delta: 0, hit: 0, feasible: false };
    return solveStart(wordItems(w, sizePx, m), w[0].pen);
  }

  // How a certified line is laid again under a law so that it returns its
  // own pens: every word from its own solved start, and each break's width
  // solved in FLOAT between the laid end of one word and the laid start of
  // the next — never the snapped gap the page shows, which is off by the
  // two words' start phases. Returns {delta: the first word's start, hit,
  // feasible: every word written, spaceWidths: one width per space of the
  // transcript in order, words}. layoutLine(set, text, firstPen + delta,
  // {metrics, spaceWidths}) then reproduces the line; an edit that keeps the
  // early words keeps their pens, and text past the edit follows the law.
  // bySrc: Map src → {sizePx, m} for a union line whose words were drawn by
  // different sets (each word is one set — wordsOf breaks at a set change).
  function lineLayout(L, sizePx, m, spaceAdv, bySrc) {
    const ws = wordsOf(L, spaceAdv);
    if (!ws.length) return { delta: 0, hit: 0, feasible: false, spaceWidths: [], words: 0 };
    const lawOf = w => (w[0].src && bySrc?.get(w[0].src)) || { sizePx, m };
    const starts = ws.map(w => { const l = lawOf(w); return solveStart(wordItems(w, l.sizePx, l.m), w[0].pen); });
    const spaceWidths = [];
    let x = ws[0][0].pen + starts[0].delta;     // the float pen, as layoutLine carries it
    for (let k = 0; k < ws.length; k++) {
      const w = ws[k], l = lawOf(w);
      x = w[0].pen + starts[k].delta;
      for (let g = 0; g < w.length; g++) {
        if (g && l.m?.kern) { const kv = l.m.kern.get(w[g - 1].ch + w[g].ch); if (kv) x += kv; }
        x += lawAdv(w[g].adv, l.sizePx, l.m);
      }
      if (k + 1 < ws.length) {
        const a = w[w.length - 1], b = ws[k + 1][0];
        // spaces at this break: the transcript's count when offsets are known, else one
        const n = (a.i != null && b.i != null) ? Math.max(1, b.i - a.i - txLen(a.ch)) : 1;
        const gap = (b.pen + starts[k + 1].delta) - x;
        for (let i = 0; i < n; i++) spaceWidths.push(gap / n);
      }
    }
    return { delta: starts[0].delta, hit: starts.reduce((n, s) => n + s.hit, 0), feasible: starts.every(s => s.feasible), spaceWidths, words: ws.length };
  }

  // ---- compositing ----
  // glyphs: [{ch, pen, set?}] in DRAWING order (text order — the blend is
  // integer arithmetic and not commutative on composite pixels). opts.phy
  // selects the y-phase records (the reader's L.phy; 0 = mupdf's own).
  // Returns the smallest window holding every glyph: {x0, y0, w, h, gray,
  // hits, missing, baseline}. gray = predicted page byte per pixel, 255 where
  // nothing was drawn; hits = how many glyphs inked each pixel (>1 =
  // composite — the reader judges those at double tolerance).
  // A fresh (white) pixel takes the record's stored byte outright — exactly
  // the reader's fresh-canvas fast path, so a lone glyph reproduces its
  // bundle bytes for EVERY set kind (standard, linear, gray-ink srcover);
  // only composite pixels go through the law.
  // opts.rects: [{x0, y0, w, h, cov}] — filled rectangles already turned into
  // coverage (ftraster.js rectCoverage: mupdf's PATH rasterizer, a different
  // antialiaser from the glyph pipeline), blended after the glyphs under the
  // same law. An underline is a `re f` in the PDF, drawn by the same device.
  function renderLine(set, glyphs, baseline, opts) {
    const phy = opts?.phy ?? 0;
    const idx = glyphIndex(set, phy);
    const lin = !!set.linear;
    const yb = snapY(baseline);
    const placed = [], missing = [];
    for (const g of glyphs) {
      // a glyph may name its own set (a union-pool line mixes faces); the
      // record's own law flag wins, then that set's
      const gs = g.set || set, gidx = gs === set ? idx : glyphIndex(gs, phy);
      const pen = snapX(g.pen), pi = Math.floor(pen);
      const rec = gidx.get(g.ch + '|' + (Math.round((pen - pi) * 4) & 3));
      if (!rec) { if (!missing.includes(g.ch)) missing.push(g.ch); continue; }
      placed.push({ rec, gx: pi + rec.dx, gy: yb + rec.dy, pen, lin: rec.lin ?? !!gs.linear });
    }
    const rects = (opts?.rects || []).filter(q => q && q.w > 0 && q.h > 0);
    if (!placed.length && !rects.length)
      return { x0: 0, y0: 0, w: 0, h: 0, gray: new Uint8Array(0), hits: new Uint8Array(0), missing, baseline: yb, glyphs: 0 };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of rects) {
      if (q.x0 < x0) x0 = q.x0;
      if (q.y0 < y0) y0 = q.y0;
      if (q.x0 + q.w > x1) x1 = q.x0 + q.w;
      if (q.y0 + q.h > y1) y1 = q.y0 + q.h;
    }
    for (const p of placed) {
      if (p.gx < x0) x0 = p.gx;
      if (p.gy < y0) y0 = p.gy;
      if (p.gx + p.rec.w > x1) x1 = p.gx + p.rec.w;
      if (p.gy + p.rec.h > y1) y1 = p.gy + p.rec.h;
    }
    const w = x1 - x0, h = y1 - y0;
    const gray = new Uint8Array(w * h).fill(255);
    const hits = new Uint8Array(w * h);
    // linear law: the page byte carries +1 per contributing light pixel, so
    // the canvas keeps a per-pixel shift count (scanLine's `shifts`)
    const anyLin = placed.some(p => p.lin);
    const shifts = anyLin ? new Uint8Array(w * h) : null;
    for (const { rec, gx, gy, lin: linG } of placed) {
      const { bytes, alpha, ink } = rec, rw = rec.w;
      for (const p of ink) {
        const i = (gy - y0 + ((p / rw) | 0)) * w + (gx - x0 + (p % rw));
        const cv = gray[i], gb = bytes[p], a = alpha[p];
        if (hits[i] < 255) hits[i]++;
        const sh = linG && gb >= 129 && gb !== 255 ? 1 : 0;
        if (cv === 255) gray[i] = gb;                    // fresh pixel: the stored byte, any law
        else if (linG) {
          const s0 = shifts[i];
          gray[i] = (((cv - s0) * a) / 255 | 0) + s0 + sh;
        } else {
          const e = a + (a >> 7);
          gray[i] = (cv * (256 - e)) >> 8;
        }
        if (sh) shifts[i] += sh;
      }
    }
    for (const q of rects)
      for (let yy = 0; yy < q.h; yy++) for (let xx = 0; xx < q.w; xx++) {
        const a = q.cov[yy * q.w + xx];
        if (!a) continue;
        const i = (q.y0 - y0 + yy) * w + (q.x0 - x0 + xx);
        if (hits[i] < 255) hits[i]++;
        gray[i] = (gray[i] * (256 - (a + (a >> 7)))) >> 8;
      }
    return { x0, y0, w, h, gray, hits, missing, baseline: yb, glyphs: placed.length };
  }

  // ---- the reader's don't-care zone ----
  // detectObjects' mask plus the box HALOS readPage draws around every
  // redaction box (and thin box slices typed 'rule'): rect ±2 columns, ±3
  // rows. The reader forgives residue that touches a halo as the box's own
  // clipped content (a glyph half-swallowed by the redactor), so a glyph
  // pixel in that zone is never evidence either way — diffLine takes this
  // mask so its verdict means what the reader's does. det = detectObjects(page).
  function objectMask(det, w, h) {
    const mask = new Uint8Array(w * h);
    if (det?.mask) mask.set(det.mask.subarray(0, w * h));
    const objects = det?.objects || [];
    const isBoxSlice = o => o.type === 'rule' && objects.some(b => b.type === 'box' &&
      o.y1 >= b.y0 - 2 && o.y0 <= b.y1 + 2 && Math.min(o.x1, b.x1) > Math.max(o.x0, b.x0));
    for (const o of objects) {
      if (!(o.type === 'box' || isBoxSlice(o))) continue;
      const x0 = Math.max(0, o.x0 - 2), x1 = Math.min(w, o.x1 + 2);
      const y0 = Math.max(0, o.y0 - 3), y1 = Math.min(h, o.y1 + 3);
      for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + x1);
    }
    return mask;
  }

  // ---- the diff ----
  // Compares a rendered window with the page on the window's ink pixels
  // (rendered gray < 255). A page pixel whose colour the reader recovered as
  // coverage (ocr-engine colourInk, LAWS §9) carries an acceptance BAND
  // rather than one byte — the producer quantized it in colour — and is
  // compared against that band, so this verdict means what the reader's
  // certificate means. quant: a palette map (ocr-engine quantMap) for
  // producers that quantized the final page, else null. mask: the reader's
  // object mask (detectObjects — redaction boxes, rules and their padding),
  // else null: a glyph pixel under it is what the reader never compared (a
  // descender dipping into a box's padded rows), so it is counted as
  // `masked`, never as a mismatch — the certificate means the same thing here
  // as in scanLine. tol: the reader's per-pixel tolerance for the line (0 =
  // byte-exact; a tolerant rung allows |Δ| ≤ tol, 2·tol on composite pixels
  // where two glyphs' rasterizer deviations compound — scanLine's rule).
  // Returns {count, ink, outside, masked, within, mism} — mism is a w·h
  // Uint8Array, 1 where the page disagrees beyond tolerance; within counts
  // pixels off by 1..tol. count === 0 with ink > 0 is the certificate: this
  // text IS the page here (to the reader's own standard for the line).
  function diffLine(r, page, quant, mask, tol) {
    const mism = new Uint8Array(r.w * r.h);
    const T = tol || 0;
    let count = 0, ink = 0, outside = 0, masked = 0, within = 0;
    for (let y = 0; y < r.h; y++) {
      const py = r.y0 + y;
      for (let x = 0; x < r.w; x++) {
        const i = y * r.w + x, g = r.gray[i];
        if (g === 255) continue;
        ink++;
        const px = r.x0 + x;
        if (px < 0 || py < 0 || px >= page.w || py >= page.h) { outside++; continue; }
        if (mask && mask[py * page.w + px]) { masked++; continue; }
        const pOff = py * page.w + px;
        const t = T && r.hits && r.hits[i] > 1 ? 2 * T : T;
        let d;
        if (page.converted && page.converted[pOff] && page.bandLo) {
          const lo = page.bandLo[pOff], hi = page.bandHi[pOff];
          d = g < lo ? lo - g : g > hi ? g - hi : 0;     // distance to the accepted band
        } else d = Math.abs(page.gray[pOff] - (quant ? quant[g] : g));
        if (!d) continue;
        if (d > t) { mism[i] = 1; count++; } else within++;
      }
    }
    return { count, ink, outside, masked, within, mism };
  }

  // Paste a rendered window onto a page buffer as the producer would have —
  // fresh pixels take the render, composite pixels re-apply the law over
  // whatever the page already holds (used by the synthetic round-trip test,
  // and by any future burn-in). Returns the page.
  function paste(page, r, set) {
    const lin = !!set?.linear;
    for (let y = 0; y < r.h; y++) {
      const py = r.y0 + y;
      if (py < 0 || py >= page.h) continue;
      for (let x = 0; x < r.w; x++) {
        const g = r.gray[y * r.w + x];
        if (g === 255) continue;
        const px = r.x0 + x;
        if (px < 0 || px >= page.w) continue;
        const i = py * page.w + px, cv = page.gray[i];
        if (cv === 255 || lin) { page.gray[i] = g; continue; }
        // standard law over an inked page: recover the coverage that yields g
        // over white, then apply it over cv
        let cov = 0;
        for (let c = 255; c >= 0; c--) { const e = c + (c >> 7); if (((255 * (256 - e)) >> 8) === g) { cov = c; break; } }
        const e = cov + (cov >> 7);
        page.gray[i] = (cv * (256 - e)) >> 8;
      }
    }
    return page;
  }

  // ---- the other half of the certificate: ink the drawing does not explain ----
  // diffLine asks "is every drawn pixel the page?"; this asks "is every page
  // pixel in the line's band drawn?" — the reader's residual. band = {top,
  // bot, x0, x1} in page coordinates (the reader's L.top/L.bot rows, the
  // box's columns); windows = renderLine results whose ink explains pixels
  // (this line's, plus neighbours whose glyphs reach into the band); mask =
  // detectObjects' mask WITHOUT halos (the reader counts residue inside a halo
  // too — that is what makes a clipped quote mark an unclean line). Returns
  // {count, pixels:[[x,y,byte]…]} — page ink (< 255) that no window inks and
  // no mask covers. A clean reader line has count 0 here by construction.
  function residualInk(page, mask, band, windows) {
    const pixels = [];
    const x0 = Math.max(0, band.x0 | 0), x1 = Math.min(page.w, Math.ceil(band.x1));
    const y0 = Math.max(0, band.top | 0), y1 = Math.min(page.h, Math.ceil(band.bot));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * page.w + x, pv = page.gray[i];
        if (pv >= 255 || (mask && mask[i])) continue;
        let inked = false;
        for (const r of windows) {
          const rx = x - r.x0, ry = y - r.y0;
          if (rx >= 0 && ry >= 0 && rx < r.w && ry < r.h && r.gray[ry * r.w + rx] < 255) { inked = true; break; }
        }
        if (!inked) pixels.push([x, y, pv]);
      }
    }
    return { count: pixels.length, pixels };
  }

  const api = { snapX, snapY, glyphIndex, advanceOf, layoutLine, lawAdv, pageMetrics, solveStart, wordsOf, producerMetrics, lineStart, lineLayout, renderLine, objectMask, diffLine, residualInk, paste };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OCRRender = api;
})(typeof self !== 'undefined' ? self : this);
