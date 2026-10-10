// adjust-core.js — Affinity's adjustments of the page view, as numbers.
//
// The adjustments a scan is read with — Curves, Invert, Levels,
// Brightness / Contrast, Threshold — computed the way Affinity's pixel
// kernels compute them for an 8-bit RGB document (see
// guide/plugins/image-adjust/README.md for what was recovered and from
// where). Every one but Threshold is a point operation on each colour
// channel, so it is a 256-entry table per channel; Threshold reads a pixel's
// Rec. 601 intensity first, which makes it a "gray" stage. A stack of
// adjustments (applied top to bottom, each at its opacity — Affinity's
// adjustment layers) compiles into stages: runs of per-channel tables fused
// into one, gray stages between them. image-adjust.js hands the stages to the
// browser as an SVG filter (feComponentTransfer tables, feColorMatrix for the
// intensity, feComposite for an opacity), and applyToSamples() applies the
// very same stages to a raster here — what the tests hold the numbers to, and
// what an export of the adjusted page uses.
//
// Values are 0…1; a curve is a list of control points [x, y] in 0…1 with
// strictly increasing x. 8-bit results are rounded half up, as Affinity's
// GPU kernels do (v + 0.5, truncated). No DOM: the node tests load
// this very file (globalThis.AdjustCore).
(function () {
  const N = 256;
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const clamp8 = v => (v < 0 ? 0 : v > 255 ? 255 : v);
  const f32 = Math.fround, trunc = Math.trunc;
  const CHANNELS = ['r', 'g', 'b'];
  // Affinity's two 8-bit paths differ by one level at most: its GPU kernels
  // (what the screen shows with hardware acceleration) round half up, its CPU
  // renderer truncates. 'gpu' is the default here.
  let rounding = 'gpu';
  // (truncation with a hair of slack: i/255·255 is i, not i − 1, whatever the float left of it)
  const q8 = v => clamp8(rounding === 'cpu' ? trunc(v + 1e-9) : Math.floor(v + 0.5));     // v in 0…255 units
  const roundC = v => Math.sign(v) * Math.round(Math.abs(v));                         // C round(): half away from zero

  // ── curves ──────────────────────────────────────────────────────────────────

  // The control points in order, x strictly increasing, clamped to 0…1; two
  // points at one x keep the later one.
  function sortPoints(points) {
    const out = [];
    for (const [x, y] of [...(points || [])].map(p => [clamp01(+p[0]), clamp01(+p[1])]).sort((a, b) => a[0] - b[0])) {
      if (out.length && Math.abs(out[out.length - 1][0] - x) < 1e-9) out[out.length - 1] = [x, y];
      else out.push([x, y]);
    }
    return out.length ? out : [[0, 0], [1, 1]];
  }

  // Affinity's curve: a natural cubic spline (the textbook algorithm:
  // spline() for the second derivatives, splint() to evaluate), flat beyond
  // its first and last points, and the identity outside 0…1 — a value an
  // earlier curve pushed past the range passes unchanged. With two points, or
  // "Linear", it is piecewise linear by the same rules. Not clamped: an
  // overshoot leaves 0…1 and is clamped only at the very end.
  function spline(points, linear = false) {
    const p = sortPoints(points), n = p.length;
    // Affinity keeps a curve's knots as float32
    const xs = p.map(q => f32(q[0])), ys = p.map(q => f32(q[1]));
    const segment = x => { let k = 0; while (k < n - 2 && x >= xs[k + 1]) k++; return k; };
    if (linear || n <= 2) {
      return x => {
        if (x < 0 || x > 1) return x;
        if (x <= xs[0]) return ys[0];
        if (x >= xs[n - 1]) return ys[n - 1];
        const k = segment(x), h = xs[k + 1] - xs[k], a = (xs[k + 1] - x) / h;
        return a * ys[k] + (1 - a) * ys[k + 1];
      };
    }
    // spline(): natural ends (y'' = 0), the tridiagonal sweep as in the book
    const y2 = new Float64Array(n), u = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) {
      const sig = (xs[i] - xs[i - 1]) / (xs[i + 1] - xs[i - 1]);
      const q = sig * y2[i - 1] + 2;
      y2[i] = (sig - 1) / q;
      u[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) - (ys[i] - ys[i - 1]) / (xs[i] - xs[i - 1]);
      u[i] = (6 * u[i] / (xs[i + 1] - xs[i - 1]) - sig * u[i - 1]) / q;
    }
    y2[n - 1] = 0;
    for (let k = n - 2; k >= 0; k--) y2[k] = y2[k] * y2[k + 1] + u[k];
    return x => {
      if (x < 0 || x > 1) return x;
      if (x <= xs[0]) return ys[0];
      if (x >= xs[n - 1]) return ys[n - 1];
      const k = segment(x), h = xs[k + 1] - xs[k], a = (xs[k + 1] - x) / h, b = 1 - a;
      return a * ys[k] + b * ys[k + 1] + ((a * a * a - a) * y2[k] + (b * b * b - b) * y2[k + 1]) * h * h / 6;
    };
  }
  // the second derivatives Affinity stores with a curve (for the tests)
  function secondDerivatives(points) {
    const p = sortPoints(points), n = p.length, xs = p.map(q => q[0]), ys = p.map(q => q[1]);
    const y2 = new Float64Array(n), u = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) {
      const sig = (xs[i] - xs[i - 1]) / (xs[i + 1] - xs[i - 1]), q = sig * y2[i - 1] + 2;
      y2[i] = (sig - 1) / q;
      u[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) - (ys[i] - ys[i - 1]) / (xs[i] - xs[i - 1]);
      u[i] = (6 * u[i] / (xs[i + 1] - xs[i - 1]) - sig * u[i - 1]) / q;
    }
    for (let k = n - 2; k >= 0; k--) y2[k] = y2[k] * y2[k + 1] + u[k];
    return Array.from(y2);
  }
  const isIdentityCurve = points => {
    const p = sortPoints(points);
    return p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1;
  };

  // ── the adjustments ─────────────────────────────────────────────────────────

  const LINE = () => [[0, 0], [1, 1]];
  const LEVELS = () => ({ black: 0, white: 1, gamma: 1, outBlack: 0, outWhite: 1 });

  // A new adjustment of a kind, with Affinity's defaults.
  function create(type) {
    const base = { type, enabled: true, opacity: 1 };
    switch (type) {
      case 'curves': return { ...base, master: LINE(), r: LINE(), g: LINE(), b: LINE(),
        linear: { master: false, r: false, g: false, b: false }, inputMin: 0, inputMax: 1 };
      case 'levels': return { ...base, master: LEVELS(), r: LEVELS(), g: LEVELS(), b: LEVELS() };
      case 'brightnessContrast': return { ...base, brightness: 0, contrast: 0, linear: false };
      case 'threshold': return { ...base, level: 0.5 };
      case 'invert': return base;
      default: return null;
    }
  }

  // Curves: each channel's own curve first, then the master curve, inside the
  // input range Min…Max (identity at the default 0…1).
  function curvesTables(adj) {
    const lin = adj.linear || {};
    const M = spline(adj.master, !!lin.master);
    const min = Number.isFinite(adj.inputMin) ? adj.inputMin : 0, max = Number.isFinite(adj.inputMax) ? adj.inputMax : 1;
    const scale = 1 / ((max - min) || 1), inv = max - min;
    const out = {};
    for (const ch of CHANNELS) {
      const C = spline(adj[ch], !!lin[ch]);
      out[ch] = Uint8Array.from({ length: N }, (_, i) => q8(255 * (inv * M(C((i / 255 - min) * scale)) + min)));
    }
    return out;
  }

  // Levels, as Affinity's kernel, in 0…255 units and float32: each channel's
  // levels first, then the master's. x = (v − black)·(outW − outB)/(white −
  // black); where x is in range and gamma ≠ 1, x = (outW − outB)·(x/(outW −
  // outB))^gamma — the stored gamma is the exponent itself, so a gamma above 1
  // darkens the midtones (Affinity's "Increase Gamma" preset stores 2) —; then
  // + outB and clamped.
  function levelsFn(l) {
    const { black = 0, white = 1, gamma = 1, outBlack = 0, outWhite = 1 } = l || {};
    const r = f32(outWhite - outBlack), span = f32(white - black) || 1e-6;
    return v => {                                   // v and the result in 0…255
      let x = f32(f32(f32(v - f32(black * 255)) * r) / span);
      if (gamma !== 1 && x >= 0 && x <= 255 && r !== 0) x = f32(f32(Math.pow(f32(x / f32(r * 255)), gamma)) * r * 255);
      return clamp8(f32(f32(outBlack * 255) + x));
    };
  }
  function levelsTables(adj) {
    const M = levelsFn(adj.master);
    const out = {};
    for (const ch of CHANNELS) { const C = levelsFn(adj[ch]); out[ch] = Uint8Array.from({ length: N }, (_, i) => q8(M(C(i)))); }
    return out;
  }

  // Brightness / Contrast: brightness B −1…1 and the stored contrast C 0…2
  // (1 = no change) — the panel's −100…100 % are B = %/100, C = 1 + %/100.
  // Affinity's exponents: pB = 2/(1 − 0.6|B|) − 1, inverted for
  // B < 0; pC = |C − 1| + 1, inverted for C < 1. Normal mode bends the tones
  // about black and white, t = 1 − (1 − v)^pB, then a power S-curve about mid
  // grey (8-bit: 128) with pC; Linear is (v − 128)·C + 128 + 255·B.
  function bcExponents(B, C) {
    let pB = 2 / (1 - 0.6 * Math.min(1, Math.abs(B))) - 1; if (B < 0) pB = 1 / pB;
    let pC = Math.abs(C - 1) + 1; if (C < 1) pC = 1 / pC;
    return { pB, pC };
  }
  function brightnessContrastTable({ brightness = 0, contrast = 0, linear = false } = {}) {
    const B = Math.max(-1, Math.min(1, brightness)), C = Math.max(0, Math.min(2, 1 + contrast));
    const { pB, pC } = bcExponents(B, C);
    return Uint8Array.from({ length: N }, (_, v) => {
      if (rounding === 'cpu') {
        if (linear) return clamp8(trunc(f32(f32(trunc(f32((v - 128) * f32(C))) + 128) + f32(f32(B) * 255))));
        const d = 255 - v;
        const t = clamp8(trunc(d - 255 * Math.pow(d / 255, pB) + v));
        return clamp8(t <= 128 ? trunc(t + roundC(128 * Math.pow(t / 128, pC) - t))
          : trunc(t + roundC((255 - t) - 128 * Math.pow((255 - t) / 128, pC))));
      }
      // the GPU kernel: the same in float, the upper branch above 128, rounded half up
      if (linear) return q8((v - 128) * C + 128 + B * 255);
      const t = clamp8(255 - 255 * Math.pow((255 - v) / 255, pB));
      return q8(Math.floor(t + 0.5) > 128 ? 255 - 128 * Math.pow((255 - t) / 128, pC) : 128 * Math.pow(t / 128, pC));
    });
  }

  // Threshold: Affinity reads the pixel's intensity (0.299 R + 0.587 G +
  // 0.114 B on the stored values, truncated to a level) and makes it black at
  // or below the threshold, white above; a stage of its own, a table over the
  // intensity.
  const thresholdTable = level => Uint8Array.from({ length: N }, (_, i) => (i <= f32(level * 255) ? 0 : 255));

  // One adjustment as a stage: { kind: 'lut', r, g, b } or { kind: 'gray', y }.
  function stageOf(adj) {
    switch (adj?.type) {
      // a curve that is the identity on every channel does nothing (Affinity skips it)
      case 'curves': return ['master', ...CHANNELS].every(ch => isIdentityCurve(adj[ch])) && !(adj.inputMin > 0) && !(adj.inputMax < 1)
        ? null : { kind: 'lut', ...curvesTables(adj) };
      case 'levels': return { kind: 'lut', ...levelsTables(adj) };
      case 'brightnessContrast': { const t = brightnessContrastTable(adj); return { kind: 'lut', r: t, g: t, b: t }; }
      case 'invert': { const t = Uint8Array.from({ length: N }, (_, i) => 255 - i); return { kind: 'lut', r: t, g: t, b: t }; }
      case 'threshold': return { kind: 'gray', y: thresholdTable(adj.level ?? 0.5) };
      default: return null;
    }
  }

  const IDENTITY = Uint8Array.from({ length: N }, (_, i) => i);

  // The stack as stages: consecutive per-channel tables fused into one (an
  // opacity mixes a table with the identity first: out = in + (t − in)·o,
  // rounded — per channel it is still a table), a gray stage kept with its
  // opacity. An empty list changes nothing.
  function compile(stack) {
    const stages = [];
    for (const adj of stack || []) {
      if (!adj?.enabled) continue;
      const o = Math.max(0, Math.min(1, adj.opacity ?? 1));
      if (o === 0) continue;
      const st = stageOf(adj);
      if (!st) continue;
      if (st.kind === 'lut') {
        const mixed = {};
        for (const ch of CHANNELS) mixed[ch] = o === 1 ? st[ch] : Uint8Array.from(st[ch], (v, i) => Math.floor(i + (v - i) * o + 0.5));
        const prev = stages[stages.length - 1];
        if (prev?.kind === 'lut') for (const ch of CHANNELS) prev[ch] = Uint8Array.from(prev[ch], v => mixed[ch][v]);
        else stages.push({ kind: 'lut', ...mixed });
      } else stages.push({ kind: 'gray', y: st.y, opacity: o });
    }
    return stages.filter(s => !(s.kind === 'lut' && CHANNELS.every(ch => s[ch].every((v, i) => v === i))));
  }
  const isIdentity = stages => !stages.length;

  // The tables of a fused stack that is only per-channel (what a plain
  // feComponentTransfer can show), else null.
  function tables(stages) {
    if (!stages.length) return { r: IDENTITY, g: IDENTITY, b: IDENTITY };
    return stages.length === 1 && stages[0].kind === 'lut' ? { r: stages[0].r, g: stages[0].g, b: stages[0].b } : null;
  }

  // The tableValues attribute of an feFunc: the 8-bit outputs as fractions.
  const tableValues = t => Array.from(t, v => +(v / 255).toFixed(6)).join(' ');

  // Rec. 601 intensity of 8-bit RGB as a level: Affinity's float32 sum, truncated.
  const K = f32(0.003921569);
  const luma = (r, g, b) => clamp8(trunc(f32(f32(f32(f32(r * K) * f32(0.299)) + f32(f32(g * K) * f32(0.587)) + f32(f32(b * K) * f32(0.114))) * 255)));

  // Apply the stages to a raster's samples: 1 component (gray), 3 (RGB) or 4
  // (RGBA, alpha kept). A gray raster is three equal channels.
  function applyToSamples(samples, components, stages) {
    const out = new Uint8Array(samples.length);
    const n = samples.length / components;
    for (let p = 0; p < n; p++) {
      const at = p * components;
      let r, g, b;
      if (components === 1) r = g = b = samples[at];
      else { r = samples[at]; g = samples[at + 1]; b = samples[at + 2]; }
      for (const s of stages) {
        if (s.kind === 'lut') { r = s.r[r]; g = s.g[g]; b = s.b[b]; continue; }
        const y = s.y[luma(r, g, b)];
        if (s.opacity >= 1) { r = g = b = y; continue; }
        r = Math.floor(r + (y - r) * s.opacity + 0.5);
        g = Math.floor(g + (y - g) * s.opacity + 0.5);
        b = Math.floor(b + (y - b) * s.opacity + 0.5);
      }
      if (components === 1) { out[at] = luma(r, g, b); continue; }
      out[at] = r; out[at + 1] = g; out[at + 2] = b;
      for (let k = 3; k < components; k++) out[at + k] = samples[at + k];
    }
    return out;
  }

  // A raster's histogram per channel (256 counts each) and of its intensity.
  function histogram(samples, components) {
    const h = { r: new Uint32Array(N), g: new Uint32Array(N), b: new Uint32Array(N), l: new Uint32Array(N) };
    if (components === 1) {
      for (let i = 0; i < samples.length; i++) { const v = samples[i]; h.r[v]++; h.g[v]++; h.b[v]++; h.l[v]++; }
      return h;
    }
    for (let i = 0; i < samples.length; i += components) {
      const r = samples[i], g = samples[i + 1], b = samples[i + 2];
      h.r[r]++; h.g[g]++; h.b[b]++; h.l[luma(r, g, b)]++;
    }
    return h;
  }

  // ── presets ─────────────────────────────────────────────────────────────────

  // Affinity's own presets (the values its preset library ships: knots exactly as
  // stored, float32 included) and a few for reading scans.
  const curve = master => [{ ...create('curves'), master }];
  const PRESETS = [
    { group: 'Curves', key: 's-curve', label: 'S-Curve', stack: () => curve([[0, 0], [0.25, 0.2], [0.75, 0.8], [1, 1]]) },
    { group: 'Curves', key: 's-curve-stronger', label: 'S-Curve Stronger', stack: () => curve([[0, 0], [0.249609375, 0.15], [0.7501450892857143, 0.85], [1, 1]]) },
    { group: 'Curves', key: 'inverse-s', label: 'Inverse S-Curve', stack: () => curve([[0, 0], [0.25, 0.3], [0.75, 0.7], [1, 1]]) },
    { group: 'Curves', key: 'inverse-s-stronger', label: 'Inverse S-Curve Stronger', stack: () => curve([[0, 0], [0.25, 0.35], [0.75, 0.65], [1, 1]]) },
    { group: 'Curves', key: 'matte-black', label: 'Matte Black', stack: () => curve([[0, 0.1], [0.25, 0.25], [1, 1]]) },
    { group: 'Curves', key: 'matte-contrast', label: 'Matte Contrast', stack: () => curve([[0, 0.0995424], [0.17, 0.17], [0.3, 0.3], [0.75, 0.8], [1, 1]]) },
    { group: 'Curves', key: 'reduce-highlights', label: 'Reduce Highlights', stack: () => curve([[0, 0], [0.25, 0.25], [0.75, 0.75], [1, 0.85]]) },
    { group: 'Curves', key: 'punchy', label: 'Punchy', stack: () => curve([[0, 0], [0.07, 0.03], [0.15, 0.09], [0.25, 0.2], [0.36, 0.35], [0.47, 0.5], [0.58, 0.65], [0.75, 0.85], [1, 1]]) },
    { group: 'Brightness / Contrast', key: 'increase-contrast', label: 'Increase Contrast', stack: () => [{ ...create('brightnessContrast'), contrast: 0.25 }] },
    { group: 'Brightness / Contrast', key: 'lower-contrast', label: 'Lower Contrast', stack: () => [{ ...create('brightnessContrast'), contrast: -0.25 }] },
    { group: 'Brightness / Contrast', key: 'subtle-punch', label: 'Subtle Punch', stack: () => [{ ...create('brightnessContrast'), brightness: 0.1, contrast: 0.1 }] },
    { group: 'Brightness / Contrast', key: 'lighter', label: 'Lighter', stack: () => [{ ...create('brightnessContrast'), brightness: 0.25 }] },
    { group: 'Brightness / Contrast', key: 'darker', label: 'Darker', stack: () => [{ ...create('brightnessContrast'), brightness: -0.25 }] },
    { group: 'Levels', key: 'darken', label: 'Darken', stack: () => [{ ...create('levels'), master: { ...LEVELS(), black: 0.2018 } }] },
    { group: 'Levels', key: 'lighten', label: 'Lighten', stack: () => [{ ...create('levels'), master: { ...LEVELS(), white: 0.798991 } }] },
    { group: 'Levels', key: 'raise-black', label: 'Raise Black Level', stack: () => [{ ...create('levels'), master: { ...LEVELS(), outBlack: 0.1 } }] },
    { group: 'Levels', key: 'lower-white', label: 'Lower White Level', stack: () => [{ ...create('levels'), master: { ...LEVELS(), outWhite: 0.9 } }] },
    { group: 'Levels', key: 'increase-gamma', label: 'Increase Gamma', stack: () => [{ ...create('levels'), master: { ...LEVELS(), gamma: 2 } }] },
    { group: 'Levels', key: 'decrease-gamma', label: 'Decrease Gamma', stack: () => [{ ...create('levels'), master: { ...LEVELS(), gamma: 0.5 } }] },
    { group: 'Invert / Threshold', key: 'invert', label: 'Invert', stack: () => [create('invert')] },
    { group: 'Invert / Threshold', key: 'threshold', label: 'Threshold 50 %', stack: () => [create('threshold')] },
    { group: 'Invert / Threshold', key: 'favour-light', label: 'Threshold: Favour Light', stack: () => [{ ...create('threshold'), level: 0.25 }] },
    { group: 'Invert / Threshold', key: 'favour-dark', label: 'Threshold: Favour Dark', stack: () => [{ ...create('threshold'), level: 0.75 }] },
    { group: 'For scans', key: 'negative-contrast', label: 'Negative with more contrast', stack: () => [create('invert'), ...curve([[0, 0], [0.249609375, 0.15], [0.7501450892857143, 0.85], [1, 1]])] },
    { group: 'For scans', key: 'clean-scan', label: 'Clean scan (paper white, ink black)', stack: () => [{ ...create('levels'), master: { ...LEVELS(), black: 0.25, white: 0.85 } }] },
    { group: 'For scans', key: 'reveal-shadows', label: 'Reveal shadows (stretch the darkest tones)', stack: () => [{ ...create('levels'), master: { ...LEVELS(), white: 0.15 } }] },
    { group: 'For scans', key: 'reveal-highlights', label: 'Reveal highlights (stretch the lightest tones)', stack: () => [{ ...create('levels'), master: { ...LEVELS(), black: 0.85 } }] },
  ];

  globalThis.AdjustCore = {
    N, CHANNELS, sortPoints, spline, secondDerivatives, isIdentityCurve, create,
    curvesTables, levelsFn, levelsTables, bcExponents, brightnessContrastTable, thresholdTable, stageOf,
    get rounding() { return rounding; }, set rounding(v) { rounding = v === 'cpu' ? 'cpu' : 'gpu'; },
    compile, isIdentity, tables, tableValues, luma, applyToSamples, histogram, PRESETS,
  };
})();
