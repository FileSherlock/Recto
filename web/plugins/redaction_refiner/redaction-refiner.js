// redaction-refiner.js — Redaction Refiner (optional plugin)
//
// Redraws each detected redaction bar to the true extent of the hidden name by
// reading the words that surround it on its line:
//
//   • Build the row's words from the embedded/OCR spans sharing the bar's line
//     (per-character positions when the span has them, so a text-layer span
//     that still runs UNDER the bar contributes only its visible words), and
//     take the nearest word left and right of the bar — but never look past
//     another redaction bar on the same row, or the pair would each stretch
//     across the other and collapse onto one span. A single capital letter
//     touching the bar is a sliver of the hidden name the bar failed to cover
//     (OCR reads the exposed "S" of "SARAH"): it is part of the redaction, so
//     the bar grows over it and the next word out is the neighbour.
//   • Judge the character/word facing the bar on each side:
//       – punctuation      → flush only when the mark BINDS toward the bar. A
//                            closing mark (. , ; : ! ? ) ] ” %) binds left, so
//                            it is flush against a bar on its left but has a
//                            space before a bar on its right; an opening mark
//                            (( [ { “) is the mirror. A dash or slash glued to
//                            a word is a tight compound (flush), standing alone
//                            it is a spaced dash. A quote glued to a word has
//                            closed it (space); standing alone it opens onto
//                            the hidden word (flush).
//       – a real word      → an inter-word space sits in the gap; the edge is
//                            redrawn one space-width in from the neighbour.
//                            "Real" = in the shipped frequency-ranked English
//                            list (words.txt), or a name from the candidate
//                            pool, or a capitalised token (a proper noun).
//       – a word FRAGMENT  → not a word, but a dictionary word completes it
//                            ("nd" → "and", "inclu" → "including"). The missing
//                            letters sit right next to the bar: either swallowed
//                            by the bar, or visible on the page but unread by
//                            the text layer. Those letters are part of the
//                            neighbour, not of the name, so the edge is redrawn
//                            one space-width PLUS the missing letters' width in
//                            from the fragment. The geometry has to agree: the
//                            gap between bar and fragment must be ~0 (letters
//                            under the bar) or ~the missing letters' width
//                            (letters visible but unread) — otherwise the token
//                            is treated as a whole word.
//     The space is sized from the NEIGHBOUR word's own font + size (HarfBuzz
//     widths through getNaturalSpaceWidth), stretched to the row's measured
//     spacing when the line is justified; the missing letters are measured the
//     same way.
//
// Both edges are rebuilt from the neighbours (not nudged from the painted ink),
// so the result can be narrower OR wider than the original bar — we redraw it.
// The derivation is a pure function of the neighbours, so re-running (when the
// OCR layer lands minutes after the embedded layer) converges instead of
// drifting; a bar the user moved by hand is left alone.
//
// Optional plugin: it attaches only through the PDFHooks bus (listens to
// 'redactions:connected', emits 'redaction:refined' with the remnant slivers)
// and guarded globals (renderBox, calculateAllWidths, getNaturalSpaceWidth,
// GEO, state.namesData). Delete this folder and nothing dangles.

