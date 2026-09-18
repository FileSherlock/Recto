// base64-tool.js — Base64 attachment decoder.
//
// Scans the document's text layer for base64 blocks (the wrapped-line body of
// an email attachment), decodes them in the browser, sniffs the file type from
// the magic bytes, and offers each block as a download or an in-browser view.
//
// Text source: the unified text box system (utbState, owned by text_tool).
// OCR and embedded layers hold the same lines at the same coordinates, so
// scanning both would interleave duplicate lines and corrupt the block —
// exactly one layer is read, preferring whichever one is visible on screen
// (the body classes hide-ocr-text / hide-embedded-text that the layer toggles
// maintain). All access is guarded so removing text_tool never throws.
//
// Embedded text lives in utbState only for pages the user has actually
// visited (the viewer hydrates lazily); the rest of the document's text is
// read from embedded_text_viewer's span cache (window.etvSpanCache, guarded —
// it's another plugin), so attachment detection always sees the whole
// document, not just the pages on screen.

const b64State = {
  blocks: [],     // { data: Uint8Array, mime, ext, pages: [first, last], chars }
  urls: [],       // object URLs to revoke on rescan / new document
  scanned: false, // a scan ran for the current document
  autoSeq: 0,     // auto-scan generation — a new document supersedes the old watcher
};

function b64Status(msg) {
  const el = document.getElementById('b64-status');
  if (el) { el.textContent = msg; el.title = msg; }
}

// ── Text gathering ────────────────────────────────────────────

// Pick exactly one text-box layer: the visible one, else whichever exists.
function b64ActiveLayer() {
  if (typeof utbState === 'undefined') return null;
  const cachedEmb = !!window.etvSpanCache?.anyText?.();   // text on unvisited pages counts
  const has = t => utbState.boxes.some(b => b.type === t && (b.text || '').trim()) ||
    (t === 'embedded' && cachedEmb);
  const hideOcr = document.body.classList.contains('hide-ocr-text');
  const hideEmb = document.body.classList.contains('hide-embedded-text');
  if (has('ocr') && !hideOcr) return 'ocr';
  if (has('embedded') && !hideEmb) return 'embedded';
  if (has('ocr')) return 'ocr';
  if (has('embedded')) return 'embedded';
  return null;
}

// One layer's boxes -> reading-order lines [{ page, text }]. Boxes whose
// vertical positions overlap are segments of the same printed line (a
// redaction split, a tab stop) and are joined left-to-right.
function b64GatherLines(layerType) {
  let source = utbState.boxes
    .filter(b => b.type === layerType && !b.ocr?.unread && (b.text || '').trim());
  if (layerType === 'embedded' && window.etvSpanCache) {
    // Pages never rendered have no boxes — take their spans from the cache.
    // Hydrated pages stay box-sourced so user edits are what gets scanned.
    const cache = window.etvSpanCache;
    for (let p = 1; p <= (state.numPages || 1); p++) {
      if (cache.isHydrated?.(p) || !cache.hasPage?.(p)) continue;
      for (const s of cache.spansFor(p) || []) {
        if ((s.text || '').trim()) source.push(s);
      }
    }
  }
  const boxes = source.sort((a, b) => (a.page - b.page) || (a.y - b.y) || (a.x - b.x));
  const lines = [];
  let cur = null;
  for (const b of boxes) {
    const sameLine = cur && cur.page === b.page &&
      Math.abs(b.y - cur.y) < Math.max(4, (cur.h || 12) * 0.5);
    if (sameLine) {
      cur.text += ' ' + b.text;
    } else {
      cur = { page: b.page, y: b.y, h: b.h, text: b.text };
      lines.push(cur);
    }
  }
  return lines.map(l => ({ page: l.page, text: l.text }));
}

// ── Block detection ───────────────────────────────────────────

// A line "looks like base64" when, ignoring whitespace (OCR may insert
// spaces) and any leading '>' quoted-reply markers (a forwarded email quotes
// the whole attachment body, line by line), it is pure base64 alphabet with
// at most trailing padding. Prose almost always carries punctuation outside
// the alphabet, and the strong-line gate below additionally demands the
// length and character mix of a wrapped attachment body, so headers and
// ordinary sentences don't qualify.
const B64_CONTENT = /^[A-Za-z0-9+/]+={0,2}$/;

function b64Stripped(text) {
  return (text || '').replace(/^\s*(?:>\s*)+/, '').replace(/\s+/g, '');
}

function b64IsCandidate(text) {
  const s = b64Stripped(text);
  return s.length >= 4 && B64_CONTENT.test(s);
}

