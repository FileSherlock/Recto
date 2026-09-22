// etv-fetch.js — Embedded Text Viewer: chunked span extraction and lifecycle hooks.
// Spans come from extract.js (this plugin's port of the server's extractor)
// over the core's raw primitive, Doc.structuredText — nothing is fetched.
// Cross-module calls into text_tool (utbState, spanToUnified, renderAllTextLayers, etc.)
// only happen inside event handlers and async continuations, so the fact that
// text_tool scripts load after this one is safe.
//
// Two tiers keep huge documents affordable:
//   1. A background loop extracts LEAN spans (text, geometry, size, font; no
//      per-character data) for every page in fixed chunks. This is
//      the whole document's text at roughly a tenth of the full payload —
//      enough for any plugin that *scans* text, via window.etvSpanCache.
//   2. FULL spans (with per-character positions) are extracted one page at a
//      time, the moment that page is rendered, and turned straight into
//      UnifiedTextBoxes ("hydration"). Boxes therefore exist only for pages
//      the user has visited — memory follows behavior, not document size.

const ETV_CHUNK_FIRST = 12;   // small first chunk: quick coverage of the opening pages
const ETV_CHUNK = 100;        // steady-state pages per background batch

const _utbFetchState = {
  fetched: false,        // every page's lean spans are cached for this document
  pagesHash: null,       // state.docHash the cache belongs to
  pages: new Map(),      // page -> JSON string of that page's LEAN spans
  hydrated: new Set(),   // pages whose full boxes currently exist in utbState
  inflight: new Set(),   // request keys ("lean:<start>" / "full:<page>") in the air
  basePt: null,          // document body size, from the first non-empty batch
  baseApplied: false,    // one-time font-select sync + redaction renorm ran
  anyText: false,        // at least one cached page has embedded text
};

// Fixed chunk grid so background requests never overlap: [1..12], [13..112], …
function etvChunkStart(p) {
  return p <= ETV_CHUNK_FIRST
    ? 1
    : ETV_CHUNK_FIRST + 1 + Math.floor((p - ETV_CHUNK_FIRST - 1) / ETV_CHUNK) * ETV_CHUNK;
}
function etvChunkCount(start) { return start === 1 ? ETV_CHUNK_FIRST : ETV_CHUNK; }

function etvCacheValid() { return _utbFetchState.pagesHash === state.docHash; }

function etvChunkCached(start, count) {
  const last = Math.min(start + count - 1, state.numPages || 1);
  for (let p = start; p <= last; p++) {
    if (!_utbFetchState.pages.has(p)) return false;
  }
  return true;
}

function etvLeanOf(span) {
  return { page: span.page, text: span.text, x: span.x, y: span.y,
           w: span.w, h: span.h, sizePt: span.sizePt, font: span.font };
}

// ── Normalization (was: the single-shot fetch's preamble) ─────
// The document's body size is the median of the first non-empty batch — a
// stable sample — and every later batch snaps to it, so all batches agree.

