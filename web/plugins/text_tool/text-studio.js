// text-studio.js — the Text panel (studio.html): every setting of text, in
// one side panel docked at the right of the page.
//
// It acts on what is selected — any box. Text the user added (Artistic and
// Frame text, or a plain typed box, which becomes Artistic text the moment
// the panel changes it) has every setting, through story-edit.js
// (storyApplyChar / storyApplyPara / storyApplyFrame): the selection of the
// text being edited, else all of the selected box's text. A box read from
// the page or a redaction's label has one face, one size and its measured
// glyph positions: the settings it has are set on the box itself
// (toolbar.js utbPlainChar), the rest is locked. With nothing selected the
// font and size are what new text takes (TextPanel.newText).
//
// Every control names its attribute in data-k ("char:<key>", "para:<key>",
// "frame:<key>"); one generic pass shows the attributes of the target and
// one generic handler applies a change. A key whose value differs inside the
// selection shows blank ("mixed"). A colour that may be "none" has a
// checkbox beside it (data-on).
//
// Locks: a setting the target or the drawing cannot have is greyed, with a
// lock and the reason on hover (lockOf) — a line read from the page has no
// paragraph settings; while a pixel renderer draws the text (the
// utbPixelRender seam, which says so through window.utbPixelRenderOn and the
// 'pixels:changed' hook), what it cannot draw (StoryCore.PIXEL_LIMITS) or
// lays past (PIXEL_IGNORES) is locked.
//
// Display: the switches that change how the page's text is drawn sit at the
// panel's foot — Space widths here, and any plugin's Settings section marked
// data-text-panel, which moves in.
//
// The panel is docked: it never covers the page. The ¶ tool shows and hides
// it; whether it is shown and which tab is kept in this browser.
(function () {
  const SC = globalThis.StoryCore;
  const panel = document.getElementById('tt-studio');
  if (!panel || !SC) return;
  const $ = id => document.getElementById(id);
  const KEY = 'recto.textStudio';
  const store = {
    get: k => { try { return localStorage.getItem(`${KEY}.${k}`); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(`${KEY}.${k}`, v); } catch { /* this session only */ } },
  };

  // ── showing, hiding, tabs ───────────────────────────────────────────────

  const toolBtn = $('tt-studio-btn');
  const isOpen = () => !panel.classList.contains('hidden');
  function showTab(tab) {
    // compared, not put into a selector: a stored value is anything (a quote
    // in it once made querySelector throw and the panel never came up)
    if (![...panel.querySelectorAll('.tt-tab-btn')].some(b => b.dataset.tab === tab)) tab = 'character';
    panel.querySelectorAll('.tt-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    panel.querySelectorAll('.tt-pane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== tab));
    store.set('tab', tab);
  }
  // The right side is shared, one side panel at a time: a panel shown says so
  // on the bus ('sidepanel:shown', { id }) and every other one hides — so the
  // ¶ tool switches from another plugin's panel to this one, and that panel's
  // tool back. Panels are marked data-side-panel.
  function open(tab) {
    panel.classList.remove('hidden');
    toolBtn?.classList.add('active');
    store.set('open', '1');
    if (tab) showTab(tab);
    sync();
    PDFHooks.emit('sidepanel:shown', { id: panel.id });
  }
  function close() {
    panel.classList.add('hidden');
    toolBtn?.classList.remove('active');
    store.set('open', '0');
  }
  PDFHooks.on('sidepanel:shown', e => { if (e?.id !== panel.id && isOpen()) close(); });
  toolBtn?.addEventListener('click', () => (isOpen() ? close() : open()));
  $('tt-studio-close')?.addEventListener('click', close);
  panel.querySelectorAll('.tt-tab-btn').forEach(b => b.addEventListener('click', () => { showTab(b.dataset.tab); sync(); }));
  showTab(store.get('tab') || 'character');
  window.openTextStudio = open;

  // Drag the panel's edge to make it wider (docked at the foot of a narrow
  // screen: taller); a double click goes back to the default size.
  (function resizable() {
    const grip = panel.querySelector('.tt-resize');
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
        if (bottom) panel.style.setProperty('--tt-height', `${Math.round(Math.min(Math.max(size, 160), innerHeight * 0.9))}px`);
        else panel.style.setProperty('--tt-width', `${Math.round(Math.min(Math.max(size, 280), Math.min(760, innerWidth * 0.7)))}px`);
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
      panel.style.removeProperty('--tt-width');
      panel.style.removeProperty('--tt-height');
    });
  })();

  // ── what the panel acts on ──────────────────────────────────────────────

  // { box, editing, range, story } — story: text the user added (it has every
  // setting); else a box with one face (a line read from the page, a
  // redaction's label). null: nothing selected, new text.
  function target() {
    const t = window.storyTarget?.();
    if (!t?.box) return null;
    return { ...t, story: !!t.box.textMode || t.box.type === 'harfbuzz' };
  }

  // What new text takes: the font and size shown while nothing is selected.
  // fonts.js puts the document's face here (the declared or detected one);
  // a change made with nothing selected is the user's own default.
  const newText = { fontFamily: $('fabric-font-family')?.value || 'Times New Roman', sizePt: parseFloat($('fabric-font-size')?.value) || 12 };
  function setNewText(fontFamily, sizePt) {
    if (fontFamily) newText.fontFamily = fontFamily;
    if (sizePt > 0) newText.sizePt = Math.round(sizePt * 100) / 100;
    if (!target()) sync();
  }
  // The user's own choice: through the font catalogue (fonts.js ranks the
  // claims), so a face a plugin detects afterwards does not undo it.
  function chooseNewText(fontFamily, sizePt) {
    if (typeof window.FontCatalog?.select === 'function') window.FontCatalog.select(fontFamily, sizePt);
    else setNewText(fontFamily, sizePt);
  }

  function states(t) {
    if (!t) return { char: { attrs: SC.charOf(newText), mixed: [] }, para: { attrs: SC.paraOf({}), mixed: [] }, frame: { attrs: SC.frameOf({}), mixed: [] } };
    const box = t.box;
    if (box.textMode) return { char: window.storyCharState(box), para: window.storyParaState(box), frame: { attrs: SC.frameOf(box.frame), mixed: [] } };
    // a box with one face: its fields, read as character attributes
    return { char: { attrs: SC.charOf(window.utbPlainChar?.attrs(box) || {}), mixed: [] }, para: { attrs: SC.paraOf({}), mixed: [] }, frame: { attrs: SC.frameOf({}), mixed: [] } };
  }

  // ── locks ───────────────────────────────────────────────────────────────

  const KIND = {
    ocr: 'An OCR line keeps one face and the glyph positions the reader measured',
    embedded: 'Embedded text keeps one face and the positions the PDF gives',
    redaction: 'A redaction box\'s label is one run of one face',
  };
  const kindWhy = box => KIND[box.type] || 'This box has one face';
  // the name of the pixel renderer drawing the text now, or null
  function pixelRenderer() {
    try { const on = window.utbPixelRenderOn?.(); return on ? (typeof on === 'string' ? on : 'The pixel renderer') : null; }
    catch { return null; }
  }
  // a setting it cannot draw at all; and one it draws some values of (the
  // others are locked option by option)
  const PIXEL_WHY = new Map(SC.PIXEL_LIMITS.filter(l => !l.allow).map(l => [l.key, l.why]));
  const PIXEL_ALLOW = new Map(SC.PIXEL_LIMITS.filter(l => l.allow).map(l => [l.key, l]));
  for (const k of SC.PIXEL_IGNORES.keys) PIXEL_WHY.set(k, SC.PIXEL_IGNORES.why);
  PIXEL_WHY.set('style', null);
  // what the pixel renderer cannot draw of a paragraph or a frame: it draws
  // the text, the HTML around it is not shown
  const PIXEL_PARA_WHY = {
    list: 'draws the text alone: no list markers', listChar: 'draws the text alone: no list markers', listSuffix: 'draws the text alone: no list markers',
    fill: 'draws the text alone: no paragraph fill', ruleAbove: 'draws the text alone: no rules', ruleBelow: 'draws the text alone: no rules',
    ruleColor: 'draws the text alone: no rules', ruleWeight: 'draws the text alone: no rules',
  };
  const PIXEL_FRAME_WHY = {
    ruleColor: 'draws the text alone: no column rules', ruleWeight: 'draws the text alone: no column rules',
    ruleStyle: 'draws the text alone: no column rules', ruleTop: 'draws the text alone: no column rules', ruleBottom: 'draws the text alone: no column rules',
  };
  const PLAIN_KEYS = () => new Set([...(window.utbPlainChar?.keys || []), 'style']);

  // Why `scope:key` cannot be set on the target now, or null.
  function lockOf(t, scope, key) {
    if (!t) return null;                                     // new text: the idle state greys it
    if (!t.story) {
      if (scope !== 'char' || !PLAIN_KEYS().has(key)) return `${kindWhy(t.box)} — this is for Artistic and Frame text.`;
    } else if (scope === 'frame' && t.box.textMode !== 'frame') {
      return 'These settings belong to Frame text — Convert to Text Frame at the foot of this tab.';
    }
    const px = pixelRenderer();
    if (px) {
      const why = scope === 'char' ? PIXEL_WHY.get(key) : scope === 'para' ? PIXEL_PARA_WHY[key] : PIXEL_FRAME_WHY[key];
      if (why) return `${px} ${why}. Turn ${px} off below to set it.`;
    }
    return null;
  }
  // a whole tab locked for the target: one notice instead of a lock per row
  function paneLock(t, pane) {
    if (!t) return null;
    if (!t.story && pane !== 'character') return `${kindWhy(t.box)}: paragraph, frame and OpenType settings are for Artistic and Frame text.`;
    if (pane === 'frame' && t.box.textMode !== 'frame') return 'These settings belong to Frame text.';
    return null;
  }

  // The lockable controls: every data-k / data-toggle / data-on control, and
  // the fitting tools that are not attributes.
  const ACTIONS = {
    'tt-size-up': 'char:sizePt', 'tt-size-down': 'char:sizePt', 'tt-change-case': 'char:case',
    'fabric-space-width': 'char:space', 'fabric-default-sw': 'char:space', 'fabric-nudge-mode': 'char:nudge', 'tt-space-line': 'char:spaceLine',
    'tt-kern-page': 'char:autoKern', 'tt-show-typography': null,
    'tt-pa-tab-pos': 'para:tabs', 'tt-pa-tab-align': 'para:tabs', 'tt-pa-tab-leader': 'para:tabs', 'tt-pa-tab-add': 'para:tabs',
  };
  const keyOfCtrl = c => c.dataset.k || c.dataset.toggle || c.dataset.on || (c.dataset.ss ? 'char:ot_ss' : null) ||
    (c.dataset.dropEnable !== undefined ? 'para:dropLines' : null) || (c.id && ACTIONS[c.id]) || null;
  const parseKey = k => { const i = k.indexOf(':'); return [k.slice(0, i), k.slice(i + 1)]; };

  function lockReason(t, ctrl) {
    const k = keyOfCtrl(ctrl);
    if (!k) return null;
    const [scope, key] = parseKey(k);
    if (key === 'case') return t && !t.story ? `${kindWhy(t.box)} — Change Case rewrites Artistic and Frame text.` : null;
    if (key === 'space' || key === 'nudge') return null;   // every box has them (nudge: see syncFitting)
    if (key === 'spaceLine') return t ? lockOf(t, scope, key) || spaceLine(t).why : null;
    const why = lockOf(t, scope, key);
    if (why) return why;
    // a toggle whose value the pixel renderer cannot draw (Small caps)
    const px = pixelRenderer(), lim = scope === 'char' && PIXEL_ALLOW.get(key);
    if (px && lim && ctrl.dataset.toggle && ctrl.dataset.onValue !== undefined && !lim.allow.includes(ctrl.dataset.onValue))
      return `${px} ${lim.why}. Turn ${px} off below to set it.`;
    return null;
  }

  const LOCK_ICON = 'lock';
  // the label a control's row is named by: its <label for>, the check label
  // it sits in, or the first label of its row
  function rowOf(ctrl) {
    const grid = ctrl.closest('.tt-grid-pt');
    if (grid && ctrl.id) {
      const lab = grid.querySelector(`label[for="${ctrl.id}"]`);
      if (lab) return { label: lab, row: lab };
    }
    const check = ctrl.closest('label.tt-check');
    if (check && !check.closest('.tt-row')) return { label: check, row: check };
    const row = ctrl.closest('.tt-row');
    if (row) return { label: row.querySelector(':scope > label:first-child') || null, row };
    return { label: null, row: null };
  }
  // with nothing selected: what new text takes, and a new redaction box's terms
  const NEW_TEXT = new Set(['fabric-font-family', 'fabric-font-size', 'tt-size-up', 'tt-size-down', 'tolerance', 'tt-name-case']);
  function setLocks(t) {
    const px = pixelRenderer();
    // the options of a select a target cannot have — a double line on a box
    // with one face, what the pixel renderer cannot draw: why, per select
    const partly = new Map();
    for (const sel of panel.querySelectorAll('.tt-pane select[data-k^="char:"]')) {
      const key = parseKey(sel.dataset.k)[1], lim = PIXEL_ALLOW.get(key);
      for (const o of sel.options) {
        const why = (key === 'underline' || key === 'strike') && o.value === 'double' && t && !t.story ? `${kindWhy(t.box)}: single lines only.`
          : px && lim && !lim.allow.includes(o.value) ? `${px} ${lim.why}.` : null;
        o.disabled = !!why;
        o.title = why || '';
        if (why) partly.set(sel, why);
      }
    }
    const rows = new Map();                                  // row → { label, whys, n, locked, last }
    for (const c of panel.querySelectorAll('.tt-pane [data-k], .tt-pane [data-toggle], .tt-pane [data-on], .tt-pane [data-ss], .tt-pane [data-drop-enable], .tt-pane button, .tt-pane input, .tt-pane select')) {
      if (c.closest('.tt-seg') && c.tagName === 'BUTTON') continue;       // with their .tt-seg
      if (c.id === 'tt-ot-hide' || c.closest('.tt-tabs-list')) continue;   // the panel's own view, a tab stop's remove
      const why = lockReason(t, c);
      const idle = !t && !NEW_TEXT.has(c.id);
      const ctrls = c.classList.contains('tt-seg') ? [...c.querySelectorAll('button')] : [c];
      for (const x of ctrls) {
        if (x.dataset.t0 === undefined) x.dataset.t0 = x.title || '';
        x.disabled = !!why || idle || (x === c && c.dataset.busy === '1');
        x.classList.toggle('tt-locked', !!why);
        x.classList.toggle('tt-off', idle);
        x.title = why || partly.get(c) || x.dataset.t0;
      }
      const { label, row } = rowOf(c);
      if (!row) continue;
      if (!rows.has(row)) rows.set(row, { label, whys: new Set(), n: 0, locked: 0, last: null });
      const r = rows.get(row);
      r.n++;
      if (why) { r.locked++; r.whys.add(why); r.last = c; }
      else if (partly.has(c)) { r.whys.add(partly.get(c)); r.last ??= c; }
    }
    for (const [row, r] of rows) {
      row.classList.toggle('tt-row-locked', r.locked > 0 && r.locked === r.n);
      // the lock goes on the row's label — or, in a row without one, after
      // the locked control
      const host = r.label || row;
      let icon = host.querySelector(':scope > .tt-lock') || (r.label ? null : row.querySelector(':scope > .tt-lock'));
      if (r.whys.size) {
        if (!icon) { icon = document.createElement('span'); icon.className = 'tt-lock material-symbols-outlined'; icon.textContent = LOCK_ICON; }
        if (r.label) { if (icon.parentNode !== host) host.appendChild(icon); }
        else if (r.last && icon.previousElementSibling !== r.last) r.last.after(icon);
        icon.title = [...r.whys].join('\n');
      } else icon?.remove();
    }
    // the tabs locked as a whole: their notice
    for (const pane of panel.querySelectorAll('.tt-pane')) {
      const why = paneLock(t, pane.dataset.pane);
      pane.classList.toggle('tt-pane-locked', !!why);
      const note = pane.querySelector(':scope > .tt-pane-lock');
      if (note) { note.classList.toggle('hidden', !why); note.querySelector('.tt-pane-lock-why').textContent = why || ''; }
    }
  }

  // ── the controls ────────────────────────────────────────────────────────

  // the twenty stylistic sets
  (function stylisticSets() {
    const grid = $('tt-ot-ss');
    for (let i = 1; i <= 20; i++) {
      const tag = `ss${String(i).padStart(2, '0')}`;
      const l = document.createElement('label');
      l.className = 'tt-check';
      l.dataset.feature = tag;
      l.innerHTML = `<input type="checkbox" data-ss="${i}" id="tt-ot-${tag}"> ${tag}`;
      grid?.appendChild(l);
    }
  })();

  const controls = () => [...panel.querySelectorAll('[data-k]')];

  function show(ctrl, value, mixed) {
    if (ctrl.classList.contains('tt-seg')) {
      ctrl.querySelectorAll('button').forEach(b => b.classList.toggle('active', !mixed && b.dataset.v === value));
      return;
    }
    if (document.activeElement === ctrl && ctrl.type !== 'checkbox') return;    // leave a field being typed in
    ctrl.classList.toggle('tt-mixed', !!mixed);
    if (ctrl.type === 'checkbox') { ctrl.checked = !mixed && !!value; ctrl.indeterminate = !!mixed; return; }
    if (ctrl.type === 'color') { if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) ctrl.value = value; return; }
    if (mixed) { ctrl.value = ''; return; }
    if (ctrl.tagName === 'SELECT') {
      const v = value === null || value === undefined ? '' : String(value);
      if (![...ctrl.options].some(o => o.value === v) && ctrl.dataset.k === 'char:fontFamily' && v) {
        // the menu must SHOW the box's family even when the catalogue lacks it
        const o = document.createElement('option'); o.value = v; o.textContent = `${v} (not installed)`; ctrl.appendChild(o);
      }
      ctrl.value = v;
      return;
    }
    ctrl.value = value === null || value === undefined ? '' : (typeof value === 'number' ? Math.round(value * 100) / 100 : value);
  }

  const SCOPE_LINE = {
    ocr: 'This OCR line', embedded: 'This embedded line', redaction: 'This redaction box\'s label', harfbuzz: 'This text (it becomes Artistic text)',
  };
  function sync() {
    if (!isOpen()) return;
    const t = target();
    const scope = $('tt-studio-scope');
    panel.classList.toggle('tt-idle', !t);
    if (scope) {
      scope.textContent = !t ? `New text — ${newText.fontFamily} ${newText.sizePt} pt. Select a text to change it.`
        : t.editing ? (t.range && SC.collapsed(t.range) ? 'The text typed next at the caret' : 'The selected text')
        : t.box.textMode ? `All of this ${t.box.textMode === 'frame' ? 'frame\'s' : 'artistic'} text`
        : SCOPE_LINE[t.box.type] || 'This text';
    }
    const del = $('utb-delete-box');
    if (del) del.disabled = !t;
    const st = states(t);
    for (const ctrl of controls()) {
      const [scopeKey, key] = parseKey(ctrl.dataset.k);
      const s = st[scopeKey];
      if (!s) continue;
      if (key === 'style') { show(ctrl, (s.attrs.bold ? 'bold' : '') + (s.attrs.italic ? 'italic' : '') || 'regular', s.mixed.includes('bold') || s.mixed.includes('italic')); continue; }
      if (key === 'autoKern') continue;                      // syncKerning
      show(ctrl, s.attrs[key], s.mixed.includes(key));
    }
    // a colour that may be none: its checkbox says whether it is set
    for (const on of panel.querySelectorAll('[data-on]')) {
      const [scopeKey, key] = parseKey(on.dataset.on);
      const s = st[scopeKey];
      if (s) { on.checked = s.attrs[key] != null && !s.mixed.includes(key); on.indeterminate = s.mixed.includes(key); }
    }
    // the toggles: on when the attribute has their value
    panel.querySelectorAll('[data-toggle]').forEach(b => {
      const [sk, key] = parseKey(b.dataset.toggle);
      const v = st[sk]?.attrs[key], onV = b.dataset.onValue;
      b.classList.toggle('active', !st[sk]?.mixed.includes(key) && (onV !== undefined ? v === onV : !!v));
    });
    const drop = $('tt-pa-drop-on');
    if (drop) { drop.checked = st.para.attrs.dropLines >= 2; drop.indeterminate = st.para.mixed.includes('dropLines'); }
    // stylistic sets: one bit each
    const ss = st.char.attrs.ot_ss | 0, ssMixed = st.char.mixed.includes('ot_ss');
    panel.querySelectorAll('[data-ss]').forEach(cb => { cb.checked = !ssMixed && !!(ss & (1 << (cb.dataset.ss - 1))); cb.indeterminate = ssMixed; });
    // leading value: what its type counts in
    const lt = st.para.attrs.leadingType, lv = $('tt-pa-leading');
    if (lv) { lv.dataset.busy = lt === 'default' ? '1' : ''; lv.dataset.t0 = { multiple: '× the default leading', percent: '% of the font size', atLeast: 'pt — at least', exact: 'pt — exactly' }[lt] || 'The face\'s own leading'; }
    const isFrame = t?.box.textMode === 'frame';
    const cf = $('tt-convert-frame'), ca = $('tt-convert-art');
    if (cf) cf.dataset.busy = !t?.story || isFrame ? '1' : '';
    if (ca) ca.dataset.busy = !t?.story || !t.box.textMode || t.box.textMode === 'artistic' ? '1' : '';
    tabsList(st.para.attrs.tabs, st.para.mixed.includes('tabs'));
    features(st.char.attrs);
    syncKerning(t, st.char);
    syncFitting(t, st.char);
    syncMatch(t);
    setLocks(t);
    if (lv && lt === 'default') lv.disabled = true;
  }

  // ── pair kerning ────────────────────────────────────────────────────────

  // The checkbox shows the kerning as drawn; beside it, where that comes
  // from: the page's producer (as read), off because nothing is known, or
  // the user's choice — which ↺ gives back to the page.
  function pageKernOf(t, attrs) {
    if (!t) return undefined;
    if (t.box.textMode) return window.storyPageKern?.(t.box, attrs);
    if (typeof window.utbAutoKerning !== 'function') return undefined;
    try { const k = window.utbAutoKerning({ ...t.box, kerningAuto: true }); return typeof k === 'boolean' ? k : undefined; } catch { return undefined; }
  }
  function syncKerning(t, cs) {
    const cb = $('kerning'), src = $('tt-kern-source'), reset = $('tt-kern-page');
    if (!cb) return;
    const mixed = cs.mixed.includes('autoKern');
    const choice = cs.attrs.autoKern;                        // true / false / null (as the page)
    const page = pageKernOf(t, cs.attrs);
    const drawn = typeof choice === 'boolean' ? choice : SC.resolveKern(cs.attrs, page).autoKern;
    cb.checked = !mixed && drawn;
    cb.indeterminate = mixed;
    let text = '', tip = '';
    if (!t) { text = 'as the page'; tip = 'New text kerns as the page it is typed on: as its producer did, where a reader learned it — else not at all, as Word sets text.'; }
    else if (mixed) { text = 'mixed'; tip = 'Some of the selected text kerns, some does not.'; }
    else if (choice == null) {
      text = page === undefined ? 'unread page: off' : `as the page: ${page ? 'on' : 'off'}`;
      tip = page === undefined
        ? 'Nobody has read how this page\'s producer set this face, so the text is set as Word sets it: without pair kerning.'
        : `The page's producer set this face ${page ? 'with' : 'without'} pair kerning (learned from the page's pixels).`;
    } else {
      text = page === undefined ? 'yours' : `yours (page: ${page ? 'on' : 'off'})`;
      tip = `Set here${page === undefined ? '' : ` — the page's producer set this face ${page ? 'with' : 'without'} pair kerning`}. ↺ follows the page again.`;
    }
    if (src) { src.textContent = text; src.title = tip; }
    reset?.classList.toggle('hidden', !t || mixed || choice == null);
  }
  $('kerning')?.addEventListener('change', e => apply('char', { autoKern: e.target.checked }));
  $('tt-kern-page')?.addEventListener('click', () => apply('char', { autoKern: null }));

  // ── space width, nudge ──────────────────────────────────────────────────

  // The width of a space: a story's paragraphs' desired word spacing (% of
  // the face's space, Affinity's Justification ▸ Word Spacing) in px of the
  // face's space of the selection's first character; a plain box's manual
  // space width. "Font's" is 100 % / no manual width.
  function syncFitting(t, cs) {
    const sw = $('fabric-space-width'), dflt = $('fabric-default-sw'), nudge = $('fabric-nudge-mode');
    if (sw && dflt && !t) { sw.value = ''; sw.placeholder = ''; dflt.checked = true; dflt.indeterminate = false; }
    if (sw && dflt && t) {
      if (t.box.textMode) {
        const ps = window.storyParaState?.(t.box);
        const ws = ps?.attrs.wordSpacing ?? 100, mixed = !!ps?.mixed.includes('wordSpacing');
        const space = window.storySpacePx?.(cs.attrs);
        dflt.checked = ws === 100 && !mixed;
        dflt.indeterminate = mixed;
        if (document.activeElement !== sw) sw.value = space > 0 && !mixed ? +(space * ws / 100).toFixed(3) : '';
      } else {
        const own = t.box.spaceWidth != null && !t.box.defaultSpaceWidth;
        dflt.checked = !own;
        dflt.indeterminate = false;
        if (document.activeElement !== sw) sw.value = own ? +(+t.box.spaceWidth).toFixed(3) : '';
        if (!own && document.activeElement !== sw) {
          sw.placeholder = '…';
          window.getNaturalSpaceWidth?.(t.box).then(w => { if (w > 0 && !(t.box.spaceWidth != null && !t.box.defaultSpaceWidth) && document.activeElement !== sw) sw.placeholder = (+w.toFixed(3)).toString(); });
        }
      }
    }
    syncSpaceLine(t);
    if (nudge) {
      const on = !!t && utbState.microTypoId === t.box.id;
      nudge.classList.toggle('active', on);
      // the nudge moves measured glyph positions (a plain box's, while they
      // hold) or a story's pairs (not while it is edited)
      const why = !t ? 'Select a text to nudge its characters.'
        : t.box.textMode ? (window.storyEditing?.() === t.box ? 'Not while the text is edited — press Escape first.' : null)
        : !utbCharsValid(t.box) ? 'This box is laid afresh in its current face: it has no measured glyph positions to nudge.' : null;
      nudge.dataset.busy = why ? '1' : '';
      nudge.dataset.t0 = why || 'Nudge characters: press one, then move it (a pair\'s manual kerning)';
    }
  }
  let defaultSwChanges = 0;
  $('fabric-default-sw')?.addEventListener('change', async e => {
    const t = target();
    if (!t) return;
    if (t.box.textMode) {
      if (e.target.checked) window.storyApplyPara?.(t.box, { wordSpacing: 100 });
      else sync();                                           // the field holds the face's space; moving it sets another
      return;
    }
    const mine = ++defaultSwChanges;
    if (e.target.checked) await window.utbPlainChar?.setSpaceWidth(t.box, null);
    else {
      const w = await window.getNaturalSpaceWidth?.(t.box);
      // ticked again while the face's space was being measured: that tick
      // stands (it landed first, and this width would have overwritten it)
      if (w > 0 && mine === defaultSwChanges) await window.utbPlainChar?.setSpaceWidth(t.box, w);
    }
    sync();
  });
  function applySpaceWidth(raw, live) {
    const t = target();
    const px = parseFloat(raw);
    if (!t || !(px >= 0)) return;
    if (t.box.textMode) {
      const space = window.storySpacePx?.(window.storyCharState?.(t.box)?.attrs || {});
      if (space > 0) window.storyApplyPara?.(t.box, { wordSpacing: px / space * 100 }, live ? `space:${t.box.id}` : null);
      return;
    }
    window.utbPlainChar?.setSpaceWidth(t.box, px, live ? `space:${t.box.id}` : null);
  }
  $('fabric-space-width')?.addEventListener('input', e => applySpaceWidth(e.target.value, true));
  $('fabric-space-width')?.addEventListener('change', e => { applySpaceWidth(e.target.value, true); sync(); });

  // Space as this line: each paragraph of the target (the selection's, else
  // all) whose first line sits on a line of the page (utbLineAt) takes the
  // space that line was set with as its desired word spacing, measured in the
  // paragraph's own face as it draws (utbLineWordSpacing): the space a
  // justified Word line was widened to — or the face's own. Where the line
  // goes on after a tab (a list label's), its tab stops become the
  // paragraph's (utbLineTabStops, from the paragraph's left edge: its first
  // character less its first-line indent), so that a typed tab lands there.
  // → { lines: [{ p, line, face, tabs }], why } — why: the lock's reason, or null
  function spaceLine(t) {
    if (!t?.story) return { lines: [], why: null };
    const box = t.box;
    const starts = box.textMode ? window.storyParaStarts?.(box) || [] : [{ p: 0, x: box.x, y: box.y, h: box.h }];
    const r = t.range ? SC.ordered(t.range) : null;
    const lines = [];
    let onLine = false;
    for (const s of starts) {
      if (r && (s.p < r.start.p || s.p > r.end.p)) continue;
      const line = window.utbLineAt?.(box.page, s);
      if (!line) continue;
      onLine = true;
      const indent = SC.paraOf(box.story?.paragraphs[s.p]?.attrs).firstIndent * GEO.docPxPerPt();
      const tabs = window.utbLineTabStops?.(line, s.x - indent) || [];
      if (line.space > 0 || tabs.length) lines.push({ p: s.p, line, face: faceOf(box, s.p), tabs });
    }
    const why = lines.length ? null
      : onLine ? 'The page\'s line under this text has no space between two words to measure, and no tab.'
      : `No line of the page under ${r && box.textMode ? 'the selected paragraphs' : 'this text'} — put its first line on a line read from the page (the Artistic Text Tool, clicked on a line, starts there).`;
    return { lines, why };
  }
  // the paragraph has the line's tab stops (a line without a tab leaves the
  // paragraph's own alone)
  const hasTabs = (pa, tabs) => !tabs.length || (pa.tabs?.length === tabs.length &&
    tabs.every((s, i) => Math.abs(pa.tabs[i].pos - s.pos) < 1e-6 && pa.tabs[i].align === s.align));
  // a paragraph's face as it draws: its first character's, kerning as
  // story-render.js resolves it, tracking and the paragraph's letter spacing
  // after every glyph
  function faceOf(box, p) {
    const para = box.story?.paragraphs[p];
    const a = SC.charOf(para?.runs[0].attrs || window.utbPlainChar?.attrs(box) || {});
    const kerning = SC.resolveKern(a, window.storyPageKern?.(box, a)).autoKern;
    const letterPx = (a.tracking || 0) / 1000 * a.sizePt * GEO.docPxPerPt() + (SC.paraOf(para?.attrs).letterSpacing || 0) / 100 * (window.storySpacePx?.(a) || 0);
    return { fontFamily: a.fontFamily, bold: !!a.bold, italic: !!a.italic, sizePt: a.sizePt, kerning, ligatures: !!a.ot_liga, letterPx };
  }
  // what a line asks for, measured once per line and face (a line's
  // measured characters → face → word spacing; null while it is measured)
  const lineWS = new WeakMap();
  function measuredWS(l) {
    const id = l.line.pieces[0];
    if (!lineWS.has(id)) lineWS.set(id, new Map());
    const byFace = lineWS.get(id), k = `${l.line.pieces.length}|${JSON.stringify(l.face)}`;
    if (!byFace.has(k)) {
      byFace.set(k, null);
      Promise.resolve(window.utbLineWordSpacing?.(l.line, l.face)).catch(() => 100).then(ws => { byFace.set(k, ws ?? 100); soon(); });
    }
    return byFace.get(k);
  }
  // beside the button: the space of the line under the text, and its tab
  // stops; the button is lit while every paragraph it would set has them
  function syncSpaceLine(t) {
    const b = $('tt-space-line'), src = $('tt-space-line-src');
    if (!b || !src) return;
    const { lines } = spaceLine(t);
    const ws = lines.map(l => (l.line.space > 0 ? measuredWS(l) : 100)), known = lines.length > 0 && ws.every(v => v != null);
    b.classList.toggle('active', known && lines.every((l, i) => {
      const pa = SC.paraOf(t.box.story?.paragraphs[l.p]?.attrs);
      return (!(l.line.space > 0) || Math.abs(pa.wordSpacing - ws[i]) < 1e-6) && hasTabs(pa, l.tabs);
    }));
    const first = lines[0], spaced = first?.line.space > 0;
    const own = known ? window.storySpacePx?.(first.face) : 0, px = own * (ws[0] || 100) / 100;
    const stops = first?.tabs.length ? `tab${first.tabs.length > 1 ? 's' : ''} at ${first.tabs.map(s => +s.pos.toFixed(2)).join(', ')} pt` : '';
    src.textContent = !lines.length ? '' : !known ? 'line: …'
      : `line: ${[spaced ? (ws[0] === 100 ? 'the font\'s' : `${px.toFixed(2)} px`) : '', stops].filter(Boolean).join(' · ')}`;
    src.title = !known ? '' : [spaced ? `The page's line under ${lines.length > 1 ? 'the first paragraph' : 'the text'} was set with ${ws[0] === 100
      ? `the face's own space (${own.toFixed(3)} px): its words land on the page's within a quarter pixel`
      : `${px.toFixed(3)} px spaces — the face's own is ${own.toFixed(3)} px`} (its spaces between words, measured in this face).` : '',
    stops ? `The line goes on after a tab (a list label's): a tab stop ${first.tabs.map(s => `${+s.pos.toFixed(3)} pt`).join(', ')} from the paragraph's left edge puts what is typed after a tab where the page's text starts.` : '']
      .filter(Boolean).join(' ');
  }
  $('tt-space-line')?.addEventListener('click', async () => {
    const t = target();
    const { lines } = spaceLine(t);
    if (!lines.length) return;
    const patches = new Map();
    for (const l of lines) {
      const patch = {};
      if (l.line.space > 0) patch.wordSpacing = (await window.utbLineWordSpacing?.(l.line, l.face)) ?? 100;
      if (l.tabs.length) patch.tabs = l.tabs;
      patches.set(l.p, patch);
    }
    window.storyApplyParaEach?.(t.box, patches, 'space as the line');
    sync();
  });
  $('fabric-nudge-mode')?.addEventListener('click', () => {
    const t = target();
    if (!t) return;
    if (utbState.microTypoId === t.box.id) window.exitMicroTypo?.();
    else if ((t.box.textMode || utbCharsValid(t.box)) && typeof enterMicroTypo === 'function') enterMicroTypo(t.box);
    sync();
  });

  // ── a redaction's match terms ───────────────────────────────────────────

  // The selected redaction's tolerance and letter case; with nothing
  // selected the defaults a new redaction box takes (the matching plugin reads
  // these fields). Shown for a redaction box and for new boxes.
  function syncMatch(t) {
    const sec = $('tt-settings');
    const box = t?.box.type === 'redaction' ? t.box : null;
    sec?.classList.toggle('hidden', !!t && !box);
    if (box) {
      const tol = $('tolerance'); if (tol && document.activeElement !== tol) tol.value = box.tolerance;
      const cs = $('tt-name-case'); if (cs) cs.value = utbCaseValue(box.uppercase);
    }
    const scope = $('tt-match-scope');
    if (scope) {
      scope.textContent = box ? '· this box' : '· new boxes';
      scope.title = box ? 'The selected redaction box' : 'No redaction box selected — the defaults for new boxes';
    }
  }
  function applyMatch(changed) {
    const box = target()?.box;
    if (!box || box.type !== 'redaction') return;
    const step = window.utbUndo?.capture([box]);
    box.tolerance = parseFloat($('tolerance')?.value) || 0;
    const caseSel = $('tt-name-case');
    if (caseSel) box.uppercase = utbCaseMode(caseSel.value);
    window.utbUndo?.commit(step, changed);
    if (changed === 'tolerance') {
      // the width is unchanged by tolerance — only which candidates pass
      if (typeof updateAllMatchesView === 'function') updateAllMatchesView(box.id);
    } else {
      renderBox(box);
      if (typeof calculateWidthsForRedaction === 'function') calculateWidthsForRedaction(box.id);
    }
  }
  $('tolerance')?.addEventListener('change', () => applyMatch('tolerance'));
  $('tt-name-case')?.addEventListener('change', () => applyMatch('letter case'));

  // ── the font's OpenType features ────────────────────────────────────────

  // what the font does not carry is hidden, as Affinity's "Hide irrelevant
  // features" does (greyed with it off)
  function features(a) {
    const m = window.storyFaceMetrics?.(a);
    const have = new Set(m?.features || []);
    const hide = $('tt-ot-hide')?.checked;
    panel.querySelectorAll('[data-feature]').forEach(l => {
      const missing = !!m && !have.has(l.dataset.feature);
      l.classList.toggle('tt-unsupported', missing && !hide);
      l.classList.toggle('hidden', missing && !!hide);
    });
  }
  $('tt-ot-hide')?.addEventListener('change', () => sync());

  // ── changes ─────────────────────────────────────────────────────────────

  function apply(scopeKey, patch, key = null) {
    const t = target();
    if (!t) {
      // nothing selected: the font and size new text takes
      if (scopeKey === 'char' && ('fontFamily' in patch || 'sizePt' in patch)) chooseNewText(patch.fontFamily, patch.sizePt);
      return;
    }
    if (!t.story) {
      if (scopeKey === 'char') window.utbPlainChar?.apply(t.box, patch, key);
      return;
    }
    if (scopeKey === 'char') window.storyApplyChar?.(t.box, patch, key);
    else if (scopeKey === 'para') window.storyApplyPara?.(t.box, patch, key);
    else if (scopeKey === 'frame' && t.box.textMode === 'frame') window.storyApplyFrame?.(t.box, patch, key);
  }

  function valueOf(ctrl) {
    if (ctrl.type === 'checkbox') return ctrl.checked;
    if (ctrl.type === 'color') return ctrl.value;
    if (ctrl.dataset.bool !== undefined) return ctrl.value === 'true';
    if (ctrl.type === 'number') {
      if (ctrl.value === '') return ctrl.dataset.nullable !== undefined ? null : undefined;
      const v = parseFloat(ctrl.value);
      return Number.isFinite(v) ? v : undefined;
    }
    return ctrl.value;
  }

  function onChange(ctrl, live) {
    const [scopeKey, key] = parseKey(ctrl.dataset.k);
    if (key === 'autoKern') return;                          // its own handler
    const t = target();
    if (key === 'style') { const v = ctrl.value; apply('char', { bold: v.startsWith('bold'), italic: v.endsWith('italic') }); return; }
    const v = valueOf(ctrl);
    if (v === undefined) return;
    if (ctrl.tagName === 'SELECT' && v === '' && key !== 'lang') return;
    const undoKey = live && t ? `${scopeKey}:${key}:${t.box.id}` : null;
    // a linked inset sets all four
    if (t && ctrl.dataset.inset !== undefined && SC.frameOf(t.box.frame).linkInsets) {
      apply('frame', { insetLeft: v, insetRight: v, insetTop: v, insetBottom: v }, undoKey);
      return;
    }
    // a new leading type starts from a value that counts in its own unit
    if (t && key === 'leadingType') {
      const size = window.storyCharState?.(t.box)?.attrs.sizePt || t.box.sizePt || 12;
      apply('para', { leadingType: v, leading: { multiple: 1.2, percent: 120, atLeast: Math.round(size * 12) / 10, exact: Math.round(size * 12) / 10 }[v] ?? 0 });
      return;
    }
    if (ctrl.type === 'color' && ctrl.dataset.nullable !== undefined) {
      const on = panel.querySelector(`[data-on="${ctrl.dataset.k}"]`);
      if (on) on.checked = true;
    }
    apply(scopeKey, { [key]: v }, undoKey);
  }

  panel.addEventListener('input', e => {
    const c = e.target.closest('[data-k]');
    if (c && (c.type === 'number' || c.type === 'color' || c.type === 'text')) onChange(c, true);
  });
  panel.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.on) {                                   // a "none" checkbox beside a colour
      const [scopeKey, key] = parseKey(t.dataset.on);
      const color = panel.querySelector(`[data-k="${t.dataset.on}"]`);
      apply(scopeKey, { [key]: t.checked ? (color?.value || '#000000') : null });
      return;
    }
    if (t.dataset.dropEnable !== undefined) {
      apply('para', { dropLines: t.checked ? 3 : 0 });           // Affinity: 3 lines when enabled
      return;
    }
    if (t.dataset.ss) {
      const tg = target();
      if (!tg) return;
      const cur = (window.storyCharState?.(tg.box)?.attrs.ot_ss) | 0, bit = 1 << (t.dataset.ss - 1);
      apply('char', { ot_ss: t.checked ? cur | bit : cur & ~bit });
      return;
    }
    const c = t.closest('[data-k]');
    if (c && !(c.type === 'number' || c.type === 'color' || c.type === 'text')) onChange(c, false);
    else if (c && c.type === 'number') sync();
  });
  panel.addEventListener('click', e => {
    const q = e.target.closest('[data-toggle]');
    if (q) {
      if (q.disabled) return;
      const [sk, key] = parseKey(q.dataset.toggle);
      // on or off as the target has it now (not as the button was last drawn:
      // a hidden panel is not kept up to date)
      const st = states(target())[sk];
      const v = st?.attrs[key], onV = q.dataset.onValue, offV = q.dataset.offValue;
      const on = !st?.mixed.includes(key) && (onV !== undefined ? v === onV : !!v);
      apply(sk, { [key]: onV !== undefined ? (on ? offV : onV) : !on });
      return;
    }
    const b = e.target.closest('.tt-seg button');
    if (!b || b.disabled) return;
    const [scopeKey, key] = parseKey(b.closest('.tt-seg').dataset.k);
    apply(scopeKey, { [key]: b.dataset.v });
  });

  // The text being edited keeps the keyboard: a button pressed here never
  // takes it (story-edit.js), and a menu, a checkbox or a colour gives it back
  // once its change is made — a field typed in, at Enter — so typing goes on
  // in the text, in what was just chosen. (Escape leaves the text from here,
  // as it does from the text.)
  const typedIn = c => c?.tagName === 'TEXTAREA' || (c?.tagName === 'INPUT' && /^(number|text|search)$/.test(c.type));
  const handBack = () => { if (window.storyEditing?.()) window.storyFocus?.(); };
  panel.addEventListener('change', e => { if (!typedIn(e.target)) handBack(); });
  panel.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !typedIn(e.target) || !window.storyEditing?.()) return;
    e.preventDefault();          // the Enter is the field's: no new paragraph where the keyboard goes
    handBack();
  });

  // Size steps: Affinity steps each run's own size by a point
  function stepSize(by) {
    const t = target();
    if (!t) { chooseNewText(null, SC.stepSize(newText, by).sizePt); return; }
    if (t.story) { window.storyMapChar?.(t.box, a => SC.stepSize(a, by)); return; }
    window.utbPlainChar?.apply(t.box, SC.stepSize({ sizePt: t.box.sizePt }, by), `size:${t.box.id}`);
  }
  $('tt-size-up')?.addEventListener('click', () => stepSize(1));
  $('tt-size-down')?.addEventListener('click', () => stepSize(-1));
  $('tt-change-case')?.addEventListener('change', e => {
    const mode = e.target.value;
    e.target.value = '';
    const t = target();
    if (mode && t?.story) window.storyChangeCase?.(t.box, mode);
  });
  $('utb-delete-box')?.addEventListener('click', () => window.utbDeleteBox?.(utbState.selectedId));

  // ── tab stops ───────────────────────────────────────────────────────────

  function tabsList(tabs, mixed) {
    const ul = $('tt-pa-tabs');
    if (!ul) return;
    ul.replaceChildren();
    if (mixed) { const li = document.createElement('li'); li.textContent = 'Different in the selected paragraphs'; ul.appendChild(li); return; }
    (tabs || []).slice().sort((a, b) => a.pos - b.pos).forEach(tab => {
      const li = document.createElement('li');
      const ALIGN = { left: 'Left', center: 'Centre', right: 'Right', decimal: 'Decimal' };
      li.textContent = `${tab.pos} pt · ${ALIGN[tab.align] || tab.align}${tab.leader ? ` · leader “${tab.leader}”` : ''}`;
      const x = document.createElement('button');
      x.className = 'icon-button tt-mini'; x.title = 'Remove this tab stop';
      x.innerHTML = '<span class="material-symbols-outlined">close</span>';
      x.addEventListener('click', () => {
        const t = target(); if (!t?.story) return;
        const cur = window.storyParaState?.(t.box)?.attrs.tabs || [];
        apply('para', { tabs: cur.filter(s => !(s.pos === tab.pos && s.align === tab.align)) });
      });
      li.appendChild(x);
      ul.appendChild(li);
    });
  }
  $('tt-pa-tab-add')?.addEventListener('click', () => {
    const t = target(); if (!t?.story) return;
    const pos = parseFloat($('tt-pa-tab-pos')?.value);
    if (!(pos >= 0)) return;
    const cur = (t.box.textMode ? window.storyParaState?.(t.box)?.attrs.tabs : []) || [];
    const stop = { pos, align: $('tt-pa-tab-align')?.value || 'left', leader: $('tt-pa-tab-leader')?.value || '' };
    apply('para', { tabs: [...cur.filter(s => s.pos !== pos), stop].sort((a, b) => a.pos - b.pos) });
  });

  $('tt-show-typography')?.addEventListener('click', () => { showTab('typography'); sync(); });

  // ── converting ──────────────────────────────────────────────────────────

  $('tt-convert-frame')?.addEventListener('click', () => { const t = target(); if (t?.story) window.storyConvert?.(t.box, 'frame'); });
  $('tt-convert-art')?.addEventListener('click', () => { const t = target(); if (t?.story) window.storyConvert?.(t.box, 'artistic'); });

  // ── Display ─────────────────────────────────────────────────────────────

  const view = $('tt-view');
  $('toggle-space-labels')?.addEventListener('change', e => window.setShowSpaceWidthLabels?.(e.target.checked));
  // A plugin's Settings section marked data-text-panel is about how text is
  // drawn: it moves to the panel's foot (its controls and listeners with it).
  for (const sec of document.querySelectorAll('#settings-sections [data-text-panel]')) view?.appendChild(sec);

  // ── keeping up ──────────────────────────────────────────────────────────

  let queued = false;
  const soon = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; sync(); }); };
  window.onStoryChange?.(soon);
  // a selection made or dropped anywhere (drag-resize.js, the undo stack…)
  document.addEventListener('mouseup', soon);
  document.addEventListener('keyup', soon);
  window.utbUndo?.onChange(soon);
  // the pixel renderer switched on or off: what it cannot draw is locked
  PDFHooks.on('pixels:changed', soon);
  PDFHooks.on('document:loaded', soon);

  window.TextPanel = { open, close, sync: () => soon(), newText: () => ({ ...newText }), setNewText };

  // As the user left it; the first time, on a screen wide enough for a side
  // panel (a phone gets the page first) where no other side panel is showing.
  const kept = store.get('open');
  const otherShown = [...document.querySelectorAll('[data-side-panel]')].some(p => p !== panel && !p.classList.contains('hidden'));
  if (kept === '1' || (kept === null && innerWidth > 900 && !otherShown)) open();

  // hyphenation needs the browser's dictionary: say so where it has none
  (function hyphenationNote() {
    const d = document.createElement('div');
    d.lang = 'en-US';
    d.style.cssText = 'position:absolute;visibility:hidden;width:40px;font:16px serif;hyphens:auto';
    d.textContent = 'hyphenationhyphenation';
    document.body.appendChild(d);
    const h1 = d.offsetHeight;
    d.style.hyphens = 'manual';
    const h2 = d.offsetHeight;
    d.remove();
    if (h1 === h2) { const n = $('tt-hyph-note'); if (n) n.textContent = 'This browser has no hyphenation dictionary, so Auto hyphenation does nothing here; a discretionary hyphen (Ctrl+Shift+- while typing) still breaks a word.'; }
  })();
})();
