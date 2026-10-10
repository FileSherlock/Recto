// image-adjust.js — Affinity's adjustments of the page view.
//
// A stack of adjustments (Curves, Levels, Brightness / Contrast, Invert,
// Threshold — adjust-core.js, computed as Affinity's kernels compute them) is
// compiled into stages and handed to the browser as an SVG filter: a run of
// per-channel tables is one feComponentTransfer (`type="table"`, 256 values:
// an 8-bit input i/255 lands exactly on entry i), Threshold reads the Rec. 601
// intensity first (feColorMatrix) and an adjustment's opacity mixes with what
// it was given (feComposite). Every page image and the webgl_mask overlay are
// drawn through it (styles.css, body.ia-on). The document is never changed:
// Doc, the other plugins and their analyses keep reading the page's own
// pixels; "Export page as PNG" applies the very same stages to those pixels.
//
// The ribbon bar (#ia-options-bar) has the quick controls — Invert, Contrast
// and Brightness, each one adjustment of the stack it keeps for itself —, the
// presets (Affinity's own and a few for scans), the panel, bypass and reset.
// The panel (#ia-panel) is the stack (top acts first, like adjustment layers
// over the page) and the editor of its selected adjustment; the Curves graph
// shows the page's histogram, and its pickers take a tone from the page:
// Add Point, Set Black Point, Set White Point, Set Grey Point. The stack is
// kept in this browser (localStorage) and applies to every document until it
// is reset.
(function () {
  const AC = globalThis.AdjustCore;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const KEY = 'recto.imageAdjust';
  const $ = id => document.getElementById(id);
  if (!AC || !$('ia-toggle')) return;

  const NAMES = { curves: 'Curves', levels: 'Levels', brightnessContrast: 'Brightness / Contrast', invert: 'Invert', threshold: 'Threshold' };
  let seq = 0;
  const newId = () => `ia-${Date.now().toString(36)}-${++seq}`;
  const fresh = a => ({ ...AC.create(a.type), ...a, id: a.id || newId() });

  // ── the stack ─────────────────────────────────────────────────────────────

  let stack = [];
  let selected = null;     // id of the adjustment in the editor
  let bypass = false;

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (Array.isArray(s?.stack)) stack = s.stack.filter(a => NAMES[a?.type]).map(fresh);
      if (s?.rounding) AC.rounding = s.rounding;
    } catch { stack = []; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ stack, rounding: AC.rounding })); } catch { /* private window: this session only */ }
  }

  // ── the filter ────────────────────────────────────────────────────────────

  const defs = document.createElementNS(SVG_NS, 'svg');
  defs.id = 'ia-defs';
  defs.setAttribute('width', '0');
  defs.setAttribute('height', '0');
  defs.setAttribute('aria-hidden', 'true');
  defs.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  document.body.appendChild(defs);

  // The stages as filter primitives. color-interpolation-filters sRGB: the
  // tables act on the samples as they are stored (gamma-encoded), as
  // Affinity's RGB adjustments do — not on linear light, the SVG default.
  const LUMA = '0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0 0 0 1 0';
  function filterMarkup(stages) {
    const funcs = (r, g, b) => `<feFuncR type="table" tableValues="${AC.tableValues(r)}"/><feFuncG type="table" tableValues="${AC.tableValues(g)}"/><feFuncB type="table" tableValues="${AC.tableValues(b)}"/>`;
    let prev = 'SourceGraphic', out = '';
    stages.forEach((s, i) => {
      if (s.kind === 'lut') {
        out += `<feComponentTransfer in="${prev}" result="s${i}">${funcs(s.r, s.g, s.b)}</feComponentTransfer>`;
      } else {
        out += `<feColorMatrix in="${prev}" type="matrix" values="${LUMA}" result="y${i}"/>`;
        out += `<feComponentTransfer in="y${i}" result="${s.opacity < 1 ? `t${i}` : `s${i}`}">${funcs(s.y, s.y, s.y)}</feComponentTransfer>`;
        if (s.opacity < 1) out += `<feComposite in="t${i}" in2="${prev}" operator="arithmetic" k1="0" k2="${s.opacity}" k3="${1 - s.opacity}" k4="0" result="s${i}"/>`;
      }
      prev = `s${i}`;
    });
    return `<filter id="ia-filter" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">${out}</filter>`;
  }

  let stages = [];
  function apply({ keep = false } = {}) {
    stages = AC.compile(stack);
    const identity = AC.isIdentity(stages);
    if (!identity) defs.innerHTML = filterMarkup(stages);
    document.body.classList.toggle('ia-on', !bypass && !identity);
    $('ia-toggle')?.classList.toggle('ia-active', !identity);
    $('ia-bypass')?.classList.toggle('active', bypass);
    if (!keep) save();
    syncQuick();
  }

  // ── the quick controls ────────────────────────────────────────────────────

  // Invert and Brightness / Contrast of the ribbon are adjustments of the
  // stack marked `quick`; the panel shows and edits them like any other.
  const quick = kind => stack.find(a => a.quick === kind);
  function syncQuick() {
    $('ia-invert')?.classList.toggle('active', !!quick('invert')?.enabled);
    const bc = quick('bc');
    const c = Math.round((bc?.enabled ? bc.contrast : 0) * 100), b = Math.round((bc?.enabled ? bc.brightness : 0) * 100);
    if ($('ia-contrast') && document.activeElement !== $('ia-contrast')) $('ia-contrast').value = c;
    if ($('ia-brightness') && document.activeElement !== $('ia-brightness')) $('ia-brightness').value = b;
    if ($('ia-contrast-value')) $('ia-contrast-value').textContent = `${c} %`;
    if ($('ia-brightness-value')) $('ia-brightness-value').textContent = `${b} %`;
  }

  function toggleInvert() {
    const inv = quick('invert');
    if (inv) stack = stack.filter(a => a !== inv);
    else stack.push(fresh({ type: 'invert', quick: 'invert' }));
    apply();
    renderPanel();
  }
  $('ia-invert')?.addEventListener('click', toggleInvert);

  function setBC(patch) {
    let bc = quick('bc');
    if (!bc) { bc = fresh({ type: 'brightnessContrast', quick: 'bc' }); stack.push(bc); }
    Object.assign(bc, patch, { enabled: true });
    if (!bc.brightness && !bc.contrast) stack = stack.filter(a => a !== bc);
    apply();
    renderPanel();
  }
  for (const [id, key] of [['ia-contrast', 'contrast'], ['ia-brightness', 'brightness']]) {
    $(id)?.addEventListener('input', e => setBC({ [key]: (+e.target.value) / 100 }));
    $(id)?.addEventListener('dblclick', () => setBC({ [key]: 0 }));
  }

  // the presets, grouped as Affinity's preset menus are
  const presetSel = $('ia-preset');
  if (presetSel) {
    const groups = new Map();
    for (const p of AC.PRESETS) {
      if (!groups.has(p.group)) { const g = document.createElement('optgroup'); g.label = p.group; groups.set(p.group, g); presetSel.appendChild(g); }
      const o = document.createElement('option'); o.value = p.key; o.textContent = p.label; groups.get(p.group).appendChild(o);
    }
  }
  presetSel?.addEventListener('change', () => {
    const p = AC.PRESETS.find(x => x.key === presetSel.value);
    presetSel.value = '';
    if (!p) return;
    stack = p.stack().map(a => fresh({ ...a, quick: a.type === 'invert' ? 'invert' : undefined }));
    selected = stack.find(a => a.type !== 'invert')?.id || stack[0]?.id || null;
    apply();
    renderPanel();
  });

  $('ia-bypass')?.addEventListener('click', () => { bypass = !bypass; apply({ keep: true }); });
  $('ia-reset')?.addEventListener('click', () => { stack = []; selected = null; bypass = false; apply(); renderPanel(); });

  // the tool column button opens the bar, as every contextual bar opens
  const toggleBtn = $('ia-toggle'), bar = $('ia-options-bar');
  window.registerSubtoolbar?.(toggleBtn);
  toggleBtn.addEventListener('click', () => {
    if (bar?.classList.contains('hidden')) window.openSubtoolbar?.(bar, toggleBtn);
    else window.openSubtoolbar?.(null, null);
  });

  // Ctrl+I inverts, as Affinity's Invert does — not in a field or a text being edited
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'i') return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
    if (typeof utbState !== 'undefined' && utbState.editingId) return;
    e.preventDefault();
    toggleInvert();
  });

  // ── the panel ─────────────────────────────────────────────────────────────

  const panel = $('ia-panel');
  function openPanel(open = panel.classList.contains('hidden')) {
    panel.classList.toggle('hidden', !open);
    $('ia-open-panel')?.classList.toggle('active', open);
    if (open) { if (!selected || !stack.some(a => a.id === selected)) selected = stack[0]?.id || null; renderPanel(); loadHistogram(); }
    else setPicker(null);
  }
  $('ia-open-panel')?.addEventListener('click', () => openPanel());
  $('ia-panel-close')?.addEventListener('click', () => openPanel(false));

  // drag the panel by its title; it remembers where it was
  (function draggable() {
    const head = $('ia-panel-head');
    try {
      const pos = JSON.parse(localStorage.getItem(`${KEY}.pos`));
      if (pos) { panel.style.left = `${pos.x}px`; panel.style.top = `${pos.y}px`; panel.style.right = 'auto'; }
    } catch { /* the default place */ }
    head?.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      const r = panel.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = ev => {
        const x = Math.max(0, Math.min(innerWidth - 60, ev.clientX - dx)), y = Math.max(0, Math.min(innerHeight - 30, ev.clientY - dy));
        panel.style.left = `${x}px`; panel.style.top = `${y}px`; panel.style.right = 'auto';
      };
      const up = () => {
        removeEventListener('mousemove', move); removeEventListener('mouseup', up);
        const rr = panel.getBoundingClientRect();
        try { localStorage.setItem(`${KEY}.pos`, JSON.stringify({ x: rr.left, y: rr.top })); } catch { /* fine */ }
      };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    });
  })();

  $('ia-add')?.addEventListener('change', e => {
    const type = e.target.value;
    e.target.value = '';
    if (!NAMES[type]) return;
    const adj = fresh({ type });
    stack.push(adj);
    selected = adj.id;
    apply();
    renderPanel();
  });

  $('ia-rounding')?.addEventListener('change', e => { AC.rounding = e.target.value; apply(); });

  function renderPanel() {
    if (!panel || panel.classList.contains('hidden')) return;
    if ($('ia-rounding')) $('ia-rounding').value = AC.rounding;
    const list = $('ia-stack');
    list.replaceChildren();
    stack.forEach((a, i) => {
      const li = document.createElement('li');
      li.className = 'ia-item' + (a.id === selected ? ' selected' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = a.enabled; cb.title = 'On / off';
      cb.addEventListener('change', () => { a.enabled = cb.checked; apply(); });
      cb.addEventListener('click', ev => ev.stopPropagation());
      const name = document.createElement('span');
      name.className = 'ia-name';
      name.textContent = NAMES[a.type] + (a.quick ? ' (ribbon)' : '');
      const btn = (icon, title, fn, disabled = false) => {
        const b = document.createElement('button');
        b.className = 'icon-button ia-mini'; b.title = title; b.disabled = disabled;
        b.innerHTML = `<span class="material-symbols-outlined">${icon}</span>`;
        b.addEventListener('click', ev => { ev.stopPropagation(); fn(); });
        return b;
      };
      li.append(cb, name,
        btn('arrow_upward', 'Move up (acts earlier)', () => { [stack[i - 1], stack[i]] = [stack[i], stack[i - 1]]; apply(); renderPanel(); }, i === 0),
        btn('arrow_downward', 'Move down (acts later)', () => { [stack[i + 1], stack[i]] = [stack[i], stack[i + 1]]; apply(); renderPanel(); }, i === stack.length - 1),
        btn('delete', 'Remove', () => { stack.splice(i, 1); if (selected === a.id) selected = stack[0]?.id || null; apply(); renderPanel(); }));
      li.addEventListener('click', () => { selected = a.id; renderPanel(); });
      list.appendChild(li);
    });
    if (!stack.length) {
      const li = document.createElement('li');
      li.className = 'ia-empty';
      li.textContent = 'No adjustments — add one, pick a preset, or use the ribbon.';
      list.appendChild(li);
    }
    renderEditor(stack.find(a => a.id === selected) || null);
  }

  // ── editors ───────────────────────────────────────────────────────────────

  const elt = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function row(label, ...controls) {
    const r = elt('div', 'ia-row');
    if (label != null) r.appendChild(elt('label', null, label));
    r.append(...controls);
    return r;
  }
  // a slider and its number over obj[key] (shown × scale), Affinity's double-click reset
  function slider(adj, obj, key, label, min, max, step, scale = 1, unit = '', dflt = 0) {
    const input = elt('input');
    input.type = 'range'; input.min = min; input.max = max; input.step = step;
    input.value = obj[key] * scale;
    const val = elt('span', 'ia-value');
    const show = () => { val.textContent = `${+(obj[key] * scale).toFixed(2)}${unit}`; };
    show();
    input.addEventListener('input', () => { obj[key] = +input.value / scale; show(); apply(); });
    input.addEventListener('dblclick', () => { obj[key] = dflt; input.value = dflt * scale; show(); apply(); });
    return row(label, input, val);
  }
  function check(obj, key, label, after = () => {}) {
    const l = elt('label', 'ia-check');
    const cb = elt('input');
    cb.type = 'checkbox'; cb.checked = !!obj[key];
    cb.addEventListener('change', () => { obj[key] = cb.checked; apply(); after(); });
    l.append(cb, document.createTextNode(` ${label}`));
    return l;
  }
  function channelSelect(value, onChange) {
    const s = elt('select', 'toolbar-select');
    for (const [v, t] of [['master', 'Master'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']]) { const o = elt('option', null, t); o.value = v; s.appendChild(o); }
    s.value = value;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }

  let levelsChannel = 'master';
  function renderEditor(adj) {
    const box = $('ia-editor');
    box.replaceChildren();
    curveUI = null;
    setPicker(null);
    if (!adj) return;
    box.appendChild(elt('div', 'ia-editor-title', NAMES[adj.type]));
    if (adj.type === 'curves') box.appendChild(curvesEditor(adj));
    if (adj.type === 'levels') {
      const l = adj[levelsChannel] || adj.master;
      box.append(row('Channel', channelSelect(levelsChannel, v => { levelsChannel = v; renderEditor(adj); })),
        slider(adj, l, 'black', 'Black Level', 0, 100, 0.1, 100, ' %', 0),
        slider(adj, l, 'white', 'White Level', 0, 100, 0.1, 100, ' %', 1),
        slider(adj, l, 'gamma', 'Gamma', 0.01, 2, 0.01, 1, '', 1),
        slider(adj, l, 'outBlack', 'Output Black Level', 0, 100, 0.1, 100, ' %', 0),
        slider(adj, l, 'outWhite', 'Output White Level', 0, 100, 0.1, 100, ' %', 1),
        elt('p', 'ia-hint', 'As in Affinity, gamma is the exponent itself: above 1 darkens the midtones, below 1 lightens them.'));
    }
    if (adj.type === 'brightnessContrast')
      box.append(slider(adj, adj, 'brightness', 'Brightness', -100, 100, 1, 100, ' %'), slider(adj, adj, 'contrast', 'Contrast', -100, 100, 1, 100, ' %'),
        check(adj, 'linear', 'Linear', () => syncQuick()));
    if (adj.type === 'threshold') box.append(slider(adj, adj, 'level', 'Threshold', 0, 100, 0.1, 100, ' %', 0.5),
      elt('p', 'ia-hint', 'A pixel whose intensity is at or below the threshold becomes black, above it white.'));
    if (adj.type === 'invert') box.appendChild(elt('p', 'ia-hint', 'Every channel becomes 255 − value: dark text on light paper turns light on dark.'));
    box.appendChild(slider(adj, adj, 'opacity', 'Opacity', 0, 100, 1, 100, ' %', 1));
  }

  // ── the Curves graph ──────────────────────────────────────────────────────

  let curveUI = null;     // { adj, channel, sel, draw }
  let histo = null;       // { key, h } — the current page's histogram

  function curvesEditor(adj) {
    const wrap = elt('div', 'ia-curves');
    const ui = curveUI = { adj, channel: 'master', sel: -1, draw: null };
    adj.linear = adj.linear || { master: false, r: false, g: false, b: false };

    const linear = elt('label', 'ia-check');
    const linCb = elt('input'); linCb.type = 'checkbox';
    linear.append(linCb, document.createTextNode(' Linear'));
    linear.title = 'Straight lines between the points instead of the spline';
    linCb.addEventListener('change', () => { adj.linear[ui.channel] = linCb.checked; apply(); draw(); });
    const chSel = channelSelect('master', v => { ui.channel = v; ui.sel = -1; linCb.checked = !!adj.linear[v]; draw(); });
    wrap.appendChild(row('Channel', chSel, linear));

    const canvas = elt('canvas', 'ia-curve-canvas');
    const SIZE = 256, PAD = 8, dpr = window.devicePixelRatio || 1;
    canvas.width = (SIZE + 2 * PAD) * dpr; canvas.height = (SIZE + 2 * PAD) * dpr;
    canvas.style.width = `${SIZE + 2 * PAD}px`; canvas.style.height = `${SIZE + 2 * PAD}px`;
    canvas.tabIndex = 0;
    canvas.title = 'Click to add a point, drag to move it, drag it off the graph or press Delete to remove it';
    wrap.appendChild(canvas);

    // X / Y of the selected point (Affinity: 0…1), the input range Min / Max
    const num = (title, step) => { const i = elt('input', 'toolbar-input-small ia-num'); i.type = 'number'; i.min = 0; i.max = 1; i.step = step; i.title = title; return i; };
    const inX = num('X — the input value of the point (0–1)', 0.001), inY = num('Y — its output (0–1)', 0.001);
    wrap.appendChild(row('X:', inX, elt('label', 'ia-inline', 'Y:'), inY));
    const inMin = num('Min — the lowest input value the curve spans', 0.01), inMax = num('Max — the highest', 0.01);
    inMin.value = adj.inputMin ?? 0; inMax.value = adj.inputMax ?? 1;
    for (const [i, k] of [[inMin, 'inputMin'], [inMax, 'inputMax']]) i.addEventListener('change', () => { adj[k] = Math.max(0, Math.min(1, +i.value)); apply(); });
    wrap.appendChild(row('Min:', inMin, elt('label', 'ia-inline', 'Max:'), inMax));

    // the pickers: take a tone from the page
    const pickers = elt('div', 'ia-row ia-pickers');
    for (const [mode, icon, title] of [['add', 'add_location', 'Add Point — press on the page to add the point of that tone, drag up or down to move it'],
      ['black', 'contrast_rtl_off', 'Set Black Point — press on what should become black (the ink)'],
      ['white', 'light_mode', 'Set White Point — press on what should become white (the paper)'],
      ['grey', 'tonality', 'Set Grey Point — press on what should become neutral grey']]) {
      const b = elt('button', 'icon-button options-toggle');
      b.dataset.picker = mode; b.title = title;
      b.innerHTML = `<span class="material-symbols-outlined">${icon}</span>`;
      b.addEventListener('click', () => setPicker(picker === mode ? null : mode));
      pickers.appendChild(b);
    }
    const reset = elt('button', 'panel-btn', 'Reset');
    reset.title = 'Reset this channel to a straight line';
    reset.addEventListener('click', () => { adj[ui.channel] = [[0, 0], [1, 1]]; ui.sel = -1; apply(); draw(); });
    pickers.appendChild(reset);
    wrap.appendChild(pickers);

    const pts = () => adj[ui.channel];
    const toPx = ([x, y]) => [PAD + x * SIZE, PAD + (1 - y) * SIZE];
    const fromPx = (px, py) => [Math.max(0, Math.min(1, (px - PAD) / SIZE)), Math.max(0, Math.min(1, 1 - (py - PAD) / SIZE))];

    function draw() {
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, SIZE + 2 * PAD, SIZE + 2 * PAD);
      g.fillStyle = '#1b1b1d'; g.fillRect(PAD, PAD, SIZE, SIZE);
      // the histogram of the channel (the intensity for Master)
      const h = histo?.h?.[ui.channel === 'master' ? 'l' : ui.channel];
      if (h) {
        let max = 0; for (let i = 1; i < 255; i++) max = Math.max(max, h[i]);
        max = Math.max(max, 1);
        g.fillStyle = ui.channel === 'master' ? 'rgba(200,200,200,0.22)' : ({ r: 'rgba(255,90,90,0.3)', g: 'rgba(90,220,90,0.3)', b: 'rgba(100,140,255,0.35)' })[ui.channel];
        for (let i = 0; i < 256; i++) {
          const v = Math.min(1, Math.sqrt(h[i] / max));
          g.fillRect(PAD + i * SIZE / 256, PAD + SIZE * (1 - v), SIZE / 256 + 0.5, SIZE * v);
        }
      }
      g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 1;
      for (let k = 1; k < 4; k++) {
        g.beginPath(); g.moveTo(PAD + k * SIZE / 4, PAD); g.lineTo(PAD + k * SIZE / 4, PAD + SIZE); g.stroke();
        g.beginPath(); g.moveTo(PAD, PAD + k * SIZE / 4); g.lineTo(PAD + SIZE, PAD + k * SIZE / 4); g.stroke();
      }
      g.strokeStyle = 'rgba(255,255,255,0.18)';
      g.beginPath(); g.moveTo(PAD, PAD + SIZE); g.lineTo(PAD + SIZE, PAD); g.stroke();
      // the curve, as Affinity evaluates it (overshoots show past the box)
      const f = AC.spline(pts(), !!adj.linear[ui.channel]);
      g.strokeStyle = ({ master: '#e8eaed', r: '#ff6b6b', g: '#69db7c', b: '#74a8ff' })[ui.channel];
      g.lineWidth = 1.6;
      g.beginPath();
      for (let i = 0; i <= SIZE; i++) { const [x, y] = toPx([i / SIZE, f(i / SIZE)]); i ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke();
      pts().forEach((p, i) => {
        const [x, y] = toPx(p);
        g.fillStyle = i === ui.sel ? '#8ab4f8' : '#202124';
        g.strokeStyle = '#e8eaed'; g.lineWidth = 1.2;
        g.beginPath(); g.rect(x - 4, y - 4, 8, 8); g.fill(); g.stroke();
      });
      const p = pts()[ui.sel];
      inX.value = p ? +p[0].toFixed(3) : '';
      inY.value = p ? +p[1].toFixed(3) : '';
      inX.disabled = inY.disabled = !p;
    }
    ui.draw = draw;

    for (const [inp, k] of [[inX, 0], [inY, 1]]) inp.addEventListener('change', () => {
      const list = pts().map(p => [...p]);
      const p = list[ui.sel];
      if (!p) return;
      p[k] = Math.max(0, Math.min(1, +inp.value || 0));
      // a point keeps strictly between its neighbours
      const prev = list[ui.sel - 1], next = list[ui.sel + 1];
      if (prev && p[0] <= prev[0]) p[0] = prev[0] + 1 / 255;
      if (next && p[0] >= next[0]) p[0] = next[0] - 1 / 255;
      adj[ui.channel] = list; apply(); draw();
    });

    canvas.addEventListener('mousedown', e => {
      e.preventDefault();
      canvas.focus();
      const r = canvas.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const list = pts().map(p => [...p]);
      let i = list.findIndex(p => { const [x, y] = toPx(p); return Math.abs(x - px) <= 6 && Math.abs(y - py) <= 6; });
      if (i < 0) {
        const [x, y] = fromPx(px, py);
        if (list.some(p => Math.abs(p[0] - x) < 1 / 255)) return;
        // a press near the curve adds a point on it, elsewhere where pressed
        const onCurve = AC.spline(list, !!adj.linear[ui.channel])(x);
        list.push([x, Math.abs(y - onCurve) < 0.04 ? Math.max(0, Math.min(1, onCurve)) : y]);
        list.sort((a, b) => a[0] - b[0]);
        i = list.findIndex(p => p[0] === x);
      }
      let pt = list[i];
      ui.sel = i;
      adj[ui.channel] = list; apply(); draw();
      const ends = i === 0 || i === list.length - 1;
      const move = ev => {
        const rr = canvas.getBoundingClientRect();
        const qx = ev.clientX - rr.left, qy = ev.clientY - rr.top;
        const off = qy < -24 || qy > SIZE + 2 * PAD + 24 || qx < -24 || qx > SIZE + 2 * PAD + 24;
        const cur = pts().map(p => [...p]);
        const k = cur.findIndex(p => p[0] === pt[0] && p[1] === pt[1]);
        if (k < 0) return;
        if (off && !ends && cur.length > 2) {          // dragged off the graph: gone
          cur.splice(k, 1); ui.sel = -1; adj[ui.channel] = cur; apply(); draw();
          window.removeEventListener('mousemove', move);
          return;
        }
        let [x, y] = fromPx(qx, qy);
        const lo = cur[k - 1] ? cur[k - 1][0] + 1 / 255 : 0, hi = cur[k + 1] ? cur[k + 1][0] - 1 / 255 : 1;
        x = Math.max(lo, Math.min(hi, x));
        cur[k] = pt = [x, y];
        adj[ui.channel] = cur; ui.sel = k; apply({ keep: true }); draw();
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); save(); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    canvas.addEventListener('keydown', e => {
      const list = pts().map(p => [...p]);
      const p = list[ui.sel];
      if (!p) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && ui.sel > 0 && ui.sel < list.length - 1) {
        e.preventDefault(); list.splice(ui.sel, 1); ui.sel = -1; adj[ui.channel] = list; apply(); draw(); return;
      }
      const step = (e.shiftKey ? 10 : 1) / 255;
      const d = { ArrowUp: [0, step], ArrowDown: [0, -step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] }[e.key];
      if (!d) return;
      e.preventDefault();
      const lo = list[ui.sel - 1] ? list[ui.sel - 1][0] + 1 / 255 : 0, hi = list[ui.sel + 1] ? list[ui.sel + 1][0] - 1 / 255 : 1;
      p[0] = Math.max(lo, Math.min(hi, p[0] + d[0]));
      p[1] = Math.max(0, Math.min(1, p[1] + d[1]));
      adj[ui.channel] = list; apply(); draw();
    });

    linCb.checked = !!adj.linear.master;
    draw();
    return wrap;
  }

  // ── the pickers ───────────────────────────────────────────────────────────

  let picker = null;      // 'add' | 'black' | 'white' | 'grey' | null
  function setPicker(mode) {
    picker = mode && curveUI ? mode : null;
    document.querySelectorAll('#ia-panel [data-picker]').forEach(b => b.classList.toggle('active', b.dataset.picker === picker));
    els.viewer.classList.toggle('ia-picking', !!picker);
  }

  // A curve's end moved to x: the black point is its first point, the white
  // point its last; the points beyond it go.
  function setEnd(list, x, y, first) {
    const inner = list.filter((p, i) => i > 0 && i < list.length - 1 && (first ? p[0] > x + 1 / 255 : p[0] < x - 1 / 255));
    const other = first ? list[list.length - 1] : list[0];
    return first ? [[x, y], ...inner, other] : [other, ...inner, [x, y]];
  }

  els.viewer.addEventListener('mousedown', async e => {
    const ui = curveUI;
    if (!ui || !picker || e.button !== 0) return;
    const pageEl = e.target.closest('.page-container');
    if (!pageEl) return;
    e.preventDefault();
    e.stopPropagation();
    const mode = picker;
    const rect = pageEl.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width, fy = (e.clientY - rect.top) / rect.height;
    const page = parseInt(pageEl.id.replace('pageContainer', ''), 10);
    const r = await raster(page);
    if (!r || curveUI !== ui) return;
    const x = Math.min(r.width - 1, Math.max(0, Math.floor(fx * r.width))), y = Math.min(r.height - 1, Math.max(0, Math.floor(fy * r.height)));
    const at = (y * r.width + x) * r.components, s = r.samples;
    const rgb = r.components === 1 ? [s[at], s[at], s[at]] : [s[at], s[at + 1], s[at + 2]];
    const adj = ui.adj;
    if (mode === 'black' || mode === 'white') {
      // each colour channel's own value goes to black (or white): a colour
      // cast in the ink or the paper goes with it
      ['r', 'g', 'b'].forEach((ch, k) => { adj[ch] = setEnd(adj[ch], rgb[k] / 255, mode === 'black' ? 0 : 1, mode === 'black'); });
      ui.channel = 'master';
      apply(); renderEditor(adj);
      return;
    }
    if (mode === 'grey') {
      // each channel's value maps to the pixel's intensity: it becomes neutral
      const l = AC.luma(...rgb) / 255;
      ['r', 'g', 'b'].forEach((ch, k) => {
        const v = rgb[k] / 255;
        const list = adj[ch].filter(p => Math.abs(p[0] - v) >= 1 / 255 || p === adj[ch][0] || p === adj[ch][adj[ch].length - 1]).map(p => [...p]);
        if (v > list[0][0] && v < list[list.length - 1][0]) { list.push([v, l]); list.sort((a, b) => a[0] - b[0]); }
        adj[ch] = list;
      });
      apply(); renderEditor(adj);
      return;
    }
    // Add Point: the tone under the pointer on the shown channel, then a
    // vertical drag moves it
    const v = ui.channel === 'master' ? AC.luma(...rgb) : rgb[{ r: 0, g: 1, b: 2 }[ui.channel]];
    const vx = v / 255;
    const list = adj[ui.channel].map(p => [...p]);
    let pt = list.find(p => Math.abs(p[0] - vx) < 1 / 255);
    if (!pt) { pt = [vx, Math.max(0, Math.min(1, AC.spline(list, !!adj.linear[ui.channel])(vx)))]; list.push(pt); list.sort((a, b) => a[0] - b[0]); }
    adj[ui.channel] = list;
    ui.sel = list.indexOf(pt);
    apply(); ui.draw();
    const y0 = e.clientY, out0 = pt[1];
    const move = ev => { pt[1] = Math.max(0, Math.min(1, out0 + (y0 - ev.clientY) / 200)); apply({ keep: true }); ui.draw(); };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); save(); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  }, true);

  // ── the page's pixels: histogram, pickers, export ────────────────────────

  // The page's raster as samples: Doc.pagePixels, or the decoded page image
  // of an image document.
  const rasters = new Map();     // `${hash}:${page}` → Promise<{ width, height, components, samples }>
  function raster(page) {
    const key = `${state.docHash}:${page}`;
    if (!rasters.has(key)) {
      if (rasters.size > 3) rasters.delete(rasters.keys().next().value);
      rasters.set(key, (async () => {
        const r = await Doc.pagePixels(page);
        if (r) return { width: r.width, height: r.height, components: r.components + (r.alpha && r.components < 4 ? 1 : 0), samples: r.samples };
        const blob = await (await fetch(await Doc.pageImageURL(page))).blob();
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, bmp.width, bmp.height);
        return { width: bmp.width, height: bmp.height, components: 4, samples: new Uint8Array(d.data.buffer) };
      })().catch(() => null));
    }
    return rasters.get(key);
  }

  async function loadHistogram() {
    if (!state.numPages || panel.classList.contains('hidden')) return;
    const key = `${state.docHash}:${state.currentPage}`;
    if (histo?.key === key) { curveUI?.draw(); return; }
    const r = await raster(state.currentPage);
    if (!r || key !== `${state.docHash}:${state.currentPage}`) return;
    histo = { key, h: AC.histogram(r.samples, r.components) };
    curveUI?.draw();
  }
  PDFHooks.on('page:rendered', () => loadHistogram());
  PDFHooks.on('document:opening', () => { rasters.clear(); histo = null; });

  // Export: the page's own pixels through the stages, as a PNG download.
  $('ia-export')?.addEventListener('click', async () => {
    if (!state.numPages) return;
    const r = await raster(state.currentPage);
    if (!r) return;
    const out = AC.applyToSamples(r.samples, r.components, stages);
    const rgba = new Uint8ClampedArray(r.width * r.height * 4);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += r.components) {
      if (r.components === 1) { rgba[i] = rgba[i + 1] = rgba[i + 2] = out[j]; rgba[i + 3] = 255; }
      else { rgba[i] = out[j]; rgba[i + 1] = out[j + 1]; rgba[i + 2] = out[j + 2]; rgba[i + 3] = r.components > 3 ? out[j + 3] : 255; }
    }
    const c = new OffscreenCanvas(r.width, r.height);
    c.getContext('2d').putImageData(new ImageData(rgba, r.width, r.height), 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(document.getElementById('document-title')?.textContent || 'page').replace(/\.[^.]+$/, '')}-p${state.currentPage}-adjusted.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  });

  window.imageAdjust = {
    get stack() { return stack; },
    set(next) { stack = (next || []).filter(a => NAMES[a?.type]).map(fresh); apply(); renderPanel(); },
    stages: () => stages,
  };

  load();
  apply({ keep: true });
})();
