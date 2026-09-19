// mask-core.js — the redaction mask of one page raster.
//
// The port of the server's webgl_mask/logic/masking.py (build_mask_array):
// given the page's gray pixels it returns a gray mask — 255 inside a blacked-out
// region, 0 where the page is clear, and on the two pixel rings around each
// region a mid-gray that carries the paper's brightness along that edge (what
// the shader un-blends the anti-aliased border with) — or null when the page
// has no such region.
//
//   MaskCore.buildMask(gray: Uint8Array, width, height) → Uint8Array | null
//   MaskCore.grayOf(rgba)                               → Uint8Array   gray of a decoded image document
//
// Pure loops, no DOM: mask-worker.js runs it off the main thread, and
// tests/masks.test.mjs holds it to the recorded server masks pixel for pixel.
// Where the server used OpenCV the same arithmetic is written out:
//   MORPH_OPEN 5×5            erode then dilate, the outside never eroding
//   findContours EXTERNAL     8-connected components that no other encloses,
//                             their outer border followed as Suzuki's does
//   contourArea / arcLength   shoelace over the border, float32 segment lengths
// One rule is dropped: the server drew each contour FILLED, so whatever a
// region enclosed became mask too — where the bars of adjacent lines touch,
// the white gaps between them and the punctuation standing there. The mask is
// the black component itself; nothing is filled (no corpus page has such a
// gap, so the goldens hold).
// And one rule is replaced: the server ran a Hough circle transform to drop
// punched holes and bullet discs (radius 8–20 px). Here a black component is a
// disc when its bounding box is square and it fills π/4 of it — no OpenCV, and
// the goldens agree (the transform finds no circle on any corpus page).
(function () {
  const FROUND = Math.fround;

  // 8-connected components of a 0/1 image: labels (1..n, 0 = background) and,
  // per label, the bounding box, pixel count and first pixel in raster order.
  function labelComponents(bin, w, h) {
    const labels = new Int32Array(w * h);
    const comps = [null];
    const stack = [];
    for (let start = 0; start < w * h; start++) {
      if (!bin[start] || labels[start]) continue;
      const id = comps.length;
      const c = { id, x0: w, y0: h, x1: -1, y1: -1, count: 0, first: start };
      labels[start] = id;
      stack.push(start);
      while (stack.length) {
        const p = stack.pop(), x = p % w, y = (p - x) / w;
        c.count++;
        if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x;
        if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            const q = ny * w + nx;
            if (bin[q] && !labels[q]) { labels[q] = id; stack.push(q); }
          }
        }
      }
      comps.push(c);
    }
    return { labels, comps };
  }

  // The disc rule (in place of HoughCircles, radius 8..20): a component whose
  // box is square within 2 px, 16..44 px across, and filled to about π/4.
  function removeDiscs(black, w, h) {
    const { labels, comps } = labelComponents(black, w, h);
    const drop = new Uint8Array(comps.length);
    let any = false;
    for (let id = 1; id < comps.length; id++) {
      const c = comps[id], bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
      if (Math.abs(bw - bh) > 2 || Math.max(bw, bh) < 16 || Math.max(bw, bh) > 44) continue;
      const fill = c.count / (bw * bh);
      if (fill > 0.70 && fill < 0.85) { drop[id] = 1; any = true; }
    }
    if (any) for (let p = 0; p < w * h; p++) if (drop[labels[p]]) black[p] = 0;
    return black;
  }

  // One pass of a 5-wide min (erode) or max (dilate) along x or y; positions
  // outside the image do not take part — OpenCV's default border for both.
  function pass5(src, w, h, horizontal, erode) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let v = erode ? 1 : 0;
        for (let k = -2; k <= 2; k++) {
          const xx = horizontal ? x + k : x, yy = horizontal ? y : y + k;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          const s = src[yy * w + xx];
          if (erode ? !s : s) { v = erode ? 0 : 1; break; }
        }
        out[y * w + x] = v;
      }
    return out;
  }
  const open5 = (bin, w, h) => pass5(pass5(pass5(pass5(bin, w, h, true, true), w, h, false, true), w, h, true, false), w, h, false, false);

  // Suzuki's border following around one component's outer border, starting at
  // its first pixel in raster order (whose west neighbour is background).
  // Returns the border pixels in order, as [x, y, x, y, …].
  const RING = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];   // clockwise from west (y grows downward)
  function outerBorder(labels, w, h, id, first) {
    const sx = first % w, sy = (first - sx) / w;
    const inside = (x, y) => x >= 0 && x < w && y >= 0 && y < h && labels[y * w + x] === id;
    const dirOf = (dx, dy) => RING.findIndex(d => d[0] === dx && d[1] === dy);

    // 3.1 — from the west neighbour, clockwise, the first pixel of the component
    let d1 = -1;
    for (let k = 0; k < 8; k++) if (inside(sx + RING[k][0], sy + RING[k][1])) { d1 = k; break; }
    const points = [sx, sy];
    if (d1 < 0) return points;                                    // a single pixel
    const x1 = sx + RING[d1][0], y1 = sy + RING[d1][1];

    let px = x1, py = y1;            // (i2, j2): where the search starts from
    let cx = sx, cy = sy;            // (i3, j3): the current border pixel
    for (let guard = 0; guard < 4 * w * h; guard++) {
      // 3.3 — counterclockwise from the pixel after (i2, j2)
      const from = dirOf(px - cx, py - cy);
      let nx = cx, ny = cy;
      for (let k = 1; k <= 8; k++) {
        const d = RING[(from - k + 16) % 8];
        if (inside(cx + d[0], cy + d[1])) { nx = cx + d[0]; ny = cy + d[1]; break; }
      }
      // 3.5 — back at the start, about to repeat the first step: the border is closed
      if (nx === sx && ny === sy && cx === x1 && cy === y1) break;
      px = cx; py = cy; cx = nx; cy = ny;
      points.push(cx, cy);
    }
    return points;                                                // ends on (i1, j1); the start is not repeated
  }

  // cv2.contourArea over the border pixels, and cv2.arcLength(closed) over the
  // CHAIN_APPROX_SIMPLE form of it (corners only, float32 segment lengths).
  function areaAndPerimeter(points) {
    const n = points.length / 2;
    let twice = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      twice += points[2 * i] * points[2 * j + 1] - points[2 * i + 1] * points[2 * j];
    }
    const corners = [];
    for (let i = 0; i < n; i++) {
      const p = (i - 1 + n) % n, q = (i + 1) % n;
      const inX = points[2 * i] - points[2 * p], inY = points[2 * i + 1] - points[2 * p + 1];
      const outX = points[2 * q] - points[2 * i], outY = points[2 * q + 1] - points[2 * i + 1];
      if (inX !== outX || inY !== outY) corners.push(points[2 * i], points[2 * i + 1]);
    }
    const m = corners.length / 2;
    let perimeter = 0;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const dx = FROUND(corners[2 * j] - corners[2 * i]), dy = FROUND(corners[2 * j + 1] - corners[2 * i + 1]);
      perimeter += FROUND(Math.sqrt(FROUND(dx * dx + dy * dy)));
    }
    return { area: Math.abs(twice) / 2, perimeter };
  }

  // _filter_components: open away thin text protrusions, keep the solid blocks.
  function filterComponents(black, w, h) {
    const opened = open5(black, w, h);
    const { labels, comps } = labelComponents(opened, w, h);
    const result = new Uint8Array(w * h);
    if (comps.length === 1) return result;

    // The background that reaches the image frame (4-connected): a component
    // touching it — or the frame itself — is external; one inside another's hole is not.
    const outside = new Uint8Array(w * h);
    const stack = [];
    const seed = p => { if (!opened[p] && !outside[p]) { outside[p] = 1; stack.push(p); } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p - x) / w;
      if (x > 0) seed(p - 1); if (x < w - 1) seed(p + 1);
      if (y > 0) seed(p - w); if (y < h - 1) seed(p + w);
    }
    const external = new Uint8Array(comps.length);
    for (let p = 0; p < w * h; p++) {
      const id = labels[p];
      if (!id || external[id]) continue;
      const x = p % w, y = (p - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1
          || outside[p - 1] || outside[p + 1] || outside[p - w] || outside[p + w]) external[id] = 1;
    }

    const keep = new Uint8Array(comps.length);
    for (let id = 1; id < comps.length; id++) {
      const c = comps[id];
      if (!external[id]) continue;
      if (c.x1 - c.x0 + 1 < 17 || c.y1 - c.y0 + 1 < 10) continue;
      // Thin strokes go: area / perimeter ≈ thickness / 2 for a thin shape,
      // far more for a solid block.
      const { area, perimeter } = areaAndPerimeter(outerBorder(labels, w, h, id, c.first));
      if (perimeter > 0 && area / perimeter < 2) continue;
      keep[id] = 1;
    }
    // The component's own pixels and nothing else: what it encloses is page —
    // the gap between two bars of touching lines, with its punctuation.
    for (let p = 0; p < w * h; p++) if (keep[labels[p]]) result[p] = 1;
    return result;
  }

  // _dilate: one pixel in the four directions, no wrap-around.
  function dilate4(m, w, h) {
    const d = Uint8Array.from(m);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (m[p]) continue;
        if ((y > 0 && m[p - w]) || (y < h - 1 && m[p + w]) || (x > 0 && m[p - 1]) || (x < w - 1 && m[p + 1])) d[p] = 1;
      }
    return d;
  }

  function buildMask(gray, w, h) {
    let black = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) black[p] = gray[p] <= 0 ? 1 : 0;
    black = filterComponents(removeDiscs(black, w, h), w, h);
    if (!black.includes(1)) return null;

    const outer1 = dilate4(black, w, h);
    const outer2 = dilate4(outer1, w, h);
    const mask = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) if (black[p]) mask[p] = 255;

    // _apply_edge_lines. A ring pixel is "horizontal" when the region lies
    // above or below it (rows wrap, as numpy's roll does), else "vertical";
    // each run of ring pixels takes 255 − the brightest page pixel along it.
    const above = (img, p) => img[(p - w + w * h) % (w * h)], below = (img, p) => img[(p + w) % (w * h)];
    const ring1 = new Uint8Array(w * h), ring2 = new Uint8Array(w * h);   // 0 = not on the ring, 1 = horizontal, 2 = vertical
    for (let p = 0; p < w * h; p++) {
      if (outer1[p] && !black[p]) ring1[p] = (above(black, p) || below(black, p)) ? 1 : 2;
      else if (outer2[p] && !outer1[p]) ring2[p] = (above(outer1, p) || below(outer1, p)) ? 1 : 2;
    }
    for (const ring of [ring1, ring2])
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w;) {
          if (ring[y * w + x] !== 1) { x++; continue; }
          let end = x, max = 0;
          while (end < w && ring[y * w + end] === 1) { if (gray[y * w + end] > max) max = gray[y * w + end]; end++; }
          for (let k = x; k < end; k++) mask[y * w + k] = 255 - max;
          x = end;
        }
    for (const ring of [ring1, ring2])
      for (let x = 0; x < w; x++)
        for (let y = 0; y < h;) {
          if (ring[y * w + x] !== 2) { y++; continue; }
          let end = y, max = 0;
          while (end < h && ring[end * w + x] === 2) { if (gray[end * w + x] > max) max = gray[end * w + x]; end++; }
          for (let k = y; k < end; k++) mask[k * w + x] = 255 - max;
          y = end;
        }
    return mask;
  }

  // Opaque RGBA → gray, for a page that arrives as an image instead of MuPDF's
  // gray samples. Integer weights that sum to 256: black stays 0, white 255.
  function grayOf(rgba) {
    const gray = new Uint8Array(rgba.length / 4);
    for (let p = 0, j = 0; p < gray.length; p++, j += 4) gray[p] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    return gray;
  }

  globalThis.MaskCore = { buildMask, grayOf, labelComponents, filterComponents, removeDiscs };
})();