function etvNormalize(spans) {
  if (!spans.length) return;

  if (_utbFetchState.basePt === null) {
    const ptSizes = spans.map(s => s.sizePt).sort((a, b) => a - b);
    _utbFetchState.basePt = Math.round(ptSizes[Math.floor(ptSizes.length / 2)]);
  }
  const documentBasePt = _utbFetchState.basePt;

  const fontCounts = {};
  let maxCount = 0;
  let mostUsedFont = 'Times New Roman';

  spans.forEach(span => {
    const pt = span.sizePt;
    span.sizePt = Math.abs(pt - documentBasePt) <= 1.0 ? documentBasePt : Math.round(pt);

    const f = typeof normUtbFont === 'function' ? normUtbFont(span.font) : (span.font || 'Times New Roman');
    if (f) {
      fontCounts[f] = (fontCounts[f] || 0) + 1;
      if (fontCounts[f] > maxCount) {
        maxCount = fontCounts[f];
        mostUsedFont = f;
      }
    }
  });

  if (_utbFetchState.baseApplied) return;
  _utbFetchState.baseApplied = true;

  // the layer's body face: its most used font at that font's own modal size,
  // weighted by characters (EFTA00173953: the small print of a warning
  // paragraph is the median span size, 8 pt, and the core's sample too; the
  // memo is Times New Roman 11 pt, and Times' own characters say so). It is
  // the toolbar default — a 'layer' claim, which a plugin that measured the
  // page's face (typography:detected) outranks whether it spoke before or
  // after these spans arrived — and the reference for a bar on a row the
  // reader failed and no span shares (utbConnectRedactionsToLines).
  const chars = new Map();
  spans.forEach(span => {
    const f = typeof normUtbFont === 'function' ? normUtbFont(span.font) : (span.font || 'Times New Roman');
    if (f !== mostUsedFont) return;
    const k = Math.round(span.sizePt);
    chars.set(k, (chars.get(k) || 0) + (span.text || '').replace(/\s+/g, '').length);
  });
  let bodyPt = documentBasePt, most = -1;
  for (const [k, n] of chars) if (n > most) { most = n; bodyPt = k; }
  _utbFetchState.baseFont = mostUsedFont;
  _utbFetchState.bodyPt = bodyPt;
  if (window.FontCatalog?.select) window.FontCatalog.select(mostUsedFont, bodyPt, 'layer');
  else {
    const fabricSel = document.getElementById('fabric-font-family');
    if (fabricSel && Array.from(fabricSel.options).find(o => o.value === mostUsedFont)) {
      fabricSel.value = mostUsedFont;
      if (typeof textOptions !== 'undefined') textOptions.fontFamily = mostUsedFont;
    }
  }

  // A bar that sits on no line takes the document's body face and size; a
  // bar on a line already has its line's (utbConnectRedactionsToLines — an
  // OCR line's face is the page's own, measured from the glyphs, and must not
  // be overwritten by the text layer's most used face: on the reference
  // document every bar on a Times header was re-fonted to the Courier body).
  if (typeof utbState === 'undefined') return;
  utbState.boxes.filter(b => b.type === 'redaction' && !b.lineId).forEach(box => {
    const pt = box.sizePt;
    const normalizedPt = Math.abs(pt - documentBasePt) <= 1.0 ? documentBasePt : Math.round(pt);

    let changed = false;
    if (box.sizePt !== normalizedPt) {
      box.sizePt = normalizedPt;
      changed = true;
    }
    if (box.fontFamily !== mostUsedFont) {
      box.fontFamily = mostUsedFont;
      changed = true;
    }

    if (changed && typeof renderBox === 'function') renderBox(box);
  });
}

// ── Lean cache (whole document) ───────────────────────────────

function etvCacheChunk(spans, start, count) {
  const byPage = new Map();
  for (const s of spans) {
    if (!byPage.has(s.page)) byPage.set(s.page, []);
    byPage.get(s.page).push(s);
  }
  const last = Math.min(start + count - 1, state.numPages || 1);
  for (let p = start; p <= last; p++) {
    if (!_utbFetchState.pages.has(p)) {
      _utbFetchState.pages.set(p, JSON.stringify(byPage.get(p) || []));
    }
  }
  if (spans.length) _utbFetchState.anyText = true;
  if (!_utbFetchState.fetched && etvChunkCached(1, state.numPages || 1)) {
    _utbFetchState.fetched = true;
  }
}

// The spans of pages start .. start+count-1 of the open document, page by
// page through the document service (each await yields, so a long scan never
// blocks the UI). null when the document changed underway — the scan aborts.
async function etvExtractPages(hash, start, count) {
  const last = Math.min(start + count - 1, state.numPages || 1);
  const spans = [];
  for (let p = start; p <= last; p++) {
    if (hash !== state.docHash) return null;
    const raw = await Doc.structuredText(p, { imageRect: true });
    // No embedded raster: the page is displayed as a 96-DPI render of the
    // full page, so the full page IS the image placement.
    for (const span of EtvExtract.extractSpans(raw, p, raw.imageRect || raw.rect)) spans.push(span);
  }
  return hash === state.docHash ? spans : null;
}

async function etvFetchLeanChunk(hash, start, count) {
  const key = `lean:${start}`;
  if (_utbFetchState.inflight.has(key)) return;
  _utbFetchState.inflight.add(key);
  try {
    const extracted = await etvExtractPages(hash, start, count);
    // A batch is valid iff it belongs to the document on screen — the hash is
    // the identity.
    if (!extracted || hash !== state.docHash || !etvCacheValid()) return;
    const spans = extracted.map(EtvExtract.leanSpan);
    etvNormalize(spans);
    etvCacheChunk(spans, start, count);
  } catch (err) {
    console.warn('UTB: lean span fetch error', err);
  } finally {
    _utbFetchState.inflight.delete(key);
  }
}

