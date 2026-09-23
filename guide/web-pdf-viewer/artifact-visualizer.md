# Artifact Visualizer — Documentation

`web/plugins/webgl_mask/mask-core.js` · `web/plugins/webgl_mask/mask-worker.js`

---

## Overview

The artifact visualizer detects the solid black regions (redaction bars) of a scanned page
and builds a grayscale mask that the WebGL overlay uses to lift those regions and to
un-blend their anti-aliased borders. It is part of the `webgl_mask` plugin and runs
entirely in the browser, off the main thread.

**Pipeline summary:**

```
Doc.pagePixels(n, { gray: true })        ← core document service: the page raster as gray samples
  └─ webgl-mask.js  buildPageMask()      ← only when raster.source === 'embedded' (the page's scan)
       └─ mask-worker.js                 ← the plugin's own worker; the gray buffer is transferred
            └─ MaskCore.buildMask(gray, width, height)      ← mask-core.js
                 ├─ regions:       black pixels → disc rule → 5×5 open → component filter
                 └─ transmission:  the outline's sides → rim levels per piece → t per pixel
            └─ mask → lossless PNG Blob (or null: no redaction on this page)
       └─ cached per page, loaded as the uMask texture
```

`mask-core.js` is pure loops with no DOM in it: the worker runs it in the browser, and
`tests/masks.test.mjs` loads the very same file under Node and holds its regions to the
recorded reference masks pixel for pixel, its edges to pages built with known rims and ink.

---

## Constants

| Name | Value | Purpose |
|------|-------|---------|
| black threshold | `gray <= 0` | Only pure black counts |
| opening kernel | 5 × 5 | Removes text strokes touching a bar |
| minimum box | 17 px wide, 10 px tall | Bounding box of a kept component |
| thinness | `area / perimeter >= 2` | Drops long thin strokes that survive the size test |
| disc rule | box square within 2 px, 16–44 px across, fill 0.70–0.85 | Drops punched holes and bullet discs |

The mask is built at the raster's native resolution — the same pixels the viewer shows, so
the overlay needs no scaling.

---

## `MaskCore.buildMask(gray, width, height)`

**Input:** one byte per pixel, row-major (`Uint8Array`), and the raster's size
**Output:** a `Uint8Array` mask of the same size, or `null` when the page has no redaction

### What counts as a redaction region

A pixel must be **exactly** `0` (pure black) in the gray raster. No tolerance: scanned text
is dark gray, a redaction bar drawn by software is `0`, and that difference is what keeps
text out of the mask. The surviving component's bounding box must be at least **17 px
wide** and **10 px tall**.

### Detection algorithm

**Step 1 — Black pixel image**

```js
black[p] = gray[p] <= 0 ? 1 : 0;
```

**Step 2 — The disc rule (`removeDiscs`)**

The black image is labelled into 8-connected components. A component is a disc — a punched
hole, a bullet — when its bounding box is square within 2 px, 16 to 44 px across, and the
component fills between 70 % and 85 % of the box (a circle fills π/4 ≈ 78.5 % of its
square; a rectangle fills 100 %). Discs are removed before anything else.

**Step 3 — 5×5 opening (`open5`)**

Erode, then dilate, with a 5×5 square — done as four 5-wide passes (erode along x, erode
along y, dilate along x, dilate along y). Positions outside the image do not take part, so
a bar touching the page edge is not eaten from that side. The opening removes everything
thinner than 5 px: letter strokes and descenders that touch a bar, thin rules, specks.

**Step 4 — External components (`filterComponents`)**

The opened image is labelled again (8-connected). Only **external** components are
considered — those not enclosed by another component. The test floods the background from
the image frame (4-connected); a component is external when it touches the frame or any of
its pixels has a 4-neighbour in that flooded background. A black shape sitting inside the
hole of another is skipped; when the outer shape is kept, its fill (step 6) covers it.

**Step 5 — Size and thinness**

