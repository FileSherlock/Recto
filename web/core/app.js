/* =========================================================
       Initialization
       ========================================================= */
    (async function init() {
      // 1. Event Listeners for Viewer functionality
      els.toggleSidebarBtn.addEventListener('click', () => {
        els.sidebar.classList.toggle('hidden');
        els.toggleSidebarBtn.classList.toggle('active');
      });

      // Right-panel toggles (e.g. the candidates "tools sidebar") are wired by
      // the plugins that own those panels — the core knows of no right panel.

      if (els.toolAddBoxBtn) {
        els.toolAddBoxBtn.addEventListener('click', () => {
          if (state.activeTool === 'add-box') {
            state.activeTool = null;
            els.toolAddBoxBtn.classList.remove('active');
            els.viewer.style.cursor = 'default';
          } else {
            state.activeTool = 'add-box';
            els.toolAddBoxBtn.classList.add('active');
            document.getElementById('tt-add-text-btn')?.classList.remove('active');
            els.viewer.style.cursor = 'crosshair';
          }
        });
      }
      
      // Subtoolbars are mutually-exclusive tabs in the options-bar row; null =
      // default (text options bar). A plugin contributes a toggle button + an
      // element with class "options-bar"; it registers the button via
      // registerSubtoolbar so openSubtoolbar can deactivate it generically —
      // the core never names a specific plugin here.
      const _subtoolbarButtons = [];
      window.registerSubtoolbar = function (button) {
        if (button && !_subtoolbarButtons.includes(button)) _subtoolbarButtons.push(button);
      };

      // Exposed as window.openSubtoolbar so plugin scripts can call it on click.
      // Only `.options-bar` (contextual) bars are switched; a plugin's
      // `.ribbon-bar` is persistent and is never hidden here.
      window.openSubtoolbar = function openSubtoolbar(barToShow, btnToActivate) {
        const toggleFmt = document.getElementById('toggle-fmt');
        document.querySelectorAll('#unified-options-bar-container .options-bar')
          .forEach(bar => bar.classList.add('hidden'));
        _subtoolbarButtons.forEach(btn => btn.classList.remove('active'));
        toggleFmt?.classList.remove('active');
        if (barToShow) {
          barToShow.classList.remove('hidden');
          btnToActivate?.classList.add('active');
        }
        window.relayoutRibbon?.();
      };

      // Set initial state — no contextual bar open
      openSubtoolbar(null, null);

      function triggerZoomCheck(mouseX = null, mouseY = null) {
        let val = parseInt(els.zoomInputElem.value.replace('%', ''));
        if (!isNaN(val)) {
          const newZoom = val / 100;
          processZoomFromText(newZoom, mouseX, mouseY);
        } else {
          updateZoomLevelText();
        }
      }

      // Zoom commands
      els.zoomInBtn.addEventListener('click', () => { 
        els.zoomInputElem.value = `${Math.round(state.currentZoom * 1.1 * 100)}%`;
        triggerZoomCheck();
      });
      els.zoomOutBtn.addEventListener('click', () => { 
        els.zoomInputElem.value = `${Math.round(state.currentZoom / 1.1 * 100)}%`;
        triggerZoomCheck();
      });
      els.zoomInputElem.addEventListener('change', () => triggerZoomCheck());

      // Click to add box/text tool logic
      els.viewer.addEventListener('mousedown', async (e) => {
        const pageEl = e.target.closest('.page-container');
        if (!pageEl) return;
        
        const pageNum = parseInt(pageEl.id.replace('pageContainer', ''));

        // Map screen click → document-space coordinates via the SVG text layer's
        // getScreenCTM().  This is immune to toolbar layout shifts, scroll offsets
        // and CSS scale-factor sizing.
        let pxX, pxY;
        const svg = pageEl.querySelector('svg.text-layer');
        if (svg && typeof svg.getScreenCTM === 'function') {
          const pt = svg.createSVGPoint();
          pt.x = e.clientX;
          pt.y = e.clientY;
          const transformed = pt.matrixTransform(svg.getScreenCTM().inverse());
          pxX = transformed.x;
          pxY = transformed.y;
        } else {
          // Fallback for pages without an SVG layer yet
          const rect = pageEl.getBoundingClientRect();
          const scale = state.currentZoom || 1.0;
          pxX = (e.clientX - rect.left) / scale;
          pxY = (e.clientY - rect.top) / scale;
        }

        if (state.activeTool === 'add-box') {
          if (typeof handleManualAddBox === 'function') {
            handleManualAddBox(pageNum, pxX, pxY);
          }
          state.activeTool = null;
          els.viewer.style.cursor = 'default';
          document.getElementById('tool-add-box')?.classList.remove('active');
        }
        else if (state.activeTool === 'text') {
           // Create a new editable UnifiedTextBox at the click position.
           if (typeof handleManualAddText === 'function') {
              handleManualAddText(pageNum, pxX, pxY);
           } else if (typeof addEmbeddedTextSpan === 'function') {
              addEmbeddedTextSpan(pageNum, pxX, pxY);
           }

           // Deselect tool after one use to avoid spam
           state.activeTool = null;
           els.viewer.style.cursor = 'default';
           const toolBtn = document.getElementById('tt-add-text-btn');
           if (toolBtn) toolBtn.classList.remove('active');
        }
      });

      // Ctrl+Wheel Zoom
      els.viewerContainer.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
          e.preventDefault();
          const newZoom = state.currentZoom * Math.pow(1.005, -e.deltaY);
          els.zoomInputElem.value = `${Math.round(newZoom * 100)}%`;
          
          const rect = els.viewerContainer.getBoundingClientRect();
          const mouseX = e.clientX - rect.left;
          const mouseY = e.clientY - rect.top;
          
          triggerZoomCheck(mouseX, mouseY);
        }
      }, { passive: false });

      // Drag overlay standard
      window.addEventListener('dragover', (e) => { e.preventDefault(); els.dragOverlay.classList.remove('hidden'); });
      els.dragOverlay.addEventListener('dragleave', (e) => { e.preventDefault(); els.dragOverlay.classList.add('hidden'); });
      window.addEventListener('drop', (e) => {
        e.preventDefault();
        els.dragOverlay.classList.add('hidden');
        if (e.dataTransfer.files.length > 0) {
          const t = e.dataTransfer.files[0].type;
          const name = e.dataTransfer.files[0].name.toLowerCase();
          const accepted = t === 'application/pdf' || t.startsWith('image/') ||
            /\.(pdf|png|jpe?g|tiff?|bmp|webp)$/.test(name);
          if (accepted) {
            els.pdfFile.files = e.dataTransfer.files;
            handleFileUpload();
          }
        }
      });

      // Regular file select
      els.pdfFile.addEventListener('change', handleFileUpload);

      // Jump to page
      els.pageInputElem.addEventListener('change', (e) => {
        if (!state.numPages) return;
        let p = parseInt(e.target.value);
        if (isNaN(p) || p < 1) p = 1;
        if (p > state.numPages) p = state.numPages;
        e.target.value = p;
        goToPage(p);
      });

      if (els.prevPageBtn) {
        els.prevPageBtn.addEventListener('click', () => {
          if (state.currentPage > 1) goToPage(state.currentPage - 1);
        });
      }
      if (els.nextPageBtn) {
        els.nextPageBtn.addEventListener('click', () => {
          if (state.currentPage < state.numPages) goToPage(state.currentPage + 1);
        });
      }

      // Core toolbar wiring is complete — plugins attach their own buttons /
      // option-bar controls now (e.g. webgl_mask wires its mask toggle here).
      await PDFHooks.emit('ui:ready');

      // 3. Auto-load the sample document on startup — after every script in
      // the page has run. Plugin scripts (scripts_after_app) come after this
      // one and subscribe to 'document:loaded' when they parse; the document
      // service can open the file and render page 1 before they have, and the
      // event would fire for nobody (the startup document then showed no
      // embedded text and no OCR until the next load). DOMContentLoaded is
      // the point at which every synchronous script has executed.
      if (document.readyState === 'loading') {
        await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
      }
      // generated/default-document.json (written by the build) names the PDF
      // in assets/pdfs/, if there is one.
      try {
        const resp = await fetch('generated/default-document.json', { cache: 'no-cache' });
        const startup = resp.ok ? await resp.json() : null;
        if (startup?.file) {
          const file = await fetch(`${startup.file}?v=${startup.v}`);
          if (!file.ok) throw new Error(`${startup.file}: ${file.status}`);
          state.hasPdf = true;
          els.titleElem.textContent = startup.name || 'Sample document';
          await openDocument(await file.blob(), startup.name, null);
        }
      } catch (e) {
        console.warn('Auto-load of the sample document failed:', e.message);
      }

    })();
