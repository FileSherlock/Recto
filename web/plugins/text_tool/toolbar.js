// toolbar.js
// Unified formatting toolbar — reads/writes UnifiedTextBox objects directly.
// No branching on box.type; one code path for embedded, redaction, and harfbuzz.

(function initToolbar() {

  // ── Helpers ───────────────────────────────────────────────────

  function el(id) { return document.getElementById(id); }

  function getSelected() {
    return utbState.selectedId ? utbState.getBox(utbState.selectedId) : null;
  }

  // ── Sync toolbar ← box ────────────────────────────────────────

  /**
   * Push a box's properties into the toolbar UI.
   * Called whenever a box is selected.
   */
  function syncToolbarToBox(box) {
    if (!box) return;

    // The menu must SHOW the box's family even when the catalogue lacks it:
    // every toolbar change writes the menu's value back into the box
    // (persistFromToolbar), so a menu left on another family would silently
    // re-font the box the next time Bold is clicked.
    const ffSel = el('fabric-font-family');
    if (ffSel && box.fontFamily) {
      if (!Array.from(ffSel.options).some(o => o.value === box.fontFamily)) {
        const opt = document.createElement('option');
        opt.value = box.fontFamily; opt.textContent = `${box.fontFamily} (not installed)`;
        ffSel.appendChild(opt);
      }
      ffSel.value = box.fontFamily;
    }

    const fsInput = el('fabric-font-size');
    // Font-size input is in POINTS — box.sizePt is shown directly.
    if (fsInput) fsInput.value = Math.round(box.sizePt * 100) / 100;

    el('fabric-bold')         ?.classList.toggle('active', box.bold);
    el('fabric-italic')       ?.classList.toggle('active', box.italic);
    el('fabric-underline')    ?.classList.toggle('active', box.underline);
    el('fabric-strikethrough')?.classList.toggle('active', box.strikethrough);

    const colorInput = el('fabric-color');
    if (colorInput && box.color && box.color.startsWith('#')) {
      colorInput.value = box.color;
    }

    const lsInput = el('fabric-letter-spacing');
    if (lsInput) lsInput.value = (box.letterSpacing || 0).toFixed(2);

    // Default Space Width button
    const defaultSwCheck = el('fabric-default-sw');
    if (defaultSwCheck) defaultSwCheck.classList.toggle('active', box.defaultSpaceWidth);

    // Space Width slider
    const swSlider  = el('fabric-space-width');
    const swDisplay = el('fabric-space-width-display');
    if (swSlider) {
      if (box.spaceWidth != null) {
        swSlider.value = box.spaceWidth;
        if (swDisplay) swDisplay.textContent = `${parseFloat(box.spaceWidth).toFixed(1)}px`;
      }
    }

    // Nudge button state
    const nudgeBtn = el('fabric-nudge-mode');
    if (nudgeBtn) {
      nudgeBtn.classList.toggle('active', utbState.microTypoId === box.id);
      nudgeBtn.disabled = !utbCharsValid(box);
    }

    // Kerning is a general text property (drives fontKerning for every box
    // type) and lives in the Style group, always visible — keep it in sync for
    // all selections.
    const kernI = el('kerning');
    if (kernI) {
      kernI.checked = !!box.kerning;
      const lbl = kernI.closest('label');
      if (lbl) lbl.title = box.kerningAuto
        ? "Apply the font's native kerning to this text — currently following the page"
        : "Apply the font's native kerning to this text";
    }

    // Match group — redaction-only tuning (Tolerance / Uppercase). Reveal it for
    // redaction boxes and reflect the box's values; hide it otherwise (they are
    // meaningless on ordinary text). The shared IDs are also read by whichever
    // matching plugin is installed.
    const isRedaction = box.type === 'redaction';
    el('fabric-match-group')?.classList.toggle('hidden', !isRedaction);
    el('fabric-match-divider')?.classList.toggle('hidden', !isRedaction);
    if (isRedaction) {
      const tolI = el('tolerance');       if (tolI) tolI.value  = box.tolerance;
      const upI  = el('force-uppercase'); if (upI)  upI.checked = !!box.uppercase;
    }

    // Formatting is contextual: reveal the Font/Style/Spacing groups whenever a
    // box becomes the active selection. Every selection path (click, add-box,
    // sidebar row) routes through here, so this is the single reveal point.
    el('fabric-options-bar')?.classList.remove('hidden');
  }

  // Expose for drag-resize.js and other modules
  window.syncToolbarToBox = syncToolbarToBox;

  function syncToolbarToSelection() {
    const box = getSelected();
    if (box) syncToolbarToBox(box);
  }
  window.syncToolbarToSelection = syncToolbarToSelection;

  // ── Persist toolbar → box ─────────────────────────────────────

  /**
   * Read current toolbar state and write to box, then re-render.
   */
  async function persistFromToolbar(box) {
    if (!box) return;

    const newFamily = el('fabric-font-family')?.value || box.fontFamily;
    const inputSize = parseFloat(el('fabric-font-size')?.value);  // points
    const newSize   = inputSize > 0 ? inputSize : box.sizePt;     // never 0, negative or NaN

    box.fontFamily    = newFamily;
    box.sizePt        = newSize;
    box.bold          = el('fabric-bold')         ?.classList.contains('active') ?? box.bold;
    box.italic        = el('fabric-italic')       ?.classList.contains('active') ?? box.italic;
    box.underline     = el('fabric-underline')    ?.classList.contains('active') ?? box.underline;
    box.strikethrough = el('fabric-strikethrough')?.classList.contains('active') ?? box.strikethrough;
    // (kerning has its own handler: reading the checkbox here would turn a
    // box that follows the page into one with a fixed choice)
    box.letterSpacing = parseFloat(el('fabric-letter-spacing')?.value) || 0;
    box.defaultSpaceWidth = el('fabric-default-sw')?.classList.contains('active') ?? box.defaultSpaceWidth;

    if (box.defaultSpaceWidth) {
      box.spaceWidth = null; // use native font spacing
    } else {
      box.spaceWidth = parseFloat(el('fabric-space-width')?.value) || box.spaceWidth;
    }

    // Always recalculate candidate widths for redactions when toolbar properties are applied
    if (box.type === 'redaction' && typeof calculateWidthsForRedaction === 'function') {
      await calculateWidthsForRedaction(box.id);
    }

    renderBox(box);
    // Update space-width display
    const swDisplay = el('fabric-space-width-display');
    if (swDisplay && box.spaceWidth != null) {
      swDisplay.textContent = `${parseFloat(box.spaceWidth).toFixed(1)}px`;
    }
  }

  // ── Natural space width helper ─────────────────────────────

  /**
   * Fetch the HarfBuzz natural space advance for the box's current font/size.
   * Used to initialise the slider when unchecking "Default".
   */
  const _naturalSpaceCache = new Map();

  async function fetchNaturalSpaceWidth(box) {
    // HarfBuzz expects the size in POINTS — box.sizePt is already points.
    const size  = box.sizePt;
    const scale = GEO.docScale();  // px-per-pt × 100 for this document
    const key = `${box.fontFamily}|${box.bold ? 'b' : ''}${box.italic ? 'i' : ''}|${size}|${box.kerning ? 1 : 0}|${scale}`;
    if (_naturalSpaceCache.has(key)) return _naturalSpaceCache.get(key);
    try {
      const data = await Shaping.widths({
        strings: [' '],
        family:  box.fontFamily,     // resolved through the font catalogue (shaping.js)
        bold:    !!box.bold,
        italic:  !!box.italic,
        size:    size,
        scale:   scale,
        kerning:    box.kerning,
      });
      // The width of a single space character = the natural space advance
      const w = data.results?.[0]?.width ?? null;
      if (w != null) _naturalSpaceCache.set(key, w);
      return w;
    } catch { return null; }
  }
  // Exposed for plugins that need a face's natural space width (a guarded global).
  window.getNaturalSpaceWidth = fetchNaturalSpaceWidth;


  // ── Event wiring ──────────────────────────────────────────────

  const STYLE_TOGGLES = ['fabric-bold', 'fabric-italic', 'fabric-underline', 'fabric-strikethrough'];

  STYLE_TOGGLES.forEach(id => {
    el(id)?.addEventListener('click', () => {
      el(id).classList.toggle('active');
      const box = getSelected();
      if (box) persistFromToolbar(box);
    });
  });

  el('fabric-font-family')?.addEventListener('change', () => persistFromToolbar(getSelected()));
  el('fabric-font-size')  ?.addEventListener('input',  () => {
    const box = getSelected();
    if (box) {
      const inputSize = parseFloat(el('fabric-font-size').value);  // points
      box.sizePt = inputSize > 0 ? inputSize : box.sizePt;
      renderBox(box);
      if (box.type === 'redaction' && typeof calculateWidthsForRedaction === 'function') {
        calculateWidthsForRedaction(box.id);
      }
    }
  });
  el('fabric-font-size')  ?.addEventListener('change', () => persistFromToolbar(getSelected()));

  el('fabric-letter-spacing')?.addEventListener('change', () => persistFromToolbar(getSelected()));
  el('fabric-color')         ?.addEventListener('input', e => {
    const box = getSelected();
    if (box) { box.color = e.target.value; renderBox(box); }
  });

  // "Default" button: toggle native vs manual space width
  el('fabric-default-sw')?.addEventListener('click', async () => {
    const box = getSelected();
    if (!box) return;

    const btn = el('fabric-default-sw');
    const isDefault = btn.classList.toggle('active');
    box.defaultSpaceWidth = isDefault;

    const swSlider  = el('fabric-space-width');
    const swDisplay = el('fabric-space-width-display');

    if (!isDefault) {
      // User deactivated "Default" → initialise slider to the font's natural space width
      const naturalSW = await fetchNaturalSpaceWidth(box);
      if (naturalSW !== null) {
        box.spaceWidth = naturalSW;
        box.nativeSpaceWidth = naturalSW;
        if (swSlider) swSlider.value = naturalSW;
        if (swDisplay) swDisplay.textContent = `${naturalSW.toFixed(1)}px`;
      }
    } else {
      box.spaceWidth = null;
    }

    renderBox(box);

    // Recalculate candidate widths for redactions
    if (box.type === 'redaction' && typeof calculateWidthsForRedaction === 'function') {
      await calculateWidthsForRedaction(box.id);
    }
  });

  // Space width slider (live drag)
  el('fabric-space-width')?.addEventListener('input', e => {
    const box = getSelected();
    if (!box || box.defaultSpaceWidth) return;
    box.spaceWidth = parseFloat(e.target.value);
    const disp = el('fabric-space-width-display');
    if (disp) disp.textContent = `${box.spaceWidth.toFixed(1)}px`;
    renderBox(box);
    if (box.type === 'redaction' && typeof calculateWidthsForRedaction === 'function') {
      calculateWidthsForRedaction(box.id);
    }
  });

  // Nudge mode button (micro-typography)
  el('fabric-nudge-mode')?.addEventListener('click', () => {
    const box = getSelected();
    if (!box) return;

    // If already in micro-typo mode, exit
    if (utbState.microTypoId === box.id) {
      if (typeof exitMicroTypo === 'function') exitMicroTypo();
      el('fabric-nudge-mode')?.classList.remove('active');
      return;
    }

    // Enter micro-typo mode if the box has character positions
    if (utbCharsValid(box) && typeof enterMicroTypo === 'function') {
      enterMicroTypo(box);
      el('fabric-nudge-mode')?.classList.add('active');
    }
  });

  // Kerning — a general text property: applies to any box type by driving the
  // SVG's fontKerning. Re-render first so the live element carries the updated
  // style before anything measures it via getBBox(); recalc candidate widths
  // for redactions (guarded so text_tool stays standalone).
  el('kerning')?.addEventListener('change', () => {
    const box = getSelected();
    if (!box) return;
    box.kerning = el('kerning')?.checked ?? box.kerning;
    box.kerningAuto = false;                       // the user chose; nothing overrides it again
    syncToolbarToBox(box);
    renderBox(box);
    if (box.type === 'redaction' && typeof calculateWidthsForRedaction === 'function') {
      calculateWidthsForRedaction(box.id);
    }
  });

  // Match controls (Tolerance / Uppercase) — redaction-only tuning that drives
  // width matching against a bar, applied to the selected redaction box. Calls
  // into a matching plugin are guarded (typeof …) so text_tool stays standalone.
  function applyMatchControls(changed) {
    const box = getSelected();
    if (!box || box.type !== 'redaction') return;
    box.tolerance = parseFloat(el('tolerance')?.value) || 0;
    box.uppercase = el('force-uppercase')?.checked ?? box.uppercase;
    if (changed === 'tolerance') {
      // Width is unchanged by tolerance — only which candidates pass.
      if (typeof updateAllMatchesView === 'function') updateAllMatchesView(box.id);
    } else {
      renderBox(box);
      if (typeof calculateWidthsForRedaction === 'function') calculateWidthsForRedaction(box.id);
    }
  }
  el('tolerance')     ?.addEventListener('change', () => applyMatchControls('tolerance'));
  el('force-uppercase')?.addEventListener('change', () => applyMatchControls('uppercase'));

  // Space-label toggle button
  el('toggle-space-labels')?.addEventListener('click', () => {
    const btn = el('toggle-space-labels');
    const active = btn.classList.toggle('active');
    if (typeof setShowSpaceWidthLabels === 'function') setShowSpaceWidthLabels(active);
  });

  // Toggle-fmt button (show/hide toolbar)
  el('toggle-fmt')?.addEventListener('click', () => {
    const bar = el('fabric-options-bar');
    const btn = el('toggle-fmt');
    if (!bar) return;

    if (bar.classList.contains('hidden')) {
      // Open: hand off to the global coordinator
      if (typeof openSubtoolbar === 'function') openSubtoolbar(bar, btn);
      else { bar.classList.remove('hidden'); btn?.classList.add('active'); }
    } else {
      // Close: revert to the default text-options-bar
      if (typeof openSubtoolbar === 'function') openSubtoolbar(null, null);
      else { bar.classList.add('hidden'); btn?.classList.remove('active'); }
    }
  });

  // Add-text tool: arm "click on page to drop a new editable text box".
  // The actual placement is handled by the viewer mousedown listener in app.js
  // (state.activeTool === 'text' → addEmbeddedTextSpan). Core no longer wires
  // this plugin-owned button, so the toggle lives here.
  el('tt-add-text-btn')?.addEventListener('click', () => {
    const btn = el('tt-add-text-btn');
    if (state.activeTool === 'text') {
      state.activeTool = null;
      btn.classList.remove('active');
      els.viewer.style.cursor = 'default';
    } else {
      state.activeTool = 'text';
      btn.classList.add('active');
      // Mutually exclusive with the add-box tool
      el('tool-add-box')?.classList.remove('active');
      els.viewer.style.cursor = 'crosshair';
    }
  });

  // Toggle-embedded-text button (show/hide embedded text in SVG globally)
  el('toggle-embedded-text')?.classList.add('active');
  el('toggle-embedded-text')?.addEventListener('click', () => {
    const btn = el('toggle-embedded-text');
    const active = btn.classList.toggle('active');
    document.body.classList.toggle('hide-embedded-text', !active);
  });

})();
