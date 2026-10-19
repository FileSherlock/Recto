// base64-tool.js — the Attachments panel.
//
// Scans the document's text layer for base64 blocks (the wrapped-line body of
// an email attachment), decodes them in the browser and shows each as a card
// in a docked side panel: its type, the name its MIME headers declare, size,
// pages, a preview for an image, View (a new tab, as the type allows) and
// Download. Finding, decoding, typing and naming are b64-core.js (B64Core, no
// DOM); this file gathers the text and draws the panel.
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
  blocks: [],     // { data: Uint8Array, kind (B64Core.sniff), name, pages: [first, last], chars, thumb }
  urls: [],       // object URLs to revoke on rescan / new document
  scanned: false, // a scan ran for the current document
  waiting: false, // the auto-scan is waiting for the text layer to settle
  autoSeq: 0,     // auto-scan generation — a new document supersedes the old watcher
};

function b64Status(msg) {
  const el = document.getElementById('b64-status');
  if (el) el.textContent = msg;
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

// ── Scan ──────────────────────────────────────────────────────

function b64Reset() {
  for (const u of b64State.urls) URL.revokeObjectURL(u);
  b64State.urls = [];
  b64State.blocks = [];
  b64State.scanned = false;
  b64Render();
  b64Status(state.numPages > 0 ? 'Waiting for the text layer…' : 'Open a document to look for attachments.');
}

function b64Url(data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  b64State.urls.push(url);
  return url;
}

function b64Scan() {
  b64Reset();
  b64State.scanned = true;
  const layer = b64ActiveLayer();
  if (!layer) {
    b64Status(typeof utbState === 'undefined'
      ? 'Needs the text tool to read the document\'s text.'
      : 'No text to read — run OCR, or open a document with embedded text.');
    return;
  }
  for (const raw of B64Core.findBlocks(b64GatherLines(layer))) {
    let data;
    try { data = B64Core.decode(raw.chars); } catch { continue; }
    if (!data.length) continue;
    const kind = B64Core.sniff(data);
    const thumb = kind.view === 'inline' && kind.mime.startsWith('image/') ? b64Url(data, kind.mime) : null;
    b64State.blocks.push({ data, kind, name: raw.name, pages: raw.pages, chars: raw.chars.length, thumb });
  }
  b64Render();
  const n = b64State.blocks.length;
  const src = layer === 'ocr' ? 'OCR' : 'embedded';
  b64Status(n ? `${n} attachment${n > 1 ? 's' : ''} in the ${src} text.` : `No base64 attachments in the ${src} text.`);
}

// ── Cards ─────────────────────────────────────────────────────

function b64FileName(block) {
  if (block.name) return block.name;
  const doc = (state.currentFile?.name || 'document').replace(/\.[^.]+$/, '');
  return `${doc}-attachment-${b64State.blocks.indexOf(block) + 1}.${block.kind.ext}`;
}

function b64View(block) {
  const type = B64Core.viewMime(block.kind);
  if (type) window.open(b64Url(block.data, type), '_blank');
}

function b64Download(block) {
  const a = document.createElement('a');
  a.href = b64Url(block.data, block.kind.mime);
  a.download = b64FileName(block);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Every text from the document (a declared name) goes in as textContent.
function b64El(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function b64Card(block) {
  const { kind } = block;
  const card = b64El('div', 'b64-card');
  const top = card.appendChild(b64El('div', 'b64-card-top'));
  top.appendChild(b64El('span', 'material-symbols-outlined b64-icon', kind.icon)).setAttribute('aria-hidden', 'true');
  const text = top.appendChild(b64El('div', 'b64-card-text'));
  const title = text.appendChild(b64El('div', 'b64-name', block.name || kind.label));
  title.title = b64FileName(block);
  const meta = text.appendChild(b64El('div', 'b64-meta'));
  meta.append(`${block.name ? kind.label + ' · ' : ''}${B64Core.formatSize(block.data.length)} · `);
  const [p0, p1] = block.pages;
  const where = meta.appendChild(b64El('button', 'b64-page', p0 === p1 ? `p. ${p0}` : `p. ${p0}–${p1}`));
  where.title = `Go to page ${p0}`;
  where.addEventListener('click', () => { if (typeof goToPage === 'function') goToPage(p0); });
  // the name says one type, the bytes read as none: the text likely holds misreads
  const declared = block.name?.match(/\.(\w{1,8})$/)?.[1];
  if (declared && kind.ext === 'bin')
    card.appendChild(b64El('div', 'b64-warn', `Doesn't decode as .${declared.toLowerCase()} — the text may hold misreads.`));
  if (block.thumb) {
    const img = card.appendChild(b64El('img', 'b64-thumb'));
    img.alt = '';
    img.src = block.thumb;
    img.addEventListener('error', () => img.remove());
  }
  const actions = card.appendChild(b64El('div', 'b64-actions'));
  const view = actions.appendChild(b64El('button', 'b64-btn primary', 'View'));
  if (kind.view === 'none') { view.disabled = true; view.title = 'No browser preview for this type — use Download'; }
  else view.title = kind.view === 'text' ? 'Open as plain text in a new tab' : 'Open in a new tab';
  view.addEventListener('click', () => b64View(block));
  const dl = actions.appendChild(b64El('button', 'b64-btn', 'Download'));
  dl.title = `Save as ${b64FileName(block)}`;
  dl.addEventListener('click', () => b64Download(block));
  return card;
}

function b64Render() {
  const cards = document.getElementById('b64-cards');
  if (cards) cards.replaceChildren(...b64State.blocks.map(b64Card));
  const n = b64State.blocks.length;
  const badge = document.getElementById('b64-badge');
  if (badge) { badge.textContent = n > 99 ? '99+' : String(n); badge.classList.toggle('hidden', !n); }
}

// ── The panel ─────────────────────────────────────────────────
// The right side is shared with the other side panels, one at a time: a panel
// shown says so on the bus ('sidepanel:shown', { id }) and every other one
// hides — so this panel's tool switches to it from whichever panel was
// showing, and that panel's tool back. Whether it is shown is kept in this
// browser; the first time, it is hidden.

const B64_PANEL_KEY = 'recto.attachments.open';

function b64PanelShown() {
  return !document.getElementById('b64-panel')?.classList.contains('hidden');
}

function b64SetPanel(open, { announce = true } = {}) {
  const panel = document.getElementById('b64-panel');
  if (!panel) return;
  panel.classList.toggle('hidden', !open);
  document.getElementById('toggle-b64-tool')?.classList.toggle('active', open);
  try { localStorage.setItem(B64_PANEL_KEY, open ? '1' : '0'); } catch { /* this session only */ }
  if (open && announce) PDFHooks.emit('sidepanel:shown', { id: panel.id });
  // first show scans — unless the auto-scan is still waiting for the text
  if (open && !b64State.scanned && !b64State.waiting && state.numPages > 0) b64Scan();
}

// Drag the panel's edge to make it wider (docked at the foot of a narrow
// screen: taller); a double click goes back to the default size.
function b64Resizable(panel) {
  const grip = panel.querySelector('.b64-resize');
  if (!grip) return;
  grip.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const bottom = matchMedia('(max-width: 768px)').matches;
    const start = bottom ? e.clientY : e.clientX, size0 = bottom ? panel.offsetHeight : panel.offsetWidth;
    grip.setPointerCapture(e.pointerId);
    panel.classList.add('is-resizing');
    const move = ev => {
      const size = size0 - ((bottom ? ev.clientY : ev.clientX) - start);
      if (bottom) panel.style.setProperty('--b64-height', `${Math.round(Math.min(Math.max(size, 160), innerHeight * 0.9))}px`);
      else panel.style.setProperty('--b64-width', `${Math.round(Math.min(Math.max(size, 260), Math.min(760, innerWidth * 0.7)))}px`);
    };
    const end = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      panel.classList.remove('is-resizing');
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  });
  grip.addEventListener('dblclick', () => {
    panel.style.removeProperty('--b64-width');
    panel.style.removeProperty('--b64-height');
  });
}

// ── Auto-scan on load ─────────────────────────────────────────
// After a document loads, wait for its text layer to settle (the OCR
// auto-read finishes long after document:loaded), then scan. When attachments
// are found the tool's badge counts them, and the panel shows itself if no
// other side panel is showing. The OCR plugin's state is read through a
// guarded global (it's optional and may be absent); without it, "settled"
// means two polls seeing the same amount of text.

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
  b64State.waiting = true;
  while (Date.now() < deadline) {
    await sleep(B64_POLL_MS);
    if (!live()) return;
    if (typeof utbState === 'undefined') { b64State.waiting = false; b64Scan(); return; }   // says what is missing
    const amount = b64TextAmount();
    const ocr = window.OCRTool?.state;
    const ocrSettled = ocr ? (ocr.autoDone && !ocr.running) : (amount > 0 && amount === prev);
    // The embedded span cache fills in background chunks — wait for the whole
    // document's text (the deadline still forces a scan on very slow fetches).
    const embSettled = !window.etvSpanCache || window.etvSpanCache.complete();
    if (ocrSettled && embSettled) break;
    prev = amount;
  }
  if (!live()) return;
  b64State.waiting = false;
  b64Scan();                      // also over a scan the user ran on half-read text
  if (!live() || !b64State.blocks.length || b64PanelShown()) return;
  // never take the right side from another panel: the badge says it instead
  const otherShown = [...document.querySelectorAll('[data-side-panel]')]
    .some(p => p.id !== 'b64-panel' && !p.classList.contains('hidden'));
  if (!otherShown) b64SetPanel(true);
}