/* =========================================================
       The tool column, the ribbon's overflow, the panels
       ========================================================= */
// The core owns the chrome and names no plugin: it arranges whatever buttons
// the build put into the column, moves whatever ribbon groups do not fit, and
// shows whatever settings sections the plugins contributed.

// ── The tool column ─────────────────────────────────────────
// Every plugin's toolbar buttons, in plugin order by default. The user picks
// which are shown and in what order (the Customise panel); the choice is
// this browser's (localStorage). A tool taken out of the column moves into
// #tool-column-overflow — the "More tools" popover — so it keeps working and
// stays reachable.
(function toolColumn() {
  const KEY = 'recto.toolColumn';
  const items = document.getElementById('tool-column-items');
  const overflow = document.getElementById('tool-column-overflow');
  const moreBtn = document.getElementById('tool-column-more');
  const customiseBtn = document.getElementById('tool-column-customise');
  const panel = document.getElementById('tool-customise');
  const list = document.getElementById('tool-customise-list');
  if (!items || !overflow) return;

  const buttonsOf = el => [...el.querySelectorAll(':scope > button[id]')];
  const natural = buttonsOf(items).map(b => b.id);            // the plugins' order
  const all = () => [...buttonsOf(items), ...buttonsOf(overflow)];
  // the tools' names as their fragments give them — a plugin may change a
  // button's tooltip later (an undo button says what it would undo)
  const labels = new Map(buttonsOf(items).map(b => [b.id, b.title || b.getAttribute('aria-label') || b.id]));
  const labelOf = b => labels.get(b.id) || b.id;

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && Array.isArray(s.order) && Array.isArray(s.hidden)) return s;
    } catch { /* nothing kept, or not readable: the default */ }
    return { order: [], hidden: [] };
  }
  function save(prefs) {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private window, full disk: this session only */ }
  }
  function apply(prefs) {
    const byId = new Map(all().map(b => [b.id, b]));
    const order = [...prefs.order.filter(id => byId.has(id)), ...natural.filter(id => !prefs.order.includes(id))];
    for (const id of order) (prefs.hidden.includes(id) ? overflow : items).appendChild(byId.get(id));
    const anyHidden = !!overflow.querySelector('button');
    moreBtn?.classList.toggle('hidden', !anyHidden);
    if (!anyHidden) overflow.classList.add('hidden');
  }
  let prefs = load();
  apply(prefs);

  // "More tools": the hidden buttons, next to the column
  moreBtn?.addEventListener('click', e => { e.stopPropagation(); overflow.classList.toggle('hidden'); });
  document.addEventListener('mousedown', e => {
    if (!overflow.classList.contains('hidden') && !overflow.contains(e.target) && e.target !== moreBtn && !moreBtn.contains(e.target))
      overflow.classList.add('hidden');
  }, true);

  // Customise: the list mirrors the column; every change is applied at once
  function fill() {
    if (!list) return;
    list.innerHTML = '';
    const byId = new Map(all().map(b => [b.id, b]));
    const order = [...prefs.order.filter(id => byId.has(id)), ...natural.filter(id => !prefs.order.includes(id))];
    order.forEach((id, i) => {
      const b = byId.get(id);
      const li = document.createElement('li');
      li.dataset.id = id;
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = !prefs.hidden.includes(id); cb.title = 'Show in the column';
      const icon = document.createElement('span');
      icon.className = 'tc-icon';
      if (b.firstElementChild) icon.appendChild(b.firstElementChild.cloneNode(true));
      const label = document.createElement('span');
      label.className = 'tc-label'; label.textContent = labelOf(b);
      const up = document.createElement('button'), down = document.createElement('button');
      up.className = 'tc-move'; up.textContent = '▲'; up.title = 'Move up'; up.disabled = i === 0;
      down.className = 'tc-move'; down.textContent = '▼'; down.title = 'Move down'; down.disabled = i === order.length - 1;
      up.addEventListener('click', () => move(id, -1));
      down.addEventListener('click', () => move(id, 1));
      cb.addEventListener('change', () => commit());
      li.append(cb, icon, label, up, down);
      list.appendChild(li);
    });
  }
  function move(id, by) {
    const order = [...list.children].map(li => li.dataset.id);
    const i = order.indexOf(id), j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    prefs = { order, hidden: prefs.hidden };
    commit(order);
  }
  function commit(order = [...list.children].map(li => li.dataset.id)) {
    const hidden = [...list.children].filter(li => !li.querySelector('input').checked).map(li => li.dataset.id);
    prefs = { order, hidden };
    save(prefs);
    apply(prefs);
    fill();
  }
  customiseBtn?.addEventListener('click', () => {
    const open = panel?.classList.contains('hidden');
    closePanels();
    if (open) { fill(); panel.classList.remove('hidden'); }
  });
  document.getElementById('tool-customise-close')?.addEventListener('click', () => panel?.classList.add('hidden'));
  document.getElementById('tool-customise-reset')?.addEventListener('click', () => {
    try { localStorage.removeItem(KEY); } catch { /* nothing to remove */ }
    prefs = { order: [], hidden: [] };
    apply(prefs);
    fill();
  });
})();

