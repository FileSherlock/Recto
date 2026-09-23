// shaping.js — text measurement with HarfBuzz, in the browser.
//
// Two calls, a request object in and a response object out:
//
//   await Shaping.widths({ strings, family, bold, italic, size, scale, kerning,
//                          ligatures, force_uppercase, space_width })
//       → { results: [{ text, width, chars: [{ c, x }] }] }
//   await Shaping.widths({ strings: [text], …, mode: 'justified', block_w })
//       → { space_width }
//   await Shaping.fontMetrics({ family, bold, italic, size_px })
//       → { family, bold, italic, file, sizePx, upem, space, adv, kern, missing } | null
//
// `size` is in POINTS and `scale` is px-per-pt as a percentage (GEO.docScale());
// `family` is resolved through the font catalogue with fixed fallbacks
// (bold italic → bold → italic → regular → Times New Roman), and the
// legacy `font: 'times.ttf'` file form still works.
//
// HarfBuzz is vendor/harfbuzz (harfbuzzjs 1.6.1 = HarfBuzz 14.4.0, the version
// the goldens were recorded with). Its build leaves out the legacy `kern`
// TABLE — and the old Windows faces (Times New Roman, Arial, Georgia, …) kern
// through nothing else. applyKernTable() below does what HarfBuzz's kern
// machine does with that table, under HarfBuzz's own condition (kerning asked
// for, and no `kern` feature in GPOS for the text's script); tests/shaping.test.mjs holds the result
// to the recorded reference numbers, digit for digit.
//
// A classic script. The measuring core (ShapingCore) has no DOM in it, so the
// node tests load this very file; the browser glue at the bottom adds
// window.Shaping over the font catalogue and fetch().
(function () {
  const FALLBACK_FAMILY = 'Times New Roman';
  const STYLE_CHAIN = {
    bolditalic: ['bolditalic', 'bold', 'italic', 'regular'],
    bold: ['bold', 'regular'],
    italic: ['italic', 'regular'],
    regular: ['regular'],
  };
  const styleKey = (bold, italic) => bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'regular';

  // The characters a metrics table covers (font_metrics.py CHARS).
  const CHARS = [
    ...Array.from({ length: 0x7f - 0x21 }, (_, i) => String.fromCharCode(0x21 + i)),
    ...'‘’“”–—•…§©®°±·',
    ...'ÀÁÂÄÇÉÈÊËÍÎÏÑÓÔÖÚÛÜß',
    ...'àáâäçéèêëíîïñóôöúûüÿ',
    'ﬁ', 'ﬂ',
  ];

  // Python's round(x, 6) for a pixel size (exact ties do not occur in practice).
  const round6 = x => Number(x.toFixed(6));

  // ── the legacy kern table ────────────────────────────────────────────────

  // OpenType `kern`, version 0: horizontal format-0 subtables → one Map per
  // subtable, keyed left << 16 | right. Anything else (Apple's version 1,
  // format 2, cross-stream or minimum subtables) is left alone, as rare as it
  // is in the faces a document names.
  function parseKernTable(bytes) {
    if (!bytes || bytes.byteLength < 4) return [];
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint16(0) !== 0) return [];
    const subtables = [];
    let offset = 4;
    for (let t = 0, n = dv.getUint16(2); t < n && offset + 14 <= dv.byteLength; t++) {
      const length = dv.getUint16(offset + 2), coverage = dv.getUint16(offset + 4);
      const format = coverage >> 8, horizontal = coverage & 1, minimum = coverage & 2, crossStream = coverage & 4;
      if (format === 0 && horizontal && !minimum && !crossStream) {
        const nPairs = dv.getUint16(offset + 6), pairs = new Map();
        for (let i = 0, p = offset + 14; i < nPairs && p + 6 <= dv.byteLength; i++, p += 6)
          pairs.set(dv.getUint16(p) * 65536 + dv.getUint16(p + 2), dv.getInt16(p + 4));
        subtables.push(pairs);
      }
      if (!length) break;
      offset += length;
    }
    return subtables;
  }

  // The OpenType script HarfBuzz will shape a string in (guess_segment_properties:
  // the first character that has a script), for the scripts these faces cover.
  const SCRIPTS = [['latn', /\p{Script=Latin}/u], ['cyrl', /\p{Script=Cyrillic}/u], ['grek', /\p{Script=Greek}/u],
                   ['arab', /\p{Script=Arabic}/u], ['hebr', /\p{Script=Hebrew}/u], ['thai', /\p{Script=Thai}/u],
                   ['armn', /\p{Script=Armenian}/u]];
  function scriptOf(text) {
    for (const ch of text)
      for (const [tag, re] of SCRIPTS) if (re.test(ch)) return tag;
    return 'latn';
  }

  // Does GPOS kern this script? HarfBuzz looks the `kern` feature up in the
  // script it chose (the text's, else DFLT, dflt, latn) under the default
  // language — a face may kern Arabic through GPOS and Latin through the
  // `kern` table (Tahoma does).
  function gposKerns(hbFace, script) {
    const scripts = hbFace.getTableScriptTags('GPOS');
    const index = [script, 'DFLT', 'dflt', 'latn'].map(tag => scripts.indexOf(tag)).find(i => i >= 0);
    if (index === undefined) return false;
    return hbFace.getLanguageFeatureTags('GPOS', index, 0xFFFF).includes('kern');
  }

  const isMark = cp => /\p{M}/u.test(String.fromCodePoint(cp));

  // hb_kern_machine_t::kern — for each glyph and the next one that is not a
  // mark, the pair's value is split over the two advances: the first half
  // (kern >> 1) closes the left glyph, the rest moves the right one.
  function applyKernTable(subtables, glyphs, codePoints) {
    for (const pairs of subtables) {
      for (let i = 0; i < glyphs.length;) {
        let j = i + 1;
        while (j < glyphs.length && isMark(codePoints[glyphs[j].cluster] ?? 0)) j++;
        if (j >= glyphs.length) break;
        const kern = pairs.get(glyphs[i].gid * 65536 + glyphs[j].gid);
        if (kern) {
          const kern1 = kern >> 1;
          glyphs[i].advance += kern1;
          glyphs[j].advance += kern - kern1;
        }
        i = j;
      }
    }
  }

  // ── the shaper ───────────────────────────────────────────────────────────

  // hb        the harfbuzzjs module
  // catalogue { families: [{ family, files, present }], default } (generated/fonts.json)
  // loadFont  file name → Promise<Uint8Array | ArrayBuffer>
  function createShaper({ hb, catalogue, loadFont }) {
    const families = new Map((catalogue.families || []).map(f => [f.family.toLowerCase(), f]));
    const faces = new Map();          // file → Promise<face record>
    const metricsCache = new Map();   // file|size → table

    // fonts.resolve(): the file for (family, bold, italic), through the
    // family's styles and finally the fallback family; null when nothing fits.
    function resolve(family, bold, italic) {
      const fam = families.get((family || '').trim().toLowerCase()) || families.get(FALLBACK_FAMILY.toLowerCase());
      if (!fam) return null;
      for (const key of STYLE_CHAIN[styleKey(bold, italic)])
        if (fam.files?.[key] && fam.present?.[key]) return fam.files[key];
      return fam.family !== FALLBACK_FAMILY ? resolve(FALLBACK_FAMILY, bold, italic) : null;
    }

    // fonts.resolve_file(): the legacy `font: 'times.ttf'` form.
    function resolveFile(name) {
      if (!name) return null;
      for (const fam of families.values())
        for (const [key, file] of Object.entries(fam.files || {}))
          if (fam.present?.[key] && (file === name || file === `${name}.ttf`)) return file;
      return null;
    }

    function face(file) {
      if (!faces.has(file)) faces.set(file, (async () => {
        const data = await loadFont(file);
        const hbFace = new hb.Face(new hb.Blob(data instanceof Uint8Array ? data : new Uint8Array(data)));
        const gposKern = new Map();                     // script tag → GPOS has a kern feature for it
        return { file, hbFace, font: new hb.Font(hbFace), upem: hbFace.upem, gposKern,
                 kernTable: parseKernTable(hbFace.referenceTable('kern')), buffer: new hb.Buffer() };
      })());
      return faces.get(file);
    }

    // Shape one string: [{ gid, cluster, advance }] in font units, clusters
    // counting code points (as Python strings do).
    function shape(rec, text, { kern, ligatures = true, plain = false }) {
      const codePoints = Array.from(text, c => c.codePointAt(0));
      const features = [new hb.Feature('kern', kern ? 1 : 0)];
      if (!ligatures || plain) features.push(new hb.Feature('liga', 0), new hb.Feature('clig', 0));
      if (plain) features.push(new hb.Feature('calt', 0), new hb.Feature('dlig', 0));
      const buffer = rec.buffer;
      buffer.reset();
      buffer.addCodePoints(codePoints);
      buffer.guessSegmentProperties();
      hb.shape(rec.font, buffer, features);
      const infos = buffer.getGlyphInfos(), positions = buffer.getGlyphPositions();
      const glyphs = infos.map((info, i) => ({ gid: info.codepoint, cluster: info.cluster, advance: positions[i].xAdvance }));
      if (kern && rec.kernTable.length) {
        const script = scriptOf(text);
        if (!rec.gposKern.has(script)) rec.gposKern.set(script, gposKerns(rec.hbFace, script));
        if (!rec.gposKern.get(script)) applyKernTable(rec.kernTable, glyphs, codePoints);
      }
      return { glyphs, codePoints };
    }

    const spaceGlyph = (rec, kern) => shape(rec, ' ', { kern }).glyphs[0]?.gid ?? null;

    function facePath(request) {
      if (request.family) return resolve(request.family, !!request.bold, !!request.italic);
      return resolveFile(String(request.font || '')) || resolve(catalogue.default || FALLBACK_FAMILY, false, false);
    }

    // POST /widths
    async function widths(request) {
      const strings = request.strings || [];
      const file = facePath(request);
      const fail = error => ({ results: strings.map(text => ({ text, width: 0, error })) });
      if (!file) return request.mode === 'justified' ? { space_width: null } : fail(`Font ${request.family || request.font} not found`);

      const size = Number(request.size || 12);
      const scaleFactor = Number(request.scale || 133) / 100.0;
      const upper = !!request.force_uppercase;
      const kern = request.kerning === undefined ? true : !!request.kerning;
      const ligatures = request.ligatures === undefined ? true : !!request.ligatures;
      const spaceWidth = request.space_width == null ? null : Number(request.space_width);

      let rec;
      try { rec = await face(file); } catch (e) { return request.mode === 'justified' ? { space_width: null } : fail(String(e?.message || e)); }
      const spaceGid = spaceGlyph(rec, kern);

      if (request.mode === 'justified') {
        // the space width that makes the shaped line exactly block_w wide
        const blockW = Number(request.block_w || 0), text = strings[0] || '';
        if (!text || !(blockW > 0) || spaceGid === null) return { space_width: null };
        let other = 0.0, spaces = 0;
        for (const g of shape(rec, upper ? text.toUpperCase() : text, { kern }).glyphs) {
          if (g.gid === spaceGid) spaces += 1;
          else other += (g.advance / rec.upem) * size * scaleFactor;
        }
        return { space_width: spaces ? Math.max(0.0, (blockW - other) / spaces) : null };
      }

      const results = strings.map(text => {
        if (!text) return { text, width: 0 };
        const { glyphs, codePoints } = shape(rec, upper ? text.toUpperCase() : text, { kern, ligatures });
        let total = 0;
        const chars = [];
        for (const g of glyphs) {
          chars.push({ c: g.cluster < codePoints.length ? String.fromCodePoint(codePoints[g.cluster]) : '', x: total });
          total += (spaceWidth !== null && spaceGid !== null && g.gid === spaceGid)
            ? spaceWidth
            : (g.advance / rec.upem) * size * scaleFactor;
        }
        return { text, width: total, chars };
      });
      return { results };
    }

    // GET /font-metrics: the face's own advances and every kern pair at one
    // pixel size, ligatures off — the table a page's pens are judged against.
    async function fontMetrics({ family, bold, italic, size_px }) {
      family = family || catalogue.default || FALLBACK_FAMILY;
      bold = bold === true || bold === 1 || bold === '1';
      italic = italic === true || italic === 1 || italic === '1';
      const sizePx = round6(Number(size_px || 16));
      if (!(sizePx > 0 && sizePx <= 512)) return null;
      const file = resolve(family, bold, italic);
      if (!file) return null;

      const key = `${file}|${sizePx}`;
      if (!metricsCache.has(key)) {
        const rec = await face(file);
        const measure = (text, kern) => {
          const { glyphs } = shape(rec, text, { kern, plain: true });
          let units = 0;
          for (const g of glyphs) units += g.advance;
          return { width: units / rec.upem * sizePx, gids: glyphs.map(g => g.gid) };
        };
        const adv = {}, missing = [];
        for (const ch of CHARS) {
          const m = measure(ch, false);
          if (m.gids.length && m.gids[0] !== 0) adv[ch] = m.width; else missing.push(ch);
        }
        const kern = {}, present = Object.keys(adv);
        for (const a of present)
          for (const b of present) {
            const m = measure(a + b, true);
            if (m.gids.length !== 2) continue;      // a substitution happened despite the flags: not a plain pair
            const k = m.width - adv[a] - adv[b];
            if (Math.abs(k) > 1e-6) kern[a + b] = k;
          }
        metricsCache.set(key, { file, sizePx, upem: rec.upem, space: measure(' ', false).width, adv, kern, missing });
      }
      return { family, bold, italic, ...metricsCache.get(key) };
    }

    return { widths, fontMetrics, resolve };
  }

  globalThis.ShapingCore = { createShaper, parseKernTable, CHARS };

  // ── browser glue: window.Shaping ─────────────────────────────────────────

  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  let shaper = null;
  function ready() {
    if (!shaper) shaper = (async () => {
      const absolute = path => new URL(assetURL(path), document.baseURI).href;
      const [hb, catalogue] = await Promise.all([
        import(absolute('vendor/harfbuzz/index.mjs')),
        fetch('generated/fonts.json', { cache: 'no-cache' }).then(r => r.json()),
      ]);
      const byFile = new Map();
      for (const fam of catalogue.families || [])
        for (const [style, file] of Object.entries(fam.files || {})) byFile.set(file, fam.hashes?.[style]);
      const loadFont = async file => {
        const v = byFile.get(file);
        const r = await fetch(`${catalogue.static}${file}${v ? `?v=${v}` : ''}`);   // the URL the @font-face rule uses: one download
        if (!r.ok) throw new Error(`${file}: ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      };
      return createShaper({ hb, catalogue, loadFont });
    })();
    return shaper;
  }

  window.Shaping = {
    widths: async request => (await ready()).widths(request),
    fontMetrics: async request => (await ready()).fontMetrics(request),
  };
})();