(function () {
  'use strict';

  // Punctuation facing the bar is not automatically flush against the hidden
  // word — it depends on which side the mark BINDS to. A mark that binds toward
  // the redaction is glued to it (no space); one that binds away from it, or
  // binds nothing, leaves a real inter-word space in between.
  //
  //   closing  . , ; : ! ? ) ] } » ” … %   bind LEFT   "Inc." "(2019)" "50%"
  //   opening  ( [ { « “ ¿ ¡               bind RIGHT  "(foo"
  //   medial   - – — / \ @ & _ ~           bind BOTH ways when glued to a word
  //                                        ("co-op"), neither when standing
  //                                        alone (a spaced dash)
  //   quotes   " ' ‘ ’ and the rest        bind to whichever side carries a
  //                                        word: a quote already glued to one
  //                                        has closed it, so the redaction is a
  //                                        separate word; a quote standing
  //                                        alone opens onto the redaction
  //
  // So `EPSTEIN, ███` has a space the old flush rule ate, while `███, and` is
  // still flush — the same comma, read from the other side.
  //
  // `<` and `>` are Unicode MATH symbols, not punctuation, but an email address
  // in angle brackets (`Klein <███>`) delimits exactly like a paren — so they
  // join the bracket classes rather than falling through to the word rule,
  // which would put a phantom space inside each bracket.
  const PUNCT_RE     = /[\p{P}<>]/u;
  const PUNCT_ONLY_RE = /^[\p{P}<>]+$/u;
  const PUNCT_CLOSE  = /[.,;:!?)\]}»”…%>]/u;
  const PUNCT_OPEN   = /[([{«“¿¡<]/u;
  const PUNCT_MEDIAL = /[-–—/\\@&_~]/u;

  // The run of word characters (letters, apostrophes, hyphens) touching the bar:
  // the tail of the left neighbour, the head of the right one.
  const TOKEN_LEFT_RE  = /[\p{L}'’-]+$/u;
  const TOKEN_RIGHT_RE = /^[\p{L}'’-]+/u;

  // A refined bar narrower than this would be a degenerate zero-width box.
  const MIN_REFINED_WIDTH_PX = 4;

  // A neighbour whose glyphs run further than this under the bar was read
  // from a sliver: its pen is evidence, but not lattice-exact. (A detector
  // column plus a glyph's side bearing is under 2 px; a comma the redactor's
  // box ran over is 2.75 px under on the reference page.)
  const PARTIAL_UNDER_PX = 2;

  // How far the missing letters of a fragment may sit from where the geometry
  // says they should be (relative to a space, with an absolute floor).
  const TOUCH_TOL_FRAC = 0.6;
  const TOUCH_TOL_MIN_PX = 2.5;

  // How many dictionary completions of a fragment are measured before giving up.
  const MAX_COMPLETIONS = 12;

  // A bar bounded by a sibling measures against the sibling's CURRENT edge,
  // which may itself move when the sibling is refined; a full run repeats
  // until a pass moves nothing (a settled bar costs a signature compare).
  const MAX_REFINE_PASSES = 3;

  // A row counts as justified when its median measured space exceeds the font's
  // natural advance by more than this (relative, with an absolute floor).
  const JUSTIFY_TOL_FRAC = 0.12;
  const JUSTIFY_TOL_MIN_PX = 0.5;

  const DICT_URL = assetURL('plugins/redaction_refiner/words.txt');

  // Sentence spacing. A typed memo may put TWO spaces after a sentence-ending
  // mark ("incident.  The same day" — a 9 px gap where a word gap is 5 on the
  // reference page), and a bar that opens a sentence ("plane. [Bledsoe] said")
  // starts that far in: read as one space, that bar came out a space too wide
  // with reader pens on both sides. The convention is measured per page from
  // the pens: the gap between a sentence-ending mark and the capital after it,
  // in the row's spaces, median over the page's sentence boundaries. A mark
  // after an abbreviation ("Dr.", an initial) ends no sentence.
  const SENTENCE_END_RE = /[.?!]/;
  const ABBREVIATIONS = new Set([
    'dr', 'mr', 'mrs', 'ms', 'jr', 'sr', 'st', 'no', 'vs', 'etc', 'inc', 'ltd', 'co', 'corp',
    'prof', 'gen', 'capt', 'sgt', 'lt', 'col', 'rev', 'hon', 'mt', 'ft', 'ave', 'blvd', 'dept',
    'est', 'approx', 'us', 'uk', 'eg', 'ie', 'am', 'pm',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  ]);
  const MIN_SENTENCE_SAMPLES = 2;

  // ── Dictionary ─────────────────────────────────────────────
  // words.txt: one lowercase word per line, most frequent first (see
  // tools/dev/words_build.py). `list` keeps that order for ranking completions; `set` is
  // the membership test.
  const dict = { list: [], set: new Set(), ready: null };

  function fillDictionary(words) {
    dict.list = [];
    dict.set = new Set();
    for (const raw of words) {
      const w = String(raw).trim().toLowerCase();
      if (!w || w.startsWith('#') || dict.set.has(w)) continue;
      dict.set.add(w);
      dict.list.push(w);
    }
    return dict.list.length;
  }

  // Replace the dictionary in place (tests / tooling).
  function setDictionary(words) {
    const n = fillDictionary(words);
    dict.ready = Promise.resolve(n);
    return n;
  }

  // Fetch words.txt once. Resolves to the word count (0 when unavailable — the
  // refiner then degrades to the punctuation/space rules only).
  function loadDictionary(url = DICT_URL) {
    if (dict.ready) return dict.ready;
    dict.ready = (async () => {
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        fillDictionary((await resp.text()).split(/\r?\n/));
      } catch (e) {
        console.warn('[redaction_refiner] word list unavailable —', e?.message || e);
      }
      return dict.list.length;
    })();
    return dict.ready;
  }

  // Is this token an English word? Case-insensitive; possessives ("device's",
  // "devices'") reduce to their base, and hyphen/apostrophe compounds count
  // when every part is a word ("co-conspirators").
  function isWord(token) {
    if (!token) return false;
    const t = token.toLowerCase().replace(/’/g, "'");
    if (dict.set.has(t)) return true;
    const base = t.replace(/'s$/, '').replace(/'$/, '');
    if (base !== t && dict.set.has(base)) return true;
    const parts = base.split(/[-']/).filter(Boolean);
    return parts.length > 1 && parts.every((p) => dict.set.has(p));
  }

  // Dictionary words the fragment could be the visible part of, most frequent
  // first. A fragment RIGHT of the bar is the end of its word (its start is
  // missing) → words ending with it; LEFT of the bar it is the start → words
  // starting with it. Only pure letter runs can be fragments.
  function completions(token, side, limit = MAX_COMPLETIONS) {
    const t = (token || '').toLowerCase();
    if (!t || !/^\p{L}+$/u.test(t)) return [];
    const out = [];
    for (const w of dict.list) {
      if (w.length <= t.length) continue;
      if (side === 'right' ? w.endsWith(t) : w.startsWith(t)) {
        out.push(w);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  // The letters a completion adds to the fragment, in the fragment's own case.
  function hiddenPart(word, token, side) {
    const part = side === 'right'
      ? word.slice(0, word.length - token.length)
      : word.slice(token.length);
    return caseOf(token) === 'upper' ? part.toUpperCase() : part;
  }

  // ── Tokens ─────────────────────────────────────────────────
  const isPunct = (ch) => !!ch && PUNCT_RE.test(ch);

  // The run of non-space characters at the end of the neighbour that faces the
  // bar. With per-character positions this is the whole word; without them the
  // neighbour is a whole span, and only its facing run can say anything.
  function facingRun(text, side) {
    const m = (text || '').match(side === 'left' ? /\S+$/ : /^\S+/);
    return m ? m[0] : '';
  }

  // Does the punctuation mark facing the bar bind TOWARD it (flush against the
  // hidden word) or away from it (an inter-word space in between)? `run` is the
  // facing run, `side` says where it sits ('left' = run, then bar).
  function punctBindsToward(run, side) {
    const ch = side === 'left' ? run[run.length - 1] : run[0];
    if (!ch) return false;
    if (PUNCT_CLOSE.test(ch)) return side === 'right';   // binds left
    if (PUNCT_OPEN.test(ch)) return side === 'left';     // binds right
    // Everything else is settled by what the mark is glued to on its FAR side.
    // A run can stack several marks ('("'), so look past them for a word.
    const rest = side === 'left' ? run.slice(0, -1) : run.slice(1);
    const glued = /[\p{L}\p{N}]/u.test(rest);
    if (PUNCT_MEDIAL.test(ch)) return glued;             // "co-" is a compound
    return !glued;                                       // a quote: glued = closed
  }

  // Does the mark ending `run` end a sentence? Not after an abbreviation or a
  // single-letter initial ("Dr.", "J."); a number does ("in 2002.").
  function isSentenceEnd(run) {
    const mark = run[run.length - 1];
    if (!SENTENCE_END_RE.test(mark || '')) return false;
    const before = run.slice(0, -1).replace(/[^\p{L}\p{N}]/gu, '');
    if (/^\p{L}$/u.test(before)) return false;
    return !ABBREVIATIONS.has(before.toLowerCase());
  }

  // How many spaces this page puts after a sentence, measured from the spans
  // of `type` on it (1 when too few sentence boundaries can be read). A walk
  // over the page's characters — cheap enough to redo per bar.
  function sentenceSpaces(page, type) {
    if (typeof utbState === 'undefined') return 1;
    const spans = utbState.boxes.filter((b) => b.page === page && b.type === type && usableSpan(b)
      && Array.isArray(b.baseCharPositions) && b.baseCharPositions.length);
    const ratios = [];
    for (const span of spans) {
      const cps = span.baseCharPositions;
      const spaceWs = cps.filter((cp) => cp.c === ' ' && cp.w > 0).map((cp) => cp.w);
      if (!spaceWs.length) continue;
      const space = median(spaceWs);
      for (let i = 0; i < cps.length; i++) {
        if (!SENTENCE_END_RE.test(cps[i].c || '')) continue;
        let k = i;
        while (k > 0 && cps[k - 1].c && cps[k - 1].c.trim()) k--;
        const run = cps.slice(k, i + 1).map((cp) => cp.c).join('');
        if (!isSentenceEnd(run)) continue;
        let j = i + 1;
        while (j < cps.length && !(cps[j].c || '').trim()) j++;
        if (j === i + 1 || j >= cps.length || !/\p{Lu}/u.test(cps[j].c)) continue;
        const gap = cps[j].x - (cps[i].x + cps[i].w);
        if (gap > 0) ratios.push(gap / space);
      }
    }
    return ratios.length >= MIN_SENTENCE_SAMPLES ? Math.min(2, Math.max(1, Math.round(median(ratios)))) : 1;
  }

  function facingToken(text, side) {
    const m = (text || '').trim().match(side === 'left' ? TOKEN_LEFT_RE : TOKEN_RIGHT_RE);
    return m ? m[0] : '';
  }

  function caseOf(token) {
    if (!token) return 'none';
    const lower = token.toLowerCase();
    const upper = token.toUpperCase();
    if (token === lower && token !== upper) return 'lower';
    if (token === upper && token !== lower) return 'upper';
    if (token[0] === token[0].toUpperCase() && token.slice(1) === token.slice(1).toLowerCase()) return 'title';
    return 'mixed';
  }

  // Names from the candidate pool (redaction_matching's state.namesData and
  // custom names) are whole words even though no dictionary lists them.
  let _namePool = null;
  let _namePoolKey = '';
  function inNamePool(token) {
    if (typeof state === 'undefined' || !state) return false;
    const data = Array.isArray(state.namesData) ? state.namesData : [];
    const customs = Array.isArray(state.customCandidates) ? state.customCandidates : [];
    const key = `${data.length}|${customs.length}`;
    if (!_namePool || key !== _namePoolKey) {
      _namePool = new Set();
      const add = (s) => {
        for (const part of String(s || '').split(/[\s-]+/)) if (part) _namePool.add(part.toLowerCase());
      };
      for (const p of data) {
        (p.first || []).forEach(add);
        (p.last || []).forEach(add);
        add(p.nickname);
      }
      customs.forEach(add);
      _namePoolKey = key;
    }
    return _namePool.has(token.toLowerCase().replace(/[’']s$/, ''));
  }

  // What the token facing the bar says about the gap between them.
  //   { kind: 'word' }                  a whole word — a real space separates it
  //   { kind: 'fragment', words: [...] } the visible part of a word whose other
  //                                      letters are missing next to the bar
  // (Punctuation is decided by the caller on the facing character.)
  function classifyToken(token, side) {
    if (!token) return { kind: 'word', reason: 'no-token' };
    if (isWord(token)) return { kind: 'word', reason: 'dictionary' };
    if (inNamePool(token)) return { kind: 'word', reason: 'name' };
    const cs = caseOf(token);
    if (cs === 'title' && token.length >= 3) return { kind: 'word', reason: 'proper-noun' };
    if (cs === 'mixed') return { kind: 'word', reason: 'mixed-case' };
    const words = completions(token, side);
    if (!words.length) return { kind: 'word', reason: 'no-completion' };
    return { kind: 'fragment', words };
  }

  // ── Row geometry ───────────────────────────────────────────
  function pxPerPt() {
    return (window.GEO && typeof GEO.docPxPerPt === 'function') ? GEO.docPxPerPt() : 96 / 72;
  }

  function usableSpan(b) {
    if (b.type !== 'embedded' && b.type !== 'ocr') return false;
    if (b.ocr && b.ocr.unread) return false;
    const t = (b.text || '').trim();
    return !!t && t !== '□';
  }

  // Spans sharing the box's row, by vertical overlap.
  function spansOnRow(box, type) {
    return utbState.boxes.filter((b) => {
      if (b.page !== box.page || !usableSpan(b)) return false;
      if (type && b.type !== type) return false;
      const overlap = Math.min(box.y + box.h, b.y + b.h) - Math.max(box.y, b.y);
      return overlap >= box.h * 0.5;
    });
  }

  // Other redaction bars sharing this bar's row. Two bars separated by a space
  // are usually the two halves of one name, and either way the text BEYOND a
  // sibling says nothing about this bar's extent: measuring against it would
  // stretch this bar across the sibling, and — since the sibling does the same
  // in reverse — collapse the pair onto one span, scoring the same stretch of
  // page twice. So a sibling bounds the neighbour search on its side, and an
  // edge with no word between it and the sibling keeps its detected position:
  // there, the painted ink is the only evidence there is.
  function siblingBars(box) {
    return utbState.boxes.filter((b) => {
      if (b.id === box.id || b.type !== 'redaction' || b.page !== box.page) return false;
      const overlap = Math.min(box.y + box.h, b.y + b.h) - Math.max(box.y, b.y);
      return overlap >= box.h * 0.5;
    });
  }

  // The text-line spans the box is measured against, and where they came from.
  //
  // OCR words are preferred whenever OCR has read this row: OCR reads the glyphs
  // actually VISIBLE on the page after redaction, whereas the embedded text
  // layer can still carry glyphs the redaction removed from view — or drop the
  // glyph touching the bar (the "a" of "and" surviving only as "nd"). With no
  // OCR on the row (the auto read of a long document can take minutes) the
  // embedded spans on the box's line are used, and the fragment rule recovers
  // the dropped letters; when OCR lands, 'redactions:connected' fires again and
  // the bar is re-derived from the OCR words.
  // The row's spans, from its best source: the reader's line when it
  // certified the row with letters (measured pens in a face it proved),
  // else the text layer's spans (the bar's own line, else the row's), else a
  // tolerant read — its pens sit on the ink, its letters and face may not
  // be the page's, so it is 'ocr-tolerant': no lattice-exact edge, no
  // reader's-set widths, no page-pixel verdict. Never an unread band.
  function lineSpansFor(box) {
    const ocrRow = spansOnRow(box, 'ocr');
    // (`trusted` is the reader's flag — certified with letters; a box built
    // elsewhere carries only `clean`, which then stands for it)
    const certified = ocrRow.filter((b) => b.ocr && (b.ocr.trusted ?? b.ocr.clean));
    if (certified.length) return { spans: certified, source: 'ocr' };

    if (box.lineId != null) {
      const line = utbState.boxes.filter(
        (b) => b.page === box.page && b.lineId === box.lineId && b.type === 'embedded' && usableSpan(b)
      );
      if (line.length) return { spans: line, source: 'embedded' };
    }
    const embRow = spansOnRow(box, 'embedded');
    if (embRow.length) return { spans: embRow, source: 'embedded' };
    return { spans: ocrRow, source: ocrRow.length ? 'ocr-tolerant' : 'embedded' };
  }

  // The row's words as [{ text, x0, x1, span }] in absolute image px. A span
  // with per-character positions contributes one entry per whitespace-separated
  // run of glyphs; without them the whole span is one entry.
  function rowWords(spans) {
    const words = [];
    for (const s of spans) {
      const cps = s.baseCharPositions;
      if (Array.isArray(cps) && cps.length) {
        let cur = null;
        for (const cp of cps) {
          const c = cp.c || '';
          if (!c.trim()) { if (cur) { words.push(cur); cur = null; } continue; }
          const x0 = s.x + (cp.x || 0);
          const x1 = x0 + (cp.w || 0);
          if (!cur) cur = { text: c, x0, x1, span: s };
          else { cur.text += c; cur.x1 = Math.max(cur.x1, x1); }
        }
        if (cur) words.push(cur);
      } else {
        const t = (s.text || '').trim();
        if (t) words.push({ text: t, x0: s.x, x1: s.x + s.w, span: s });
      }
    }
    return words.sort((a, b) => a.x0 - b.x0);
  }

  // A sliver of the hidden name the bar failed to cover: a lone capital letter
  // (not a word — "A"/"I" stay articles/pronouns) touching or straddling the
  // bar's edge. The redaction owns it, so it is skipped as a neighbour and the
  // bar grows over it. A letter buried deeper inside the bar than its own
  // width is under-bar text, not a sliver.
  function isRemnant(word, box, side) {
    const t = word.text;
    if (t.length !== 1 || !/\p{Lu}/u.test(t) || isWord(t)) return false;
    const est = 0.25 * (word.span.sizePt || 12) * pxPerPt();       // ≈ a space, before shaping
    const tol = Math.max(TOUCH_TOL_MIN_PX, est * TOUCH_TOL_FRAC);
    const gap = side === 'left' ? box.x - word.x1 : word.x0 - (box.x + box.w);
    return gap <= tol && gap >= -((word.x1 - word.x0) + tol);
  }

  // Nearest word on each side of the box, split at the box's horizontal centre.
  // A word lying mostly under the bar is the redacted text itself (a text layer
  // can still carry it) and is never a neighbour; nor is a remnant sliver.
  function neighboursFor(box) {
    const { spans, source } = lineSpansFor(box);
    const words = rowWords(spans);
    const centre = box.x + box.w / 2;
    const remnants = [];

    // How far out each side may look before it runs into another bar.
    const tol = TOUCH_TOL_MIN_PX;
    let leftLimit = -Infinity;
    let rightLimit = Infinity;
    for (const b of siblingBars(box)) {
      const bx1 = b.x + b.w;
      if (bx1 <= box.x + tol) leftLimit = Math.max(leftLimit, bx1);
      if (b.x >= box.x + box.w - tol) rightLimit = Math.min(rightLimit, b.x);
    }
    const blocked = { left: leftLimit > -Infinity, right: rightLimit < Infinity };

    let left = null;
    let right = null;
    for (const w of words) {
      const wCentre = (w.x0 + w.x1) / 2;
      const side = wCentre <= centre ? 'left' : 'right';
      // Behind a sibling bar — that text belongs to the sibling, not to us.
      // Judged by the word's centre: a comma the sibling's painted edge runs
      // a pixel into ("[A], [B]") still stands between the bars, and is B's
      // neighbour as much as A's.
      if (side === 'left' ? wCentre <= leftLimit : wCentre >= rightLimit) continue;
      if (isRemnant(w, box, side)) { remnants.push({ text: w.text, side }); continue; }
      const width = w.x1 - w.x0;
      const under = Math.min(w.x1, box.x + box.w) - Math.max(w.x0, box.x);
      // Text lying mostly under the bar is the redacted text itself. A
      // punctuation mark is the exception: the redactor's box often runs over
      // the comma after a name ("[Lesley Groff,] Jean"), and a mark the reader
      // still saw part of belongs to the visible text — it is the neighbour,
      // partly covered — until it is covered whole.
      const punctOnly = PUNCT_ONLY_RE.test(w.text);
      if (width > 0 && (punctOnly ? under >= width - 0.5 : under > width * 0.5)) continue;
      w.under = Math.max(0, under);
      if (side === 'left') {
        if (!left || w.x1 > left.x1) left = w;
      } else if (!right || w.x0 < right.x0) {
        right = w;
      }
    }
    return { left, right, remnants, blocked, source, spans };
  }

  function median(nums) {
    const s = [...nums].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // Natural space advance (image px) for a span's own font + size. Uses the
  // shared HarfBuzz path when present; otherwise a 0.25em estimate.
  async function naturalSpaceWidth(span) {
    if (typeof getNaturalSpaceWidth === 'function') {
      try {
        const w = await getNaturalSpaceWidth({
          fontFamily: span.fontFamily,
          bold: !!span.bold,
          italic: !!span.italic,
          sizePt: span.sizePt,
          kerning: false,
        });
        if (w != null && w > 0) return w;
      } catch { /* fall through to the estimate */ }
    }
    return span.sizePt * pxPerPt() * 0.25;
  }

  // The inter-word space actually used on this row. Justification only ever
  // STRETCHES spaces above the natural advance, so: drop measured spaces that
  // read clearly below natural (a space partly under the bar), and trust the
  // median of the rest only when it sits clearly above natural.
  function rowSpaceWidth(spans, natural) {
    const measured = [];
    for (const s of spans) {
      const cps = s.baseCharPositions;
      if (!Array.isArray(cps)) continue;
      for (const cp of cps) if (cp.c === ' ' && cp.w > 0) measured.push(cp.w);
    }
    if (!measured.length) return natural;
    const tol = Math.max(JUSTIFY_TOL_MIN_PX, natural * JUSTIFY_TOL_FRAC);
    const real = measured.filter((w) => w >= natural - tol);
    if (!real.length) return natural;
    const typical = median(real);
    return typical > natural + tol ? typical : natural;
  }

  // Width (image px) of `text` set in the span's font + size, via HarfBuzz
  // (text_tool's Shaping.widths). null when it cannot be measured.
  const _measureCache = new Map();
  async function measureTextWidth(span, text) {
    if (!text) return 0;
    const scale = (window.GEO && typeof GEO.docScale === 'function') ? GEO.docScale() : 100 * (96 / 72);
    const key = `${span.fontFamily}|${span.bold ? 'b' : ''}${span.italic ? 'i' : ''}|${span.sizePt}|${scale}|${text}`;
    if (_measureCache.has(key)) return _measureCache.get(key);
    let w = null;
    try {
      // text_tool's shaper (HarfBuzz in the browser); unmeasurable without it
      const data = typeof Shaping !== 'undefined' ? await Shaping.widths({
        strings: [text],
        family: span.fontFamily,
        bold: !!span.bold,
        italic: !!span.italic,
        size: span.sizePt,
        scale,
        kerning: false,
        ligatures: false,   // plain advances, as the matcher measures
      }) : null;
      w = data?.results?.[0]?.width ?? null;
    } catch { /* unmeasurable */ }
    if (w != null) _measureCache.set(key, w);
    return w;
  }

  // ── Edge derivation ────────────────────────────────────────
  // Where the hidden name's edge is, judged from the neighbour word on `side`
  // ('left' = the word left of the bar). Returns
  //   { edge, wordEdge, kind, token, ... }
  // where `wordEdge` is the plain whole-word reading, kept as the fallback when
  // a fragment reading would collapse the bar.
  async function resolveEdge(box, word, side, spans) {
    const text = word.text;
    const run = facingRun(text, side);
    const facing = side === 'left' ? run[run.length - 1] : run[0];
    const inkEdge = side === 'left' ? word.x1 : word.x0;
    const token = facingToken(text, side);
    // Read from a sliver (the bar covers part of it): evidence, not exact.
    const partial = (word.under || 0) > PARTIAL_UNDER_PX;

    if (isPunct(facing)) {
      if (punctBindsToward(run, side)) {
        return { edge: inkEdge, wordEdge: inkEdge, kind: 'punct', reason: 'abuts',
                 token: facing, inkEdge, space: 0, partial };
      }
      // The mark belongs to the text behind it, so a real space separates it
      // from the hidden word — sized like any other inter-word space on the
      // row; two of them when the mark ends a sentence and the page spaces
      // sentences that way ("plane. [Bledsoe] said").
      const natural = await naturalSpaceWidth(word.span);
      const space = rowSpaceWidth(spans, natural);
      const spaces = side === 'left' && isSentenceEnd(run) ? sentenceSpaces(box.page, word.span.type) : 1;
      const edge = side === 'left' ? inkEdge + space * spaces : inkEdge - space;
      return { edge, wordEdge: edge, kind: 'punct', reason: 'spaced',
               token: facing, inkEdge, space, spaces, partial };
    }

    const natural = await naturalSpaceWidth(word.span);
    const space = rowSpaceWidth(spans, natural);
    const wordEdge = side === 'left' ? inkEdge + space : inkEdge - space;
    const cls = classifyToken(token, side);
    const base = { wordEdge, token, inkEdge, space, reason: cls.reason, partial };

    if (cls.kind !== 'fragment') return { ...base, edge: wordEdge, kind: 'word' };

    // The missing letters sit between the fragment and the name, so they are
    // either under the bar (gap ≈ 0 — the detector swallowed them) or in the
    // gap itself (visible but unread — gap ≈ their width). Take the most
    // frequent completion whose letters fit that geometry.
    const gap = side === 'left' ? box.x - inkEdge : inkEdge - (box.x + box.w);
    const tol = Math.max(TOUCH_TOL_MIN_PX, space * TOUCH_TOL_FRAC);
    for (const w of cls.words) {
      const hidden = hiddenPart(w, token, side);
      const hw = await measureTextWidth(word.span, hidden);
      if (hw == null) break;                      // no shaper — fall back to the word rule
      const underBar = gap <= tol && box.w >= hw + space + MIN_REFINED_WIDTH_PX;
      const unread = Math.abs(gap - hw) <= tol;
      if (!underBar && !unread) continue;
      const edge = side === 'left' ? inkEdge + hw + space : inkEdge - hw - space;
      return {
        ...base, edge, kind: 'fragment', word: w, hidden, hiddenWidth: hw, gap,
        placement: underBar ? 'under-bar' : 'unread',
      };
    }
    return { ...base, edge: wordEdge, kind: 'word', reason: 'no-fitting-completion' };
  }

  function signatureOf(nb) {
    const w = (x) => (x ? `${x.text}@${x.x0.toFixed(2)}-${x.x1.toFixed(2)}` : '-');
    const r = nb.remnants.map((x) => `${x.side[0]}:${x.text}`).join(',');
    const b = `${nb.blocked.left ? 'L' : ''}${nb.blocked.right ? 'R' : ''}`;
    return `${nb.source}|${w(nb.left)}|${w(nb.right)}|${r}|${b}|${dict.list.length}`;
  }

  // Refine one redaction box in place. Returns true when its geometry changed.
  // The verdict is recorded on box.refineInfo for inspection.
  async function refineRedaction(box, opts = {}) {
    if (!box || box.type !== 'redaction') return false;
    await loadDictionary();

    const nb = neighboursFor(box);
    if (!nb.left && !nb.right) {
      // Nothing to measure against. Still record what bounds the bar, so a
      // consumer can tell a lone bar from one whose only company on the row
      // is another bar — the other half of a name.
      box.refineInfo = {
        source: nb.source, left: null, right: null, remnants: nb.remnants, blocked: nb.blocked,
        x: box.x, w: box.w, exact: false,
      };
      return false;
    }

    const sig = signatureOf(nb);
    const prev = box._refine;
    if (prev && !opts.force) {
      const userEdited = prev.x !== box.x || prev.w !== box.w;
      if (prev.sig === sig) return false;                          // nothing new to learn
      if (userEdited && prev.source === nb.source) return false;   // keep the user's edit
    }

    const left = nb.left ? await resolveEdge(box, nb.left, 'left', nb.spans) : null;
    const right = nb.right ? await resolveEdge(box, nb.right, 'right', nb.spans) : null;

    let newX0 = left ? left.edge : box.x;
    let newX1 = right ? right.edge : box.x + box.w;
    if (newX1 - newX0 < MIN_REFINED_WIDTH_PX) {
      // A fragment reading ate the whole bar — fall back to the word reading.
      if (left && left.kind === 'fragment') { left.kind = 'word'; left.reason = 'collapsed'; left.edge = left.wordEdge; }
      if (right && right.kind === 'fragment') { right.kind = 'word'; right.reason = 'collapsed'; right.edge = right.wordEdge; }
      newX0 = left ? left.edge : box.x;
      newX1 = right ? right.edge : box.x + box.w;
      if (newX1 - newX0 < MIN_REFINED_WIDTH_PX) return false;  // would still collapse — leave it
    }

    const changed = newX0 !== box.x || newX1 !== box.x + box.w;
    if (changed) {
      box.x = newX0;
      box.w = newX1 - newX0;
      box.refined = true;
    }
    // The verdict, for consumers (a matcher reads `exact`: both edges derived
    // from the reader's ¼-px pens, so the width is lattice-exact and a name
    // either fits to a quarter pixel or it does not — see
    // guide/plugins/redaction-refiner/pixel-evidence-plan.md §0). `x`/`w` are
    // the geometry this verdict produced; a bar moved since is no longer exact.
    box.refineInfo = {
      source: nb.source, left, right, remnants: nb.remnants, blocked: nb.blocked,
      x: box.x, w: box.w,
      // An edge bounded by a sibling bar is the detector's, not a reader pen,
      // so a pair-adjacent bar is never lattice-exact; nor is an edge read
      // from a neighbour the bar partly covers.
      exact: nb.source === 'ocr' && !!left && !!right && !left.partial && !right.partial,
    };
    box._refine = { sig, source: nb.source, x: box.x, w: box.w };
    if (changed && typeof renderBox === 'function') renderBox(box);
    // Announce the verdict. Generic lifecycle event (names no plugin): a
    // matcher can read the remnant slivers as the hidden name's own first /
    // last letters and narrow its candidates accordingly.
    window.PDFHooks?.emit('redaction:refined', {
      boxId: box.id, source: nb.source, changed,
      remnants: nb.remnants.map((x) => ({ ...x })),
    });
    return changed;
  }

  // Refine every eligible redaction box, then re-measure candidate widths once.
  // Bars are visited in reading order and the run repeats while a pass moves
  // anything: a bar's neighbour search is bounded by its siblings' edges, and
  // a sibling refined later would leave the earlier bar judged against a
  // detected edge that has since moved (the pair "[A], [B]" visited B-first
  // used to lose B's comma behind A's painted edge).
  async function refineAllRedactions(opts = {}) {
    if (typeof utbState === 'undefined') return;
    const boxes = utbState.boxes.filter((b) => b.type === 'redaction')
      .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
    let changed = false;
    for (let pass = 0; pass < MAX_REFINE_PASSES; pass++) {
      let moved = false;
      for (const box of boxes) {
        // Don't fight a box the user is actively editing/selecting.
        if (utbState.selectedId === box.id || utbState.editingId === box.id) continue;
        try {
          if (await refineRedaction(box, opts)) moved = true;
        } catch (e) {
          console.warn('[redaction_refiner] refine failed for', box.id, e);
        }
      }
      if (!moved) break;
      changed = true;
    }
    // Widths depend on box.w — recompute matches for the redrawn bars.
    if (changed && typeof calculateAllWidths === 'function') calculateAllWidths();
  }

  // Run whenever redactions have just been (re)connected to their text lines —
  // this fires on the span-load path (per hydrated page) and after an OCR pass.
  if (window.PDFHooks) {
    PDFHooks.on('redactions:connected', () => { refineAllRedactions(); });
  }

  // Guarded globals for manual re-runs / tooling.
  window.refineRedaction = refineRedaction;
  window.refineAllRedactions = refineAllRedactions;
  window.RedactionRefiner = {
    setDictionary, loadDictionary, isWord, completions, hiddenPart, facingToken,
    caseOf, classifyToken, rowWords, neighboursFor, isRemnant, rowSpaceWidth, resolveEdge,
    siblingBars, isSentenceEnd, sentenceSpaces,
    facingRun, punctBindsToward,
    refineRedaction, refineAllRedactions,
  };
})();
