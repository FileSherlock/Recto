// line-boxes.js — a page's read becomes text boxes. Recto-owned and DOM-free,
// like box-rules.js: the page loads it as a classic script before ocr-tool.js,
// the node tests (and any harness that scores what the app makes of a read)
// import the same file; it defines globalThis.OCRLineBoxes, nothing else.
//
// In: the SLIM page read (ocr-result.js — what the worker posts and the cache
// stores) and its pass. Out: plain box specs in the order the adapter adds
// them — { data, ocr?, ink? }, where `data` is what `new UnifiedTextBox(data)`
// takes and `ocr` / `ink` are set on the box after it is made — plus the
// page's tallies. ocr-tool.js ocrAddBoxes turns each spec into a
// UnifiedTextBox; nothing here touches utbState, the document or the window.
//
// The other questions the adapter asks of a read live here too, as pure
// functions of the boxes: whether a read is too weak to name the page's face
// (readIsWeak), the face and size it names (dominantTypography), which
// certified glyphs teach each set's producer law (lawInputs) — and the ink
// of every glyph, from the page's RGB right after a read (inkColours).
(function (root) {
  'use strict';

  const UNCLEAN_COLOR = 'rgba(230, 124, 0, 0.85)';   // non-byte-clean lines
  const UNREAD_COLOR = 'rgba(217, 48, 37, 0.85)';    // □ marker boxes
  const txLen = ch => (ch === 'ﬁ' || ch === 'ﬂ') ? 2 : 1;   // ligatures transcribe as 2 chars

  // Set name ('timesbdlin16', 'nimbus791', union 'a+b') -> the face it was
  // rendered from, from the generated engine/set-fonts.js (glyph-registry
  // PROVENANCE). A union name resolves through its first member; callers with
  // per-glyph src pass the majority set instead.
  function fontFromSetName(name, setFonts = root.OCR_SET_FONTS) {
    const first = (name || '').split('+')[0];
    const f = setFonts ? setFonts[first] : null;
    return f ? { family: f.family, bold: !!f.bold, italic: !!f.italic }
             : { family: 'Times New Roman', bold: false, italic: false };
  }

  // The set that drew most of a segment's glyphs (union lines mix faces —
  // a bold label, a regular value): per-glyph src, else the line's font label.
  function majoritySet(seg, fallback) {
    const votes = new Map();
    for (const e of seg) if (e.src) votes.set(e.src, (votes.get(e.src) || 0) + 1);
    let best = null, n = 0;
    for (const [s, c] of votes) if (c > n) { best = s; n = c; }
    return best || fallback;
  }

  // ── Underline and ink ─────────────────────────────────────
  // A line's underlined glyphs: under each, a rule the read found (a thin
  // object detectObjects typed 'rule' — the slim read keeps them since cache
  // version 4) starting below the baseline row and no deeper than the line's
  // descent, under the glyph's middle. Not the glyphs' own feet: a run of
  // bottom strokes along the baseline row ('ZzZE' in base64, the serifs of
  // "Summary") is a rule to detectObjects, one row up. Not a separator: a
  // rule that runs on more than an em past the line's text (a heading's rule
  // across the column), or sits deeper. Not a slice of a redaction box (the
  // engine types a bar's thin rows 'rule' too). Returns Map entry -> the rule
  // under it; an unread □ takes the state of the glyph before it.
  function underlinedEntries(L, objects) {
    const out = new Map();
    const em = L.set?.sizePx ?? 16;
    const desc = L.set?.maxDesc ?? Math.max(2, (L.bot ?? L.baseline) - L.baseline);
    const first = L.entries[0], last = L.entries[L.entries.length - 1];
    const tx0 = first.pen, tx1 = last.pen + last.adv;
    const boxes = objects.filter(o => o.type === 'box');
    const rules = objects.filter(o => o.type === 'rule' && o.y0 >= L.baseline + 1 && o.y0 <= L.baseline + desc &&
      o.x0 >= tx0 - em && o.x1 <= tx1 + em &&
      !boxes.some(b => b.x1 >= o.x0 - 2 && b.x0 <= o.x1 + 2 && o.y1 >= b.y0 - 3 && o.y0 <= b.y1 + 3));
    if (!rules.length) return out;
    let prev = null;
    for (const e of L.entries) {
      const mid = e.pen + e.adv / 2;
      const r = e.ch === '□' ? prev : rules.find(q => mid >= q.x0 - 1 && mid <= q.x1 + 1) || null;
      if (r) out.set(e, r);
      prev = r;
    }
    return out;
  }

  // The ink of every glyph of a read, from the page's own RGB: the colour
  // law read coloured text as the coverage it is, through its pen
  // (Engine.colourInk; page.converted marks those pixels), so a glyph whose
  // dark pixels are mostly converted is in a pen's colour. One glyph's most
  // covered pixel need not reach the pen (a thin stroke, a period: #c30f0f
  // for a #c00000 pen), so consecutive inked glyphs whose colours lie on one
  // pen's ramp from white are one run, and the run takes its darkest colour.
  // Stamped on the entry as e.ink ('#rrggbb') — black text gets none, nor
  // does a glyph whose cell only catches a coloured neighbour's overhang.
  // Run on the main thread after a read, where the raster is (ocr-tool.js
  // ocrReadOnePage); the slim read keeps e.ink. page: the whitened page
  // (w, h, converted), rgba: its RGBA bytes. Returns the glyphs inked.
  const INK_DARK = 3 * 191;                          // a pixel at least a quarter covered
  // b is on the ramp of the darker a when every channel with contrast keeps
  // one coverage: (255 − b) / (255 − a) alike, at most full
  function sameRamp(a, b) {
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < 3; k++) {
      const da = 255 - a[k], db = 255 - b[k];
      if (da < 32) { if (db > 40) return false; continue; }
      const e = db / da;
      if (e < lo) lo = e;
      if (e > hi) hi = e;
    }
    return hi <= 1.05 && hi - lo <= 0.1;
  }
  function inkColours(res, page, rgba) {
    const conv = page?.converted;
    if (!conv || !rgba) return 0;
    const { w, h } = page;
    const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
    let n = 0;
    for (const L of res.lines || []) {
      if (!L.entries?.length || L.top == null || L.bot == null) continue;
      // each glyph's most covered converted pixel, when its dark pixels are mostly converted
      const own = L.entries.map(e => {
        if (e.ch === '□') return null;
        const x0 = Math.max(0, Math.floor(e.pen)), x1 = Math.min(w, Math.ceil(e.pen + e.adv));
        let dark = 0, colour = 0, best = -1, bestSum = 766;
        for (let y = Math.max(0, L.top); y <= Math.min(h - 1, L.bot); y++)
          for (let x = x0; x < x1; x++) {
            const i = y * w + x, o = i * 4, sum = rgba[o] + rgba[o + 1] + rgba[o + 2];
            if (sum > INK_DARK) continue;
            dark++;
            if (!conv[i]) continue;
            colour++;
            if (sum < bestSum) { bestSum = sum; best = o; }
          }
        return best >= 0 && colour * 2 > dark ? [rgba[best], rgba[best + 1], rgba[best + 2]] : null;
      });
      // runs of one pen: consecutive inked glyphs on one ramp, in the run's darkest colour
      for (let i = 0; i < own.length;) {
        if (!own[i]) { i++; continue; }
        let j = i + 1, dark = own[i];
        while (j < own.length && own[j]) {
          const [a, b] = own[j][0] + own[j][1] + own[j][2] < dark[0] + dark[1] + dark[2] ? [own[j], dark] : [dark, own[j]];
          if (!sameRamp(a, b)) break;
          dark = a;
          j++;
        }
        const ink = hex(dark);
        for (let k = i; k < j; k++) { L.entries[k].ink = ink; n++; }
        i = j;
      }
    }
    return n;
  }

  // Rebuild per-char positions from a line's entries + transcription, walking
  // the text so inserted spaces and ligature expansions ('ﬁ'->"fi") line up
  // exactly with lineEntries' construction. x values are relative to x0
  // (raster px — caller applies the viewBox scale).
  function charPositions(L, x0) {
    const byOffset = new Map();
    for (const e of L.entries) byOffset.set(e.i, e);
    const chars = [];
    let ti = 0, prevEnd = null, spaceStart = null;
    while (ti < L.text.length) {
      const e = byOffset.get(ti);
      if (!e) {                                  // inserted space run
        if (spaceStart === null) spaceStart = ti;
        ti++;
        continue;
      }
      if (spaceStart !== null) {
        const n = ti - spaceStart, gapStart = prevEnd ?? e.pen;
        const w = (e.pen - gapStart) / n;
        for (let s = 0; s < n; s++) chars.push({ c: ' ', x: gapStart + s * w - x0, w });
        spaceStart = null;
      }
      const two = L.text.slice(ti, ti + 2);
      const isLig = (e.ch === 'ﬁ' && two === 'fi') || (e.ch === 'ﬂ' && two === 'fl');
      if (isLig) {
        // the page holds ONE ligature glyph: mark the pair so a pixel renderer
        // draws e.ch at the first pen and skips the tail (SVG text is unaffected)
        chars.push({ c: two[0], x: e.pen - x0, w: e.adv / 2, lig: e.ch, src: e.src });
        chars.push({ c: two[1], x: e.pen + e.adv / 2 - x0, w: e.adv / 2, ligTail: true });
        ti += 2;
      } else {
        chars.push({ c: L.text[ti], x: e.pen - x0, w: e.adv, src: e.src });
        ti += 1;
      }
      prevEnd = e.pen + e.adv;
    }
    return chars;
  }

  // One page's read result -> box specs and the page's tallies.
  // opts: { sx, sy } raster px -> viewBox px (1 for the 96-dpi family),
  // setFonts (engine/set-fonts.js' table; the global by default), boxBetween
  // (the engine's; BlindOCR's by default).
  function pageBoxes(pageNum, res, pass, opts = {}) {
    const sx = opts.sx ?? 1, sy = opts.sy ?? 1;
    const setFonts = opts.setFonts ?? root.OCR_SET_FONTS;
    const boxBetween = opts.boxBetween ?? root.BlindOCR?.boxBetween;
    const tally = { lines: 0, clean: 0, unread: 0, boxes: 0 };
    const boxes = [];

    let n = 0;
    for (const L of res.lines) {
      n++;
      if (!L.set || !L.entries?.length) {
        // unreadable band — an honest red □ marker at the band's ink start
        const x = (L.fails?.[0] ?? 0) * sx;
        boxes.push({ data: {
          type: 'ocr', page: pageNum, text: '□',
          lineId: `ocr_p${pageNum}_l${n}`,
          x, y: L.top * sy, w: 40 * sx, h: Math.max(8, (L.bot - L.top)) * sy,
          sizePt: 12, color: UNREAD_COLOR,
        }, ocr: { clean: false, unread: true } });
        tally.unread++;
        continue;
      }

      const set = L.set;
      // A certified line is evidence of the page's face only through its
      // letterforms, and only as far as the rung it was certified on: a row of
      // dots or quotes matches in any face at ±10 (EFTA00173953's two "clean"
      // lines, "`     ` `" and ".", in tnr8lin10 on an 11 pt Times memo), while
      // one letter reproduced byte for byte (`To: "` on the startup document,
      // times16) pins face and size. At ±2 or better one letter is enough; on a
      // looser rung three are needed. Consumers that take typography from a
      // line — the connect step, the refiner's width seam, the typography
      // claim — ask for `trusted`, not `clean`.
      const letters = (L.text.match(/\p{L}/gu) || []).length;
      const trusted = !!L.clean && letters >= ((pass.tol || 0) <= 2 ? 1 : 3);

      // Which set drew each glyph: a union pool ('a+b') accepts glyphs from
      // several sets, and the engine records that on L.glyphs[].src. Carry it
      // onto the entries (keyed by pen — entries are the glyphs in pen order)
      // so the pixel view can re-render a mixed-font line with the right
      // bitmaps. A cached result already has entry.src from the slim payload.
      if (L.glyphs?.length) {
        const srcAt = new Map();
        for (const g of L.glyphs) if (g.src) srcAt.set(g.pen, g.src);
        for (const e of L.entries) if (e.src === undefined && srcAt.has(e.pen)) e.src = srcAt.get(e.pen);
      }

      // invert svg-renderer's computeBaseline (y + h·0.85 − 1.3) so the SVG
      // text sits on the MEASURED baseline exactly
      const h = (set.maxAsc + set.maxDesc) * sy;
      const y = L.baseline * sy - (h * 0.85 - 1.3);

      // A redaction box interrupting the line ALWAYS splits it into separate
      // text boxes, one per side, each anchored at its own measured pen and
      // carrying no separator spaces (the segment after a box must not ride as
      // trailing chars of the segment before it). The predicate is the
      // engine's boxBetween — the one that put the single separator space into
      // L.text — so the two views can never disagree about where a bar is.
      // A box carries one underline and one colour, so the line is split
      // where the page's underline starts or stops and where its ink changes
      // too (a blue underlined link inside a black sentence: three boxes).
      const rects = L.boxes ?? [];
      const under = underlinedEntries(L, res.objects || []);
      const inkOf = [];
      for (let i = 0; i < L.entries.length; i++) {
        const e = L.entries[i];
        inkOf.push(e.ch === '□' && i ? inkOf[i - 1] : (e.ink || null));
      }
      const segs = [[L.entries[0]]];
      for (let i = 1; i < L.entries.length; i++) {
        const a = L.entries[i - 1], b = L.entries[i];
        if (boxBetween(rects, a, b) || under.has(a) !== under.has(b) || inkOf[i - 1] !== inkOf[i]) segs.push([]);
        segs[segs.length - 1].push(b);
      }

      for (const seg of segs) {
        const first = seg[0], last = seg[seg.length - 1];
        const startOff = first.i, endOff = last.i + txLen(last.ch);
        const segLine = { text: L.text.slice(startOff, endOff),
          entries: seg.map(e => ({ ...e, i: e.i - startOff })) };
        const x0 = first.pen;
        const { family, bold, italic } = fontFromSetName(majoritySet(seg, L.font), setFonts);
        // keep every field charPositions marks (lig/ligTail, src) — the pixel
        // view needs them; only the geometry is scaled into viewBox space
        const chars = charPositions(segLine, x0).map(cp => ({ ...cp, x: cp.x * sx, w: cp.w * sx }));

        boxes.push({ data: {
          type: 'ocr', page: pageNum, text: segLine.text,
          lineId: `ocr_p${pageNum}_l${n}`,      // segments share the line — redactions connect to it
          x: x0 * sx, y, w: (last.pen + last.adv - x0) * sx, h,
          fontFamily: family, bold, italic,
          sizePt: set.sizePx * 0.75 * sx,
          baseCharPositions: chars,
          // the page's ink (black: none) — an uncertified line keeps the
          // reader's orange instead: its letters are not proven
          color: L.clean ? (inkOf[L.entries.indexOf(first)] ?? null) : UNCLEAN_COLOR,
          ...(under.has(first) ? { underline: true } : {}),
        }, ocr: {
          // the page's own underline under the segment: its rule (x viewBox px,
          // rows raster px), where the pixel view draws a read line's underline
          ...(under.has(first) ? { underline: (r => ({ x0: r.x0 * sx, x1: (r.x1 + 1) * sx, y0: r.y0, y1: r.y1 }))(under.get(first)) } : {}), clean: !!L.clean, trusted, tol: pass.tol || 0, quant: !!pass.quant,
          // the reader's entries for this segment (offset, glyph, pen, advance,
          // drawing set) — what the pixel view re-lays an EDITED line from: the
          // unchanged part keeps its pens, the rest follows the producer's law
          entries: segLine.entries,
          union: !!pass.union, font: L.font, baseline: L.baseline, fails: L.fails.length,
          // the y-phase records the reader pinned the line to (0, or 0.5 on a
          // legacy set) — the pixel view re-draws with the same records
          phy: L.phy ?? 0,
          // the band the reader judged (rows) — the pixel view's residual check
          // looks for page ink here that no drawn glyph explains
          top: L.top, bot: L.bot,
          // the reader's own residual: ink pixels in the band it could not explain
          // (clean ⇔ no fails and residual 0)
          residual: L.residual ?? 0,
          // the space this line was shaped with — its set's calibration on the
          // page (a Times header and a Courier body differ), the page's when a
          // cached read predates per-set calibration — what a re-layout of
          // edited text uses for a new break
          spaceAdv: L.spaceAdv ?? res.spaceAdv ?? null } });
      }
      tally.lines++;
      if (L.clean) tally.clean++;
    }

    // detected redaction rectangles -> redaction boxes (the same kind the Add
    // Box tool creates; the matching suite picks them up when installed)
    for (const ob of (res.objects || []).filter(o => o.type === 'box')) {
      const x = ob.x0 * sx, w = (ob.x1 - ob.x0 + 1) * sx;
      boxes.push({ data: {
        type: 'redaction', page: pageNum, text: '',
        x, y: ob.y0 * sy, w, h: (ob.y1 - ob.y0 + 1) * sy,
      // the black ink's own extent (viewBox px), kept apart from x/w which a
      // refiner moves: the hidden text can start no earlier and end no later
      }, ink: { x0: x, x1: x + w } });
      tally.boxes++;
    }

    return { boxes, tally };
  }

  // The certified glyphs of a page read, per set — what each set's producer
  // law is learned from (render.js producerMetrics). A union line reports one
  // font label; each glyph carries the set that drew it. Map set name ->
  // { sizePx, lines: [{ entries }] }, in the order the sets first appear.
  function lawInputs(res) {
    const bySet = new Map();
    for (const L of res.lines || []) {
      if (!L.clean || !L.font || !L.entries?.length) continue;
      const sizePx = L.set?.sizePx;
      if (!sizePx) continue;
      const names = new Set([L.font.split('+')[0]]);
      for (const e of L.entries) if (e.src) names.add(e.src);
      for (const name of names) {
        const own = L.entries.filter(e => e.ch !== '□' && (e.src || L.font.split('+')[0]) === name);
        if (own.length < 2) continue;
        if (!bySet.has(name)) bySet.set(name, { sizePx, lines: [] });
        bySet.get(name).lines.push({ entries: own });
      }
    }
    return bySet;
  }

  // After a read: the dominant face and size of the certified lines, told to
  // the text tool through the generic typography:detected event (fonts.js
  // selects it as the default for new boxes). Weighted by glyph count. Only a
  // read that certified most of what it saw makes the claim — it outranks the
  // text layer's, and on a page the reader could not read (EFTA00173953: 2 of
  // 46 bands clean, at ±10) the two clean lines named Cambria and every new
  // box took it, while the layer said Times New Roman 11 pt.
  // boxes: every box of the document (only type 'ocr' counts).
  function readIsWeak(boxes) {
    const lines = new Map();                       // lineId -> certified, with letters?
    for (const b of boxes)
      if (b.type === 'ocr' && b.lineId) lines.set(b.lineId, lines.get(b.lineId) || !!(b.ocr?.trusted ?? b.ocr?.clean));
    let clean = 0;
    for (const c of lines.values()) if (c) clean++;
    return clean < 3 || clean < lines.size * 0.5;
  }
  // { fontFamily, sizePt } the read names, or null (a weak read, or nothing certified)
  function dominantTypography(boxes) {
    if (readIsWeak(boxes)) return null;
    const tally = new Map();
    for (const b of boxes) {
      if (b.type !== 'ocr' || !(b.ocr?.trusted ?? b.ocr?.clean) || !b.text) continue;
      const k = `${b.fontFamily}|${Math.round(b.sizePt * 100) / 100}`;
      tally.set(k, (tally.get(k) || 0) + b.text.replace(/\s+/g, '').length);
    }
    if (!tally.size) return null;
    const [key] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    const [fontFamily, sizePt] = key.split('|');
    return { fontFamily, sizePt: +sizePt };
  }

  // ── Paragraphs ─────────────────────────────────────────────
  // A page's read lines as paragraphs, the way a word processor set them:
  // [{ lines: [lineId…], align: 'left'|'right'|'center'|'justify',
  //    leftIndentPt, firstIndentPt, rightIndentPt, leadingPt, spaceBeforePt,
  //    list: null|'bullet'|'number' }] in reading order. boxes: the page's
  // boxes (OCR lines; a redaction box on a line counts toward its extent —
  // a bar opening a line is not an indent). opts: { page, w } (w: the page
  // width in px, for a centred line on a page with no full line). Geometry in
  // viewBox px (96 dpi: × 0.75 is points), baselines where the renderer puts
  // them.
  //
  // A line joins the paragraph above when it is set in the same size, at the
  // paragraph's leading (the first gap: under three ems), and the line above
  // was FULL: started at the column's left (or the block's) and left no room
  // for this line's first word — word wrap; a paragraph's last line is the
  // one with room to spare — or, centred or set right, could not have taken
  // it either; or the two are a block starting and ending together, or with
  // equal indents on both sides (a quote is full against its own margins).
  // A list marker (•, a number, a letter) followed by a tab-wide gap starts
  // an item. The column is where lines agree (below). A justified
  // paragraph's lines end at the margin AND are spaced
  // wider than its last line. The leading is pooled over the page's
  // paragraphs of one size (baselines sit on whole pixels: one gap of 13.8 pt
  // reads 13.5 or 14.25); a one-line paragraph takes its size's, else Word's
  // single spacing for these faces (1.15 × size).
  const PX_PT = 0.75;
  const BULLET = /^[•◦▪‣·*–-]$/u;
  const NUMBER = /^\(?(\d{1,3}|[a-z]|[ivxlc]{1,5})[.)]$/i;
  function paragraphs(boxes, opts = {}) {
    const mid = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const byId = new Map();
    for (const b of boxes || []) {
      if (b.type !== 'ocr' || b.ocr?.unread || !b.text || (opts.page != null && b.page !== opts.page)) continue;
      let L = byId.get(b.lineId);
      if (!L) byId.set(b.lineId, L = { id: b.lineId, baseline: b.y + b.h * 0.85 - 1.3, x0: Infinity, x1: -Infinity, sizePt: b.sizePt, segs: [], barStart: false, barEnd: false });
      L.segs.push(b);
      L.x0 = Math.min(L.x0, b.x); L.x1 = Math.max(L.x1, b.x + b.w);
      if (b.sizePt > L.sizePt) L.sizePt = b.sizePt;
    }
    for (const b of boxes || []) {
      const L = b.type === 'redaction' && byId.get(b.lineId);
      if (!L || (opts.page != null && b.page !== opts.page)) continue;
      if (b.x < L.x0) { L.x0 = b.x; L.barStart = true; }
      if (b.x + b.w > L.x1) { L.x1 = b.x + b.w; L.barEnd = true; }
    }
    const lines = [...byId.values()].sort((a, b) => a.baseline - b.baseline);
    if (!lines.length) return [];
    for (const L of lines) {
      L.segs.sort((a, b) => a.x - b.x);
      const main = L.segs.reduce((a, b) => (b.text.length > a.text.length ? b : a));
      L.face = `${main.fontFamily}|${!!main.bold}|${!!main.italic}`;
      const sizePx = L.sizePt / PX_PT;
      L.space = L.segs[0].ocr?.spaceAdv ?? sizePx * 0.25;
      // words per segment: where each starts and its glyphs' advances
      const words = [];
      let gapSum = 0, gapN = 0;
      for (const sg of L.segs) {
        let cur = null, n = 0;
        for (const cp of sg.baseCharPositions || []) {
          const x = sg.x + cp.x;
          if (!cp.c || cp.c === ' ') { if (cur) n++; continue; }
          if (cur && n > 0) {                          // a gap: start to start, the snaps telescope
            gapSum += x - (cur.x0 + cur.adv); gapN += n;
            words.push(cur); cur = null;
          }
          if (!cur) { cur = { text: '', x0: x, adv: 0 }; n = 0; }
          if (!cp.ligTail) cur.text += cp.lig || cp.c;
          cur.adv += cp.w || 0;
        }
        if (cur) words.push(cur);
      }
      L.gap = gapN ? gapSum / gapN : null;
      const w0 = words[0];
      L.firstWordW = w0 ? w0.adv : 0;
      L.list = null;
      if (w0 && words[1] && L.segs[0].x <= L.x0 + 0.5 && words[1].x0 - (w0.x0 + w0.adv) > 1.5 * L.space &&
          (BULLET.test(w0.text) || NUMBER.test(w0.text))) {
        L.list = BULLET.test(w0.text) ? 'bullet' : 'number';
        L.textX = words[1].x0;
      }
    }
    // the column: the leftmost start two lines share. On the right, the end
    // two long lines share (justified lines end at the margin); on a ragged
    // page, where no line need reach it, the margin mirroring the left one —
    // when the longest line comes within an inch of it (an e-mail wrapped at
    // its own width keeps its longest line)
    const sharedLeft = vals => { const s = [...vals].sort((a, b) => a - b); for (const v of s) if (vals.filter(w => Math.abs(w - v) <= 1).length >= 2) return v; return s[0]; };
    const colLeft = sharedLeft(lines.map(l => l.x0));
    const maxX1 = Math.max(...lines.map(l => l.x1));
    const ends = lines.map(l => l.x1).filter(x => x >= 0.9 * maxX1);
    const sharedRight = ends.find(x => ends.filter(y => Math.abs(y - x) <= 1.5).length >= 2);
    const mirrored = opts.w ? opts.w - colLeft : null;
    const colRight = sharedRight != null ? Math.max(sharedRight, maxX1)
      : mirrored != null && mirrored > maxX1 && mirrored - maxX1 < 96 ? mirrored : maxX1;
    const colMid = (colLeft + colRight) / 2, colW = colRight - colLeft;
    const pageMid = opts.w ? opts.w / 2 : null;
    const tolEnd = L => L.barEnd ? 2.5 : 1.5;          // a bar ending a line is padded past its text
    const tolStart = L => L.barStart ? 2.5 : 1.5;      // and one opening it, before
    const centred = L => Math.abs((L.x0 + L.x1) / 2 - colMid) <= 2 || (pageMid != null && Math.abs((L.x0 + L.x1) / 2 - pageMid) <= 2);

    const paras = [];
    let P = null;
    for (const L of lines) {
      const prev = P?.lines[P.lines.length - 1];
      let join = false;
      // a whole line in another face (a regular line after a bold one) is another paragraph
      if (prev && !L.list && Math.abs(L.sizePt - prev.sizePt) <= 0.3 && L.face === prev.face) {
        const gap = L.baseline - prev.baseline;
        const gapOk = P.lead != null ? Math.abs(gap - P.lead) <= 1.5 : gap > 0 && gap <= 3 * prev.sizePt / PX_PT;
        const room = L.firstWordW + prev.space + 1;
        // a wrapped line starts at the column's left, a first-line or list indent from it (under an inch)
        const flowStart = prev.x0 - colLeft <= 96 || (prev.list && prev.textX - colLeft <= 96);
        const full = flowStart && colRight - prev.x1 < room;
        const centreFull = centred(prev) && centred(L) && prev.x0 - colLeft > 3 && colW - (prev.x1 - prev.x0) < room;
        const rightFull = Math.abs(prev.x1 - colRight) <= tolEnd(prev) && Math.abs(L.x1 - colRight) <= tolEnd(L) &&
          prev.x0 - colLeft > 0.25 * colW && colW - (prev.x1 - prev.x0) < room;
        const block = prev.x0 - colLeft > 3 && Math.abs(L.x0 - prev.x0) <= 1.5 && prev.x1 - prev.x0 > 0.5 * colW &&
          (Math.abs(L.x1 - prev.x1) <= 1.5 || Math.abs((colRight - prev.x1) - (prev.x0 - colLeft)) <= 2.5);
        join = gapOk && (full || centreFull || rightFull || block);
      }
      if (join) { P.lead ??= L.baseline - prev.baseline; P.lines.push(L); }
      else paras.push(P = { lines: [L], lead: null });
    }
    // A two-line paragraph is two paragraphs when its one gap is the page's
    // gap BETWEEN paragraphs — the gap after a line with room to spare, the
    // leading plus the space after: a long last line of one paragraph (no
    // room for the next word) over the first of the next. The e-mail's link
    // line over "Thank you." is 28 px apart, as its paragraphs are; on the
    // spacing page a double-spaced paragraph's 37 px is no paragraph gap.
    // (only a gap clearly wider than the size's closest lines: where paragraphs
    // have no space after, their gap is the leading itself)
    const minGap = new Map();
    for (let k = 1; k < lines.length; k++) {
      const a = lines[k - 1], b = lines[k], key = Math.round(a.sizePt * 4);
      if (Math.abs(a.sizePt - b.sizePt) <= 0.3) minGap.set(key, Math.min(minGap.get(key) ?? Infinity, b.baseline - a.baseline));
    }
    const paraGaps = [];
    for (let k = 1; k < paras.length; k++) {
      const a = paras[k - 1].lines[paras[k - 1].lines.length - 1], b = paras[k].lines[0], gap = b.baseline - a.baseline;
      if (Math.abs(a.sizePt - b.sizePt) <= 0.3 && colRight - a.x1 >= b.firstWordW + a.space + 1 &&
          gap > (minGap.get(Math.round(a.sizePt * 4)) ?? 0) + 1.5) paraGaps.push({ sizePt: a.sizePt, gap });
    }
    for (let k = paras.length - 1; k >= 0; k--) {
      const q = paras[k];
      if (q.lines.length !== 2) continue;
      const gap = q.lines[1].baseline - q.lines[0].baseline;
      if (paraGaps.some(g => Math.abs(g.sizePt - q.lines[0].sizePt) <= 0.3 && Math.abs(g.gap - gap) <= 1.5))
        paras.splice(k, 1, { lines: [q.lines[0]], lead: null }, { lines: [q.lines[1]], lead: null });
    }

    // the leading of a size: pooled over the paragraphs that agree (start to
    // end of each: a span's two baselines are whole rows, ±1 px over the span).
    // Within that uncertainty of Word's single, 1½ or double spacing for these
    // faces (1.15 × size), it is that.
    const own = q => (q.lines[q.lines.length - 1].baseline - q.lines[0].baseline) / (q.lines.length - 1);
    const pooled = (sizePt, near) => {
      let span = 0, n = 0, spans = 0;
      for (const q of paras) {
        if (q.lines.length < 2 || Math.abs(q.lines[0].sizePt - sizePt) > 0.3) continue;
        if (near != null && Math.abs(own(q) - near) > 1) continue;
        span += q.lines[q.lines.length - 1].baseline - q.lines[0].baseline; n += q.lines.length - 1; spans++;
      }
      if (!n) return null;
      const lead = span / n, single = 1.15 * sizePt / PX_PT;
      const word = [1, 1.5, 2].map(k => k * single).find(c => Math.abs(c - lead) <= spans / n + 0.05);
      return word ?? lead;
    };
    const r2 = v => Math.round(v * 100) / 100;
    const snap = v => Math.abs(v) < 3 ? 0 : v;           // under 3 px: bar padding, an overhang — not an indent
    const out = [];
    let before = null;
    for (const q of paras) {
      const ls = q.lines, n = ls.length, first = ls[0], last = ls[n - 1];
      // a one-line paragraph: the leading the page's paragraphs of its size agree on, else single spacing
      const others = paras.filter(o => o.lines.length > 1 && Math.abs(o.lines[0].sizePt - first.sizePt) <= 0.3).map(own);
      const agreed = others.length && Math.max(...others) - Math.min(...others) <= 1 ? pooled(first.sizePt, null) : null;
      const lead = n > 1 ? pooled(first.sizePt, own(q)) : (agreed ?? 1.15 * first.sizePt / PX_PT);
      const same = (vals, tol) => vals.every(v => Math.abs(v - vals[0]) <= tol);
      let align = 'left';
      if (n > 1) {
        const heads = ls.slice(0, -1);
        const body = ls.slice(1), x0s = body.map(l => l.x0);
        const leftEdge = body.every(l => Math.abs(l.x0 - Math.min(...x0s.filter((x, k) => !body[k].barStart), Infinity) ) <= tolStart(l)) ||
          same(x0s, 1.5);
        // at the margin — or, for an indented block, at its own: the left indent mirrored
        const indentR = colRight - (Math.min(...x0s) - colLeft);
        const atRight = heads.every(l => Math.abs(l.x1 - colRight) <= tolEnd(l)) ||
          heads.every(l => Math.abs(l.x1 - indentR) <= tolEnd(l)) || (n > 2 && same(heads.map(l => l.x1), 1.5));
        // stretched: the full lines' gaps wider than the last line's (or, with none there, than the paragraph's narrowest)
        const gaps = heads.map(l => l.gap).filter(g => g != null);
        const lastGap = last.gap ?? (gaps.length ? Math.min(...gaps) : null);
        const stretched = gaps.length && lastGap != null && mid(gaps) > lastGap + 0.15;
        if (leftEdge && atRight && (stretched || n > 2 && last.gap != null && mid(gaps) > last.gap + 0.15)) align = 'justify';
        else if (!same(ls.map(l => l.x0), 1.5) && ls.every(l => Math.abs(l.x1 - colRight) <= tolEnd(l))) align = 'right';
        else if (!same(ls.map(l => l.x0), 1.5) && ls.every(centred)) align = 'center';
        else if (leftEdge && atRight && n === 2 && stretched) align = 'justify';
      } else if (first.x0 - colLeft > 3) {
        if (centred(first)) align = 'center';
        else if (Math.abs(first.x1 - colRight) <= tolEnd(first)) align = 'right';
      }
      let leftIndent = 0, firstIndent = 0, rightIndent = 0;
      if (first.list) { leftIndent = first.textX - colLeft; firstIndent = first.x0 - first.textX; }
      else if (align === 'left' || align === 'justify') {
        const body = n > 1 ? mid(ls.slice(1).map(l => l.x0)) : colLeft;
        leftIndent = snap(body - colLeft);
        firstIndent = snap(first.x0 - body);
        if (align === 'justify') rightIndent = snap(colRight - Math.max(...ls.slice(0, -1).map(l => l.x1)));
      }
      out.push({ lines: ls.map(l => l.id), align, leftIndentPt: r2(leftIndent * PX_PT), firstIndentPt: r2(firstIndent * PX_PT),
        rightIndentPt: r2(Math.max(0, rightIndent) * PX_PT), leadingPt: r2(lead * PX_PT),
        spaceBeforePt: before == null ? null : r2(Math.max(0, first.baseline - before - lead) * PX_PT), list: first.list });
      before = last.baseline;
    }
    return out;
  }

  root.OCRLineBoxes = { fontFromSetName, majoritySet, underlinedEntries, inkColours, charPositions, pageBoxes, lawInputs, readIsWeak, dominantTypography,
    paragraphs, UNCLEAN_COLOR, UNREAD_COLOR };
})(globalThis);