async function utbFetchSpans() {
  const hash = state.docHash;
  if (!hash) return;

  for (let p = 1; p <= (state.numPages || 1) && hash === state.docHash;) {
    const start = etvChunkStart(p);
    const count = etvChunkCount(start);
    if (!etvChunkCached(start, count)) await etvFetchLeanChunk(hash, start, count);
    p = start + count;
  }
}

// ── Hydration (per rendered page) ─────────────────────────────

function etvHydratePage(pageNum) {
  if (!etvCacheValid() || _utbFetchState.hydrated.has(pageNum)) return;
  if (typeof utbState === 'undefined') return;
  etvFetchFull(pageNum);   // async — boxes appear when the spans arrive
}

async function etvFetchFull(pageNum) {
  const key = `full:${pageNum}`;
  if (_utbFetchState.inflight.has(key)) return;
  _utbFetchState.inflight.add(key);
  const hash = state.docHash;
  try {
    if (!hash) return;
    const spans = await etvExtractPages(hash, pageNum, 1);
    if (!spans || hash !== state.docHash || !etvCacheValid()) return;
    if (_utbFetchState.hydrated.has(pageNum)) return;

    etvNormalize(spans);
    _utbFetchState.hydrated.add(pageNum);
    // The lean tier can learn this page from the full response too.
    if (!_utbFetchState.pages.has(pageNum)) {
      etvCacheChunk(spans.map(etvLeanOf), pageNum, 1);
    }
    if (!spans.length || typeof utbState === 'undefined') return;

    spans.forEach(span => utbState.addBox(spanToUnified(span)));
    renderAllTextLayers();
    utbConnectRedactionsToLines();
    if (typeof calculateAllWidths === 'function') calculateAllWidths();
  } catch (err) {
    console.warn('UTB: span fetch error', err);
  } finally {
    _utbFetchState.inflight.delete(key);
  }
}


// ── Connect redaction boxes to embedded text lines ────────────
// Emits the generic 'redactions:connected' PDFHooks event when done (see the
// tail of the function) so line-aware consumers can react on both the span-load
// path and after an OCR pass.