- Bounding box narrower than 17 px or shorter than 10 px → dropped.
- `area / perimeter < 2` → dropped. For a thin shape that ratio is about half its
  thickness; for a solid block it is far larger. Area and perimeter are measured on the
  component's **outer border**, followed pixel by pixel from the component's first pixel in
  raster order (Suzuki's border following — `outerBorder`): the area is the shoelace sum
  over the border pixels, the perimeter the sum of the segment lengths between the border's
  corner points, in float32. This writes out what OpenCV's `findContours` /
  `contourArea` / `arcLength` compute, so the reference masks are met exactly.

**Step 6 — Regions, not filled**

A kept component is written into the region map as it is — its own pixels and nothing it
encloses. Where the bars of adjacent lines touch they are one component, and the white
gaps between them, with the punctuation standing there, stay page.

If no component survives, `regions` and `buildMask` return `null` and the page gets no overlay.

---

## Mask Construction

### Interior

```js
mask[p] = B[p] ? 255 : …
```

Every pixel of a region is 255 (fully redacted).

### The rims — `transmission(gray, w, h, B)`

A redaction bar is drawn with a soft rim: up to three pixel rows and columns outside it,
all the way round and through the corners, are the page showing through the box —
`page × t`, with `t` constant along one side of one box. Boxes overlap into one region,
and where their rims cross the `t` multiply. `transmission` reads those `t` off the page:

```
sides    the region's outline, cut into its straight stretches (sidesOf)
lines    rows 1..3 outward of a side
level    of a line: its brightest pixel, vouched for by a second one
pieces   of a side: the plateaus of its first line — two boxes can end in one pixel column
corners  where a horizontal side ends and the region stops: t = 1 − (1 − tx)(1 − ty)
t        per pixel: the product of every line and corner block on it
```

**Why the brightest pixel?**
The strip beside a bar holds a mix of paper and letter strokes, all darkened by the same
rim. The brightest pixel of a line is taken to be paper — white before the bar was drawn —
so `brightest / 255` is that rim's `t`. One value per line keeps the correction uniform:
dark strokes crossing the rim stay proportionally dark instead of being flattened to white.

**Why pieces, and why so guarded?**
A straight side can carry two rims (the bars of two text lines, ending in the same pixel
column with different sub-pixel positions), so one brightest pixel per side would leave
the darker rim behind as a line. But a plateau on the first rim line can also be text: the
bar of a T under the rim, a stem standing against the box — and under a dark rim any text
flattens into plateaus. A darker plateau is therefore a box's only when it reaches an end
of the side (a corner of the outline) or is longer than any stroke, and only when its
next line outward is lighter, as a rim's is. A level that no second pixel vouches for is
no level, and one pixel is never evidence. The full rule set and what it costs and buys:
[frontend/webgl-mask.md](../frontend/webgl-mask.md#edges--maskcoretransmission).

```js
mask[p] = T[p] === 0 ? 255 : Math.min(254, 255 - Math.round(255 * T[p]));
```

`T = 0` marks the few rim pixels declared paper outright (under rims that hide 7/8 of the
page: where two stacked boxes overlap, the step between two pieces, the ringing pixel at a
convex corner) — `0 / t` would stay black, so they are shown white like the region.

### Mask value semantics

| Value | Meaning | In the shader (`mask = value / 255`) |
|-------|---------|--------------------------------------|
| `0` | Clear page | `page / 1` — unchanged |
| `1–254` | A rim: `255 · (1 − t)` of that pixel | `min(page / (1 − mask), 1)` — the blend is inverted — mixed with the page by `uStrength` |
| `255` | Redacted interior | white, mixed with the page by `uStrength`; the content under a bar is not recoverable |

---

## The worker — `mask-worker.js`

`webgl-mask.js` creates one worker on first use and sends it the content-hashed URL of
`mask-core.js` (`{ type: 'init', core }`), which the worker loads with `importScripts`.
Then, per page:

```
→ { id, gray: Uint8Array, width, height }      the gray buffer is transferred, not copied
← { id, png: Blob | null, ms }                  null = no redaction on the page
← { id, error }                                 logged as "webgl_mask: mask failed"
```

The mask goes back as a lossless PNG blob because that is what the overlay loads into its
texture. The worker paints gray `v` as `(v, v, v, 255)` onto an `OffscreenCanvas` and
calls `convertToBlob` — alpha stays 255, so nothing is premultiplied away and the texture's
red channel is the mask.

Masks are requested lazily, when a page's overlay initializes, and the answer — a blob, or
`null` — is kept in `maskBlobCache` for the rest of the document's lifetime. The cache is
validated against `state.docHash` on every use, so a new document never sees an old mask.

---

## WebGL Integration

The mask PNG is loaded as a `LUMINANCE` texture (`NEAREST` filtering) beside the page image
(`RGBA`, `LINEAR`) in `web/plugins/webgl_mask/webgl-mask.js`.

Fragment shader:
```glsl
vec3 page = texture2D(uPage, vTexCoord).rgb;
float mask = texture2D(uMask, vTexCoord).r;
vec3 result;
if (mask > 0.999) {
  result = vec3(1.0);                           // interior: nothing to recover, show white
} else {
  result = min(page / max(1.0 - mask, 0.001), 1.0);  // border or clear pixel: invert the blend, per channel
}
result = mix(page, result, uStrength);   // Reveal Strength: a linear fade from the page as it is to the page revealed
gl_FragColor = vec4(result, 1.0);
```

The overlay canvas draws the whole page itself (opaque, blending disabled,
`mix-blend-mode: normal`), so the page stays in colour. `uStrength` is driven by the
**Reveal Strength** slider (`#edge-subtract`, 0–255 → 0.0–1.0): at 0 the overlay equals the
page, at 255 the bars are white and their borders fully un-blended.

See [WebGL Mask: Implementation Overview](webgl-mask-implementation.md) for the overlay's
lifecycle.

---

## Running it outside the browser

```bash
node --test tests/masks.test.mjs
```

opens every reference PDF with MuPDF under Node, builds each page's mask with the same
`mask-core.js`, and compares it with the recorded mask in `tests/golden/` (SHA-256 of the
gray pixels). One page differs by design: a scan taller than 8.5 × 11 is cropped to the
page ratio by the core, and the mask is built from the cropped raster the viewer shows —
its mask equals the top rows of the recorded one.

---

## Known Constraints

- **Pure black only** — a gray value of `1` is not detected. This is intentional: it keeps
  dark text out of the mask. A redaction printed and re-scanned (then not pure black) is
  not found.
- **Minimum size** — regions under 17 × 10 px are ignored, and anything thinner than 5 px
  disappears in the opening.
- **Scanned pages only** — a mask is built only when the page raster is the page's
  embedded scan (`source: 'embedded'`). A born-digital page, shown as a 96-dpi render, gets
  none, and neither does an image document (PNG, JPEG, …), for which `Doc.pagePixels`
  returns `null`.
- **The disc rule is a shape test**, not a circle fit: a square-ish black blob of 16–44 px
  that happens to fill about π/4 of its box is dropped as a disc.
