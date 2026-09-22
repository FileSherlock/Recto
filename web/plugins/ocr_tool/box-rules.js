// box-rules.js — which of the reader's boxes are redactions. Recto-owned and
// DOM-free: the page loads it as a classic script before ocr-tool.js, the node
// tests import the same file; it defines globalThis.OCRBoxRules, nothing else.
//
// The engine's detectObjects (tol0, verbatim) calls any long near-solid dark
// run a box, so a grey table cell, a logo's plate, a thick rule, a photograph
// or a page border arrives here beside the redactions. Two questions sort them:
//
//   1. Is it black? A redaction is solid black ink: its interior, one pixel in
//      from every side (past the AA rim), must be at least BLACK_FRACTION
//      black — BLACK_MAX is a level scan noise stays under. A box too thin to
//      have an interior keeps the reader's word.
//   2. Is it where text is? A redaction covers text, so it sits on the page's
//      text grid. Either visible text shares its rows — a line's band overlaps
//      it by ON_LINE of its height, the other words of the line the name was
//      on — or the whole line went under the bar and a line lies within
//      GRID_GAP × pitch above or below it: one line's bar, or a block of
//      lines. Either way it is at least GRID_MIN_H × pitch tall — a thick
//      rule (5–8 rows, past the engine's 4-row rule limit) is shorter than
//      any bar. A box narrower than the run rule's 40 px (stack-born) and
//      taller than NARROW_TALL lines is a border or the junction of two
//      lines' touching bars, not a bar a name could fit. The grid is trusted
//      only from MIN_ROWS distinct text rows; a page with fewer — an image, a
//      page the reader could not read — keeps every black box. Unread bands count as rows: they have a top, a bottom
//      and a baseline like a read line.
//
// Measured 2026-09-22 on the corpus (startup document, EFTA00382083 and
// EFTA01011184 to page 20, the goldens) and on EFTA00173953 (23 bars, most of
// them on unread bands): every real bar overlaps a line by 0.47–0.84 of its
// height or lies 0–11 px from one, and is 0.78–1.27 lines tall; nothing real
// is off the grid, and the rule drops nothing on those pages. What it drops:
// a 5–8 px black rule (a line is taller), a black plate or photograph away
// from the text, a page border along it, the 35 × 34 px junction piece the
// touching Subject-block bars of EFTA00173953 leave (redaction ink, but no
// name fits it).
(function (root) {
  'use strict';

  const BLACK_MAX = 48;        // gray level up to which a pixel is black ink
  const BLACK_FRACTION = 0.9;  // of the interior
  const MIN_ROWS = 8;          // distinct text rows before the page's grid is trusted
  const ROW_MIN_GAP = 4;       // baselines closer than this are one row (a line's segments)
  const ON_LINE = 0.4;         // line overlap ≥ this × box height: visible text shares the rows
  const GRID_GAP = 0.6;        // … or a line within this × pitch above or below …
  const GRID_MIN_H = 0.6;      // … and the box at least this × pitch tall
  const NARROW_PX = 40;        // under the engine's long-run rule: a stack-born box
  const NARROW_TALL = 1.6;     // such a box taller than this many lines is no bar

  // the black fraction of a box's interior; 1 for a box too thin to have one
  function blackness(page, ob) {
    const x0 = Math.max(0, ob.x0 + 1), x1 = Math.min(page.w - 1, ob.x1 - 1);
    const y0 = Math.max(0, ob.y0 + 1), y1 = Math.min(page.h - 1, ob.y1 - 1);
    if (x1 < x0 || y1 < y0) return 1;
    let black = 0, n = 0;
    for (let y = y0; y <= y1; y++) {
      const row = y * page.w;
      for (let x = x0; x <= x1; x++, n++) if (page.gray[row + x] <= BLACK_MAX) black++;
    }
    return black / n;
  }

  // the page's text grid from its lines ({top, bot, baseline} in rows):
  // { rows, pitch } — the distinct rows and the typical distance between
  // them — or null when there are too few rows to trust it
  function grid(lines) {
    const bl = [...new Set((lines || []).filter(L => Number.isFinite(L.baseline)).map(L => Math.round(L.baseline)))]
      .sort((a, b) => a - b);
    const rows = [];
    for (const b of bl) if (!rows.length || b - rows[rows.length - 1] >= ROW_MIN_GAP) rows.push(b);
    if (rows.length < MIN_ROWS) return null;
    const gaps = rows.slice(1).map((b, i) => b - rows[i]).sort((a, b) => a - b);
    return { rows: rows.length, pitch: gaps[gaps.length >> 1] };
  }

  // where a box stands to the lines: onLine — the largest line-band overlap
  // as a fraction of the box's height; gap — rows to the nearest line band
  // (0 when one touches or overlaps it, Infinity with no line at all)
  function anchoring(lines, ob) {
    const h = Math.max(1, ob.y1 - ob.y0);
    let best = 0, gap = Infinity;
    for (const L of lines || []) {
      if (!(L.top < L.bot)) continue;
      const ov = Math.min(ob.y1, L.bot) - Math.max(ob.y0, L.top);
      if (ov > 0) { if (ov > best) best = ov; gap = 0; continue; }
      const d = L.bot <= ob.y0 ? ob.y0 - L.bot : L.top - ob.y1;
      if (d < gap) gap = d;
    }
    return { onLine: best / h, gap };
  }

  // one box: { keep, why, black, onLine, gap, hPitch } — why names what
  // failed ('not black', 'narrow and taller than a line', 'shorter than a
  // line', 'away from the text'), null when the box stays
  function verdict(page, lines, ob, g = grid(lines)) {
    const black = blackness(page, ob);
    const out = { keep: true, why: null, black: +black.toFixed(3), onLine: null, gap: null, hPitch: null };
    if (black < BLACK_FRACTION) return { ...out, keep: false, why: 'not black' };
    if (!g) return out;                                   // no grid to judge by
    const h = ob.y1 - ob.y0, w = ob.x1 - ob.x0;
    const a = anchoring(lines, ob);
    Object.assign(out, { onLine: +a.onLine.toFixed(2), gap: Number.isFinite(a.gap) ? a.gap : null, hPitch: +(h / g.pitch).toFixed(2) });
    if (w < NARROW_PX && h > NARROW_TALL * g.pitch) return { ...out, keep: false, why: 'narrow and taller than a line' };
    // a bar is never shorter than GRID_MIN_H of a line: a thick rule (5–8
    // rows, past the engine's 4-row rule limit) is, and would still touch
    // the next line's band by half its own height
    if (h < GRID_MIN_H * g.pitch) return { ...out, keep: false, why: 'shorter than a line' };
    if (a.onLine >= ON_LINE || a.gap <= GRID_GAP * g.pitch) return out;
    return { ...out, keep: false, why: 'away from the text' };
  }

  // every 'box' object of a page read: { kept: objects (the others untouched,
  // in order), dropped: [{ x0, y0, x1, y1, black, onLine, gap, hPitch, why }] }
  function filter(page, lines, objects) {
    const g = grid(lines);
    const kept = [], dropped = [];
    for (const o of objects || []) {
      if (o.type !== 'box') { kept.push(o); continue; }
      const v = verdict(page, lines, o, g);
      if (v.keep) kept.push(o);
      else dropped.push({ x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1, black: v.black, onLine: v.onLine, gap: v.gap, hPitch: v.hPitch, why: v.why });
    }
    return { kept, dropped };
  }

  root.OCRBoxRules = { blackness, grid, anchoring, verdict, filter,
    BLACK_MAX, BLACK_FRACTION, MIN_ROWS, ON_LINE, GRID_GAP, GRID_MIN_H, NARROW_PX, NARROW_TALL };
})(globalThis);