// Strong enough to *start* a block: wrapped-body length + mixed charset.
function b64IsStrong(text) {
  const s = b64Stripped(text);
  return s.length >= 40 && B64_CONTENT.test(s) &&
    /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9+/]/.test(s);
}

const B64_MIN_BLOCK = 80;   // total chars — anything shorter is a false positive

// Reading-order lines -> raw blocks [{ chars, pages }]. A block is a run of
// consecutive base64-looking lines containing at least one strong line; runs
// continue across page boundaries (attachments span pages).
function b64FindBlocks(lines) {
  const blocks = [];
  let run = null;
  const flush = () => {
    if (run && run.strong && run.chars.length >= B64_MIN_BLOCK)
      blocks.push({ chars: run.chars, pages: [run.firstPage, run.lastPage] });
    run = null;
  };
  for (const line of lines) {
    // blank / quote-marks-only lines are neutral: they neither extend nor
    // break a run (an OCR hiccup inside the body must not split the block)
    if (run && !b64Stripped(line.text)) continue;
    if (b64IsCandidate(line.text)) {
      const s = b64Stripped(line.text);
      if (!run) run = { chars: '', strong: false, firstPage: line.page, lastPage: line.page };
      run.chars += s;
      run.strong = run.strong || b64IsStrong(line.text);
      run.lastPage = line.page;
      if (s.endsWith('=')) flush();   // padding closes the attachment body
    } else {
      flush();
    }
  }
  flush();
  return blocks;
}

// ── Decoding + type sniffing ──────────────────────────────────

function b64DecodeChars(chars) {
  let s = chars.replace(/=+/g, '');
  if (s.length % 4 === 1) s = s.slice(0, -1);          // stray char (OCR slip)
  s += '='.repeat((4 - s.length % 4) % 4);
  const bin = atob(s);                                  // throws on bad input
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64Sniff(bytes) {
  const at = (i, ...vals) => vals.every((v, k) => bytes[i + k] === v);
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return { mime: 'application/pdf', ext: 'pdf', label: 'PDF' };
  if (at(0, 0x89, 0x50, 0x4E, 0x47)) return { mime: 'image/png', ext: 'png', label: 'PNG' };
  if (at(0, 0xFF, 0xD8, 0xFF)) return { mime: 'image/jpeg', ext: 'jpg', label: 'JPEG' };
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return { mime: 'image/gif', ext: 'gif', label: 'GIF' };
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
    return { mime: 'image/webp', ext: 'webp', label: 'WebP' };
  if (at(0, 0x50, 0x4B)) return { mime: 'application/zip', ext: 'zip', label: 'ZIP' };
  // mostly printable ASCII -> text
  const n = Math.min(bytes.length, 256);
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const c = bytes[i];
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++;
  }
  if (n && printable / n > 0.9) return { mime: 'text/plain', ext: 'txt', label: 'text' };
  return { mime: 'application/octet-stream', ext: 'bin', label: 'unknown type' };
}

