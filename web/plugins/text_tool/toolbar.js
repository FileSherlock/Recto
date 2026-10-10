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
  // Artistic / Frame text: the ribbon shows and sets the character
  // attributes of its selection — all of its text while the box is only
  // selected, the selected characters while it is edited (story-edit.js)
  const storyBoxOf = box => (box?.textMode && typeof storyApplyChar === 'function' ? box : null);
  const selectedStory = () => storyBoxOf(getSelected());

  function syncToolbarToStory(box) {
    const st = window.storyCharState?.(box);
    if (!st) return;
    const a = st.attrs, mixed = new Set(st.mixed);
    const ffSel = el('fabric-font-family');
    if (ffSel) {
      if (!Array.from(ffSel.options).some(o => o.value === a.fontFamily)) {
        const opt = document.createElement('option');
        opt.value = a.fontFamily; opt.textContent = `${a.fontFamily} (not installed)`;
        ffSel.appendChild(opt);
      }
      ffSel.value = a.fontFamily;
    }
    const fs = el('fabric-font-size');
    if (fs && document.activeElement !== fs) fs.value = mixed.has('sizePt') ? '' : Math.round(a.sizePt * 100) / 100;
    el('fabric-bold')         ?.classList.toggle('active', !!a.bold);
    el('fabric-italic')       ?.classList.toggle('active', !!a.italic);
    el('fabric-underline')    ?.classList.toggle('active', a.underline !== 'none');
    el('fabric-strikethrough')?.classList.toggle('active', a.strike !== 'none');
    const c = el('fabric-color');
    if (c && a.color && /^#[0-9a-f]{6}$/i.test(a.color)) c.value = a.color;
    showOpacity(mixed.has('opacity') ? null : a.opacity);
    const ls = el('fabric-letter-spacing');
    if (ls && document.activeElement !== ls) ls.value = ((a.tracking || 0) / 1000).toFixed(2);
    const kernI = el('kerning');
    if (kernI) { kernI.checked = !!a.autoKern; const lbl = kernI.closest('label'); if (lbl) lbl.title = "Apply the font's native kerning to this text"; }
    // what only a one-line box has: the measured space width and the nudge
    for (const id of ['fabric-default-sw', 'fabric-space-width', 'toggle-space-labels', 'fabric-nudge-mode']) {
      const b = el(id); if (b) b.disabled = true;
    }
  }
  window.onStoryChange?.(() => { const b = selectedStory(); if (b) syncToolbarToStory(b); });

  function syncToolbarToBox(box) {
    if (!box) return;
    for (const id of ['fabric-default-sw', 'fabric-space-width', 'toggle-space-labels']) {
      const b = el(id); if (b) b.disabled = !!storyBoxOf(box);
    }
    window.syncStoryControls?.(box);
    if (storyBoxOf(box)) {
      syncToolbarToStory(box);
      syncMatchSettings(null);
      el('fabric-options-bar')?.classList.remove('hidden');
      return;
    }

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
    showOpacity(box.opacity ?? 100);

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

    // The matching terms (Settings panel) show the selected redaction's
    // values; the shared ids are also read by whichever matching plugin is
    // installed.
    syncMatchSettings(box.type === 'redaction' ? box : null);

    // Formatting is contextual: reveal the Font/Style/Spacing groups whenever a
    // box becomes the active selection. Every selection path (click, add-box,
    // sidebar row) routes through here, so this is the single reveal point.
    el('fabric-options-bar')?.classList.remove('hidden');
  }

  // Expose for drag-resize.js and other modules
  window.syncToolbarToBox = syncToolbarToBox;

  // The opacity slider and its number show one value (null: mixed in the selection)
  function showOpacity(v) {
    const r = el('fabric-opacity'), n = el('fabric-opacity-value');
    if (r && document.activeElement !== r) r.value = v ?? 100;
    if (n && document.activeElement !== n) n.value = v == null ? '' : Math.round(v);
  }

  function syncToolbarToSelection() {
    const box = getSelected();
    if (box) syncToolbarToBox(box);
    else syncMatchSettings(null);
  }
  window.syncToolbarToSelection = syncToolbarToSelection;

  // The Settings panel's matching terms: the selected redaction's, or — with
  // none selected — the defaults a new redaction box takes.
  function syncMatchSettings(box) {
    if (box) {
      const tolI = el('tolerance');    if (tolI) tolI.value = box.tolerance;
      const caseSel = el('tt-name-case'); if (caseSel) caseSel.value = utbCaseValue(box.uppercase);
    }
    const scope = el('tt-match-scope');
    if (scope) {
      scope.textContent = box ? '· this box' : '· new boxes';
      scope.title = box ? 'The selected redaction box' : 'No redaction box selected — the defaults for new boxes';
    }
  }

  // ── Persist toolbar → box ─────────────────────────────────────

  /**
   * Read current toolbar state and write to box, then re-render.
   */
  async function persistFromToolbar(box, key = null) {
    if (!box) return;
    const step = window.utbUndo?.capture([box]);

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
    window.utbUndo?.commit(step, 'format', key);

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

  const STORY_TOGGLE = {
    'fabric-bold': on => ({ bold: on }),
    'fabric-italic': on => ({ italic: on }),
    'fabric-underline': on => ({ underline: on ? 'single' : 'none' }),
    'fabric-strikethrough': on => ({ strike: on ? 'single' : 'none' }),
  };
  STYLE_TOGGLES.forEach(id => {
    el(id)?.addEventListener('click', () => {
      const on = el(id).classList.toggle('active');
      const sb = selectedStory();
      if (sb) { storyApplyChar(sb, STORY_TOGGLE[id](on)); return; }
      const box = getSelected();
      if (box) persistFromToolbar(box);
    });
  });

  el('fabric-font-family')?.addEventListener('change', () => {
    const sb = selectedStory();
    if (sb) { storyApplyChar(sb, { fontFamily: el('fabric-font-family').value }); return; }
    persistFromToolbar(getSelected());
  });
  el('fabric-font-size')  ?.addEventListener('input',  () => {
    const sb = selectedStory();
    if (sb) {
      const v = parseFloat(el('fabric-font-size').value);
      if (v > 0) storyApplyChar(sb, { sizePt: v }, `size:${sb.id}`);
      return;
    }
    const box = getSelected();
    if (box) {
      const step = window.utbUndo?.capture([box]);
      const inputSize = parseFloat(el('fabric-font-size').value);  // points
      box.sizePt = inputSize > 0 ? inputSize : box.sizePt;
      window.utbUndo?.commit(step, 'font size', `size:${box.id}`);
      renderBox(box);
      if (box.type === 'redaction' && typeof calculateWidthsForRedaction === 'function') {
        calculateWidthsForRedaction(box.id);
      }
    }
  });
  el('fabric-font-size')  ?.addEventListener('change', () => {
    if (selectedStory()) return;                       // the input handler applied it
    const b = getSelected(); if (b) persistFromToolbar(b, `size:${b.id}`);
  });

  el('fabric-letter-spacing')?.addEventListener('change', () => {
    const sb = selectedStory();
    if (sb) { storyApplyChar(sb, { tracking: Math.round((parseFloat(el('fabric-letter-spacing').value) || 0) * 1000) }); return; }
    persistFromToolbar(getSelected());
  });
  el('fabric-color')         ?.addEventListener('input', e => {
    const sb = selectedStory();
    if (sb) { storyApplyChar(sb, { color: e.target.value }, `color:${sb.id}`); return; }
    const box = getSelected();
    if (box) {
      const step = window.utbUndo?.capture([box]);
      box.color = e.target.value;
      window.utbUndo?.commit(step, 'colour', `color:${box.id}`);
      renderBox(box);
    }
  });

  // Text opacity: a story's selected characters, or a plain box's text
  function applyOpacity(raw) {
    const v = Math.max(0, Math.min(100, Math.round(parseFloat(raw))));
    if (!Number.isFinite(v)) return;
    showOpacity(v);
    const sb = selectedStory();
    if (sb) { storyApplyChar(sb, { opacity: v }, `opacity:${sb.id}`); return; }
    const box = getSelected();
    if (!box) return;
    const step = window.utbUndo?.capture([box]);
    box.opacity = v;
    window.utbUndo?.commit(step, 'opacity', `opacity:${box.id}`);
    renderBox(box);
  }
  el('fabric-opacity')?.addEventListener('input', e => applyOpacity(e.target.value));
  el('fabric-opacity-value')?.addEventListener('change', e => applyOpacity(e.target.value));
  el('fabric-opacity')?.addEventListener('dblclick', () => applyOpacity(100));

  // "Default" button: toggle native vs manual space width
  el('fabric-default-sw')?.addEventListener('click', async () => {
    const box = getSelected();
    if (!box) return;

    const btn = el('fabric-default-sw');
    const isDefault = btn.classList.toggle('active');
    const step = window.utbUndo?.capture([box]);
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
    window.utbUndo?.commit(step, 'space width');

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
    const step = window.utbUndo?.capture([box]);
    box.spaceWidth = parseFloat(e.target.value);
    window.utbUndo?.commit(step, 'space width', `space:${box.id}`);
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
    const sb = selectedStory();
    if (sb) { storyApplyChar(sb, { autoKern: !!el('kerning').checked }); return; }
    const box = getSelected();
    if (!box) return;
    const step = window.utbUndo?.capture([box]);
    box.kerning = el('kerning')?.checked ?? box.kerning;
    box.kerningAuto = false;                       // the user chose; nothing overrides it again
    window.utbUndo?.commit(step, 'kerning');
    syncToolbarToBox(box);
    renderBox(box);
    if (box.type === 'redaction' && typeof calculateWidthsForRedaction === 'function') {
      calculateWidthsForRedaction(box.id);
    }
  });

  // Match controls (tolerance / letter case, in the Settings panel) —
  // redaction-only tuning that drives width matching against a bar, applied
  // to the selected redaction box. Calls
  // into a matching plugin are guarded (typeof …) so text_tool stays standalone.
  function applyMatchControls(changed) {
    const box = getSelected();
    if (!box || box.type !== 'redaction') return;
    const step = window.utbUndo?.capture([box]);
    box.tolerance = parseFloat(el('tolerance')?.value) || 0;
    const caseSel = el('tt-name-case');
    if (caseSel) box.uppercase = utbCaseMode(caseSel.value);
    window.utbUndo?.commit(step, changed);
    if (changed === 'tolerance') {
      // Width is unchanged by tolerance — only which candidates pass.
      if (typeof updateAllMatchesView === 'function') updateAllMatchesView(box.id);
    } else {
      renderBox(box);
      if (typeof calculateWidthsForRedaction === 'function') calculateWidthsForRedaction(box.id);
    }
  }
  el('tolerance')   ?.addEventListener('change', () => applyMatchControls('tolerance'));
  el('tt-name-case')?.addEventListener('change', () => applyMatchControls('letter case'));

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

  // ── Artistic / Frame text: Affinity's text context toolbar ────────────
  // The ribbon groups marked .tt-story-only / .tt-frame-only show while text
  // the user added is selected; a plain one-line box becomes Artistic text the
  // moment one of them is used on it (storyApplyChar → ensureStory).

  const storyCapable = box => !!box && (!!box.textMode || box.type === 'harfbuzz');
  const SC = globalThis.StoryCore;

  function showStoryGroups(box) {
    const story = storyCapable(box), frame = box?.textMode === 'frame';
    // (by class, not under the bar: a group that did not fit sits in the
    // ribbon's "More" menu)
    document.querySelectorAll('.tt-story-only').forEach(e => e.classList.toggle('hidden', !story));
    document.querySelectorAll('.tt-frame-only').forEach(e => e.classList.toggle('hidden', !frame));
  }

  function syncStoryControls(box) {
    showStoryGroups(box);
    if (!storyCapable(box) || !SC) return;
    const ch = box.textMode ? window.storyCharState?.(box) : { attrs: SC.charOf({}), mixed: [] };
    const pa = box.textMode ? window.storyParaState?.(box) : { attrs: SC.paraOf({}), mixed: [] };
    const fr = SC.frameOf(box.frame);
    if (!ch || !pa) return;
    el('tt-superscript')?.classList.toggle('active', ch.attrs.position === 'super');
    el('tt-subscript')?.classList.toggle('active', ch.attrs.position === 'sub');
    el('tt-highlight-btn')?.classList.toggle('active', !!ch.attrs.highlight);
    if (ch.attrs.highlight && /^#[0-9a-f]{6}$/i.test(ch.attrs.highlight) && el('tt-highlight')) el('tt-highlight').value = ch.attrs.highlight;
    const align = el('tt-align');
    if (align) align.value = pa.mixed.includes('align') ? '' : pa.attrs.align;
    const lt = el('tt-leading-type'), lv = el('tt-leading');
    if (lt) lt.value = pa.mixed.includes('leadingType') ? '' : pa.attrs.leadingType;
    if (lv && document.activeElement !== lv) {
      lv.disabled = pa.attrs.leadingType === 'default';
      lv.value = pa.attrs.leadingType === 'default' || pa.mixed.includes('leading') ? '' : pa.attrs.leading;
    }
    el('tt-bullets')?.classList.toggle('active', pa.attrs.list === 'bullet');
    el('tt-numbers')?.classList.toggle('active', pa.attrs.list !== 'none' && pa.attrs.list !== 'bullet');
    if (el('tt-valign')) el('tt-valign').value = fr.valign;
    if (el('tt-columns') && document.activeElement !== el('tt-columns')) el('tt-columns').value = fr.columns;
    if (el('tt-gutter') && document.activeElement !== el('tt-gutter')) el('tt-gutter').value = fr.gutter;
  }
  window.syncStoryControls = syncStoryControls;
  window.onStoryChange?.(() => syncStoryControls(getSelected()));

  // the box these controls act on: text the user added, or nothing
  const storyTargetBox = () => { const b = getSelected(); return storyCapable(b) ? b : null; };
  const onStory = (id, type, fn) => el(id)?.addEventListener(type, e => { const b = storyTargetBox(); if (b) fn(b, e); });

  // Affinity steps each run's own size by a point
  onStory('tt-size-up', 'click', b => storyMapChar(b, a => ({ sizePt: Math.round((a.sizePt + 1) * 100) / 100 })));
  onStory('tt-size-down', 'click', b => storyMapChar(b, a => ({ sizePt: Math.max(1, Math.round((a.sizePt - 1) * 100) / 100) })));
  onStory('tt-change-case', 'change', (b, e) => { const mode = e.target.value; e.target.value = ''; if (mode) storyChangeCase(b, mode); });
  onStory('tt-superscript', 'click', b => storyApplyChar(b, { position: el('tt-superscript').classList.contains('active') ? 'normal' : 'super' }));
  onStory('tt-subscript', 'click', b => storyApplyChar(b, { position: el('tt-subscript').classList.contains('active') ? 'normal' : 'sub' }));
  onStory('tt-highlight-btn', 'click', b => storyApplyChar(b, { highlight: el('tt-highlight-btn').classList.contains('active') ? null : el('tt-highlight').value }));
  onStory('tt-highlight', 'input', (b, e) => storyApplyChar(b, { highlight: e.target.value }, `highlight:${b.id}`));
  onStory('tt-align', 'change', (b, e) => { if (e.target.value) storyApplyPara(b, { align: e.target.value }); });
  onStory('tt-leading-type', 'change', (b, e) => {
    const t = e.target.value;
    if (!t) return;
    // a value to start from that keeps the lines where they are near enough
    const size = (window.storyCharState?.(b)?.attrs.sizePt) || b.sizePt || 12;
    const leading = { multiple: 1.2, percent: 120, atLeast: Math.round(size * 1.2 * 10) / 10, exact: Math.round(size * 1.2 * 10) / 10 }[t] ?? 0;
    storyApplyPara(b, { leadingType: t, leading });
  });
  onStory('tt-leading', 'change', (b, e) => { const v = parseFloat(e.target.value); if (v > 0) storyApplyPara(b, { leading: v }); });
  onStory('tt-bullets', 'click', b => storyApplyPara(b, { list: el('tt-bullets').classList.contains('active') ? 'none' : 'bullet' }));
  onStory('tt-numbers', 'click', b => storyApplyPara(b, { list: el('tt-numbers').classList.contains('active') ? 'none' : 'decimal' }));
  onStory('tt-valign', 'change', (b, e) => storyApplyFrame(b, { valign: e.target.value }));
  onStory('tt-columns', 'change', (b, e) => {
    const n = Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 1));
    const fr = SC.frameOf(b.frame);
    // columns that touch read as one: a first split gets a quarter inch between them
    storyApplyFrame(b, fr.columns === 1 && n > 1 && !fr.gutter ? { columns: n, gutter: 18 } : { columns: n });
  });
  onStory('tt-gutter', 'change', (b, e) => storyApplyFrame(b, { gutter: Math.max(0, parseFloat(e.target.value) || 0) }));
  for (const [id, tab] of [['tt-open-character', 'character'], ['tt-open-paragraph', 'paragraph'], ['tt-open-frame', 'frame'], ['tt-open-typography', 'typography']])
    el(id)?.addEventListener('click', () => window.openTextStudio?.(tab));

  // Toggle-embedded-text button (show/hide embedded text in SVG globally)
  el('toggle-embedded-text')?.classList.add('active');
  el('toggle-embedded-text')?.addEventListener('click', () => {
    const btn = el('toggle-embedded-text');
    const active = btn.classList.toggle('active');
    document.body.classList.toggle('hide-embedded-text', !active);
  });

})();
