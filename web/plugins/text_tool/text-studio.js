// text-studio.js — the Text panel (studio.html): Affinity's Character,
// Paragraph, Text Frame and Typography panels.
//
// Every control names its attribute in data-k ("char:<key>", "para:<key>",
// "frame:<key>"); one generic pass shows the attributes of what the settings
// act on (storyTarget: the selection of the text being edited, else all of
// the selected box's text) and one generic handler applies a change through
// story-edit.js (storyApplyChar / storyApplyPara / storyApplyFrame). A key
// whose value differs inside the selection shows blank ("mixed"). A colour
// that may be "none" has a checkbox beside it (data-on). A plain one-line
// box you typed becomes Artistic text the moment the panel changes it; the
// extracted layers' boxes (embedded, OCR, redaction) are not set here.
//
// The panel floats; drag it by its tabs' row. Where it was is kept in this
// browser (localStorage).
(function () {
  const SC = globalThis.StoryCore;
  const panel = document.getElementById('tt-studio');
  if (!panel || !SC) return;
  const $ = id => document.getElementById(id);
  const KEY = 'recto.textStudio';
  const DEFAULTS = { char: SC.CHAR_DEFAULTS, para: SC.PARA_DEFAULTS, frame: SC.FRAME_DEFAULTS };

  // ── open, close, tabs, position ─────────────────────────────────────────

  function showTab(tab) {
    panel.querySelectorAll('.tt-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    panel.querySelectorAll('.tt-pane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== tab));
    try { localStorage.setItem(`${KEY}.tab`, tab); } catch { /* fine */ }
  }
  function open(tab) {
    panel.classList.remove('hidden');
    $('tt-studio-btn')?.classList.add('active');
    if (tab) showTab(tab);
    sync();
  }
  function close() {
    panel.classList.add('hidden');
    $('tt-studio-btn')?.classList.remove('active');
  }
  $('tt-studio-btn')?.addEventListener('click', () => (panel.classList.contains('hidden') ? open() : close()));
  $('tt-studio-close')?.addEventListener('click', close);
  panel.querySelectorAll('.tt-tab-btn').forEach(b => b.addEventListener('click', () => { showTab(b.dataset.tab); sync(); }));
  try { const t = localStorage.getItem(`${KEY}.tab`); if (t) showTab(t); } catch { /* the first tab */ }
  window.openTextStudio = open;

  (function draggable() {
    const head = $('tt-studio-head');
    try {
      const pos = JSON.parse(localStorage.getItem(`${KEY}.pos`));
      if (pos) { panel.style.left = `${pos.x}px`; panel.style.top = `${pos.y}px`; panel.style.right = 'auto'; }
    } catch { /* the default place */ }
    head?.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      const r = panel.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = ev => {
        panel.style.left = `${Math.max(0, Math.min(innerWidth - 80, ev.clientX - dx))}px`;
        panel.style.top = `${Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy))}px`;
        panel.style.right = 'auto';
      };
      const up = () => {
        removeEventListener('mousemove', move); removeEventListener('mouseup', up);
        const rr = panel.getBoundingClientRect();
        try { localStorage.setItem(`${KEY}.pos`, JSON.stringify({ x: rr.left, y: rr.top })); } catch { /* fine */ }
      };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    });
  })();

  // ── what the panel acts on ──────────────────────────────────────────────

  // Text the user added: Artistic / Frame text, or a plain typed box (it
  // becomes Artistic text on the first change). null for anything else.
  function target() {
    const t = window.storyTarget?.();
    if (!t?.box) return null;
    if (!t.box.textMode && t.box.type !== 'harfbuzz') return null;
    return t;
  }

  function states(box) {
    if (box.textMode) return { char: window.storyCharState(box), para: window.storyParaState(box), frame: { attrs: SC.frameOf(box.frame), mixed: [] } };
    // a plain box, read as the Artistic text it would become
    const char = SC.charOf({ fontFamily: box.fontFamily, sizePt: box.sizePt, bold: !!box.bold, italic: !!box.italic, color: box.color || null,
      underline: box.underline ? 'single' : 'none', strike: box.strikethrough ? 'single' : 'none', tracking: Math.round((+box.letterSpacing || 0) * 1000), autoKern: !!box.kerning });
    return { char: { attrs: char, mixed: [] }, para: { attrs: SC.paraOf({}), mixed: [] }, frame: { attrs: SC.frameOf({}), mixed: [] } };
  }

  // ── the controls ────────────────────────────────────────────────────────

  // the font menu: the catalogue's families
  async function fillFonts() {
    const sel = $('tt-ch-family');
    if (!sel) return;
    try { await window.FontCatalog?.ready; } catch { /* the fallback */ }
    const fams = window.FontCatalog?.families?.() || [];
    sel.innerHTML = '';
    for (const f of fams) {
      const o = document.createElement('option');
      o.value = f.family; o.textContent = f.present?.regular ? f.family : `${f.family} (not installed)`;
      o.disabled = !f.present?.regular;
      sel.appendChild(o);
    }
    sync();
  }
  fillFonts();

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
  const parseKey = k => { const i = k.indexOf(':'); return [k.slice(0, i), k.slice(i + 1)]; };

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
      if (![...ctrl.options].some(o => o.value === v) && ctrl.dataset.k === 'char:fontFamily') {
        const o = document.createElement('option'); o.value = v; o.textContent = `${v} (not installed)`; ctrl.appendChild(o);
      }
      ctrl.value = v;
      return;
    }
    ctrl.value = value === null || value === undefined ? '' : value;
  }

  function sync() {
    if (panel.classList.contains('hidden')) return;
    const t = target();
    const scope = $('tt-studio-scope');
    panel.classList.toggle('tt-disabled', !t);
    if (!t) {
      if (scope) scope.textContent = 'Select or edit text you added (Artistic or Frame text) — or type some with a text tool.';
      return;
    }
    if (scope) scope.textContent = t.editing ? (t.range && SC.collapsed(t.range) ? 'Applies to the text typed next at the caret' : 'Applies to the selected text')
      : t.box.textMode ? `Applies to all of this ${t.box.textMode === 'frame' ? 'frame\'s' : 'artistic'} text` : 'Applies to this text (it becomes Artistic text)';
    const st = states(t.box);
    for (const ctrl of controls()) {
      const [scopeKey, key] = parseKey(ctrl.dataset.k);
      const s = st[scopeKey];
      if (!s) continue;
      if (key === 'style') { show(ctrl, (s.attrs.bold ? 'bold' : '') + (s.attrs.italic ? 'italic' : '') || 'regular', s.mixed.includes('bold') || s.mixed.includes('italic')); continue; }
      show(ctrl, s.attrs[key], s.mixed.includes(key));
    }
    // a colour that may be none: its checkbox says whether it is set
    for (const on of panel.querySelectorAll('[data-on]')) {
      const [scopeKey, key] = parseKey(on.dataset.on);
      const s = st[scopeKey];
      if (s) { on.checked = s.attrs[key] != null && !s.mixed.includes(key); on.indeterminate = s.mixed.includes(key); }
    }
    // the quick toggles: on when the attribute has their value
    panel.querySelectorAll('[data-toggle]').forEach(b => {
      const [sk, key] = parseKey(b.dataset.toggle);
      const v = st[sk]?.attrs[key], onV = b.dataset.onValue;
      b.classList.toggle('active', onV !== undefined ? v === onV : !!v);
    });
    const drop = $('tt-pa-drop-on');
    if (drop) { drop.checked = st.para.attrs.dropLines >= 2; drop.indeterminate = st.para.mixed.includes('dropLines'); }
    // stylistic sets: one bit each
    const ss = st.char.attrs.ot_ss | 0, ssMixed = st.char.mixed.includes('ot_ss');
    panel.querySelectorAll('[data-ss]').forEach(cb => { cb.checked = !ssMixed && !!(ss & (1 << (cb.dataset.ss - 1))); cb.indeterminate = ssMixed; });
    // leading value: what its type counts in
    const lt = st.para.attrs.leadingType, lv = $('tt-pa-leading');
    if (lv) { lv.disabled = lt === 'default'; lv.title = { multiple: '× the default leading', percent: '% of the font size', atLeast: 'pt — at least', exact: 'pt — exactly' }[lt] || 'The face\'s own leading'; }
    // the Text Frame tab belongs to frames
    const isFrame = t.box.textMode === 'frame';
    panel.querySelectorAll('.tt-frame-sec').forEach(s => s.classList.toggle('tt-off', !isFrame));
    $('tt-fr-hint')?.classList.toggle('hidden', isFrame);
    $('tt-convert-frame')?.toggleAttribute('disabled', isFrame);
    $('tt-convert-art')?.toggleAttribute('disabled', t.box.textMode === 'artistic' || !t.box.textMode);
    tabsList(st.para.attrs.tabs, st.para.mixed.includes('tabs'));
    features(st.char.attrs);
  }

  // the font's OpenType features: what it does not carry is hidden, as
  // Affinity's "Hide irrelevant features" does (greyed with it off)
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

  function apply(scopeKey, patch, key) {
    const t = target();
    if (!t) return;
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
    const t = target();
    if (!t) return;
    if (key === 'style') { const v = ctrl.value; apply('char', { bold: v.startsWith('bold'), italic: v.endsWith('italic') }); return; }
    const v = valueOf(ctrl);
    if (v === undefined) return;
    if (ctrl.tagName === 'SELECT' && v === '' && key !== 'lang') return;
    const undoKey = live ? `${scopeKey}:${key}:${t.box.id}` : null;
    // a linked inset sets all four
    if (ctrl.dataset.inset !== undefined && SC.frameOf(t.box.frame).linkInsets) {
      apply('frame', { insetLeft: v, insetRight: v, insetTop: v, insetBottom: v }, undoKey);
      return;
    }
    // a new leading type starts from a value that counts in its own unit
    if (key === 'leadingType') {
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
      const tg = target(); if (!tg) return;
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
  });
  panel.addEventListener('click', e => {
    const q = e.target.closest('[data-toggle]');
    if (q) {
      const [sk, key] = parseKey(q.dataset.toggle);
      const t = target(); if (!t) return;
      const on = q.classList.contains('active');
      const onV = q.dataset.onValue, offV = q.dataset.offValue;
      apply(sk, { [key]: onV !== undefined ? (on ? offV : onV) : !on });
      return;
    }
    const b = e.target.closest('.tt-seg button');
    if (!b) return;
    const [scopeKey, key] = parseKey(b.closest('.tt-seg').dataset.k);
    apply(scopeKey, { [key]: b.dataset.v });
  });

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
        const t = target(); if (!t) return;
        const cur = window.storyParaState?.(t.box)?.attrs.tabs || [];
        apply('para', { tabs: cur.filter(s => !(s.pos === tab.pos && s.align === tab.align)) });
      });
      li.appendChild(x);
      ul.appendChild(li);
    });
  }
  $('tt-pa-tab-add')?.addEventListener('click', () => {
    const t = target(); if (!t) return;
    const pos = parseFloat($('tt-pa-tab-pos')?.value);
    if (!(pos >= 0)) return;
    const cur = (t.box.textMode ? window.storyParaState?.(t.box)?.attrs.tabs : []) || [];
    const stop = { pos, align: $('tt-pa-tab-align')?.value || 'left', leader: $('tt-pa-tab-leader')?.value || '' };
    apply('para', { tabs: [...cur.filter(s => s.pos !== pos), stop].sort((a, b) => a.pos - b.pos) });
  });

  $('tt-show-typography')?.addEventListener('click', () => { showTab('typography'); sync(); });

  // ── converting ──────────────────────────────────────────────────────────

  $('tt-convert-frame')?.addEventListener('click', () => { const t = target(); if (t) window.storyConvert?.(t.box, 'frame'); });
  $('tt-convert-art')?.addEventListener('click', () => { const t = target(); if (t) window.storyConvert?.(t.box, 'artistic'); });

  // ── keeping up ──────────────────────────────────────────────────────────

  window.onStoryChange?.(sync);
  // a selection made or dropped anywhere (drag-resize.js, the undo stack…)
  document.addEventListener('mouseup', () => requestAnimationFrame(sync));
  document.addEventListener('keyup', () => requestAnimationFrame(sync));
  window.utbUndo?.onChange(() => requestAnimationFrame(sync));
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