// ── Wiring ────────────────────────────────────────────────────
// Module scope, NOT 'ui:ready' — this is a scripts_after_app entry, so the
// DOM already exists (ui:ready fired before this script parsed).

(function wireB64Tool() {
  const btn = document.getElementById('toggle-b64-tool');
  const panel = document.getElementById('b64-panel');
  if (!btn || !panel) return;
  btn.addEventListener('click', () => b64SetPanel(!b64PanelShown()));
  document.getElementById('b64-close')?.addEventListener('click', () => b64SetPanel(false));
  document.getElementById('b64-scan')?.addEventListener('click', () => { if (state.numPages > 0) b64Scan(); });
  b64Resizable(panel);
  // as the user left it
  let kept = null;
  try { kept = localStorage.getItem(B64_PANEL_KEY); } catch { /* the default: hidden */ }
  if (kept === '1') b64SetPanel(true);
})();

PDFHooks.on('sidepanel:shown', ({ id } = {}) => {
  if (id !== 'b64-panel' && b64PanelShown()) b64SetPanel(false, { announce: false });
});

PDFHooks.on('document:opening', () => { b64State.autoSeq++; b64State.waiting = false; b64Reset(); });
PDFHooks.on('document:loaded', () => { b64Reset(); b64AutoScan(); });
