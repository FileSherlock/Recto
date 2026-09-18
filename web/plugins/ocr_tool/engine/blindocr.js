// blindocr.js — browser/Recto-facing shell around the shared OCR engine
// (src/ocr-engine.js — same matcher core the bench uses, see there for the
// scanning derivation). This file owns everything platform-specific to the
// app: the glyphs.bin bundle loader (DataView, browser-native), colored-ink
// removal from live canvas RGBA, same-pixel-size union-pool grouping, the
// escalating multi-pass ladder, and box-positioned output shaping for the
// UI (lineEntries). No layout constants anywhere in the pipeline.
//
// In-app certificate: a line is CLEAN when the scan explained every non-object
// ink pixel of its band byte-exactly through the proven blend law
// (dst = (dst·(256−e))>>8, e = cov + (cov>>7)) — L.fails.length === 0 and
// L.residual === 0 (see ocr-engine.js readPage/scanLine).
//
// The glyph dictionary is ONE binary bundle — assets/glyphs/glyphs.bin,
// every fontgen set (raw gray + true-alpha planes), built and byte-certified
// from the committed .npz rasters by tools/export-glyphs.mjs (layout doc in
// tools/glyph-bundle.mjs). Load with BlindOCR.loadSets().
(function (root) {
  'use strict';

  const Engine = (typeof module !== 'undefined' && module.exports)
    ? require('./ocr-engine.js')
    : root.OCREngine;

  // ---- glyph sets (glyphs.bin bundle) ----
  const BUNDLE_URL = '/assets/glyphs/glyphs.bin';
  // the app's default working set — deliberate, NOT "everything in the
  // bundle": every extra set adds per-band probes and new pick ties
  const DEFAULT_SETS = ['times16', 'timesbd16', 'timesi16', 'tnr8_16',
    'arial16', 'georgia16',
    'cour13',                                    // courier_1/2 body font
    // linear-compositor variants (eDiscovery producer — see ocr-engine.js);
    // the per-band auto-pick chooses whichever compositor matches the page
    'timeslin16', 'timesbdlin16', 'timesilin16', 'tnr8lin16', 'tnr8lin10',
    // Tahoma email family (ocr/FINDINGS-tahoma.md) — the largest tol-0 corpus
    // population with no engine pool until 2026-07-26; three sizes plus the
    // Segoe UI 853 second body face the same threads quote
    'tahoma832', 'tahomabd832', 'tahoma853', 'tahomabd853',
    'tahoma1024', 'tahomabd1024', 'segoeui853', 'segoeuib853',
    // EFTA01150379's face (ocr/FINDINGS-b64grid.md): DejaVu Serif em64 786.
    // Right face, wrong BUILD — polygon glyphs byte-exact, curve glyphs off
    // 2–4 (`t` 7, `D` 13), so useful reads come from the ladder tol rungs.
    'dejavuserif786',
    // …and the same face under the producer's recreated TRANSPORT LAW, which
    // reads that document at TOLERANCE 0: p2 goes 285 glyphs / 278 □ on the
    // stock set to 2,575 glyphs / 1 □ on this one, and six consecutive base64
    // pages read 5,320 glyphs at 0 □. Both are carried — the stock set still
    // names the face for anything the law does not cover.
    'dejavuserif786law'];
  // "…/glyphs_times16.json" (legacy url) / "times16" -> "times16"
  const setName = s => s.replace(/^.*glyphs_/, '').replace(/\.json$/, '').replace(/^.*\//, '');

  function parseBundleDir(buf) {                 // buf: Uint8Array of glyphs.bin
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== 'GBF1')
      throw new Error('bad GBF1 magic');
    const td = new TextDecoder();
    const dir = new Map();
    let o = 8;
    for (let i = 0, n = dv.getUint32(4, true); i < n; i++) {
      const nameLen = buf[o];
      const name = td.decode(buf.subarray(o + 1, o + 1 + nameLen)); o += 1 + nameLen;
      o += 1 + buf[o];                           // npz provenance name — unused here
      const flags = buf[o]; o += 1;
      const sizePx = dv.getFloat64(o, true); o += 8;
      const off = dv.getUint32(o, true); o += 8;
      dir.set(name, { name, linear: !!(flags & 1), sizePx, off });
    }
    return { buf, dv, dir };
  }

  // one set out of the bundle, in the exact per-candidate shape the scanner
  // uses (insertion order = char × phx order — tie-break-significant)
  function materializeSet(bundle, name) {
    const d = bundle.dir.get(name);
    if (!d) return null;
    const { buf, dv } = bundle;
    const byPhy = new Map();
    let maxAsc = 0, maxDesc = 0;
    let o = d.off;
    const nChars = dv.getUint32(o, true); o += 4;
    for (let ci = 0; ci < nChars; ci++) {
      const ch = String.fromCodePoint(dv.getUint32(o, true)); o += 4;
      const adv = dv.getFloat64(o, true); o += 8;
      const nPh = buf[o]; o += 1;
      for (let pi = 0; pi < nPh; pi++) {
        const phx = buf[o] / 4, phy = buf[o + 1] / 2;
        const dx = dv.getInt16(o + 2, true), dy = dv.getInt16(o + 4, true);
        const w = dv.getUint16(o + 6, true), h = dv.getUint16(o + 8, true);
        o += 10;
        if (!w) continue;
        const bytes = buf.subarray(o, o + w * h);
        const alpha = buf.subarray(o + w * h, o + 2 * w * h);
        o += 2 * w * h;
        const ink = [];
        let inkLeft = w;
        for (let c = 0; c < w; c++)
          for (let rr = 0; rr < h; rr++)
            if (bytes[rr * w + c] < 255) { ink.push(rr * w + c); if (c < inkLeft) inkLeft = c; }
        // hot-loop precomputation: per ink pixel its column, row, raster byte
        // and alpha (the candidate trial loop runs millions of times per page)
        const inkC = new Int16Array(ink.length), inkR = new Int16Array(ink.length),
          inkB = new Uint8Array(ink.length), inkA = new Uint8Array(ink.length);
        for (let k = 0; k < ink.length; k++) {
          inkC[k] = ink[k] % w; inkR[k] = (ink[k] / w) | 0;
          inkB[k] = bytes[ink[k]]; inkA[k] = alpha[ink[k]];
        }
        if (!byPhy.has(phy)) byPhy.set(phy, []);
        byPhy.get(phy).push({ ch, adv, phx, w, h, dx, dy,
          bytes, alpha, ink, inkC, inkR, inkB, inkA, inkLeft });
        maxAsc = Math.max(maxAsc, -dy);
        maxDesc = Math.max(maxDesc, dy + h);
      }
    }
    return { name, sizePx: d.sizePx, linear: d.linear, byPhy, maxAsc, maxDesc };
  }

  let _sets = null;
  // loadSets(list?) — entries may be set names ("times16"), legacy glyph-JSON
  // urls (mapped to names), or a glyphs.bin url. A bare .bin entry loads
  // EVERY set in the bundle (Recto's index.json lists exactly that — Recto
  // ships them all); no list = DEFAULT_SETS from BUNDLE_URL.
  async function loadSets(list) {
    if (_sets) return _sets;
    let url = BUNDLE_URL, names = DEFAULT_SETS, all = false;
    if (list && list.length) {
      const bin = list.find(u => /\.bin($|\?)/.test(u));
      const rest = list.filter(u => u !== bin).map(setName);
      if (bin) { url = bin; names = rest; all = !rest.length; }
      else { url = list[0].replace(/[^/]*$/, 'glyphs.bin'); names = rest; }
    }
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`glyph bundle fetch failed: ${url} (${r.status})`);
    const bundle = parseBundleDir(new Uint8Array(await r.arrayBuffer()));
    const out = [];
    for (const n of all ? [...bundle.dir.keys()] : names) {
      const s = materializeSet(bundle, n);
      if (s) out.push(s);                        // unknown name: skip (parked/renamed set)
    }
    _sets = out;
    return out;
  }

  // ---- colored-ink removal (color pages) ----
  // Plain black text is achromatic (R=G=B). Colored ink (hyperlink blue) can
  // never byte-match gray glyph rasters, so every ink component connected to a
  // non-neutral pixel is whitened; the reader then sees only the plain text,
  // byte-exactly (the bench's readGray does the same to mode-2 rasters).
  // Non-neutral: R≠G≠B when RGBA is supplied (app canvas — exact), else a
  // non-integral gray value ((R+G+B)/3 with the sum not divisible by 3 — the
  // bench's sum%3 signal; misses neutral-sum colored pixels the same way).
  // Returns the page untouched when nothing is colored.
  function whitenColored(page, rgba) {
    const { w, h } = page, n = w * h, g = page.gray;
    const colored = new Uint8Array(n), stack = [];
    if (rgba) {
      // ONE implementation of the colour law (Engine.colourInk, LAWS §9):
      // coloured TEXT is read as the coverage it is, through its pen; what
      // no pen explains is whitened as before
      const c = Engine.colourInk(w, h, rgba, 4);
      if (!c.removed && !c.convertedN) {
        let same = true;
        for (let i = 0; i < n && same; i++) if (c.gray[i] !== g[i]) same = false;
        if (same) return page;
      }
      return { w, h, gray: Float32Array.from(c.gray), colorRemoved: c.removed, colorRead: c.convertedN,
        converted: c.convertedN ? c.converted : null, bandLo: c.bandLo, bandHi: c.bandHi };
    }
    // no RGBA (cached page): fractional gray = non-neutral (sum-only law)
    for (let i = 0; i < n; i++) {
      if (g[i] >= 255) continue;
      if (g[i] !== Math.floor(g[i])) { colored[i] = 1; stack.push(i); }
    }
    if (!stack.length) return page;
    const gray = Float32Array.from(g);
    while (stack.length) {                             // flood over connected ink
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const j = ny * w + nx;
          if (!colored[j] && gray[j] < 255) { colored[j] = 1; stack.push(j); }
        }
    }
    let removed = 0;
    for (let i = 0; i < n; i++) if (colored[i]) { gray[i] = 255; removed++; }
    return { w, h, gray, colorRemoved: removed };
  }

  // entries: glyphs plus □ stand-ins for unreadable clusters, in pen order.
  // Returns per-entry text offsets so the app can build boxes at measured pens.
  //
  // How many spaces a gap is. spaceAdv is the SET's space on this page —
  // readPage calibrates one per set: a 16-px Times header and a 13-px
  // Courier body on one page have different spaces (4.0 and 7.7 px), and one
  // calibration for both wrote every Courier space as two (measured
  // 2026-09-15 on EFTA00434905 p1: 98 of 98 breaks). Within a line the unit
  // is the line's own: a justified line stretches every gap alike, so gaps
  // that agree with each other within two snaps (0.7 px between the widest
  // and the narrowest) are one space each whatever their width (48 of 315
  // breaks on a justified Times page were two or three spaces before); where
  // they do not agree, a gap counts against the line's narrowest-half median
  // (its single space) — a typist's double space after a period is twice its
  // neighbours, a stretched single is not. A lone gap has no neighbours and
  // counts against the set's space, as before.
  function lineEntries(L, spaceAdv) {
    const entries = L.glyphs.map(g => ({ ch: g.ch, pen: g.pen, adv: g.adv, score: 1 }));
    for (const col of L.fails) entries.push({ ch: '□', pen: col, adv: 8, score: 0 });
    entries.sort((a, b) => a.pen - b.pen);
    const boxes = L.boxes ?? [];
    const gaps = [];
    for (let i = 1; i < entries.length; i++) {
      const gap = entries[i].pen - (entries[i - 1].pen + entries[i - 1].adv);
      const isBox = Engine.boxBetween(boxes, entries[i - 1], entries[i]);
      gaps.push({ gap, isBox, space: !isBox && !!spaceAdv && gap > 0.55 * spaceAdv });
    }
    const widths = gaps.filter(g => g.space).map(g => g.gap).sort((a, b) => a - b);
    const uniform = widths.length >= 2 && widths[widths.length - 1] - widths[0] <= 0.7;
    const unit = widths.length >= 2 ? widths[(widths.length - 1) >> 1] : spaceAdv;
    let text = '';
    for (let i = 0; i < entries.length; i++) {
      if (i) {
        const g = gaps[i - 1];
        if (g.isBox) text += ' ';   // a redaction box: one separator, never measured spaces
        else if (g.space) text += ' '.repeat(uniform ? 1 : Math.max(1, Math.round(g.gap / unit)));
      }
      entries[i].i = text.length;
      const ch = entries[i].ch;
      text += ch === 'ﬁ' ? 'fi' : ch === 'ﬂ' ? 'fl' : ch;  // ligatures transcribe as letters
    }
    return { entries, text };
  }

  // ---- per-page driver ----
  // page: {w, h, gray} (the engine's own buffer — Float32 with integral values
  // on native gray pages; run color pages through whitenColored first).
  // opts: {tol, quant, union, progress}. progress(done, total) is called
  // between bands; the read yields to the event loop so the UI stays alive.
  async function readPage(page, sets, opts) {
    // opts.carry = cross-page layout hints for sequential whole-document
    // reads (see ocr-engine.js): certified picks keyed by BASELINE y, plus
    // the last (set, phy) and the built union pools, carried page to page.
    // Callers scope one carry per (document, pass config) — mixing pass
    // configs would smuggle e.g. a union pool into a stricter pass.
    const carry = opts?.carry;
    // union pools group by PIXEL SIZE, not into one global pool: fonts mixed
    // within a line (bold label + regular value) share their size, while a
    // global pool lets a foreign-size font byte-match glyph fragments and
    // steal pixels (a times sliver ate courier 'e's — measured on courier_1)
    if (opts?.union && sets.length > 1) {
      if (carry?.usets) sets = carry.usets;
      else {
        const bySize = new Map();
        for (const s of sets) {
          if (!bySize.has(s.sizePx)) bySize.set(s.sizePx, []);
          bySize.get(s.sizePx).push(s);
        }
        sets = [...bySize.values()].map(g => g.length > 1 ? Engine.unionSets(g) : g[0]);
        if (carry) carry.usets = sets;
      }
    }
    const { lines: kept, objects } = await Engine.readPage(page, sets,
      { tol: opts?.tol, quant: opts?.quant, shadow: opts?.shadow, carry, progress: opts?.progress });
    // one space calibration per SET on the page (a Times header and a Courier
    // body differ), the page's over every line as the fallback for a set with
    // too few gaps to cluster; each line carries the one it was shaped with
    const spaceAdv = Engine.spaceCalib(kept);
    const bySet = new Map();
    for (const L of kept) { const n = L.set?.name; if (!n) continue; if (!bySet.has(n)) bySet.set(n, []); bySet.get(n).push(L); }
    const spaceAdvBySet = {};
    for (const [n, ls] of bySet) spaceAdvBySet[n] = Engine.spaceCalib(ls) ?? spaceAdv;
    for (const L of kept) {
      L.spaceAdv = (L.set?.name && spaceAdvBySet[L.set.name]) || spaceAdv;
      const { entries, text } = lineEntries(L, L.spaceAdv);
      L.entries = entries; L.text = text;
    }
    return { lines: kept, objects, spaceAdv, spaceAdvBySet };
  }

  // ---- escalating auto-read (shared by the app and any embedder) ----
  // All BYTE-EXACT machinery first: plain per-band pick (both compositor
  // models are in the set list), palette quantization (v4/email-P1-family
  // producers palettize the final page), same-size mixed-font union pools
  // (bold label + regular value on ONE line) — and only then per-pixel
  // tolerances for producers with sub-model rounding stragglers, ±10 last
  // for near-identical renderers we haven't modelled. Keeps the fewest-
  // failures read at the earliest (weakest-machinery) pass; certificates
  // are labelled accordingly, never silently weakened.
  // {tol:2, union} is the NEW/calibri family's pass: per-page ±1-quanta
  // render state needs tol 2 AND the body line mixes sets (calibri +
  // gray-23 twin + bullets) — same-size pooling mirrors the bench's '+'.
  const blindPasses = [
    { tol: 0 }, { tol: 0, quant: true },
    { tol: 0, union: true }, { tol: 0, quant: true, union: true },
    { tol: 1 }, { tol: 2 }, { tol: 2, union: true }, { tol: 10 },
  ];

  function passLabel(pass) {
    return (pass.tol ? ` (±${pass.tol})` : '') + (pass.quant ? ' (palette)' : '') +
      (pass.union ? ' (mixed-font)' : '');
  }

  // Run the ladder on one page: { res, pass } — the fewest-failures read at
  // the earliest pass. opts: { passHint, carry, progress(pass, done, total),
  // onPass(pass, res, ms) — called after every rung that ran (tools/ladder-bench.mjs times the ladder with it) }.
  // A document's producer doesn't change page to page — pass the previous
  // page's winning pass back in as passHint to try it first. opts.carry is a
  // caller-owned per-DOCUMENT object for sequential whole-document reads
  // (cross-page baseline hints); it is scoped per pass config here so a
  // hint can never carry one pass's machinery (a union pool, a palette
  // read) into a stricter pass and weaken its certificate label.
  async function readPageAuto(page, sets, opts) {
    const key = p => `${p.tol}|${p.quant ? 1 : 0}|${p.union ? 1 : 0}`;
    const hint = opts?.passHint;
    const passes = hint ? [hint, ...blindPasses.filter(p => key(p) !== key(hint))] : blindPasses;
    const doc = opts?.carry;
    if (doc) doc.passes ??= new Map();
    // The pass that EXPLAINS THE MOST INK wins: score = glyphs read − unread
    // clusters, ties to the earliest (weakest-machinery) rung. "Fewest
    // failures" used to decide, and it preferred a page whose unreadable lines
    // stayed unread bands (one failure each) over the same page half-read at
    // a tolerant rung (a □ per gap) — EFTA00009865 p1: tol 0 read 82 glyphs
    // with 57 failures, tol 2 (union) 278 with 164, and the ladder showed the
    // 82. The ±10 rung is a last resort and only competes when no rung up to
    // ±2 read anything at all. A pass with no failures still stops the ladder.
    let best = null;
    for (const pass of passes) {
      if (pass.tol > 2 && best && best.glyphs > 0) continue;   // the last resort only when nothing read
      let carry = doc?.passes.get(key(pass));
      if (doc && !carry) doc.passes.set(key(pass), carry = {});
      const t0 = Date.now();
      const r = await readPage(page, sets, { tol: pass.tol,
        quant: pass.quant, union: pass.union, carry,
        progress: opts?.progress && ((d, t) => opts.progress(pass, d, t)) });
      if (opts?.onPass) opts.onPass(pass, r, Date.now() - t0);
      const fails = r.lines.reduce((s, L) => s + L.fails.length, 0) +
        r.lines.filter(L => !L.set && !L.fragOnly).length;
      const glyphs = r.lines.reduce((s, L) => s + L.glyphs.length, 0);
      const rank = blindPasses.findIndex(p => key(p) === key(pass));
      const score = glyphs - fails;
      const lastResort = pass.tol > 2;
      if (!best || (lastResort ? best.glyphs === 0 && glyphs > 0
                               : score > best.score || (score === best.score && rank < best.rank)))
        best = { res: r, pass, fails, glyphs, score, rank };
      if (best.fails === 0) break;                     // fully read — stop here
      // "good enough" gives up only after the strongest tol-2 machinery
      // (WITH union) ran — stopping at plain {tol:2} starved the calibri
      // family's union pass of its chance to clear the remaining □s
      if (pass.tol >= 2 && pass.union && glyphs >= fails * 8) break;
    }
    return { res: best.res, pass: best.pass };
  }

  const api = { loadSets, readPage, readPageAuto, blindPasses, passLabel, boxBetween: Engine.boxBetween,
    detectObjects: Engine.detectObjects, findBands: Engine.findBands,
    scanLine: Engine.scanLine, whitenColored, quantMap: Engine.quantMap, snapConverted: Engine.snapConverted,
    unionSets: Engine.unionSets, parseBundleDir, materializeSet };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlindOCR = api;
})(typeof self !== 'undefined' ? self : this);