function b64FormatSize(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

// ── Scan + UI ─────────────────────────────────────────────────

function b64Reset() {
  for (const u of b64State.urls) URL.revokeObjectURL(u);
  b64State.urls = [];
  b64State.blocks = [];
  b64State.scanned = false;
  const sel = document.getElementById('b64-blocks');
  if (sel) sel.innerHTML = '';
  b64SetActionButtons();
  b64Status('idle');
}

function b64SetActionButtons() {
  const none = !b64State.blocks.length;
  document.getElementById('b64-view')?.toggleAttribute('disabled', none);
  document.getElementById('b64-download')?.toggleAttribute('disabled', none);
}

function b64Scan() {
  b64Reset();
  b64State.scanned = true;
  const layer = b64ActiveLayer();
  if (!layer) {
    b64Status(typeof utbState === 'undefined'
      ? 'text_tool is required'
      : 'no text — run OCR or load a document with embedded text');
    return;
  }
  const rawBlocks = b64FindBlocks(b64GatherLines(layer));
  const sel = document.getElementById('b64-blocks');
  for (const raw of rawBlocks) {
    let data;
    try { data = b64DecodeChars(raw.chars); } catch { continue; }
    if (!data.length) continue;
    const kind = b64Sniff(data);
    const block = { data, mime: kind.mime, ext: kind.ext, pages: raw.pages, chars: raw.chars.length };
    b64State.blocks.push(block);
    if (sel) {
      const opt = document.createElement('option');
      const where = raw.pages[0] === raw.pages[1] ? `p. ${raw.pages[0]}` : `p. ${raw.pages[0]}–${raw.pages[1]}`;
      opt.value = String(b64State.blocks.length - 1);
      opt.textContent = `${b64State.blocks.length}: ${kind.label} · ${b64FormatSize(data.length)} · ${where}`;
      sel.appendChild(opt);
    }
  }
  b64SetActionButtons();
  b64Status(b64State.blocks.length
    ? `${b64State.blocks.length} attachment${b64State.blocks.length > 1 ? 's' : ''} found (${layer} text)`
    : `no base64 blocks in the ${layer} text`);
}

function b64Selected() {
  const sel = document.getElementById('b64-blocks');
  return b64State.blocks[Number(sel?.value ?? 0)] || null;
}

function b64BlockUrl(block) {
  const url = URL.createObjectURL(new Blob([block.data], { type: block.mime }));
  b64State.urls.push(url);
  return url;
}

function b64FileName(block) {
  const doc = (state.currentFile?.name || 'document').replace(/\.[^.]+$/, '');
  const idx = b64State.blocks.indexOf(block) + 1;
  return `${doc}-attachment-${idx}.${block.ext}`;
}

function b64View() {
  const block = b64Selected();
  if (!block) return;
  window.open(b64BlockUrl(block), '_blank');
}

function b64Download() {
  const block = b64Selected();
  if (!block) return;
  const a = document.createElement('a');
  a.href = b64BlockUrl(block);
  a.download = b64FileName(block);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ── Auto-scan on load ─────────────────────────────────────────
// After a document loads, wait for its text layer to settle (the OCR
// auto-read finishes long after document:loaded), then scan. When attachments
// are found and the user hasn't opened any subtoolbar yet, the base64 bar
// opens by itself so download/view are one click away. The OCR plugin's state
// is read through a guarded global (it's optional and may be absent); without
// it, "settled" means two polls seeing the same amount of text.

const B64_POLL_MS = 600;
const B64_POLL_MAX_MS = 180000;   // give a slow whole-document OCR time

function b64TextAmount() {
  const layer = b64ActiveLayer();
  if (!layer) return 0;
  let n = 0;
  for (const b of utbState.boxes) if (b.type === layer) n += (b.text || '').length;
  return n;
}

async function b64AutoScan() {
  const seq = ++b64State.autoSeq;
  const live = () => seq === b64State.autoSeq;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const deadline = Date.now() + B64_POLL_MAX_MS;
  let prev = -1;
  while (Date.now() < deadline) {
    await sleep(B64_POLL_MS);
    if (!live()) return;
    if (typeof utbState === 'undefined') return;   // no text_tool, nothing to scan
    const amount = b64TextAmount();
    const ocr = window.OCRTool?.state;
    const ocrSettled = ocr ? (ocr.autoDone && !ocr.running) : (amount > 0 && amount === prev);
    // The embedded span cache fills in background chunks — wait for the whole
    // document's text (the deadline still forces a scan on very slow fetches).
    const embSettled = !window.etvSpanCache || window.etvSpanCache.complete();
    if (ocrSettled && embSettled) break;
    prev = amount;
  }
  if (!live() || b64State.scanned) return;   // user beat us to it — leave their result
  b64Scan();
  if (!live() || !b64State.blocks.length) return;
  // don't steal the ribbon if the user already opened some bar
  if (document.querySelector('#unified-options-bar-container .options-bar:not(.hidden)')) return;
  const btn = document.getElementById('toggle-b64-tool');
  const bar = document.getElementById('b64-tool-bar');
  if (btn && bar) window.openSubtoolbar?.(bar, btn);
}

// ── Wiring ────────────────────────────────────────────────────
// Module scope, NOT 'ui:ready' — this is a scripts_after_app entry, so the
// DOM and registerSubtoolbar/openSubtoolbar already exist (same pattern as
// text_tool's toolbar.js; ui:ready fired before this script parsed).

(function wireB64Tool() {
  const btn = document.getElementById('toggle-b64-tool');
  const bar = document.getElementById('b64-tool-bar');
  if (!btn || !bar) return;
  window.registerSubtoolbar?.(btn);
  btn.addEventListener('click', () => {
    if (bar.classList.contains('hidden')) {
      window.openSubtoolbar?.(bar, btn);
      if (!b64State.scanned) b64Scan();   // first open scans automatically
    } else {
      window.openSubtoolbar?.(null, null);
    }
  });
  document.getElementById('b64-scan')?.addEventListener('click', b64Scan);
  document.getElementById('b64-view')?.addEventListener('click', b64View);
  document.getElementById('b64-download')?.addEventListener('click', b64Download);
})();

PDFHooks.on('document:loaded', () => { b64Reset(); b64AutoScan(); });
