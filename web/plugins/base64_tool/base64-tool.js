// base64-tool.js — the Attachments panel.
//
// Reads the base64 bodies in the document's OCR read (the wrapped-line body of
// an email attachment), decodes them in the browser and shows each as a card in
// a docked side panel: its type, the name its MIME headers declare, size, pages,
// how far the file can be trusted, a preview for an image, View (a new tab, as
// the type allows) and Download. Finding, decoding, typing, naming and judging
// are b64-core.js (B64Core, no DOM); this file gathers the boxes and draws the panel.
//
// Text source: the OCR layer of the unified text box system (utbState, owned
// by text_tool), and nothing else. The embedded layer is another OCR's text,
// with nothing to say which of its characters are right, and one wrong
// character is a wrong byte: it is never decoded, whichever layer is on screen.
// All access is guarded so removing text_tool never throws.

const b64State = {
  blocks: [],     // B64Core.examine's files, each with its thumb
  others: [],     // B64Core.examine's others: found, decoded, and not files
  urls: [],       // object URLs to revoke on rescan / new document
  scanned: false, // a scan ran for the current document
  waiting: false, // the auto-scan is waiting for the text layer to settle
  autoSeq: 0,     // auto-scan generation — a new document supersedes the old watcher
};

function b64Status(msg) {
  const el = document.getElementById('b64-status');
  if (el) el.textContent = msg;
}

// ── Scan ──────────────────────────────────────────────────────

function b64Reset() {
  for (const u of b64State.urls) URL.revokeObjectURL(u);
  b64State.urls = [];
  b64State.blocks = [];
  b64State.others = [];
  b64State.scanned = false;
  b64Render();
  b64Status(state.numPages > 0 ? 'Waiting for the OCR read…' : 'Open a document to look for attachments.');
}

function b64Url(data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  b64State.urls.push(url);
  return url;
}

function b64Scan() {
  b64Reset();
  b64State.scanned = true;
  if (typeof utbState === 'undefined') { b64Status('Needs the text tool to read the OCR boxes.'); return; }
  const reading = window.OCRTool?.state?.running ? ' The OCR read is still going: this is what it has so far.' : '';
  const lines = B64Core.linesFromBoxes(utbState.boxes);
  if (!lines.length) {
    b64Status(`Nothing read yet. Attachments come only from the OCR read, never from the embedded text.${reading}`);
    return;
  }
  const { files, others } = B64Core.examine(lines);
  for (const f of files) {
    const thumb = f.kind.view === 'inline' && f.kind.mime.startsWith('image/') ? b64Url(f.data, f.kind.mime) : null;
    b64State.blocks.push({ ...f, thumb });
  }
  b64State.others = others;
  b64Render();
  b64Status(b64Summary(files, others) + reading);
}

