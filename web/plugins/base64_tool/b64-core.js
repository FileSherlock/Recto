// b64-core.js — base64 attachments in a document's OCR read: found, decoded,
// typed, named, and judged.
//
// The rules are tol0's (tools/b64/blocks.mjs, sniff.mjs, what decode.mjs does
// with a body), measured there over its archive and 15,000 documents, and kept
// the same here by hand. The input is the reader's lines in reading order, so a
// line carries what the reader knows about it: `fails` counts the ink clusters
// no glyph explained (each a □ in its text), `unread` marks a band no set read,
// `tol` the rung it was read on, `pens` its glyphs' places. A character the
// read did not certify is DAMAGE: its place is kept, so that nothing after it
// shifts, and the card says so.
//
// A body is a run of base64 lines of one width W (76 for MIME; vCard photos
// 72), quote marks ('>') stripped; it may end in one shorter line, and padding
// ('=') ends it. Blank lines, page breaks and Bates stamps are neutral. What a
// line is to a body is pieceOf's business: its base64 may share the line with a
// MARKER that opens or closes the body (an armor line, an XML tag, an HTML
// attribute), it may end in a printer's soft hyphen and hold a printer's
// spaces, but a line of prose with digits and slashes is not base64 because its
// words happen to join up into the alphabet.
//
// Two rules are this file's own, for a line the read did not certify: an '='
// at its end does not close the body when a full line that opens no new file
// follows, and an '=' mid-stream decodes as 'A', so a misread costs 1–2 bytes
// and not the rest of the file.
//
// The type is sniffed from the decoded bytes, never taken from the name the
// email declares, and it decides how the file may be viewed: 'inline' (the
// browser shows its real type — PDF, images, audio, video, plain text),
// 'text' (markup — HTML, SVG, XML, RTF, an email — shown as text/plain: a
// blob URL runs in the page's own origin, so decoded markup must never run
// script there) or 'none' (archives, Office files, TIFF: saved, not viewed).
//
// What a file may be called (verdict):
//   exact       every character certified, and the file known to be whole: a
//               check of its format passed, or both ends of the body are proven
//   incomplete  every character certified, and the body itself is cut short
//   unproven    every character certified, nothing says whether that is all of it
//   damaged     some characters were not certified
// A form's hidden field and a mail header's value are listed apart, as no files.
//
// No DOM: base64-tool.js gathers the boxes and draws the panel; the node tests
// load this very file (globalThis.B64Core).
(function () {
  const QUOTE = /^\s*(?:>\s*)+/;
  const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
  const FILL = 'A';                  // what a lost character decodes as (its bytes are marked damaged)
  const MIN_BODY = 64;               // characters: anything shorter is no body
  const LOST = '□';                  // the reader's stand-in for a cluster no glyph explained

  // The share of neighbouring characters that change class (upper, lower, the
  // rest). Random base64: 63 %, σ ≈ 6 % over 76 characters. A repeating JPEG or
  // PNG fill can drop to 15–30 %, prose stays there.
  function classChanges(t) {
    let changes = 0, prev = -1;
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i), k = c >= 65 && c <= 90 ? 0 : c >= 97 && c <= 122 ? 1 : 2;
      if (prev >= 0 && k !== prev) changes++;
      prev = k;
    }
    return t.length > 1 ? changes / (t.length - 1) : 0;
  }

  // strong: the length and alphabet mix of a wrapped attachment body
  const isStrong = t => t.length >= 40 && B64.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t) && /[0-9+/]/.test(t) && classChanges(t) >= 0.2;

  // ── what opens a body on its own line, and what closes one ──────────────
  const ARMOR_BEGIN = /^-{3,}\s*BEGIN\s+([^-]*?)\s*-{3,}\s*/;
  const ARMOR_END = /^\s*-{3,}\s*END\b/;
  const TAGS = /^(?:(?:<[A-Za-z_][^<>]*>|<!\[CDATA\[)\s*)+/;
  // the end of a tag the printer wrapped, the body right after it: `…XMLSchema-instance">PD94…`.
  // Something outside the alphabet in it: `Zc/2">Name` is the end of a body, not the start of one
  const TAG_RAN_ON = /^[^<>\s]*[^A-Za-z0-9+/=<>\s"'][^<>\s]*["']?\s*>/;
  const DATA_URI = /^.*?(?:\bdata:([\w.+/-]*))?;\s*base64\s*,/i;
  const ATTR = /([A-Za-z_][\w:.-]*)\s*=\s*(["'])/g;
  const STAMP = /^(?:EFTA\d{8}|HOUSE_OVERSIGHT_\d{4,})$/;     // a Bates stamp: printed on the page, not in the file

  // a value in quotes: one that runs off the end of the line, its closing quote
  // further on, or a closed one long enough to be a body by itself
  function attrHead(s) {
    if (!s.includes('=')) return null;
    let m, best = null;
    ATTR.lastIndex = 0;
    while ((m = ATTR.exec(s))) {
      const from = m.index + m[0].length, to = s.indexOf(m[2], from);
      if (to < 0) { best = { name: m[1], from }; break; }
      const v = s.slice(from, to);
      if (v.length >= 40 && B64.test(v) && (!best || v.length > best.n)) best = { name: m[1], from, n: v.length };
      ATTR.lastIndex = to + 1;
    }
    return best;
  }

  // an <INPUT> field's name, `_ VIEWSTATE` as the printer left it → VIEWSTATE
  function formField(s) {
    if (!/<\s*INPUT\b/i.test(s) && !/\bTYPE\s*=\s*["']?hidden/i.test(s)) return null;
    const m = /\bNAME\s*=\s*["']([^"']*)["']/i.exec(s);
    return m ? m[1].replace(/[\s_]+/g, '') || 'unnamed field' : 'unnamed field';
  }

  const isBodyChar = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 47 && c <= 57) || c === 43 || c === 61 || c === 32 || c === 9;

  // What a line of the read is to a base64 body, the marker and the printer's
  // marks taken off:
  //   { blank: true }                nothing, or a Bates stamp: neutral
  //   { prose: true }                not base64
  //   { t, head, tail, soft, off, weak }
  // t: the base64 characters (may be '' on a line that is only a marker)
  // head: { kind: armor | xml | attr | data-uri, name, form?, type? } opens a body on this line
  // tail: armor | xml | close-tag | quote | cdata | paren: closes one (the caller
  //       decides: a quote means nothing outside an opened attribute)
  // soft: the printer's '-' at the end of a wrapped line: not base64, and not a word's hyphen either
  // off:  how many non-space characters of the line stand before t
  // weak: a short line with a space in it: body only inside a run
  // Spaces in a line of a certified read are the printer's (a body re-flowed by
  // a mail client, one every 64 characters) or the reader's own (a gap where a
  // wide glyph was taken for an 'I', a lost cluster): few, and between long
  // tokens of random-looking characters. Prose has a space every few letters.
  function pieceOf(text, fails = 0) {
    const s = (text || '').replace(QUOTE, '').trim();
    if (!s) return { blank: true };
    if (STAMP.test(s)) return { blank: true, stamp: true };
    let head = null, at = 0, m;
    if ((m = ARMOR_BEGIN.exec(s))) { head = { kind: 'armor', name: m[1] }; at = m[0].length; }
    else if (/;\s*base64\s*,/i.test(s) && (m = DATA_URI.exec(s))) { head = { kind: 'data-uri', name: m[1] || 'data', type: m[1] || undefined }; at = m[0].length; }
    else {
      const a = /["']/.test(s) ? attrHead(s) : null;
      if (a) { const form = formField(s); head = { kind: 'attr', name: a.name, ...(form ? { form } : {}) }; at = a.from; }
      else if ((m = TAGS.exec(s))) {
        const last = m[0].trim().split('<').pop();
        head = { kind: 'xml', name: last.replace(/^!\[CDATA\[$/, 'CDATA').split(/[\s>]/)[0] };
        at = m[0].length;
      } else if ((m = TAG_RAN_ON.exec(s)) && m[0].length < s.length) { head = { kind: 'xml', name: 'wrapped tag' }; at = m[0].length; }
    }
    const rest = at ? s.slice(at) : s;
    let i = 0;
    while (i < rest.length && isBodyChar(rest.charCodeAt(i))) i++;
    const body = rest.slice(0, i).trim(), after = rest.slice(i);
    let soft = false, tail = null;
    if (after === '-') soft = true;
    else if (after) {
      if (ARMOR_END.test(after)) tail = 'armor';
      else if (after.startsWith('</')) tail = 'close-tag';
      else if (after[0] === '<') tail = 'xml';
      else if (after[0] === '"' || after[0] === "'") tail = 'quote';
      else if (after.startsWith(']]>')) tail = 'cdata';
      else if (after[0] === ')') tail = 'paren';
      else return { prose: true };
    }
    const tokens = body ? body.split(/\s+/) : [];
    const t = tokens.join('');
    if (t && !B64.test(t)) return { prose: true };
    if (!t && !head && !tail) return { prose: true };          // a lone '-'
    let weak = false;
    if (tokens.length > 1) {
      const sp = tokens.length - 1, cc = classChanges(t), longest = tokens.reduce((n, x) => Math.max(n, x.length), 0);
      if (fails) { if (sp >= 4 && cc < 0.3) return { prose: true }; }
      else if (t.length >= 30) { if (sp > t.length / 20 || longest < 12 || cc < 0.4) return { prose: true }; }
      else if (sp > 1 || longest < 6 || cc < 0.3) return { prose: true };
      else weak = true;
    }
    const off = at ? s.slice(0, at).replace(/\s+/g, '').length : 0;
    return { t, head, tail, soft, off, weak };
  }

  // A line as the finder sees it: its piece, and where its lost clusters sit
  // among the piece's characters. A cluster in the marker beside the body (the
  // '__' of `NAME="__VIEWSTATE"`) costs the body nothing.
  function readLine(L) {
    const raw = (L.text || '').replace(QUOTE, '').trim();
    const fails = L.fails ?? 0;
    if (!raw.includes(LOST)) {
      const q = pieceOf(raw, fails);
      return { q, lostAt: [], failing: q.t ? fails : 0 };
    }
    const q = pieceOf(raw.replaceAll(LOST, ' '), fails || 1);
    const lostAt = [];
    if (q.t != null) {
      let n = 0;
      for (const c of raw) {
        if (c === LOST) { const k = n - q.off; if (k >= 0 && k <= q.t.length) lostAt.push(k); }
        else if (c !== ' ' && c !== '\t') n++;
      }
    }
    return { q, lostAt, failing: lostAt.length };
  }

  // Why a line's characters are not certified, whatever they look like.
  const doubtOf = L => (L.edited ? 'edited by hand' : L.tol > 0 ? `read at tolerance ${L.tol}` : null);

  // ── wide glyphs ─────────────────────────────────────────────────────────
  // A base64 line has no spaces, so every pen step is the advance of the glyph
  // before it: narrower where the face kerns, never wider. A step wider than
  // its character's advance means a wider glyph stood there and the exact read
  // took a pixel SUBSET of it: an 'I' inside an 'L' whose foot is too light to
  // count as unexplained ink. The line is certified and wrong, so a file with
  // one is damaged here (tol0 settles them by reading the glyph again).

  // a certified line's body characters and pens; a step across a space is kept:
  // the space may be the reader's own, in the gap a wide glyph left
  function bodyPens(L, q) {
    if (!L.pens || L.fails || L.tol || L.edited || !q.t) return null;
    let k0 = 0;
    while (k0 < L.pens.length && L.pens[k0][0] === '>') k0++;
    const g = L.pens.slice(k0 + q.off, k0 + q.off + q.t.length);
    if (g.map(x => x[0]).join('') !== q.t) return null;
    return { t: q.t, pen: g.map(x => x[1]) };
  }

  // per character, the steps that hold at least 2 % of its glyphs: the ¼-px
  // lattice rounds one advance up or down, so two values
  function advances(read, lines) {
    const hist = new Map();
    read.forEach((r, i) => {
      const p = r.q.t && r.q.t.length >= 40 ? bodyPens(lines[i], r.q) : null;
      if (!p || !B64.test(p.t)) return;
      for (let k = 0; k + 1 < p.t.length; k++) {
        if (!hist.has(p.t[k])) hist.set(p.t[k], new Map());
        const h = hist.get(p.t[k]), st = p.pen[k + 1] - p.pen[k];
        h.set(st, (h.get(st) ?? 0) + 1);
      }
    });
    const usual = new Map();
    for (const [c, h] of hist) {
      const n = [...h.values()].reduce((x, y) => x + y, 0);
      usual.set(c, [...h].filter(([, k]) => k >= 0.02 * n).map(([st]) => st));
    }
    return usual;
  }

  // line index → [[k, step, candidates]]: k into the line's characters
  function wideGlyphs(read, lines) {
    const usual = advances(read, lines), out = new Map();
    read.forEach((r, i) => {
      const p = r.q.t && r.q.t.length >= 40 ? bodyPens(lines[i], r.q) : null;
      if (!p || !B64.test(p.t)) return;
      for (let k = 0; k + 1 < p.t.length; k++) {
        const u = usual.get(p.t[k]), st = p.pen[k + 1] - p.pen[k];
        if (!u?.length || st <= Math.max(...u) + 1) continue;
        const cands = [...usual].filter(([c, us]) => c !== p.t[k] && /^[A-Za-z0-9+/]$/.test(c) && us.includes(st)).map(([c]) => c);
        if (!cands.length) continue;
        if (!out.has(i)) out.set(i, []);
        out.get(i).push([k, st, cands]);
      }
    });
    return out;
  }

  // ── finding ─────────────────────────────────────────────────────────────

  // Would this base64 line open a NEW file? Its first bytes must carry a
  // sniffable header: text and unknown bytes say no.
  function startsNewFile(chars) {
    if (chars.length < 8) return false;
    try {
      return !['txt', 'bin', 'jpgpart', 'xml', 'json', 'html', 'eml'].includes(sniff(decode(chars.slice(0, 24))).ext);
    } catch { return false; }
  }

  // A line's characters with the lost ones put back as FILL where its clusters
  // sat: `want` characters in all, shared out evenly where there are several.
  // [chars, [[at, n], …]]
  function putBack(t, lostAt, want) {
    const lost = want - t.length;
    if (lost <= 0) return [t, []];
    let out = '', prev = 0, left = lost;
    const ranges = [];
    lostAt.forEach((k, i) => {
      const n = i === lostAt.length - 1 ? left : Math.min(left, Math.round(lost / lostAt.length));
      left -= n;
      out += t.slice(prev, k);
      prev = k;
      if (n) { ranges.push([out.length, n]); out += FILL.repeat(n); }
    });
    return [out + t.slice(prev), ranges];
  }

  // Reading-order lines [{ page, text, fails?, unread?, tol?, edited?, pens? }] → bodies
  // [{ chars, pages: [first, last], lines: [first, last], name, damage: [[char, n, why], …],
  //    suspects: [[char, candidates, why], …], width, padded, softWrapped?, opened, closed, declared }].
  //
  // Two passes. RUNS: consecutive base64 pieces (blank lines and page breaks
  // neutral), started by a strong clean line, ended by prose or padding.
  // LOGICAL LINES: a printer wraps a line wider than its page, so one 76-char
  // line of the e-mail can arrive as 75 + 1 or 73 + 3; pieces are summed back to
  // the body's width W (the commonest such sum). A logical line that comes out
  // short in the middle of a body lost characters: they are put back as FILL at
  // its end and recorded as damage, so every later byte keeps its place. A lost
  // band (unread) is one logical line of FILL. A body wrapped with the printer's
  // '-' has no width: the printer also breaks after a '/', anywhere, so a short
  // line there is not a short line (and a band lost inside it is a guess at the
  // commonest line's length, recorded as such). How the body is known to start
  // and end is kept in `opened` and `closed`; either is null where nothing shows it.
  function findBlocks(lines) {
    const read = lines.map(L => (L.unread ? { unread: true, q: {} } : readLine(L)));
    const wide = wideGlyphs(read, lines);
    const runs = [];
    let run = null, pending = null;                     // pending: a marker alone on the line above
    const flush = (why, text) => {
      if (run && (!run.head || run.strong)) {           // a marker opened it, nothing long followed: a short value, no body
        run.end = why;
        if (why === 'prose' && /^--\S{6,}$/.test((text || '').replace(QUOTE, '').trim())) run.closer = 'mime boundary';
        runs.push(run);
      }
      run = null;
    };
    const open = (i, head) => { run = { pieces: [], first: i, head: head ?? null, soft: false, strong: !head }; };
    // a closing marker counts where something opened it, or after a full line:
    // a quote or a bracket on any other line is punctuation
    const closing = (tail, t) => tail === 'armor' || isStrong(t) || (!!run?.head && (
      tail === 'close-tag' || tail === 'cdata' ? run.head.kind === 'xml'
      : tail === 'quote' ? run.head.kind === 'attr' || run.head.kind === 'data-uri'
      : tail === 'paren' ? run.head.kind === 'data-uri' : false));
    // the '=' of a line the read did not certify, a full line that opens no new file after it: a misread
    const misreadPad = (L, i) => {
      if (!(L.fails || doubtOf(L))) return false;
      for (let k = i + 1; k < read.length; k++) {
        if (read[k].unread || read[k].q.blank) continue;
        const t = read[k].q.t;
        return !!t && isStrong(t) && !startsNewFile(t);
      }
      return false;
    };
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i], r = read[i];
      if (r.unread) { if (run) run.pieces.push({ unread: true, i }); continue; }
      const q = r.q;
      if (q.blank) continue;
      // padding the printer wrapped onto a line of its own closes the body it belongs to
      if (run && /^={1,2}$/.test((L.text || '').replace(QUOTE, '').trim())) {
        run.pieces.push({ t: L.text.replace(QUOTE, '').trim(), q: { t: '', off: 0 }, r: { lostAt: [], failing: 0 }, i });
        run.padded = true; flush('padding'); pending = null; continue;
      }
      if (q.prose) { flush('prose', L.text); pending = null; continue; }
      const { t, tail } = q;
      if (q.head) {                                     // a marker opens a body here: whatever ran before it has ended
        flush('prose', L.text);
        pending = t ? null : q.head;
        if (!t || q.weak) continue;
        open(i, q.head);
      } else if (!run) {
        const from = pending && t && !tail ? pending : null;
        pending = null;
        if (!from && (!t || r.failing || !isStrong(t))) continue;   // a body starts on a clean, full line
        open(i, from);
      } else if (tail && !closing(tail, t)) { flush('prose', L.text); continue; }
      // a word's hyphen is no soft wrap: only a body already wrapped that way, or a full line, says so
      else if (q.soft && !run.soft && !run.head && !isStrong(t)) { flush('prose', L.text); continue; }
      if (t) {
        run.pieces.push({ t, q, r, i });
        if (isStrong(t)) run.strong = true;
        if (q.soft) run.soft = true;
      }
      if (tail) {
        if (t.endsWith('=')) run.padded = true;
        if (closing(tail, t)) run.tail = tail;
        flush('marker');
      } else if (t.endsWith('=') && !misreadPad(L, i)) { run.padded = true; flush('padding'); }
    }
    flush('end of document');

    const out = [];
    let floor = 0;
    // a line of quoted-printable ends in '=' as well: one such line, with another
    // beside it, is a mail's soft break and not a padded body of one line
    const softBreak = i => (lines[i]?.text ?? '').trim().endsWith('=');
    const besideOne = (i, step) => {
      for (let k = i + step; k >= 0 && k < lines.length; k += step) if ((lines[k].text ?? '').trim()) return softBreak(k);
      return false;
    };
    for (const r of runs) {
      while (r.pieces.length && r.pieces.at(-1).unread) r.pieces.pop();   // lost bands after the body are not the body's
      if (!r.pieces.length) continue;
      if (r.pieces.length === 1 && r.padded && (besideOne(r.pieces[0].i, -1) || besideOne(r.pieces[0].i, 1))) continue;
      const P = r.pieces.filter(p => !p.unread);
      const sums = new Map();
      for (let k = 0; k < P.length; k++) {
        if (P[k].r.failing || P[k].t.length < 20 || P[k].q.head || P[k].q.tail) continue;   // a line shared with a marker holds what is left of a line
        const nx = P[k + 1], n = P[k].t.length + (nx && !nx.r.failing && nx.t.length < 20 ? nx.t.length : 0);
        sums.set(n, (sums.get(n) || 0) + 1);
      }
      let W = 0, best = 0, all = 0;
      for (const [n, c] of sums) { all += c; if (c > best || (c === best && n > W)) { W = n; best = c; } }
      // a body sent as ONE unbroken line is re-flowed to the page by the printer,
      // no width to hold it to: it is taken as it reads
      const widest = W;                                 // what a lost line of a soft-wrapped body is taken to hold
      if (best < 0.6 * all || r.soft) W = 0;
      const form = r.head?.form ?? null;
      const b = { chars: '', damage: [], suspects: [], width: W, pages: null, lines: [r.first, r.first], name: null, count: 0, padded: !!r.padded, end: r.end,
        ...(r.soft ? { softWrapped: true } : {}) };
      let acc = 0, firstPage = null, lastPage = null;   // acc: characters of the current logical line so far
      const shortEnd = why => {                         // the logical line so far is all it will get
        const miss = W - acc;
        if (acc > 0 && miss > 0) { b.damage.push([b.chars.length, miss, why]); b.chars += FILL.repeat(miss); }
        acc = 0;
      };
      for (const p of r.pieces) {
        const L = lines[p.i];
        if (p.unread) {
          shortEnd('characters lost before a band nobody read');
          // a form field is not a file: nothing depends on the bytes keeping their place
          if (form) { b.damage.push([b.chars.length, 0, 'unread band']); continue; }
          if (r.soft && !W) { b.damage.push([b.chars.length, widest, 'unread band, its length a guess: what follows may be out of place']); b.chars += FILL.repeat(widest); continue; }
          b.damage.push([b.chars.length, W, 'unread band']); b.chars += FILL.repeat(W); continue;
        }
        let t = p.t;
        const want = W ? (W - acc >= t.length ? W - acc : t.length) : t.length;
        if (p.r.failing) {
          const at = p.r.lostAt;
          if (at.length) {
            // no width to say how many: a cluster is one glyph, as far as anyone can tell
            const [m, ranges] = putBack(t, at, W ? want : t.length + at.length);
            if (W && acc && acc + m.length > W) shortEnd('short line inside the body');
            for (const [a, n] of ranges) b.damage.push([b.chars.length + a, n, W ? 'unexplained cluster' : 'unexplained cluster, its length a guess']);
            if (!ranges.length) b.damage.push([b.chars.length, t.length, 'unexplained cluster, place unknown']);
            t = m;
          } else {
            const m = t + FILL.repeat(Math.max(0, want - t.length));
            if (W && acc && acc + m.length > W) shortEnd('short line inside the body');
            b.damage.push([b.chars.length, m.length, 'unexplained cluster, place unknown']);
            t = m;
          }
        }
        if (W && acc && acc + t.length > W) shortEnd('short line inside the body');
        const doubt = doubtOf(L);
        if (doubt) b.damage.push([b.chars.length, t.length, doubt]);
        else if (t === p.t) for (const [k, st, cands] of wide.get(p.i) ?? [])
          b.suspects.push([b.chars.length + k, cands, `'${t[k]}' read where the pen steps ${st} px: a wider glyph`]);
        b.chars += t; b.count++;
        b.lines[1] = p.i;
        firstPage ??= L.page; lastPage = L.page;
        acc += t.length;
        if (p.q.head) acc = 0;                          // what is left of a line after a marker: the next one starts fresh
        if (W && acc >= W) acc = acc === W ? 0 : acc % W;
      }
      if (b.chars.length < MIN_BODY) continue;
      b.pages = [firstPage, lastPage];
      b.declared = declared(lines, r.first, floor);
      // right under a part that says it is not base64: the text of that part
      if (b.declared.near && b.declared.encoding !== 'base64' && !r.head) continue;
      if (r.head) {
        // what stands above a marker is no part's header: a `name=` there belongs to some other element
        if (!b.declared.near) for (const k of ['name', 'filename', 'type', 'charset', 'encoding']) delete b.declared[k];
        b.declared.marker = r.head.kind;
        if (r.head.kind === 'xml' || r.head.kind === 'attr') b.declared.element = r.head.name;
        if (r.head.kind === 'armor') b.declared.armor = r.head.name;
        if (r.head.type && !b.declared.type) b.declared.type = r.head.type.toLowerCase();
      }
      // ASP.NET's own state, wherever its marker went: a serialized page, not a file
      const state = form ?? (/^\/?wE[PWdT]/.test(b.chars) && !b.declared.encoding && !b.declared.type && !b.declared.name ? 'ASP.NET state' : null);
      if (state) b.declared.form = state;
      b.opened = r.head ? `marker: ${r.head.kind}` : b.declared.encoding === 'base64' && b.declared.near ? 'mime header' : b.declared.vcard ? 'vcard property' : null;
      b.closed = r.padded ? 'padding' : r.tail && r.tail !== 'xml' ? `marker: ${r.tail}` : r.closer ?? (W && acc > 0 ? 'short last line' : null);
      delete b.declared.near;
      b.name = b.declared.name ?? null;
      floor = b.lines[1] + 1;
      out.push(b);
    }
    return out;
  }

  // the lines a part's headers can take below its Content-Transfer-Encoding:
  // another header, a parameter, a name wrapped onto a line of its own. Prose has spaces.
  const HEADERISH = /^[\w-]+\s*:|^[\w*-]+\s*=|^\S+$/;

  // the MIME headers that declare a body: the nearest ones above it, no further
  // up than the previous body. A header the reader wrapped ("attachment;" then
  // 'filename="…"' on the next line) is found on its own line.
  function declared(lines, start, floor) {
    const d = {};
    let encodingAt = -1;
    const textAt = i => (lines[i]?.text || '').replace(QUOTE, '').trim();
    for (let i = start - 1; i >= Math.max(floor, start - 40); i--) {
      const t = textAt(i);
      const next = i + 1 < start ? textAt(i + 1) : '';
      const joined = t + ' ' + next;
      // the header itself, not its name in a DKIM signature's list of signed headers (`h=…content-transfer-encoding:message-id:…`)
      if (!d.encoding) { const m = /^content-transfer-encoding\s*:\s*([\w-]+)/i.exec(t); if (m) { d.encoding = m[1].toLowerCase(); encodingAt = i; } }
      if (!d.type) { const m = /content-type\s*:\s*([\w.+-]+\/[\w.+-]+)/i.exec(t); if (m) d.type = m[1].toLowerCase(); }
      if (!d.charset) { const m = /charset\s*=\s*"?([\w.-]+)/i.exec(joined); if (m) d.charset = m[1].toLowerCase(); }
      if (!d.filename) { const m = /\bfilename\*?\s*=\s*(?:"([^"]+)"?|([^\s";]+))/i.exec(joined); if (m) d.filename = (m[1] ?? m[2]).trim(); }
      if (!d.name) { const m = /(?:^|[\s;])name\*?\s*=\s*(?:"([^"]+)"?|([^\s";]+))/i.exec(joined); if (m) d.name = (m[1] ?? m[2]).trim(); }
      if (!d.vcard) { const m = /^(PHOTO|LOGO|SOUND|KEY)[;:].*ENCODING=b/i.exec(t); if (m) d.vcard = m[1].toUpperCase(); }
      if (/^--\S{6,}$/.test(t) && (d.type || d.encoding)) break;   // the part's boundary: its headers are below it
    }
    const name = cleanName(d.filename || d.name);
    // the header stands right above the body, nothing but headers between: it declares THIS body
    let near = encodingAt >= 0;
    for (let i = encodingAt + 1; near && i < start; i++) {
      const t = textAt(i);
      if (t && !HEADERISH.test(t)) near = false;
    }
    return { ...d, name: name || undefined, near };
  }

  // A declared name made safe to save under: RFC 2231's charset'' prefix and
  // %-escapes undone, RFC 2047's =?utf-8?…?= words decoded, no path, no
  // characters a file system refuses.
  function cleanName(raw) {
    if (!raw) return null;
    let n = raw.trim().replace(/"+$/, '');
    const ext = n.match(/^[\w-]+'[\w-]*'(.*)$/);
    if (ext) { try { n = decodeURIComponent(ext[1]); } catch { n = ext[1]; } }
    n = n.replace(/=\?([\w-]+)\?([bq])\?([^?]*)\?=/gi, (m, cs, enc, txt) => {
      try {
        const bin = enc.toLowerCase() === 'b' ? atob(txt)
          : txt.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
        return new TextDecoder(/^utf-?8$/i.test(cs) ? 'utf-8' : 'latin1').decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
      } catch { return m; }
    });
    n = n.split(/[\\/]/).pop().replace(/[:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
    return n && n.length <= 200 ? n : null;
  }

  // A decoded text file's lines, as findBlocks takes them: no pens, no
  // certificates, what the file says it says. A tag starts a new line, so a
  // form saved as one long line is read element by element.
  function textLines(bytes, page = 0) {
    const out = [];
    for (const line of latin1(bytes, 0, bytes.length).split(/\r\n|\r|\n/)) {
      if (line.length < 200 || !line.includes('<')) out.push({ page, text: line });
      else for (const part of line.split(/(?=<)/)) out.push({ page, text: part });
    }
    return out;
  }

  // ── decoding ────────────────────────────────────────────────────────────

  function decode(chars) {
    // Only TRAILING padding is stripped; an '=' mid-stream is a misread —
    // swapped for 'A' so every later byte stays where it is (cost: 1–2
    // wrong bytes at the misread, not a ruined tail).
    let s = chars.replace(/=+$/, '').replace(/=/g, 'A');
    if (s.length % 4 === 1) s = s.slice(0, -1);       // a stray character
    s += '='.repeat((4 - s.length % 4) % 4);
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // ── type sniffing ───────────────────────────────────────────────────────

  // bytes [i, i + len) as Latin-1, in chunks (a spread of a big array
  // overflows the call stack)
  function latin1(bytes, i, len) {
    const end = Math.min(bytes.length, i + len);
    let s = '';
    for (let k = i; k < end; k += 8192) s += String.fromCharCode(...bytes.subarray(k, Math.min(end, k + 8192)));
    return s;
  }

  // The share of the first `limit` bytes that is text: printable ASCII, tab,
  // line breaks, and well-formed UTF-8 sequences. A lone high byte is not
  // text — counting every byte ≥ 128 as printable would pass most random
  // binary (226 of 256 byte values) as a text file.
  function textShare(bytes, limit = 4096) {
    const n = Math.min(bytes.length, limit);
    let good = 0;
    for (let i = 0; i < n;) {
      const c = bytes[i];
      if (c === 9 || c === 10 || c === 12 || c === 13 || (c >= 32 && c < 127)) { good++; i++; continue; }
      const len = c >= 0xC2 && c <= 0xDF ? 2 : c >= 0xE0 && c <= 0xEF ? 3 : c >= 0xF0 && c <= 0xF4 ? 4 : 0;
      let ok = len > 0 && i + len <= bytes.length;
      for (let k = 1; ok && k < len; k++) ok = bytes[i + k] >= 0x80 && bytes[i + k] <= 0xBF;
      if (ok) {                                       // no overlong forms, no surrogates, nothing past U+10FFFF
        const c1 = bytes[i + 1];
        ok = !(c === 0xE0 && c1 < 0xA0) && !(c === 0xED && c1 > 0x9F) && !(c === 0xF0 && c1 < 0x90) && !(c === 0xF4 && c1 > 0x8F);
      }
      if (ok) { good += Math.min(len, n - i); i += len; } else i++;
    }
    return n ? good / n : 0;
  }

  // An MPEG audio stream with no ID3 tag: a frame header at 0 AND another one
  // exactly a frame later. A lone 0xFFEx pair is 1 in 2,000 of random bytes.
  function mpegFrames(b) {
    const BR = { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
    const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
    const frameLen = o => {
      if (o + 4 > b.length || b[o] !== 0xFF || (b[o + 1] & 0xE0) !== 0xE0) return 0;
      const ver = (b[o + 1] >> 3) & 3, layer = (b[o + 1] >> 1) & 3, bri = b[o + 2] >> 4, sri = (b[o + 2] >> 2) & 3, pad = (b[o + 2] >> 1) & 1;
      if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) return 0;      // Layer III only
      const kbps = (ver === 3 ? BR[1] : BR[2])[bri], sr = SR[ver][sri];
      return Math.floor((ver === 3 ? 144 : 72) * kbps * 1000 / sr) + pad;
    };
    const n = frameLen(0);
    return n > 0 && frameLen(n) > 0;
  }

  // Magic bytes → { mime, ext, label, icon (a Material Symbols name), view }.
  function sniff(bytes) {
    const at = (i, ...vals) => vals.every((v, k) => bytes[i + k] === v);
    const str = (i, len) => latin1(bytes, i, len);
    const has = (needle, limit) => str(0, limit).includes(needle);
    const t = (mime, ext, label, icon, view = 'inline') => ({ mime, ext, label, icon, view });

    // documents
    if (str(0, 4) === '%PDF') return t('application/pdf', 'pdf', 'PDF', 'picture_as_pdf');
    if (str(0, 5) === '{\\rtf') return t('application/rtf', 'rtf', 'RTF document', 'description', 'text');
    if (at(0, 0xD0, 0xCF, 0x11, 0xE0)) return t('application/msword', 'doc', 'Office document (legacy)', 'description', 'none');

    // images
    if (at(0, 0x89, 0x50, 0x4E, 0x47)) return t('image/png', 'png', 'PNG image', 'image');
    if (at(0, 0xFF, 0xD8, 0xFF)) return t('image/jpeg', 'jpg', 'JPEG image', 'image');
    if (at(0, 0x47, 0x49, 0x46, 0x38)) return t('image/gif', 'gif', 'GIF image', 'image');
    if (at(0, 0x42, 0x4D) && bytes.length > 26) return t('image/bmp', 'bmp', 'BMP image', 'image');
    if (at(0, 0x00, 0x00, 0x01, 0x00)) return t('image/x-icon', 'ico', 'Icon', 'image');
    if (at(0, 0x49, 0x49, 0x2A, 0x00) || at(0, 0x4D, 0x4D, 0x00, 0x2A))
      return t('image/tiff', 'tif', 'TIFF image', 'image', 'none');   // browsers don't render TIFF

    // RIFF container: WebP / WAV / AVI
    if (str(0, 4) === 'RIFF') {
      const kind = str(8, 4);
      if (kind === 'WEBP') return t('image/webp', 'webp', 'WebP image', 'image');
      if (kind === 'WAVE') return t('audio/wav', 'wav', 'WAV audio', 'audio_file');
      if (kind === 'AVI ') return t('video/x-msvideo', 'avi', 'AVI video', 'video_file', 'none');
      return t('application/octet-stream', 'riff', 'RIFF file', 'attach_file', 'none');
    }

    // ISO media (an ftyp box): m4a / mp4 / mov / heic / avif
    if (str(4, 4) === 'ftyp') {
      const brand = str(8, 4);
      if (brand.startsWith('M4A')) return t('audio/mp4', 'm4a', 'M4A audio', 'audio_file');
      if (brand.startsWith('M4B')) return t('audio/mp4', 'm4b', 'M4B audiobook', 'audio_file');
      if (brand.startsWith('qt')) return t('video/quicktime', 'mov', 'QuickTime video', 'video_file');
      if (brand === 'avif' || brand === 'avis') return t('image/avif', 'avif', 'AVIF image', 'image');
      if (brand.startsWith('hei') || brand === 'mif1') return t('image/heic', 'heic', 'HEIC image', 'image', 'none');
      return t('video/mp4', 'mp4', 'MP4 video', 'video_file');
    }

    // audio
    if (str(0, 3) === 'ID3' || mpegFrames(bytes))
      return t('audio/mpeg', 'mp3', 'MP3 audio', 'audio_file');
    if (str(0, 4) === 'OggS') return t('audio/ogg', 'ogg', 'Ogg audio', 'audio_file');
    if (str(0, 4) === 'fLaC') return t('audio/flac', 'flac', 'FLAC audio', 'audio_file');
    if (str(0, 4) === '#!AM') return t('audio/amr', 'amr', 'AMR audio', 'audio_file', 'none');

    // video (EBML: WebM or Matroska)
    if (at(0, 0x1A, 0x45, 0xDF, 0xA3))
      return has('webm', 64) ? t('video/webm', 'webm', 'WebM video', 'video_file')
        : t('video/x-matroska', 'mkv', 'Matroska video', 'video_file', 'none');

    // archives — OOXML and EPUB are ZIPs whose member paths show early on
    if (str(0, 2) === 'PK') {
      const head = str(0, 4096);
      if (head.includes('word/')) return t('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx', 'Word document', 'description', 'none');
      if (head.includes('xl/')) return t('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx', 'Excel spreadsheet', 'table_chart', 'none');
      if (head.includes('ppt/')) return t('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx', 'PowerPoint', 'slideshow', 'none');
      if (head.includes('mimetypeapplication/epub')) return t('application/epub+zip', 'epub', 'EPUB book', 'menu_book', 'none');
      return t('application/zip', 'zip', 'ZIP archive', 'folder_zip', 'none');
    }
    if (at(0, 0x37, 0x7A, 0xBC, 0xAF)) return t('application/x-7z-compressed', '7z', '7-Zip archive', 'folder_zip', 'none');
    if (str(0, 4) === 'Rar!') return t('application/vnd.rar', 'rar', 'RAR archive', 'folder_zip', 'none');
    if (at(0, 0x1F, 0x8B)) return t('application/gzip', 'gz', 'Gzip archive', 'folder_zip', 'none');
    if (str(0, 3) === 'BZh') return t('application/x-bzip2', 'bz2', 'Bzip2 archive', 'folder_zip', 'none');
    if (str(257, 5) === 'ustar') return t('application/x-tar', 'tar', 'TAR archive', 'folder_zip', 'none');

    // DER: a CMS message by its OID, anything else only if its length is the whole file
    const der = derInfo(bytes);
    if (der) {
      if (!der.cms) return t('application/x-x509-ca-cert', 'der', 'DER data', 'key', 'none');
      const k = t('application/pkcs7-mime', 'p7m', `CMS ${der.cms}${der.encrypted ? ', encrypted' : ''}`, der.encrypted ? 'lock' : 'verified', 'none');
      return der.encrypted ? { ...k, encrypted: true } : k;
    }
    if (at(0, 0xFF, 0x01)) return t('application/octet-stream', 'viewstate', 'ASP.NET form state', 'attach_file', 'none');

    // text — markup is viewed as text/plain, so it can never run
    if (bytes.length && textShare(bytes) > 0.9) {
      const head = str(0, 512).trimStart().toLowerCase();
      if (head.startsWith('<?xml'))
        return has('<svg', 2048) ? t('image/svg+xml', 'svg', 'SVG image', 'code', 'text')
          : t('application/xml', 'xml', 'XML file', 'code', 'text');
      if (head.startsWith('<svg')) return t('image/svg+xml', 'svg', 'SVG image', 'code', 'text');
      if (/^(<!doctype html|<html|<head|<body|<div|<p[\s>]|<table|<meta|<style|<!--)/.test(head) || /<html[\s>]/.test(head))
        return t('text/html', 'html', 'HTML file', 'code', 'text');
      if (head.startsWith('begin:vcalendar')) return t('text/calendar', 'ics', 'Calendar invitation', 'event', 'text');
      if (head.startsWith('begin:vcard')) return t('text/vcard', 'vcf', 'vCard', 'contact_page', 'text');
      if ((head.startsWith('{') || head.startsWith('[')) && bytes.length <= 4 << 20) {
        try { JSON.parse(new TextDecoder().decode(bytes)); return t('application/json', 'json', 'JSON file', 'data_object', 'text'); }
        catch { /* not JSON — plain text */ }
      }
      if (/^(from|received|return-path|mime-version|date|subject|delivered-to|x-[\w-]+):/.test(head))
        return t('message/rfc822', 'eml', 'Email message', 'mail', 'text');
      return t('text/plain', 'txt', 'Text file', 'article');
    }
    // the middle of a JPEG: entropy-coded scan data, where every 0xFF is stuffed
    // (FF 00) or a restart marker (FF D0–D7) — a body whose printout starts
    // mid-attachment still says what it is
    let ff = 0, stuffed = 0;
    for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 0xFF) { ff++; const n = bytes[i + 1]; if (n === 0 || (n >= 0xD0 && n <= 0xD7) || n === 0xD9) stuffed++; }
    if (ff >= 8 && stuffed >= 0.97 * ff) return t('application/octet-stream', 'jpgpart', 'JPEG scan data, no header', 'image', 'none');
    return t('application/octet-stream', 'bin', 'File', 'attach_file', 'none');
  }

  // ── containers and DER ──────────────────────────────────────────────────

  // An attachment in an InfoPath form: 4-byte signature, then u32 header size,
  // version, reserved, file size, name length in UTF-16 characters, the name,
  // the file. → { offset, size, name } or null
  function infoPath(b) {
    if (b.length < 24 || b[0] !== 0xC7 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x41) return null;
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const headerSize = v.getUint32(4, true), size = v.getUint32(16, true), chars = v.getUint32(20, true);
    if (headerSize !== 20 || chars > 4096 || 24 + 2 * chars > b.length) return null;
    return { offset: 24 + 2 * chars, size, name: new TextDecoder('utf-16le').decode(b.subarray(24, 24 + 2 * chars)).replace(/\0+$/, '') };
  }

  const CMS = { 1: ['Data', false], 2: ['SignedData', false], 3: ['EnvelopedData', true], 5: ['DigestedData', false], 6: ['EncryptedData', true] };
  const PKCS7 = [0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07];     // 1.2.840.113549.1.7

  // a tag and length at i → { len (null: indefinite), value } or null
  function tlv(b, i) {
    if (i + 2 > b.length || (b[i] & 0x1F) === 0x1F) return null;      // no multi-byte tags in anything read here
    const first = b[i + 1];
    if (first < 0x80) return { len: first, value: i + 2 };
    if (first === 0x80) return { len: null, value: i + 2 };
    const n = first & 0x7F;
    if (n > 4 || i + 2 + n > b.length) return null;
    let len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + b[i + 2 + k];
    return { len, value: i + 2 + n };
  }

  // the outer object: what it says it is, and how long it says it is
  function derInfo(b) {
    if (b.length < 16 || b[0] !== 0x30) return null;
    const outer = tlv(b, 0);
    if (!outer) return null;
    const child = tlv(b, outer.value);
    if (!child || child.len === null) return null;
    const total = outer.len === null ? null : outer.value + outer.len;
    if (b[outer.value] === 0x06 && child.len === 9 && PKCS7.every((x, k) => b[child.value + k] === x) && CMS[b[child.value + 8]]) {
      const [name, encrypted] = CMS[b[child.value + 8]];
      return { total, cms: name, encrypted };
    }
    // no name: a SEQUENCE of a SEQUENCE (a certificate, a key) only if its length is the whole file
    return b[outer.value] === 0x30 && total === b.length ? { total, cms: null, encrypted: false } : null;
  }

  // every length inside the object nests: → null, or what is wrong and where
  function derWalk(b, start, end, depth = 0) {
    let i = start;
    while (i < end) {
      if (b[i] === 0 && b[i + 1] === 0) return i + 2 === end || depth ? { eoc: i + 2 } : `stray end-of-contents at ${i}`;   // BER's end of an indefinite length
      const h = tlv(b, i);
      if (!h) return `no length at byte ${i}`;
      const stop = h.len === null ? end : h.value + h.len;
      if (stop > end) return `an object at byte ${i} runs past its parent`;
      if ((b[i] & 0x20) && depth < 40) {
        const r = derWalk(b, h.value, stop, depth + 1);
        if (typeof r === 'string') return r;
        if (h.len === null) { if (!r?.eoc) return `an open object at byte ${i} never ends`; i = r.eoc; continue; }
      } else if (h.len === null) return `an open primitive at byte ${i}`;
      i = stop;
    }
    return null;
  }

  // ── is it whole? ────────────────────────────────────────────────────────

  let crcTable = null;
  function crc32(b, from, to) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    }
    let c = 0xFFFFFFFF;
    for (let i = from; i < to; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // every chunk's CRC-32, up to IEND
  function pngCheck(b) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 8; ;) {
      if (i + 12 > b.length) return { ok: false, tool: 'png', note: 'no IEND chunk: cut short' };
      const n = v.getUint32(i), end = i + 8 + n;
      if (end + 4 > b.length) return { ok: false, tool: 'png', note: 'a chunk runs past the end: cut short' };
      if (crc32(b, i + 4, end) !== v.getUint32(end)) return { ok: false, tool: 'png', note: `a chunk's CRC fails at byte ${i}` };
      if (latin1(b, i + 4, 4) === 'IEND') return { ok: true, tool: 'png', note: 'every chunk\'s CRC passes' };
      i = end + 4;
    }
  }

  const holds = (b, needle, from = 0) => {
    outer: for (let i = Math.max(0, from); i + needle.length <= b.length; i++) {
      for (let k = 0; k < needle.length; k++) if (b[i + k] !== needle[k]) continue outer;
      return true;
    }
    return false;
  };
  const ZIP_END = [0x50, 0x4B, 0x05, 0x06];
  const ZIPS = new Set(['zip', 'docx', 'xlsx', 'pptx', 'epub']);

  // What the bytes alone can say about a format's end. { ok: null } where they can't.
  function check(b, kind) {
    const e = kind.ext;
    if (e === 'p7m' || e === 'der') {
      const d = derInfo(b), what = d?.cms ? `CMS ${d.cms}` : 'DER';
      if (!d || d.total === null) return { ok: null, tool: 'der', note: `${what}: an open outer length says nothing about the end` };
      if (d.total > b.length) return { ok: false, tool: 'der', note: `${what}: outer length says ${d.total} bytes, the body holds ${b.length}` };
      if (d.total < b.length) return { ok: null, tool: 'der', note: `${what}: outer length says ${d.total} bytes, ${b.length - d.total} more follow` };
      const wrong = derWalk(b, 0, b.length);
      return wrong ? { ok: false, tool: 'der', note: `${what}: ${wrong}` } : { ok: true, tool: 'der', note: `${what}: outer length is the whole body, every inner length nests` };
    }
    if (e === 'png') return pngCheck(b);
    if (e === 'jpg' && !holds(b, [0xFF, 0xD9])) return { ok: false, tool: 'jpeg', note: 'no end marker' };
    if (e === 'pdf' && !holds(b, [0x25, 0x25, 0x45, 0x4F, 0x46])) return { ok: false, tool: 'pdf', note: 'no %%EOF' };
    if (ZIPS.has(e) && !holds(b, ZIP_END, b.length - 66000)) return { ok: false, tool: 'zip', note: 'no end of central directory' };
    return { ok: null, tool: null, note: '' };
  }

  // the format's own last bytes, at the end of the body
  function formatEnd(ext, b) {
    const tail = latin1(b, Math.max(0, b.length - 1024), 1024);
    if (ext === 'html') return /<\/html>\s*$/i.test(tail);
    if (ext === 'rtf') return /\}[\s\0]*$/.test(tail);
    if (ext === 'pdf') return /%%EOF\s*$/.test(tail);
    if (ext === 'jpg') return /\xFF\xD9[\0\s]*$/.test(tail);
    if (ext === 'gif') return tail.endsWith('\x3B');
    if (ZIPS.has(ext)) return holds(b, ZIP_END, b.length - 66000);
    return false;
  }

  const NOT_A_START = new Set(['txt', 'jpgpart', 'bin', 'viewstate']);

  // What a decoded body may be called. Every character it holds is certified
  // unless `damaged` says otherwise; what is left to ask is whether the body is
  // the whole file. b: from findBlocks; kind: sniff; c: check; bytes: the file's
  // size; wrap: a container's { size }; surplus: bytes past that size.
  // → { status, start, end, why }
  function verdict({ b, kind, c, damaged = false, bytes, wrap = null, surplus = 0, formatEnd: atEnd = false }) {
    const start = b.opened ?? (wrap ? 'attachment header' : !NOT_A_START.has(kind.ext) ? 'magic number' : null);
    const end = wrap && !surplus && bytes === wrap.size ? 'declared size' : atEnd ? 'format end' : wrap ? null : b.closed ?? null;
    const out = (status, why) => ({ status, start, end, why });
    if (damaged) return out('damaged', typeof damaged === 'string' ? damaged : 'some characters were not read');
    if (c?.ok === false) return out('incomplete', c.note || 'the format refuses it');
    if (wrap && bytes < wrap.size) return out('incomplete', `${bytes} of ${wrap.size} declared bytes`);
    if (kind.ext === 'jpgpart') return out('incomplete', 'starts mid-attachment: scan data with no JPEG header');
    if (c?.ok === true) return out('exact', c.note);
    if (!b.padded && b.chars.length % 4 !== 0) return out('incomplete', 'the last base64 group is not whole: cut short');
    if (start && end) return out('exact', `opens by ${start}, ends by ${end}`);
    return out('unproven', `no check covers it; ${start ? `opens by ${start}` : 'nothing shows where it starts'}, ${end ? `ends by ${end}` : 'nothing shows where it ends'}`);
  }

  // ── from lines to what the panel lists ──────────────────────────────────

  const CAN_HOLD_MORE = new Set(['txt', 'html', 'xml', 'svg', 'eml', 'ics', 'vcf']);

  function whyDamaged(b) {
    const parts = [];
    const shown = new Set();
    for (const [, n, why] of b.damage) { const k = why.split(':')[0]; if (n && !shown.has(k)) { shown.add(k); parts.push(k); } }
    if (b.suspects.length) parts.push(`${b.suspects.length} glyph${b.suspects.length > 1 ? 's' : ''} wider than read`);
    return parts.length ? `not certified: ${parts.join('; ')}` : 'not certified';
  }

  // One body → what the panel lists; a file that holds more base64 gives the
  // inner bodies their own entries the same way.
  // files: [{ data, kind, name, pages, chars, status, why, start, end, encrypted, declaredSize, parent }]
  // others: [{ what: 'form data' | 'header value', field?, kind, bytes, pages }]
  function emit(b, x, out) {
    const bytes = decode(b.chars);
    const wrap = infoPath(bytes), off = wrap?.offset ?? 0;
    const kind = sniff(off ? bytes.subarray(off) : bytes);
    const pages = x.pages ?? b.pages;
    // a web form's hidden field: the page's own state, not an attachment
    const form = b.declared.form ?? (kind.ext === 'viewstate' ? 'ASP.NET state' : null);
    if (form) { out.others.push({ what: 'form data', field: form, kind, bytes: bytes.length, pages }); return; }
    // a short base64 value that no MIME part or marker opens is a HEADER's value —
    // a DKIM signature, an Exchange diagnostics blob — not a file
    if (!b.opened && !b.declared.name && !wrap && bytes.length < 1024 && kind.ext === 'bin') {
      out.others.push({ what: 'header value', kind, bytes: bytes.length, pages }); return;
    }
    const data = wrap ? bytes.subarray(off, Math.min(bytes.length, off + wrap.size)) : bytes;
    const surplus = wrap ? Math.max(0, bytes.length - off - wrap.size) : 0;
    const damaged = b.damage.some(d => d[1]) || b.suspects.length ? whyDamaged(b) : x.parentDamaged ? 'the file it is inside is damaged' : false;
    const v = verdict({ b, kind, c: check(data, kind), damaged, bytes: data.length, wrap, surplus, formatEnd: formatEnd(kind.ext, data) });
    const element = x.parent && b.declared.element ? b.declared.element.replace(/[^\w.-]+/g, '-') : null;
    const name = (wrap?.name && cleanName(wrap.name)) || b.declared.name || (element ? `${element}.${kind.ext}` : null);
    const file = { data, kind, name, pages, chars: b.chars.length, status: v.status, why: v.why, start: v.start, end: v.end,
      ...(kind.encrypted ? { encrypted: true } : {}), ...(wrap ? { declaredSize: wrap.size } : {}), ...(x.parent ? { parent: x.parent } : {}) };
    out.files.push(file);
    // more base64 in what it turned out to hold
    if (CAN_HOLD_MORE.has(kind.ext) && x.depth < 3) {
      // inside a file nothing is certified but the file: only what a marker opens, or long enough not to be a name
      const inner = findBlocks(textLines(data, pages[0])).filter(q => q.opened?.startsWith('marker') || q.chars.length >= 256);
      for (const q of inner) emit(q, { depth: x.depth + 1, pages, parent: name ?? kind.label, parentDamaged: v.status === 'damaged' }, out);
    }
  }

  // Reading-order lines → { files, others }.
  function examine(lines) {
    const out = { files: [], others: [] };
    for (const b of findBlocks(lines)) {
      try { emit(b, { depth: 0 }, out); } catch { /* a body that does not decode lists nothing */ }
    }
    return out;
  }

  // The OCR layer's boxes → reading-order lines with what the read knows of
  // each. Segments of one printed line (a redaction split, a change of face)
  // share a lineId and are joined left to right. Only 'ocr' boxes count: the
  // embedded layer is another OCR's text and nothing in it is certified.
  function linesFromBoxes(boxes) {
    const byLine = new Map();
    for (const b of boxes) {
      if (b.type !== 'ocr' || !(b.ocr?.unread || (b.text || '').trim())) continue;
      const key = `${b.page}|${b.lineId ?? `${b.y}|${b.x}`}`;
      if (!byLine.has(key)) byLine.set(key, []);
      byLine.get(key).push(b);
    }
    const rows = [...byLine.values()].map(segs => segs.sort((a, b) => a.x - b.x));
    rows.sort((a, b) => (a[0].page - b[0].page) || (a[0].y - b[0].y) || (a[0].x - b[0].x));
    return rows.map(segs => {
      const page = segs[0].page;
      if (segs.some(s => s.ocr?.unread)) return { page, unread: true, text: '' };
      const L = { page, text: segs.map(s => s.text).join(' '), fails: 0, tol: 0, pens: [] };
      for (const s of segs) {
        const entries = s.ocr?.entries;
        const read = entries?.map(e => e.ch).join('').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl');
        // the box's text is no longer what the reader read
        if (read == null || read !== (s.text || '').replace(/\s+/g, '')) L.edited = true;
        L.fails += s.ocr?.fails ?? 0;
        L.tol = Math.max(L.tol, s.ocr?.tol ?? 0);
        for (const e of entries ?? []) if (e.ch !== LOST && e.ch !== ' ') L.pens.push([e.ch, e.pen]);
      }
      return L;
    });
  }

  // The type a View opens a block as: its own for 'inline', plain text for
  // 'text' (and UTF-8 for any text), nothing for 'none'.
  function viewMime(kind) {
    if (kind.view === 'none') return null;
    if (kind.view === 'text' || kind.mime === 'text/plain') return 'text/plain;charset=utf-8';
    return kind.mime;
  }

  function formatSize(n) {
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }

  globalThis.B64Core = { findBlocks, examine, linesFromBoxes, pieceOf, classChanges, decode, sniff, check, verdict, infoPath, derInfo, cleanName, textLines, textShare, viewMime, formatSize };
})();