function utbConnectRedactionsToLines() {
  // OCR-read lines are text lines too — a redaction connects to whichever
  // kind sits on its row (scanned pages only ever have 'ocr' lines)
  const embeddedBoxes = utbState.boxes.filter(b => b.type === 'embedded' || b.type === 'ocr');
  const redactionBoxes = utbState.boxes.filter(b => b.type === 'redaction');

  // A bar links to the best line its row has NOW and moves up when a better
  // one arrives: the reader's boxes land before the text layer's spans on
  // one path and after them on the other, so a bar linked to an unread band
  // takes the layer's span when that lands, and a bar linked to the layer's
  // span takes the reader's line if the reader certifies the row. A bar on a
  // failed read takes the layer's body face once the layer is known, once.
  const rank = b => b.type === 'ocr' ? (b.ocr?.unread ? 0 : (b.ocr?.trusted ?? b.ocr?.clean) ? 3 : 1) : 2;
  // the face for a bar whose row the reader failed and no span shares: the
  // adjacent embedded line's — the row above or below, within one and a
  // half of its own height — else the layer's body face. Not a line further
  // off: on EFTA00173953 the layer skips the redacted Subject lines, and the
  // nearest text below the last of them is the small print of the warning
  // paragraph, two rows down and in another face.
  const layerFaceFor = rb => {
    let near = null, dist = Infinity;
    for (const b of embeddedBoxes) {
      if (b.type !== 'embedded' || b.page !== rb.page || !/\p{L}/u.test(b.text || '')) continue;
      const d = Math.abs((b.y + b.h / 2) - (rb.y + rb.h / 2));
      if (d < dist) { dist = d; near = b; }
    }
    if (near && dist <= near.h * 1.5) return { fontFamily: near.fontFamily, sizePt: near.sizePt };
    return _utbFetchState.baseFont ? { fontFamily: _utbFetchState.baseFont, sizePt: _utbFetchState.bodyPt || _utbFetchState.basePt } : null;
  };
  redactionBoxes.forEach(rb => {
    // The line with the most vertical overlap, from the best source the row
    // has. A line the reader CERTIFIED wins: its baseline, height and size are
    // measured from the glyphs on the page, whereas a scanned document's
    // embedded text layer only approximates them (its sizes drift word by
    // word), and a bar must not adopt an 11 pt guess for a 12 pt line. But a
    // row the reader failed on has nothing measured to offer: a tolerant read
    // names whatever set matched at ±10 (Arial bold, Courier 9 pt on a Times
    // memo), an unread band carries a placeholder. There the text layer is
    // the reference — the row's own span, else the layer's body face — and
    // the reader's line lends only its rows. (EFTA00173953: 33 of 46 bands
    // unread, the rest read at ±10, the layer says Times New Roman 11 pt on
    // every row.)
    const pageBoxes = embeddedBoxes.filter(b => b.page === rb.page);
    const best = (list) => {
      let box = null, overlap = 0;
      for (const eb of list) {
        const o = Math.min(rb.y + rb.h, eb.y + eb.h) - Math.max(rb.y, eb.y);
        if (o > overlap) { overlap = o; box = eb; }
      }
      return overlap >= rb.h * 0.3 ? box : null;
    };
    let bestBox = null;
    for (const r of [3, 2, 1, 0]) if ((bestBox = best(pageBoxes.filter(b => rank(b) === r)))) break;
    if (!bestBox) return;
    const current = rb.lineId !== null ? pageBoxes.find(b => b.lineId === rb.lineId) : null;
    const better = rank(bestBox) > (current ? rank(current) : -1);
    const layerFace = rank(bestBox) <= 1 ? layerFaceFor(rb) : null;
    if (!better && !(layerFace && !rb._layerFaced)) return;      // nothing new for this bar

    if (better) {
      rb.lineId = bestBox.lineId;
      rb.y = bestBox.y;
      rb.h = bestBox.h;
      rb._layerFaced = false;
    }
    // A detected bar carries no typography of its own; the line it sits on
    // does. Adopt the line's face, size and style — as a manually added bar
    // inherits them from its nearest line — so whatever measures text against
    // the bar measures in the page's own font, not the box default. A row
    // whose only line is a failed read takes the layer's body face instead.
    const face = layerFace || bestBox;
    if (face.fontFamily) rb.fontFamily = face.fontFamily;
    if (face.sizePt > 0) rb.sizePt = face.sizePt;
    rb.bold = layerFace ? false : !!bestBox.bold;
    rb.italic = layerFace ? false : !!bestBox.italic;
    if (layerFace) rb._layerFaced = true;

    const lineBoxes = embeddedBoxes.filter(b => b.page === rb.page && b.lineId === bestBox.lineId);
    // The hidden name is set in capitals when the line writes its other names
    // that way ("including ███ and GHISLAINE MAXWELL"): test the candidate
    // phrases, uppercased, against the line AS WRITTEN. (Against an uppercased
    // copy every line naming a known person would match, and a mixed-case
    // document would measure every bar in capitals.)
    let hasUpper = false;
    if (typeof state !== 'undefined' && state.candidates && state.candidates.length > 0) {
      const lineText = lineBoxes.map(lb => lb.text || '').join(' ');
      for (const c of state.candidates) {
        const words = c.toUpperCase().trim().split(/\s+/).filter(Boolean);
        // Skip trivially short names (e.g. "Al", "Ed") — too ambiguous to force uppercase
        if (words.join('').replace(/[^A-Z]/g, '').length < 3) continue;
        // Escape regex metacharacters per word; tolerate variable whitespace between name parts
        const phrasePattern = new RegExp('\\b' + words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+') + '\\b');
        if (phrasePattern.test(lineText)) {
          hasUpper = true;
          break;
        }
      }
    }
    if (hasUpper) {
      rb.uppercase = true;
    }

    renderBox(rb);
  });

  // Announce that redactions are now line-associated. Generic lifecycle event
  // (names no plugin); listeners such as a redaction refiner react to it on both
  // the span-load path and after an OCR pass. Fire-and-forget — a slow/async
  // subscriber must not block line connection.
  window.PDFHooks?.emit('redactions:connected');
}


// ── Nearest-line helper (exposed so text-tool.js can use it) ──

window._utbFindNearestLine = function (pageNum, y, thresholdMultiplier = 2.0) {
  // only lines on a shown layer: a new box takes its face and size from what
  // the user sees, never from a hidden embedded line's declared substitute
  const cl = document.body.classList;
  const shown = b => !(b.type === 'embedded' && cl.contains('hide-embedded-text')) &&
                     !(b.type === 'ocr' && cl.contains('hide-ocr-text'));
  const pageBoxes = utbState.boxes.filter(b => b.page === pageNum &&
    (b.type === 'embedded' || b.type === 'ocr') && shown(b));
  if (!pageBoxes.length) return null;

  let nearest = null;
  let minDist = Infinity;
  for (const b of pageBoxes) {
    const cy = b.y + b.h / 2;
    const d = Math.abs(cy - y);
    if (d < minDist) { minDist = d; nearest = b; }
  }
  return nearest && minDist < nearest.h * thresholdMultiplier ? nearest : null;
};


// ── Tool: add embedded text span ──────────────────────────────

window.addEmbeddedTextSpan = function (pageNum, x, y) {
  const nearest = window._utbFindNearestLine(pageNum, y);

  const newBox = utbState.addBox(new UnifiedTextBox({
    type: 'embedded',
    page: pageNum,
    text: 'Click to edit',
    lineId: nearest ? nearest.lineId : `manual_${Date.now()}`,
    x: x,
    y: nearest ? nearest.y : y - 10,
    w: 120,
    h: nearest ? nearest.h : 20,
    fontFamily: nearest ? nearest.fontFamily : (document.getElementById('fabric-font-family')?.value || 'Times New Roman'),
    // Font-size input is in POINTS — no DPI conversion.
    sizePt: nearest ? nearest.sizePt : (parseFloat(document.getElementById('fabric-font-size')?.value) || 12),
  }));

  renderBox(newBox);

  utbState.selectedId = newBox.id;
  selectBoxInSVG(newBox.id);
  if (typeof syncToolbarToBox === 'function') syncToolbarToBox(newBox);
};


// ── Cross-plugin text access ──────────────────────────────────
// Read-only view of the lean span cache for plugins that scan the whole
// document's text. Pages the user
// visited live in utbState (with any edits); this covers everything else.

window.etvSpanCache = {
  complete() { return etvCacheValid() && _utbFetchState.fetched; },
  anyText() { return etvCacheValid() && _utbFetchState.anyText; },
  hasPage(p) { return etvCacheValid() && _utbFetchState.pages.has(p); },
  isHydrated(p) { return etvCacheValid() && _utbFetchState.hydrated.has(p); },
  // Lean spans: { page, text, x, y, w, h, sizePt, font }.
  spansFor(p) {
    if (!this.hasPage(p)) return null;
    return JSON.parse(_utbFetchState.pages.get(p));
  },
};


// ── Lifecycle hooks ───────────────────────────────────────────
// Subscribe to the core's document lifecycle instead of monkey-patching
// window.openDocument. The core already resets utbState and the SVG layers
// when it shows a document, so these handlers only manage the span cache.
if (window.PDFHooks) {
  PDFHooks.on('document:loaded', () => {
    // Boxes were reset by the core, so every page needs hydrating again; the
    // cached lean spans survive only when it's the same document (same hash).
    _utbFetchState.hydrated.clear();
    if (!etvCacheValid()) {
      _utbFetchState.pagesHash = state.docHash;
      _utbFetchState.pages.clear();
      _utbFetchState.inflight.clear();
      _utbFetchState.fetched = false;
      _utbFetchState.basePt = null;
      _utbFetchState.baseFont = null;
      _utbFetchState.bodyPt = null;
      _utbFetchState.baseApplied = false;
      _utbFetchState.anyText = false;
    }
    // Kick the background lean loop and hydrate whatever is on screen.
    // Deliberately not awaited — openDocument must not block on text.
    utbFetchSpans();
    document.querySelectorAll('.page-container').forEach(c => {
      etvHydratePage(parseInt(c.id.replace('pageContainer', '')));
    });
  });

  // Rendering a page is the demand signal for its full spans. (For a page
  // rendered before document:loaded lands — the initial page — the cache
  // isn't valid yet; the document:loaded handler above catches it.)
  PDFHooks.on('page:rendered', ({ pageNum }) => {
    etvHydratePage(pageNum);
  });
}

// Clear stale overlays the moment the user picks a new file, before analysis returns.
document.getElementById('pdf-file')?.addEventListener('change', () => {
  _utbFetchState.fetched = false;
  utbState.reset();
  clearAllSVGLayers?.();
});


window.utbFetchSpans = utbFetchSpans;
window.utbConnectRedactionsToLines = utbConnectRedactionsToLines;