// "3 attachments in the OCR read: 2 exact, 1 incomplete. 4 values that are no files."
function b64Summary(files, others) {
  const n = files.length;
  const counts = ['exact', 'incomplete', 'unproven', 'damaged']
    .map(st => [files.filter(f => f.status === st).length, st]).filter(([k]) => k).map(([k, st]) => `${k} ${st}`);
  const found = n ? `${n} attachment${n > 1 ? 's' : ''} in the OCR read: ${counts.join(', ')}.` : 'No base64 attachments in the OCR read.';
  return others.length ? `${found} ${others.length} value${others.length > 1 ? 's' : ''} that ${others.length > 1 ? 'are' : 'is'} no file${others.length > 1 ? 's' : ''}.` : found;
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

const B64_VERDICT = {
  exact: 'Exact: every character certified, the file whole',
  incomplete: 'Incomplete: read exactly, but the file is cut short',
  unproven: 'Unproven: read exactly, nothing shows it is all of the file',
  damaged: 'Damaged: some characters are not certified',
};

function b64Card(block) {
  const { kind } = block;
  const card = b64El('div', 'b64-card');
  const top = card.appendChild(b64El('div', 'b64-card-top'));
  top.appendChild(b64El('span', 'material-symbols-outlined b64-icon', kind.icon)).setAttribute('aria-hidden', 'true');
  const text = top.appendChild(b64El('div', 'b64-card-text'));
  const title = text.appendChild(b64El('div', 'b64-name', block.name || kind.label));
  title.title = b64FileName(block);
  const meta = text.appendChild(b64El('div', 'b64-meta'));
  meta.append(`${block.name ? kind.label + ' · ' : ''}${B64Core.formatSize(block.data.length)}${block.declaredSize != null && block.declaredSize !== block.data.length ? ` of ${B64Core.formatSize(block.declaredSize)}` : ''} · `);
  const [p0, p1] = block.pages;
  const where = meta.appendChild(b64El('button', 'b64-page', p0 === p1 ? `p. ${p0}` : `p. ${p0}–${p1}`));
  where.title = `Go to page ${p0}`;
  where.addEventListener('click', () => { if (typeof goToPage === 'function') goToPage(p0); });
  if (block.parent) text.appendChild(b64El('div', 'b64-meta', `Inside ${block.parent}`));
  const verdict = text.appendChild(b64El('div', `b64-verdict b64-verdict-${block.status}`, B64_VERDICT[block.status]));
  verdict.title = block.why;
  if (block.status !== 'exact') card.appendChild(b64El('div', 'b64-warn', block.why));
  // the name says one type, the bytes read as none: the text likely holds misreads
  const declared = block.name?.match(/\.(\w{1,8})$/)?.[1];
  if (declared && kind.ext === 'bin')
    card.appendChild(b64El('div', 'b64-warn', `Doesn't decode as .${declared.toLowerCase()} — the text may hold misreads.`));
  if (block.thumb) {
    const img = card.appendChild(b64El('img', 'b64-thumb'));
    img.alt = '';
    img.loading = 'lazy';
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

// What was decoded and is not a file: a form's hidden field, a mail header's value.
function b64Others() {
  const list = b64El('details', 'b64-others');
  const n = b64State.others.length;
  list.appendChild(b64El('summary', null, `${n} value${n > 1 ? 's' : ''} that ${n > 1 ? 'are' : 'is'} no file${n > 1 ? 's' : ''}`));
  for (const o of b64State.others) {
    const [p0, p1] = o.pages;
    list.appendChild(b64El('div', 'b64-other', `${o.what}${o.field ? ` (${o.field})` : ''} · ${B64Core.formatSize(o.bytes)} · ${p0 === p1 ? `p. ${p0}` : `p. ${p0}–${p1}`}`));
  }
  return list;
}

function b64Render() {
  const cards = document.getElementById('b64-cards');
  if (cards) cards.replaceChildren(...b64State.blocks.map(b64Card), ...(b64State.others.length ? [b64Others()] : []));
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
// After a document loads, wait for the OCR read to settle (it finishes long
// after document:loaded, and a hard document takes the better part of an hour),
// then scan. No deadline: a scan of half a read would say there is nothing and
// never look again. When attachments are found the tool's badge counts them,
// and the panel shows itself if no other side panel is showing. The OCR
// plugin's state is read through a guarded global: without it there is no read
// to wait for.

const B64_POLL_MS = 600;

async function b64AutoScan() {
  const seq = ++b64State.autoSeq;
  const live = () => seq === b64State.autoSeq;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  b64State.waiting = true;
  for (;;) {
    await sleep(B64_POLL_MS);
    if (!live()) return;
    const ocr = window.OCRTool?.state;
    // done, or the user stopped it: what was read is all there will be
    if (typeof utbState === 'undefined' || !ocr || (!ocr.running && (ocr.autoDone || ocr.cancel))) break;
  }
  if (!live()) return;
  b64State.waiting = false;
  b64Scan();                      // also over a scan the user ran on half a read
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
