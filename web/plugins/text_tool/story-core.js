// story-core.js — the rich-text model behind Artistic and Frame text.
//
// A story is what Affinity calls the text of a text object: paragraphs, each
// with its paragraph attributes, made of runs of characters that share their
// character attributes. Pure data and pure functions, no DOM — the node tests
// load this very file (globalThis.StoryCore); story-render.js turns a story
// into the page's markup, story-edit.js edits it in place.
//
//   story = { paragraphs: [ { attrs: {…}, runs: [ { text, attrs: {…} } ] } ] }
//
// Attributes are stored as overrides of the defaults below: a key equal to its
// default is dropped, so a story of plain text is small and two runs compare
// by their keys. The defaults are Affinity's (see guide/frontend/text-tool.md,
// "Affinity text settings"). Positions are { p, o }: the paragraph index and
// the UTF-16 offset into that paragraph's text — the offsets a DOM text node
// speaks. A soft line break (Shift+Enter) is a U+2028 inside a paragraph.
//
// Lengths of typography are points (the canonical typography unit, GEO); the
// renderer converts them to image px once, through ctx.pxPerPt.
(function () {
  // built from its code point: the character itself ends a line in JS source
  const LINE_BREAK = String.fromCharCode(0x2028);
  const LINE_BREAKS = new RegExp(LINE_BREAK, 'g');
  const PARAGRAPH_BREAKS = new RegExp(`\\n|${String.fromCharCode(0x2029)}`);

  // ── the attributes ────────────────────────────────────────────────────────

  // Character attributes (Affinity: Character panel + Typography panel), with
  // Affinity's defaults — but for the
  // font, which follows the ribbon, and the fill, which is the colour of text
  // the user added in Recto unless chosen.
  const CHAR_DEFAULTS = {
    // Font
    fontFamily: 'Times New Roman',
    bold: false,
    italic: false,
    sizePt: 12,
    // Font Colour, Background Colour
    color: null,              // CSS colour; null = the box type's colour
    opacity: 100,             // %
    highlight: null,          // Background Colour (behind the glyphs); null = none
    // Position & Transform
    autoKern: true,           // Kerning "Auto": the font's GPOS kern or its kern table
    manualKern: 0,            // Kerning "Manual": ‰ of an em after each character
    tracking: 0,              // ‰ of an em after every character
    baselineShift: 0,         // pt, up
    leadingOverride: null,    // pt; null = Auto (the paragraph's leading)
    shear: 0,                 // degrees, positive leans right (±85)
    scaleX: 100,              // Horizontal Scale %
    scaleY: 100,              // Vertical Scale %
    position: 'normal',       // Super/Subscript: POSITIONS (synthesised: 58.3 %, ±33.3 % of the size)
    noBreak: false,
    // Decorations: type and colour (geometry from the font, as Affinity)
    underline: 'none',        // LINE_STYLES
    underlineColor: null,     // null = the text colour
    strike: 'none',
    strikeColor: null,
    strokeColor: null,        // Outline Stroke; null = none
    strokeWidth: 0,           // pt
    // Typography: capitals (CAPS) and the OpenType features
    caps: 'none',
    ot_liga: true,            // standard ligatures
    ot_clig: true,            // contextual ligatures
    ot_calt: true,            // contextual alternates
    ot_dlig: false,           // discretionary ligatures
    ot_hlig: false,           // historical ligatures
    ot_salt: false,           // stylistic alternates
    ot_swsh: false,           // swash
    ot_cswh: false,           // contextual swash
    ot_titl: false,           // titling alternates
    ot_case: false,           // case-sensitive forms
    ot_cpsp: false,           // capital spacing
    ot_zero: false,           // slashed zero
    ot_frac: false,           // fractions
    ot_ordn: false,           // ordinals
    ot_hist: false,           // historical forms
    ot_ornm: false,           // ornaments
    ot_numForm: 'default',    // Figure style: 'default' | 'lnum' | 'onum'
    ot_numSpacing: 'default', // Figure width: 'default' | 'pnum' | 'tnum'
    ot_position: 'normal',    // Figure position: OT_POSITIONS (the font's own glyphs)
    ot_ss: 0,                 // bit mask of stylistic sets 1–20 (bit 0 = ss01)
    // Language (spelling and hyphenation; the script and language shaping use)
    lang: '',                 // BCP 47; '' = the default
  };

  // Affinity's caps modes: None, Caps to small caps (c2sc), Small caps
  // (smcp), All caps (always synthesised: upper case), All small caps
  // (smcp + c2sc), Caps to petite caps (c2pc), Petite caps (pcap), All petite
  // caps, Titling (titl), Unicase (unic). Small caps and caps to small caps
  // are synthesised when the font lacks them, all small caps when it has
  // neither feature; the rest come from the font only.
  const CAPS = ['none', 'c2sc', 'small', 'all', 'allSmall', 'c2pc', 'petite', 'allPetite', 'titling', 'unicase'];
  const POSITIONS = ['normal', 'super', 'sub'];
  const OT_POSITIONS = ['normal', 'sups', 'subs', 'numr', 'dnom', 'sinf'];
  const LINE_STYLES = ['none', 'single', 'double'];

  // Paragraph attributes (Affinity: Paragraph panel), Affinity's defaults.
  const PARA_DEFAULTS = {
    align: 'left',            // ALIGNS
    // Spacing
    leadingType: 'default',   // LEADINGS
    leading: 0,               // × for 'multiple', % of the size for 'percent', pt for 'atLeast' / 'exact'
    leftIndent: 0,            // pt
    rightIndent: 0,           // pt
    firstIndent: 0,           // pt, the first line (negative = hanging)
    spaceBefore: 0,           // pt
    spaceAfter: 0,            // pt
    spaceBeforeMode: 'between', // Use space before: 'between' (only between paragraphs) | 'columnTop' | 'always'
    sumSpacing: false,        // space after + the next space before, instead of the larger
    // Justification (% of the font's space)
    wordSpacingMin: 80,
    wordSpacing: 100,
    wordSpacingMax: 133,
    letterSpacingMin: 0,
    letterSpacing: 0,
    letterSpacingMax: 0,
    // Hyphenation
    hyphenate: false,
    hyphMinWord: 5,           // characters
    hyphMinBefore: 2,
    hyphMinAfter: 2,
    hyphMaxLines: 0,          // consecutive hyphenated lines, 0 = no limit
    // Flow options
    startAt: 'anywhere',      // 'anywhere' | 'column' (In Next Column / In Next Frame)
    keepWithPrevious: false,
    keepWithNext: false,
    keepTogether: false,
    preventWidows: false,
    preventOrphans: false,
    // Tab stops
    defaultTabs: 36,          // pt between the default tab stops
    tabs: [],                 // [{ pos: pt, align: TAB_ALIGNS, leader: '' }]
    // Bullets and numbering
    list: 'none',             // LISTS
    listChar: '•',
    listStart: 0,             // 0 = continue the previous list paragraph's count
    listSuffix: '.',          // after a number
    listIndent: 18,           // pt between the marker and the text
    // Drop caps (Affinity: off; when on, 3 lines, 1 character, distance 0)
    dropLines: 0,             // 0 = no drop cap
    dropChars: 1,
    dropDistance: 0,          // pt between the drop cap and the text
    // Decorations
    fill: null,               // CSS colour behind the paragraph
    ruleAbove: false,
    ruleBelow: false,
    ruleColor: '#000000',
    ruleWeight: 0.5,          // pt
  };

  // Towards / away from spine: a PDF page read on its own is a right-hand
  // page, its spine on the left — towards it is left, away from it right.
  const ALIGNS = ['left', 'center', 'right', 'justify-left', 'justify-center', 'justify-right', 'justify-all', 'towards-spine', 'away-spine'];
  // Affinity's Paragraph Leading: Default, Multiple, % Height, At Least, Exactly
  const LEADINGS = ['default', 'multiple', 'percent', 'atLeast', 'exact'];
  const LISTS = ['none', 'bullet', 'decimal', 'decimal-2', 'decimal-3', 'decimal-4', 'upper-roman', 'lower-roman', 'upper-alpha', 'lower-alpha'];
  const TAB_ALIGNS = ['left', 'center', 'right', 'decimal'];

  // Text-frame attributes (Affinity: Text Frame panel) — one set per box. A
  // new Affinity frame has them all at zero: one column, no insets, Top,
  // Default initial advance, no column rule.
  const FRAME_DEFAULTS = {
    // General
    fill: null,               // CSS colour of the frame
    stroke: null,             // CSS colour of its outline
    strokeWidth: 0,           // pt
    insetLeft: 0,             // pt
    insetRight: 0,
    insetTop: 0,
    insetBottom: 0,
    linkInsets: true,         // the panel sets all four together
    hideOverflow: true,       // text that does not fit is not shown (the red marker says it is there)
    // Columns
    columns: 1,
    gutter: 0,                // pt between columns (Affinity's default gutter width)
    balance: false,           // Balance text in columns
    // Column rules
    ruleColor: null,          // null = none
    ruleWeight: 0.5,          // pt
    ruleStyle: 'solid',       // 'solid' | 'dashed' | 'dotted'
    ruleTop: 0,               // pt the rule stops short of the top
    ruleBottom: 0,            // … and of the bottom
    // Vertical position
    valign: 'top',            // VALIGNS
    maxParaSpace: 0,          // pt: Justify gives paragraph gaps up to this first
    baseline: 'default',      // BASELINES — Affinity's Initial advance
    baselineMin: 0,           // pt: Minimum — the first baseline is never higher
    // Recto: the frame's height follows its text (Affinity has no such switch)
    autoHeight: false,
  };

  const VALIGNS = ['top', 'center', 'bottom', 'justify'];
  const BASELINES = ['default', 'leading', 'pointsize', 'ascent', 'cap', 'x', 'fixed'];

  // ── attribute sets ────────────────────────────────────────────────────────

  const isObj = v => v !== null && typeof v === 'object';
  const copy = v => (isObj(v) ? JSON.parse(JSON.stringify(v)) : v);
  const same = (a, b) => a === b || (isObj(a) && isObj(b) && JSON.stringify(a) === JSON.stringify(b));

  // The overrides of `attrs` against `defaults`: unknown keys, undefined
  // values and values equal to their default are dropped.
  function clean(attrs, defaults) {
    const out = {};
    for (const k of Object.keys(attrs || {}).sort()) {
      const v = attrs[k];
      if (v === undefined || !(k in defaults) || same(v, defaults[k])) continue;
      out[k] = copy(v);
    }
    return out;
  }
  function sameAttrs(a, b) {
    const ka = Object.keys(a || {}), kb = Object.keys(b || {});
    return ka.length === kb.length && ka.every(k => same(a[k], b?.[k]));
  }
  const charOf = attrs => ({ ...CHAR_DEFAULTS, ...attrs });
  const paraOf = attrs => ({ ...PARA_DEFAULTS, ...attrs });
  const frameOf = attrs => ({ ...FRAME_DEFAULTS, ...attrs });

  // ── stories ───────────────────────────────────────────────────────────────

  // Plain text into a story: a line feed is a new paragraph (Affinity's
  // Enter), U+2028 a line break inside one.
  function fromText(text = '', charAttrs = {}, paraAttrs = {}) {
    const ca = clean(charAttrs, CHAR_DEFAULTS), pa = clean(paraAttrs, PARA_DEFAULTS);
    const paragraphs = String(text).replace(/\r\n?/g, '\n').split(PARAGRAPH_BREAKS)
      .map(t => ({ attrs: { ...pa }, runs: [{ text: t, attrs: { ...ca } }] }));
    return { paragraphs };
  }

  const paraText = para => para.runs.map(r => r.text).join('');
  const paraLength = para => para.runs.reduce((n, r) => n + r.text.length, 0);
  // The story as plain text — paragraphs and line breaks both as '\n' (what
  // box.text carries for everyone who reads a box's text).
  const toText = story => story.paragraphs.map(paraText).join('\n').replace(LINE_BREAKS, '\n');

  function clone(story) {
    return { paragraphs: story.paragraphs.map(p => ({ attrs: copy(p.attrs), runs: p.runs.map(r => ({ text: r.text, attrs: copy(r.attrs) })) })) };
  }

  // Adjacent runs with the same attributes merge, empty runs go — except the
  // one an empty paragraph keeps: its attributes are what the caret types in.
  function normalizePara(para) {
    const runs = [];
    for (const r of para.runs) {
      if (!r.text) continue;
      const attrs = clean(r.attrs, CHAR_DEFAULTS), last = runs[runs.length - 1];
      if (last && sameAttrs(last.attrs, attrs)) last.text += r.text;
      else runs.push({ text: r.text, attrs });
    }
    if (!runs.length) runs.push({ text: '', attrs: clean(para.runs[0]?.attrs, CHAR_DEFAULTS) });
    return { attrs: clean(para.attrs, PARA_DEFAULTS), runs };
  }
  function normalize(story) {
    const paragraphs = (story?.paragraphs || []).map(normalizePara);
    if (!paragraphs.length) paragraphs.push({ attrs: {}, runs: [{ text: '', attrs: {} }] });
    return { paragraphs };
  }

  // ── positions ─────────────────────────────────────────────────────────────

  const cmp = (a, b) => a.p - b.p || a.o - b.o;
  const ordered = r => (cmp(r.start, r.end) <= 0 ? r : { start: r.end, end: r.start });
  const collapsed = r => !cmp(r.start, r.end);
  const startPos = () => ({ p: 0, o: 0 });
  const endPos = story => ({ p: story.paragraphs.length - 1, o: paraLength(story.paragraphs[story.paragraphs.length - 1]) });
  const whole = story => ({ start: startPos(story), end: endPos(story) });
  function clampPos(story, pos) {
    const p = Math.max(0, Math.min(story.paragraphs.length - 1, pos?.p | 0));
    return { p, o: Math.max(0, Math.min(paraLength(story.paragraphs[p]), pos?.o | 0)) };
  }
  const isWhole = (story, r) => !cmp(ordered(r).start, startPos(story)) && !cmp(ordered(r).end, endPos(story));

  // Split the run under offset o so that a run starts there; the index of
  // that run (runs.length when o is the paragraph's end).
  function splitAt(para, o) {
    let at = 0;
    for (let i = 0; i < para.runs.length; i++) {
      const r = para.runs[i];
      if (o === at) return i;
      if (o < at + r.text.length) {
        para.runs.splice(i, 1, { text: r.text.slice(0, o - at), attrs: copy(r.attrs) },
          { text: r.text.slice(o - at), attrs: copy(r.attrs) });
        return i + 1;
      }
      at += r.text.length;
    }
    return para.runs.length;
  }

  // The stored attributes the caret at `o` types with: those of the character
  // before it — or after it at the start of a paragraph (Affinity's rule).
  function runAttrsAt(para, o) {
    let at = 0;
    for (const r of para.runs) {
      if (r.text.length && o > at && o <= at + r.text.length) return copy(r.attrs);
      at += r.text.length;
    }
    return copy((para.runs.find(r => r.text.length) || para.runs[0])?.attrs || {});
  }

  // ── reading attributes ────────────────────────────────────────────────────

  // The effective attributes over a range, and which keys are mixed in it
  // (the panels show those as blank). A collapsed range reads the caret's.
  function charSummary(story, range) {
    const r = ordered(range || whole(story));
    if (collapsed(r)) return { attrs: charOf(runAttrsAt(story.paragraphs[r.start.p], r.start.o)), mixed: [] };
    let first = null;
    const mixed = new Set();
    for (let p = r.start.p; p <= r.end.p; p++) {
      const para = story.paragraphs[p];
      const o0 = p === r.start.p ? r.start.o : 0, o1 = p === r.end.p ? r.end.o : paraLength(para);
      let at = 0;
      for (const run of para.runs) {
        const a = at, b = at + run.text.length;
        at = b;
        if (!(b > o0 && a < o1) && !(paraLength(para) === 0 && o0 === 0)) continue;
        const eff = charOf(run.attrs);
        if (!first) { first = eff; continue; }
        for (const k of Object.keys(CHAR_DEFAULTS)) if (!same(first[k], eff[k])) mixed.add(k);
      }
    }
    return { attrs: first || charOf(runAttrsAt(story.paragraphs[r.start.p], r.start.o)), mixed: [...mixed] };
  }
  function paraSummary(story, range) {
    const r = ordered(range || whole(story));
    const first = paraOf(story.paragraphs[r.start.p].attrs), mixed = new Set();
    for (let p = r.start.p + 1; p <= r.end.p; p++) {
      const eff = paraOf(story.paragraphs[p].attrs);
      for (const k of Object.keys(PARA_DEFAULTS)) if (!same(first[k], eff[k])) mixed.add(k);
    }
    return { attrs: first, mixed: [...mixed] };
  }

  // ── changing attributes ───────────────────────────────────────────────────

  // Character attributes onto a range (null = the whole story, empty
  // paragraphs included — what applying to a selected text object means).
  function applyChar(story, range, patch) {
    const s = clone(story);
    const all = !range || isWhole(s, range);
    const r = ordered(range || whole(s));
    for (let p = r.start.p; p <= r.end.p; p++) {
      const para = s.paragraphs[p];
      if (all) { for (const run of para.runs) run.attrs = { ...run.attrs, ...patch }; continue; }
      const o0 = p === r.start.p ? r.start.o : 0, o1 = p === r.end.p ? r.end.o : paraLength(para);
      if (o0 === o1) continue;
      const i0 = splitAt(para, o0), i1 = splitAt(para, o1);
      for (let i = i0; i < i1; i++) para.runs[i].attrs = { ...para.runs[i].attrs, ...patch };
    }
    return normalize(s);
  }

  // A patch per run, computed from its effective attributes (`fn(attrs)` →
  // patch): what changes each run by its own value — a size step, a scale.
  function mapChar(story, range, fn) {
    const s = clone(story);
    const all = !range || isWhole(s, range);
    const r = ordered(range || whole(s));
    for (let p = r.start.p; p <= r.end.p; p++) {
      const para = s.paragraphs[p];
      let i0 = 0, i1 = para.runs.length;
      if (!all) {
        const o0 = p === r.start.p ? r.start.o : 0, o1 = p === r.end.p ? r.end.o : paraLength(para);
        if (o0 === o1) continue;
        i0 = splitAt(para, o0); i1 = splitAt(para, o1);
      }
      for (let i = i0; i < i1; i++) para.runs[i].attrs = { ...para.runs[i].attrs, ...fn(charOf(para.runs[i].attrs)) };
    }
    return normalize(s);
  }

  // Paragraph attributes onto every paragraph a range touches.
  function applyPara(story, range, patch) {
    const s = clone(story);
    const r = ordered(range || whole(s));
    for (let p = r.start.p; p <= r.end.p; p++) s.paragraphs[p].attrs = { ...s.paragraphs[p].attrs, ...patch };
    return normalize(s);
  }

  // ── editing ───────────────────────────────────────────────────────────────

  // Remove a range; the paragraphs it spans join (the first one's attributes
  // stay, as in Affinity). → { story, pos }
  function deleteRange(story, range) {
    const s = clone(story);
    const { start, end } = ordered(range);
    if (collapsed({ start, end })) return { story: normalize(s), pos: clampPos(s, start) };
    const pa = s.paragraphs[start.p], pb = s.paragraphs[end.p];
    const keepAttrs = runAttrsAt(pa, start.o);
    const ia = splitAt(pa, start.o);
    const head = pa.runs.slice(0, ia);
    const ib = splitAt(pb, end.o);
    const tail = pb.runs.slice(ib);
    const runs = [...head, ...tail];
    if (!runs.some(r => r.text)) runs.splice(0, runs.length, { text: '', attrs: keepAttrs });
    s.paragraphs.splice(start.p, end.p - start.p + 1, { attrs: pa.attrs, runs });
    return { story: normalize(s), pos: { p: start.p, o: start.o } };
  }

  // Insert text at a position: '\n' starts a new paragraph (it takes the
  // current one's attributes), U+2028 is a line break. `attrs` are the stored
  // character attributes of the new text; null = the caret's. → { story, pos }
  function insertText(story, pos, text, attrs = null) {
    const s = clone(story);
    const at = clampPos(s, pos);
    const para = s.paragraphs[at.p];
    const a = attrs ? clean(attrs, CHAR_DEFAULTS) : runAttrsAt(para, at.o);
    const chunks = String(text).replace(/\r\n?/g, '\n').split('\n');
    const i = splitAt(para, at.o);
    const tail = para.runs.splice(i);
    para.runs.push({ text: chunks[0], attrs: copy(a) });
    let p = at.p, o = at.o + chunks[0].length;
    for (let k = 1; k < chunks.length; k++) {
      s.paragraphs.splice(++p, 0, { attrs: copy(para.attrs), runs: [{ text: chunks[k], attrs: copy(a) }] });
      o = chunks[k].length;
    }
    s.paragraphs[p].runs.push(...tail);
    return { story: normalize(s), pos: { p, o } };
  }

  // Replace a range with text (typing over a selection). → { story, pos }
  function replaceRange(story, range, text, attrs = null) {
    const r = ordered(range);
    const typing = attrs || runAttrsAt(story.paragraphs[r.start.p], collapsed(r) ? r.start.o : r.start.o + 1);
    const d = deleteRange(story, r);
    return insertText(d.story, d.pos, text, typing);
  }

  // A sub-story: the range's paragraphs and runs (copy / cut).
  function slice(story, range) {
    const r = ordered(range);
    const s = clone(story);
    const out = [];
    for (let p = r.start.p; p <= r.end.p; p++) {
      const para = s.paragraphs[p];
      const o0 = p === r.start.p ? r.start.o : 0, o1 = p === r.end.p ? r.end.o : paraLength(para);
      const i0 = splitAt(para, o0), i1 = splitAt(para, o1);
      out.push({ attrs: copy(para.attrs), runs: para.runs.slice(i0, i1) });
    }
    return normalize({ paragraphs: out });
  }

  // Affinity's Change Case: 'upper' | 'lower' | 'sentence' | 'title' over a
  // range (null = all). The text is rewritten, its runs keep their
  // attributes; a character whose case mapping would change the length (ß →
  // SS) stays as it is, so every offset — the runs, the selection — holds.
  const TITLE_SMALL = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'as', 'at', 'by',
    'in', 'of', 'off', 'on', 'per', 'to', 'up', 'via', 'vs']);
  function caseMapped(text, mode) {
    const one = (c, up) => { const m = up ? c.toUpperCase() : c.toLowerCase(); return m.length === c.length ? m : c; };
    if (mode === 'upper' || mode === 'lower') return Array.from(text, c => one(c, mode === 'upper')).join('');
    const lower = Array.from(text, c => one(c, false));
    if (mode === 'sentence') {
      let start = true;
      return lower.map(c => {
        if (/\p{L}/u.test(c)) { const out = start ? one(c, true) : c; start = false; return out; }
        if (/[.!?]/.test(c)) start = true;
        return c;
      }).join('');
    }
    // title case: every word capitalised but the small ones inside a sentence
    const s = lower.join('');
    const words = [...s.matchAll(/[\p{L}\p{N}'’]+/gu)];
    const out = lower.slice();
    words.forEach((w, i) => {
      const firstOrLast = i === 0 || i === words.length - 1 || /[.!?:]\s*$/.test(s.slice(0, w.index));
      if (firstOrLast || !TITLE_SMALL.has(w[0])) out[w.index] = one(out[w.index], true);
    });
    return out.join('');
  }
  function changeCase(story, range, mode) {
    const s = clone(story);
    const r = ordered(range || whole(s));
    for (let p = r.start.p; p <= r.end.p; p++) {
      const para = s.paragraphs[p];
      const text = paraText(para);
      const o0 = p === r.start.p ? r.start.o : 0, o1 = p === r.end.p ? r.end.o : text.length;
      if (o0 >= o1) continue;
      // the paragraph's text with the range mapped (sentence and title case
      // read their context from the whole paragraph)
      const mapped = caseMapped(text, mode);
      const next = text.slice(0, o0) + mapped.slice(o0, o1) + text.slice(o1);
      let at = 0;
      for (const run of para.runs) { run.text = next.slice(at, at + run.text.length); at += run.text.length; }
    }
    return normalize(s);
  }

  // Word boundaries for double-click / Ctrl+arrows: the word around offset o.
  function wordAt(story, pos) {
    const text = paraText(story.paragraphs[pos.p]);
    const isWord = c => /[\p{L}\p{N}_'’-]/u.test(c);
    let a = pos.o, b = pos.o;
    while (a > 0 && isWord(text[a - 1])) a--;
    while (b < text.length && isWord(text[b])) b++;
    return { start: { p: pos.p, o: a }, end: { p: pos.p, o: b } };
  }

  // ── list markers ──────────────────────────────────────────────────────────

  function roman(n) {
    const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
    let out = '';
    for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
    return out;
  }
  function alpha(n) {
    let out = '';
    while (n > 0) { n--; out = String.fromCharCode(97 + (n % 26)) + out; n = Math.floor(n / 26); }
    return out;
  }
  // The marker of every paragraph ('' for none). A numbered paragraph counts
  // on from the previous numbered one of the same kind unless it sets
  // listStart; any other paragraph between them ends the list.
  function listMarkers(story) {
    let kind = null, n = 0;
    return story.paragraphs.map(para => {
      const a = paraOf(para.attrs);
      if (a.list === 'none') { kind = null; n = 0; return ''; }
      if (a.list === 'bullet') { kind = null; n = 0; return a.listChar || '•'; }
      n = a.listStart > 0 ? a.listStart : (kind === a.list ? n + 1 : 1);
      kind = a.list;
      const num = a.list === 'decimal' ? String(n)
        : a.list.startsWith('decimal-') ? String(n).padStart(+a.list.slice(8), '0')
        : a.list === 'lower-alpha' ? alpha(n) : a.list === 'upper-alpha' ? alpha(n).toUpperCase()
        : a.list === 'lower-roman' ? roman(n) : roman(n).toUpperCase();
      return num + (a.listSuffix ?? '');
    });
  }

  // ── font metrics ──────────────────────────────────────────────────────────

  // The metrics Affinity sets text with, from a face record
  // (Shaping.faceMetrics, font units) scaled to a size in px. Each falls back
  // as Affinity's do when the face does not say:
  //   idealLeading  (hhea ascender − descender + max(0, line gap)) / em; 1.1 without hhea
  //   capHeight     the top of 'H'; 0.7 em      xHeight   the top of 'x'; 0.5 em
  //   typoAscent    max(top of 'l', cap height) — the Default initial advance
  //   underline     post's position (its top below the baseline) and thickness;
  //                 0.1 / 0.05 em; a thickness ≤ 0 is 0.05 em
  //   strikeout     OS/2's position (above) and size; 0.2 / 0.05 em
  //   smallCaps     OS/2 xHeight / capHeight; 0.5 / 0.7 ≈ 0.714
  // A face not known yet gets those fallbacks, and the renderer draws again
  // when its metrics arrive.
  function scaledMetrics(m, sizePx) {
    const u = m?.upem || 1000;
    const em = v => v / u * sizePx;
    const ok = v => Number.isFinite(v) && v !== 0;
    const hhea = m && Number.isFinite(m.hheaAscender) && Number.isFinite(m.hheaDescender);
    const ascender = hhea ? em(m.hheaAscender) : Number.isFinite(m?.ascender) ? em(m.ascender) : 0.75 * sizePx;
    const descender = hhea ? em(m.hheaDescender) : Number.isFinite(m?.descender) ? em(m.descender) : -0.25 * sizePx;
    const lineGap = hhea ? em(Math.max(0, m.hheaLineGap || 0)) : 0;
    const capHeight = ok(m?.topH) ? em(m.topH) : ok(m?.capHeight) ? em(m.capHeight) : 0.7 * sizePx;
    const xHeight = ok(m?.topX) ? em(m.topX) : ok(m?.xHeight) ? em(m.xHeight) : 0.5 * sizePx;
    // a post table of zeros (some CFF faces keep their underline in CFF) says nothing
    const post = m && (ok(m.postUnderlinePosition) || ok(m.postUnderlineThickness));
    const strike = m && (ok(m.os2StrikeoutPosition) || ok(m.os2StrikeoutSize));
    return {
      ascender, descender, lineGap,
      idealLeading: hhea ? ascender - descender + lineGap : 1.1 * sizePx,
      capHeight, xHeight,
      typoAscent: Math.max(ok(m?.topL) ? em(m.topL) : 0, capHeight),
      space: Number.isFinite(m?.space) ? em(m.space) : 0.25 * sizePx,
      underlinePos: post ? em(-m.postUnderlinePosition) : 0.1 * sizePx,         // its top, below the baseline
      underlineSize: post && m.postUnderlineThickness > 0 ? em(m.postUnderlineThickness) : 0.05 * sizePx,
      strikePos: strike ? em(m.os2StrikeoutPosition) : 0.2 * sizePx,           // above the baseline
      strikeSize: strike && m.os2StrikeoutSize > 0 ? em(m.os2StrikeoutSize) : 0.05 * sizePx,
      smallCaps: ok(m?.os2XHeight) && ok(m?.os2CapHeight) ? m.os2XHeight / m.os2CapHeight : 0.5 / 0.7,
      features: m?.features || null,
    };
  }

  // The leading of a run, in px, as Affinity takes it: a Leading
  // Override is the run's own; else the paragraph's — Default the face's
  // ideal leading, Multiple that times the value, % Height the value in % of
  // the size, Exactly the value, At Least the larger of ideal and value. A
  // line takes the largest leading of its runs.
  const naturalLeading = m => m.idealLeading;
  function leadingPx(pa, a, m, pxPerPt) {
    if (a.leadingOverride != null) return a.leadingOverride * pxPerPt;
    const size = a.sizePt * pxPerPt;
    switch (pa.leadingType) {
      case 'multiple': return m.idealLeading * (pa.leading > 0 ? pa.leading : 1);
      case 'percent': return size * (pa.leading > 0 ? pa.leading : 100) / 100;
      case 'atLeast': return Math.max(m.idealLeading, (pa.leading || 0) * pxPerPt);
      case 'exact': return (pa.leading || 0) * pxPerPt || m.idealLeading;
      default: return m.idealLeading;
    }
  }
  // Leading that follows each run (all but Exactly): every run brings its
  // line height, and the line takes its largest.
  const leadingPerRun = pa => pa.leadingType !== 'exact';

  // Affinity's Initial advance: the first baseline sits max(metric, Minimum)
  // below the top of the frame's inner box.
  // Default is the typographic ascent (max of the top of 'l' and the cap
  // height), Ascent the face's ascender, Pointsize the size, Leading the
  // line's leading; Fixed is 0 — the baseline at Minimum.
  function firstBaselinePx(frame, a, m, leading, pxPerPt) {
    const metric = {
      default: m.typoAscent, leading, pointsize: a.sizePt * pxPerPt,
      ascent: m.ascender, cap: m.capHeight, x: m.xHeight, fixed: 0,
    }[frame.baseline] ?? m.typoAscent;
    return Math.max(metric, (frame.baselineMin || 0) * pxPerPt);
  }

  // ── capitals ──────────────────────────────────────────────────────────────

  // What the caps mode of a run needs: the OpenType features the font will
  // apply, and what Recto must synthesise as Affinity does when the font
  // lacks them — 'lower' (lower case drawn as small capitals), 'upper'
  // (capitals drawn as small capitals) or both. `features` the face's list
  // (null while unknown: the font is trusted).
  function capsPlan(caps, features) {
    const has = tag => !features || features.includes(tag);
    switch (caps) {
      case 'small': return has('smcp') ? { tags: ['smcp'], synth: [] } : { tags: [], synth: ['lower'] };
      case 'c2sc': return has('c2sc') ? { tags: ['c2sc'], synth: [] } : { tags: [], synth: ['upper'] };
      case 'allSmall':
        if (!has('smcp') && !has('c2sc')) return { tags: [], synth: ['lower', 'upper'] };
        return { tags: ['smcp', 'c2sc'].filter(has), synth: [] };
      case 'c2pc': return { tags: ['c2pc'], synth: [] };
      case 'petite': return { tags: ['pcap'], synth: [] };
      case 'allPetite': return { tags: ['pcap', 'c2pc'], synth: [] };
      case 'titling': return { tags: ['titl'], synth: [] };
      case 'unicase': return { tags: ['unic'], synth: [] };
      default: return { tags: [], synth: [] };
    }
  }

  // ── CSS ───────────────────────────────────────────────────────────────────

  // font-feature-settings for the Typography attributes: only what differs
  // from the font's defaults is named, so a face keeps everything else.
  function featureSettings(a, features = null) {
    const f = [];
    const flag = (tag, on, dflt) => { if (on !== dflt) f.push(`"${tag}" ${on ? 1 : 0}`); };
    flag('liga', a.ot_liga, true); flag('clig', a.ot_clig, true); flag('calt', a.ot_calt, true);
    flag('dlig', a.ot_dlig, false); flag('hlig', a.ot_hlig, false); flag('salt', a.ot_salt, false);
    flag('swsh', a.ot_swsh, false); flag('cswh', a.ot_cswh, false); flag('titl', a.ot_titl, false);
    flag('case', a.ot_case, false); flag('cpsp', a.ot_cpsp, false); flag('zero', a.ot_zero, false);
    flag('frac', a.ot_frac, false); flag('ordn', a.ot_ordn, false); flag('hist', a.ot_hist, false);
    flag('ornm', a.ot_ornm, false);
    if (a.ot_numForm === 'lnum' || a.ot_numForm === 'onum') f.push(`"${a.ot_numForm}" 1`);
    if (a.ot_numSpacing === 'pnum' || a.ot_numSpacing === 'tnum') f.push(`"${a.ot_numSpacing}" 1`);
    if (OT_POSITIONS.includes(a.ot_position) && a.ot_position !== 'normal') f.push(`"${a.ot_position}" 1`);
    for (let i = 0; i < 20; i++) if (a.ot_ss & (1 << i)) f.push(`"ss${String(i + 1).padStart(2, '0')}" 1`);
    for (const tag of capsPlan(a.caps, features).tags) if (!f.some(s => s.startsWith(`"${tag}"`))) f.push(`"${tag}" 1`);
    if (!a.autoKern) f.push('"kern" 0');
    return f.join(', ');
  }

  // The CSS of a run: `a` its effective character attributes, `pa` its
  // paragraph's, `m` the face's scaled metrics (scaledMetrics), ctx
  // { pxPerPt, defaultColor }. Returns a plain { property: value } object.
  function runCSS(a, pa, m, ctx) {
    const px = v => `${+v.toFixed(4)}px`;
    const size = a.sizePt * ctx.pxPerPt;
    const css = {
      'font-family': `"${a.fontFamily}", "Times New Roman", serif`,
      'font-size': px(size),
      'font-weight': a.bold ? '700' : '400',
      'font-style': a.italic ? 'italic' : 'normal',
      'font-kerning': a.autoKern ? 'normal' : 'none',
      'font-synthesis': 'weight style',      // bold and italic as before; small caps and super/subscript are Recto's own
      'color': a.color || ctx.defaultColor || '#000',
    };
    if (a.opacity < 100) css.color = `color-mix(in srgb, ${css.color} ${Math.max(0, a.opacity)}%, transparent)`;
    const features = featureSettings(a, m.features);
    if (features) css['font-feature-settings'] = features;
    if (a.caps === 'all') css['text-transform'] = 'uppercase';

    // spacing after each glyph: tracking and manual kerning in ‰ of an em,
    // the justification's desired letter spacing in % of the space
    const em = ((a.tracking || 0) + (a.manualKern || 0)) / 1000;
    const extra = (pa.letterSpacing || 0) / 100 * m.space;
    if (em || extra) css['letter-spacing'] = extra ? `calc(${em}em + ${px(extra)})` : `${em}em`;
    if (pa.wordSpacing !== 100) css['word-spacing'] = px((pa.wordSpacing - 100) / 100 * m.space);

    // Super/Subscript: Affinity synthesises them — 58.3 % of the size, the
    // baseline 33.3 % of the size up or down — from every font alike
    let shift = (a.baselineShift || 0) * ctx.pxPerPt;
    if (a.position === 'super' || a.position === 'sub') {
      css['font-size'] = px(size * 0.583);
      shift += (a.position === 'super' ? 1 : -1) * 0.333 * size;
    }
    if (shift) { css.position = 'relative'; css.top = px(-shift); }

    // decorations: the type and colour are the run's, where and how thick
    // the font says (post's underline, OS/2's strikeout)
    const lines = [];
    if (a.underline !== 'none') lines.push('underline');
    if (a.strike !== 'none' && (a.underline === 'none' || sameDecoration(a))) lines.push('line-through');
    if (lines.length) {
      css['text-decoration-line'] = lines.join(' ');
      css['text-decoration-style'] = (a.underline !== 'none' ? a.underline : a.strike) === 'double' ? 'double' : 'solid';
      const color = a.underline !== 'none' ? a.underlineColor : a.strikeColor;
      if (color) css['text-decoration-color'] = color;
      css['text-decoration-thickness'] = px(a.underline !== 'none' ? m.underlineSize : m.strikeSize);
      if (a.underline !== 'none') css['text-underline-offset'] = px(m.underlinePos);
      css['text-decoration-skip-ink'] = 'none';
    }
    if (a.strokeColor && a.strokeWidth > 0) {
      css['-webkit-text-stroke'] = `${px(a.strokeWidth * ctx.pxPerPt)} ${a.strokeColor}`;
      css['paint-order'] = 'stroke fill';
    }
    if (a.highlight) { css['background-color'] = a.highlight; css['box-decoration-break'] = 'clone'; }
    if (a.noBreak) css['white-space'] = 'nowrap';
    if (a.leadingOverride != null) css['line-height'] = px(a.leadingOverride * ctx.pxPerPt);
    return css;
  }
  // underline and strikethrough share one CSS decoration only when they look alike
  const sameDecoration = a => a.underline === a.strike && a.underlineColor === a.strikeColor;
  // A strikethrough that must be drawn by an inner element of its own
  function strikeCSS(a, m) {
    if (a.strike === 'none' || a.underline === 'none' || sameDecoration(a)) return null;
    const css = {
      'text-decoration-line': 'line-through',
      'text-decoration-style': a.strike === 'double' ? 'double' : 'solid',
      'text-decoration-thickness': `${+m.strikeSize.toFixed(4)}px`,
      'text-decoration-skip-ink': 'none',
    };
    if (a.strikeColor) css['text-decoration-color'] = a.strikeColor;
    return css;
  }

  const TEXT_ALIGN = {
    left: ['left', 'auto'], center: ['center', 'auto'], right: ['right', 'auto'],
    'justify-left': ['justify', 'left'], 'justify-center': ['justify', 'center'],
    'justify-right': ['justify', 'right'], 'justify-all': ['justify', 'justify'],
    'towards-spine': ['left', 'auto'], 'away-spine': ['right', 'auto'],
  };

  // The CSS of a paragraph: `pa` its effective attributes, `lead` its leading
  // in px (leadingPx of its first run), `prev` the previous paragraph's
  // effective attributes (null for the first) — for the space between them.
  function paraCSS(pa, lead, prev, ctx, { marker = '', first = false } = {}) {
    const pt = v => `${+(v * ctx.pxPerPt).toFixed(4)}px`;
    const [align, last] = TEXT_ALIGN[pa.align] || TEXT_ALIGN.left;
    const listIndent = marker ? pa.listIndent : 0;
    const css = {
      'text-align': align,
      'text-align-last': last,
      'padding-left': pt(pa.leftIndent + listIndent),
      'padding-right': pt(pa.rightIndent),
      'text-indent': pt(pa.firstIndent),
      'line-height': `${+lead.toFixed(4)}px`,
      'tab-size': pt(pa.defaultTabs || 36),
      'margin': '0',
    };
    // space between paragraphs: the larger of after and before, or (Sum)
    // both. At the top of the frame by Use space before: only between
    // paragraphs (not there), only at the column top (only there), always.
    const mode = pa.spaceBeforeMode;
    const before = first ? (mode === 'between' ? 0 : pa.spaceBefore)
      : mode === 'columnTop' ? 0
      : prev && !(pa.sumSpacing || prev.sumSpacing) ? Math.max(0, pa.spaceBefore - prev.spaceAfter) : pa.spaceBefore;
    if (before) css['padding-top'] = pt(before);
    if (pa.spaceAfter) css['padding-bottom'] = pt(pa.spaceAfter);
    if (pa.hyphenate) {
      css.hyphens = 'auto';
      css['hyphenate-limit-chars'] = `${pa.hyphMinWord} ${pa.hyphMinBefore} ${pa.hyphMinAfter}`;
    } else css.hyphens = 'manual';
    if (pa.startAt === 'column' && !first) css['break-before'] = 'column';
    else if (pa.keepWithPrevious) css['break-before'] = 'avoid';
    if (pa.keepTogether) css['break-inside'] = 'avoid';
    if (pa.keepWithNext) css['break-after'] = 'avoid';
    css.orphans = pa.preventOrphans ? '2' : '1';
    css.widows = pa.preventWidows ? '2' : '1';
    if (pa.fill) css['background-color'] = pa.fill;
    if (pa.ruleAbove) css['border-top'] = `${pt(pa.ruleWeight)} solid ${pa.ruleColor}`;
    if (pa.ruleBelow) css['border-bottom'] = `${pt(pa.ruleWeight)} solid ${pa.ruleColor}`;
    return css;
  }

  const styleText = css => Object.entries(css).map(([k, v]) => `${k}:${v}`).join(';');

  globalThis.StoryCore = {
    LINE_BREAK, CHAR_DEFAULTS, PARA_DEFAULTS, FRAME_DEFAULTS,
    CAPS, POSITIONS, OT_POSITIONS, LINE_STYLES, ALIGNS, LEADINGS, LISTS, TAB_ALIGNS, VALIGNS, BASELINES,
    clean, sameAttrs, charOf, paraOf, frameOf,
    fromText, toText, paraText, paraLength, clone, normalize,
    cmp, ordered, collapsed, startPos, endPos, whole, clampPos, isWhole,
    runAttrsAt, charSummary, paraSummary, applyChar, mapChar, applyPara,
    deleteRange, insertText, replaceRange, slice, wordAt, listMarkers, changeCase, caseMapped,
    scaledMetrics, leadingPx, leadingPerRun, naturalLeading, firstBaselinePx, capsPlan, featureSettings, runCSS, strikeCSS, paraCSS, styleText,
  };
})();
