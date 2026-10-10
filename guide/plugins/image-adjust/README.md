# image_adjust — Affinity's adjustments of the page view

`web/plugins/image_adjust/` shows a document's pages through Affinity-style adjustment
layers: **Invert**, **Curves**, **Levels**, **Brightness / Contrast** and **Threshold**, each
computed as Affinity 3 computes it for an 8-bit RGB document. It is for reading scans —
invert them, raise their contrast, stretch the darkest tones to see what a poor redaction
left. **The document is never changed**: `Doc`, the other plugins and their analyses keep
reading the page's own pixels.

## Using it

- **Tool column: Adjustments** (`#ia-toggle`, a dot on it while something is applied) opens
  the ribbon bar `#ia-options-bar`:
  - **Invert** (`#ia-invert`, also **Ctrl+I** outside text), **Contrast** and **Brightness**
    sliders (−100…100 %, double-click resets) — each one adjustment of the stack that the ribbon
    keeps for itself;
  - **Presets** (`#ia-preset`) — Affinity's own (Curves: S-Curve, S-Curve Stronger, Inverse
    S-Curve(s), Matte Black, Matte Contrast, Reduce Highlights, Punchy; Brightness / Contrast:
    Increase / Lower Contrast, Subtle Punch, Lighter, Darker; Levels: Darken, Lighten, Raise
    Black Level, Lower White Level, Increase / Decrease Gamma; Invert; Threshold, Favour Light,
    Favour Dark) and some for scans (negative with more contrast, clean scan, reveal shadows,
    reveal highlights). A preset replaces the stack;
  - **Curves…** (`#ia-open-panel`) opens the panel; **Bypass** (`#ia-bypass`) shows the page
    without the adjustments; **Reset** (`#ia-reset`) removes them all.
- **The Adjustments panel** (`#ia-panel`, floating — drag it by its title):
  - the **stack** (`#ia-stack`), applied top to bottom like adjustment layers over the page —
    on/off, order, remove; **Add adjustment…** (`#ia-add`);
  - the **editor** (`#ia-editor`) of the selected adjustment, with its **Opacity**:
    - **Curves** — Channel (Master / Red / Green / Blue), **Linear**, the graph over the page's
      histogram (click to add a point, drag to move, drag off the graph or Delete to remove,
      arrow keys nudge), **X: / Y:**, **Min: / Max:** (the input range), the pickers **Add
      Point** (press on the page, drag up or down), **Set Black Point** (press on the ink),
      **Set White Point** (press on the paper), **Set Grey Point**, **Reset**;
    - **Levels** — Channel, Black Level, White Level, Gamma, Output Black / White Level;
    - **Brightness / Contrast** — both sliders and **Linear**;
    - **Threshold** — the level;
  - **Rounding** (`#ia-rounding`): Affinity's screen rendering (GPU, rounds half up) or its CPU
    rendering (truncates) — at most one level apart;
  - **Export page as PNG** (`#ia-export`): the page's own pixels through the very same stages.

The stack and the rounding are kept in this browser (`localStorage`, `recto.imageAdjust`) and
apply to every document until reset.

## How it computes

All on the stored (gamma-encoded) 8-bit values, as Affinity's RGB adjustments do; alpha is
never touched.

- **Curves** — a natural cubic spline through the points (second derivative 0 at both ends),
  flat beyond the first and last point, the identity outside 0…1; piecewise linear with two
  points or "Linear". Not clamped until the end, so an overshoot shows. Each channel's curve
  first, then Master: `out = (max − min)·Master(C((v − min)/(max − min))) + min`. A curve that
  is the identity everywhere does nothing.
- **Invert** — `255 − v`.
- **Levels** — each channel's levels, then Master's: `x = (v − black)·(outW − outB)/(white −
  black)`, then where `x` is in range `x = (outW − outB)·(x/(outW − outB))^gamma`, then `+ outB`,
  clamped. **Gamma is the exponent itself**: above 1 darkens the midtones (Affinity's "Increase
  Gamma" stores 2).
- **Brightness / Contrast** — brightness `B` −1…1, contrast `C = 1 + %/100` (0…2). Exponents
  `pB = 2/(1 − 0.6|B|) − 1` (inverted for `B < 0`) and `pC = |C − 1| + 1` (inverted for `C < 1`).
  Normal: `t = 1 − (1 − v)^pB`, then the power S-curve about mid grey 128 —
  `128·(t/128)^pC` below, `255 − 128·((255 − t)/128)^pC` above. Linear:
  `(v − 128)·C + 128 + 255·B`.
- **Threshold** — the Rec. 601 intensity `0.299 R + 0.587 G + 0.114 B` (float32, truncated to a
  level); black at or below the threshold, white above.
- **A stack** — each adjustment acts on the 8-bit result of the ones above it (Affinity's 8-bit
  pipeline re-quantises after every layer), mixed with its input by its opacity. Runs of
  per-channel adjustments fuse into one 256-entry table per channel; Threshold is a stage of its
  own.

On screen the stages are an SVG filter (`#ia-filter`, `color-interpolation-filters="sRGB"`):
a run of tables is one `feComponentTransfer` (`type="table"`, 256 values — an 8-bit input
`i/255` lands exactly on entry `i`), Threshold an `feColorMatrix` for the intensity and a
table, an opacity an `feComposite`. It applies to `.page-container > img` and, when
`webgl_mask` is installed and on, to its `.webgl-overlay` canvas; text boxes, rulers and other
overlays are not adjusted. `adjust-core.js` (`AdjustCore`, no DOM) computes the stages and
applies them to samples (`applyToSamples`) — what the tests and the export use.

On screen the browser applies the tables after it has scaled the page; at 100 % zoom and for
the export every sample is the table's.

## Files and tests

| File | |
|---|---|
| `plugin.json` | order 25; `toolbar_button.html`, `options_bar.html`, `panel.html` (sidebar slot), `styles.css`; scripts `adjust-core.js`, `image-adjust.js` |
| `adjust-core.js` | `AdjustCore`: `spline`, `secondDerivatives`, `create`, `curvesTables`, `levelsFn`, `brightnessContrastTable`, `thresholdTable`, `compile`, `applyToSamples`, `histogram`, `tableValues`, `PRESETS`, `rounding` |
| `image-adjust.js` | the filter, the ribbon, the panel, the pickers, the export; `window.imageAdjust` (`stack`, `set(stack)`, `stages()`) |

`tests/plugins/image_adjust/adjust-core.test.mjs` holds the numbers to Affinity's (the second
derivatives its presets store, its preset knots, its kernels' formulas);
`page.test.mjs` checks the controls and that the filter reaches only the page view. Both skip
when the plugin is not installed.

## Dependencies

None. It reads pixels through `Doc.pagePixels` (an image document's through
`Doc.pageImageURL`), styles `webgl_mask`'s overlay by its class when it is there, and names no
other plugin. Drag the folder out and nothing of it remains.
