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
// (readIsWeak), the face and size it names (dominantTypography), and which
// certified glyphs teach each set's producer law (lawInputs).
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
      const rects = L.boxes ?? [];
      const segs = [[L.entries[0]]];
      for (let i = 1; i < L.entries.length; i++) {
        if (boxBetween(rects, L.entries[i - 1], L.entries[i])) segs.push([]);
        segs[segs.length - 1].push(L.entries[i]);
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
          color: L.clean ? null : UNCLEAN_COLOR,
        }, ocr: { clean: !!L.clean, trusted, tol: pass.tol || 0, quant: !!pass.quant,
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

  root.OCRLineBoxes = { fontFromSetName, majoritySet, charPositions, pageBoxes, lawInputs, readIsWeak, dominantTypography,
    UNCLEAN_COLOR, UNREAD_COLOR };
})(globalThis);