// ── The ribbon's overflow ──────────────────────────────────
// The ribbon is one line. When its visible groups are wider than the row,
// the trailing groups (in reading order: bars by their CSS `order`, groups in
// bar order) move under the "More" button, into #ribbon-overflow, and come
// back the moment there is room — the width changes, a bar opens or closes,
// a group is shown or hidden. A group keeps its element and its listeners
// wherever it sits.
(function ribbonOverflow() {
  const row = document.getElementById('text-toolbar-row');
  const more = document.getElementById('ribbon-more');
  const menu = document.getElementById('ribbon-overflow');
  if (!row || !more || !menu) return;
  const moved = [];          // { group, divider, parent }, in the order they left the row
  let busy = false, queued = false;

  const shown = el => !el.classList.contains('hidden');
  const fits = () => row.scrollWidth <= row.clientWidth + 1;
  function restoreAll() {
    while (moved.length) {
      const { group, divider, parent } = moved.pop();
      if (divider) parent.appendChild(divider);
      parent.appendChild(group);
    }
  }
  function groupsInReadingOrder() {
    const bars = [...row.children].filter(el => shown(el) && el.matches('.ribbon-bar, .options-bar'));
    bars.sort((a, b) => (+getComputedStyle(a).order || 0) - (+getComputedStyle(b).order || 0));
    return bars.flatMap(bar => [...bar.querySelectorAll(':scope > .options-group')].filter(shown).map(g => ({ g, bar })));
  }
  function relayout() {
    if (busy) return;
    busy = true;
    try {
      restoreAll();
      more.classList.add('hidden');
      if (fits()) { menu.classList.add('hidden'); return; }
      more.classList.remove('hidden');
      const groups = groupsInReadingOrder();
      while (!fits() && groups.length) {
        const { g, bar } = groups.pop();
        const prev = g.previousElementSibling;
        const divider = prev && prev.classList.contains('options-divider') ? prev : null;
        moved.push({ group: g, divider, parent: bar });
        if (divider) menu.appendChild(divider);
        menu.appendChild(g);
      }
      if (!moved.length) { more.classList.add('hidden'); menu.classList.add('hidden'); }
    } finally { busy = false; }
  }
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; relayout(); });
  }
  window.relayoutRibbon = schedule;

  new ResizeObserver(schedule).observe(row);
  // a bar opened or closed, a group shown or hidden — never the moves above
  // (those change no class)
  new MutationObserver(schedule).observe(row, { subtree: true, attributes: true, attributeFilter: ['class'] });
  more.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('hidden'); });
  document.addEventListener('mousedown', e => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target) && !more.contains(e.target)) menu.classList.add('hidden');
  }, true);
  schedule();
})();

// ── The Settings panel ─────────────────────────────────────
// One panel, a section per plugin (its `settings` fragment). Without any
// section there is nothing to open, and the button goes.
function closePanels() {
  document.querySelectorAll('.floating-panel').forEach(p => p.classList.add('hidden'));
}
(function settingsPanel() {
  const btn = document.getElementById('toggle-settings');
  const panel = document.getElementById('settings-panel');
  const sections = document.getElementById('settings-sections');
  if (!btn || !panel) return;
  if (!sections?.children.length) { btn.classList.add('hidden'); return; }
  btn.addEventListener('click', () => {
    const open = panel.classList.contains('hidden');
    closePanels();
    if (open) panel.classList.remove('hidden');
    btn.classList.toggle('active', open);
  });
  document.getElementById('settings-close')?.addEventListener('click', () => { panel.classList.add('hidden'); btn.classList.remove('active'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.classList.contains('hidden')) { panel.classList.add('hidden'); btn.classList.remove('active'); } });
  document.addEventListener('mousedown', e => {
    if (panel.classList.contains('hidden') || panel.contains(e.target) || btn.contains(e.target)) return;
    panel.classList.add('hidden');
    btn.classList.remove('active');
  }, true);
})();
