// mask-core.js — the redaction mask of one page raster.
//
// Two halves. DETECTION (regions) finds the blacked-out regions of the page's
// gray pixels. The EDGES (transmission): every box is drawn with a soft rim
// through which the page shows, and transmission() reads off the page how much
// of it each rim pixel lets through. The mask is 255 inside a region, 0 where
// the page is clear, and 255 · (1 − t) on the rims, which the shader divides
// out again — so that text under a rim comes back with the paper. null when
// the page has no region.
//
//   MaskCore.buildMask(gray: Uint8Array, width, height) → Uint8Array | null
//   MaskCore.regions(gray, width, height)               → Uint8Array | null   1 inside a region
//   MaskCore.transmission(gray, width, height, regions) → Float32Array        t per pixel
//   MaskCore.grayOf(rgba)                               → Uint8Array          gray of a decoded image document
//
// Pure loops, no DOM: mask-worker.js runs it off the main thread, and
// tests/masks.test.mjs holds the regions to the recorded reference masks pixel
// for pixel and the edges to pages built with known rims and known ink.
// The morphology and the contour measures are written out with OpenCV's
// arithmetic (the reference masks were computed with it):
//   MORPH_OPEN 5×5            erode then dilate, the outside never eroding
//   findContours EXTERNAL     8-connected components that no other encloses,
//                             their outer border followed as Suzuki's does
//   contourArea / arcLength   shoelace over the border, float32 segment lengths
// Regions are not filled: whatever a component encloses stays page — where the
// bars of adjacent lines touch, the white gaps between them and the punctuation
// standing there. The mask is the black component itself. (The reference masks
// were filled; no corpus page has such a gap, so they agree.)
// Discs — punched holes and bullet discs — are dropped by shape: a black
// component whose bounding box is square, 16–44 px across, and filled to about
// π/4 of it. (A Hough circle transform finds no circle on any corpus page, so
// the reference masks agree here too.)
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

  // ── the edges ────────────────────────────────────────────────────────────
  // A redaction is a black rectangle drawn with a soft rim: up to DEPTH pixels
  // around it show the page through the box, page × t, with t constant along
  // one side of one box. Boxes overlap into one region, and their rims then
  // multiply. transmission() reads those t off the page, so that the shader's
  // page / t gives the page back — text under a rim included.
  //
  // The region's outline is cut into its straight SIDES. Outward of a side lie
  // its LINES (rows 1..DEPTH), and the level of a line — what white paper reads
  // under it — is its brightest pixel: text only ever darkens. One side can
  // belong to two boxes that end in the same pixel column, so a side is cut
  // into PIECES, the plateaus of its first line. Where the sides of one box
  // meet at a convex corner the two rims cover the corner block together;
  // where lines of different boxes cross, the levels multiply.
  //
  // Every rule errs toward text: a pixel darker than its line's level stays
  // that much darker, a level nothing vouches for is no level (the rim then
  // stays as it is), and what could be a stroke of text is never taken for an
  // edge. The exceptions are spelled out in paint() and hold only under a rim
  // that hides 7/8 of the page or more.
  const DEPTH = 3;
  const NO_EDGE = 253;      // a line this bright carries no rim
  const TOL = 2;            // gray levels the pixels of one plateau may differ by
  const RUN_MIN = 6;        // pixels that make a plateau …
  const RUN_LONG = 20;      // … and a plateau longer than any stroke of text
  const REACH = 5;          // a piece this near its side's end is anchored there, at a corner of the outline
  const DARK = 32;          // a level below this hides 7/8 of the page
  const DIP_MAX = 4;        // rows two stacked boxes overlap by, at most
  const SNAP = 4;           // gray levels that do not tell paper from paper
  const FACING = [[0, -1], [0, 1], [-1, 0], [1, 0]];               // top, bottom, left, right: the way out

  // The straight sides of a region map: { f: facing, c: the row (column) of its
  // region pixels, a..b: their extent along it, len }.
  function sidesOf(B, w, h) {
    const at = (x, y) => x >= 0 && x < w && y >= 0 && y < h && B[y * w + x] === 1;
    const sides = [];
    for (const f of [0, 1]) {
      const dy = FACING[f][1];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w;) {
          if (!at(x, y) || at(x, y + dy)) { x++; continue; }
          let e = x;
          while (at(e + 1, y) && !at(e + 1, y + dy)) e++;
          sides.push({ f, c: y, a: x, b: e, len: e - x + 1 });
          x = e + 1;
        }
    }
    for (const f of [2, 3]) {
      const dx = FACING[f][0];
      for (let x = 0; x < w; x++)
        for (let y = 0; y < h;) {
          if (!at(x, y) || at(x + dx, y)) { y++; continue; }
          let e = y;
          while (at(x, e + 1) && !at(x + dx, e + 1)) e++;
          sides.push({ f, c: x, a: y, b: e, len: e - y + 1 });
          y = e + 1;
        }
    }
    return sides;
  }

  // gray, and the region map B (1 inside) → Float32Array t per pixel, 1 where no rim lies.
  function transmission(gray, w, h, B) {
    const sides = sidesOf(B, w, h);
    const cover = new Uint8Array(w * h);                           // lines and corner blocks on a pixel
    const inB = (x, y) => x >= 0 && x < w && y >= 0 && y < h && B[y * w + x] === 1;

    // A side's lines as pixel indices, −1 behind the region or the frame;
    // line DEPTH + 1 is only ever looked at: the pixel beyond the rim.
    const { labels } = labelComponents(B, w, h), bounds = new Map();
    for (const s of sides) {
      s.px = [null];
      for (let d = 1; d <= DEPTH + 1; d++) s.px[d] = new Int32Array(s.len).fill(-1);
      for (let i = 0; i < s.len; i++)
        for (let d = 1; d <= DEPTH + 1; d++) {
          const x = s.f < 2 ? s.a + i : s.c + FACING[s.f][0] * d, y = s.f < 2 ? s.c + FACING[s.f][1] * d : s.a + i;
          if (x < 0 || y < 0 || x >= w || y >= h || B[y * w + x]) break;
          s.px[d][i] = y * w + x;
          if (d <= DEPTH) cover[y * w + x]++;
        }
      s.convex = [false, false];
      // per region, the rows of its horizontal sides and the columns of its vertical ones: where its boxes end
      s.region = s.f < 2 ? labels[s.c * w + s.a] : labels[s.a * w + s.c];
      if (!bounds.has(s.region)) bounds.set(s.region, [new Set(), new Set()]);
      if (s.len >= 3) bounds.get(s.region)[s.f < 2 ? 0 : 1].add(s.c);
    }
    const boxEndsNear = (s, i) => {
      const ends = bounds.get(s.region)[s.f < 2 ? 1 : 0];
      for (let k = -2; k <= 2; k++) if (ends.has(s.a + i + k)) return true;
      return false;
    };

    // Convex corners: a horizontal side ends where the region stops, and the
    // vertical side that starts there is the same box's.
    const vertical = new Map();
    for (const s of sides) if (s.f >= 2) { vertical.set(`${s.f}:${s.c}:${s.a}`, s); vertical.set(`${s.f}:${s.c}:${s.b}`, s); }
    const corners = [];
    for (const s of sides) {
      if (s.f >= 2) continue;
      for (const [x, f] of [[s.a, 2], [s.b, 3]]) {
        if (inB(x + FACING[f][0], s.c)) continue;                  // concave: the region goes on
        const v = vertical.get(`${f}:${x}:${s.c}`);
        if (!v) continue;
        const c = { hs: s, vs: v, hi: x - s.a, vi: s.c - v.a, px: [] };
        s.convex[x === s.a ? 0 : 1] = true;
        v.convex[s.c === v.a ? 0 : 1] = true;
        for (let dy = 1; dy <= DEPTH; dy++)
          for (let dx = 1; dx <= DEPTH; dx++) {
            const px = x + FACING[f][0] * dx, py = s.c + FACING[s.f][1] * dy;
            if (px < 0 || py < 0 || px >= w || py >= h || B[py * w + px]) continue;
            c.px.push({ p: py * w + px, dx, dy, t: -1 });
            cover[py * w + px]++;
          }
        corners.push(c);
      }
    }

    // ── pieces ──
    // Plateaus of the first line, read where nothing else reaches (cover 1):
    // runs of RUN_MIN pixels within TOL. Plateaus of one level are one piece,
    // whatever dips between them; its level is the value most of them hold.
    for (const s of sides) {
      const line = s.px[1], clean = k => line[k] >= 0 && cover[line[k]] === 1;
      let pieces = [];
      for (let i = 0; i < s.len;) {
        if (!clean(i)) { i++; continue; }
        let e = i, lo = gray[line[i]], hi = lo;
        while (e + 1 < s.len && clean(e + 1)) {
          const g = gray[line[e + 1]];
          if (Math.max(hi, g) - Math.min(lo, g) > TOL) break;
          lo = Math.min(lo, g); hi = Math.max(hi, g); e++;
        }
        if (e - i + 1 >= RUN_MIN) {
          let pc = pieces[pieces.length - 1];
          if (!pc || (Math.abs(pc.level - hi) > TOL && Math.abs(pc.level - lo) > TOL)) pieces.push(pc = { i0: i, i1: e, run: 0, hist: new Map(), level: 0 });
          pc.i1 = e;
          pc.run = Math.max(pc.run, e - i + 1);
          for (let k = i; k <= e; k++) pc.hist.set(gray[line[k]], (pc.hist.get(gray[line[k]]) || 0) + 1);
          let best = -1;
          for (const [g, n] of pc.hist) if (best < 0 || n > pc.hist.get(best) || (n === pc.hist.get(best) && g > best)) best = g;
          pc.level = best;
        }
        i = e + 1;
      }
      // A plateau darker than the side's brightest may be a flat stroke of
      // text under the rim. It is a box's when it reaches an end of the side
      // — a corner of the outline — or runs longer than any stroke; under a
      // dark rim text flattens into plateaus of its own, and only length
      // counts. And a rim gets lighter outward: a plateau whose next line is
      // darker still is a stroke standing against the box.
      if (pieces.length > 1) {
        const base = Math.max(...pieces.map(pc => pc.level));
        const lightens = pc => {
          let m = -1;
          for (let i = pc.i0; i <= pc.i1; i++) { const q = s.px[2][i]; if (q >= 0 && cover[q] === 1 && gray[q] > m) m = gray[q]; }
          return m < 0 || m >= pc.level - TOL;
        };
        const kept = [];
        for (const pc of pieces) {
          const anchored = pc.i0 <= REACH || pc.i1 >= s.len - 1 - REACH;
          if (pc.level < base - TOL && !(lightens(pc) && (pc.run >= RUN_LONG || (base >= DARK && anchored)))) continue;
          const last = kept[kept.length - 1];
          if (last && Math.abs(last.level - pc.level) <= TOL) { last.i1 = pc.i1; if (pc.run > last.run) { last.run = pc.run; last.level = pc.level; } }
          else kept.push(pc);
        }
        pieces = kept;
      }
      if (!pieces.length) pieces.push({ i0: 0, i1: s.len - 1, level: -1 });
      pieces[0].i0 = 0;                                            // the outer pieces reach the side's ends,
      pieces[pieces.length - 1].i1 = s.len - 1;                    // between two pieces lies a gap (see paint)
      for (const pc of pieces) pc.L = [0, pc.level, -1, -1];       // L[d]: the level of line d, −1 = not known yet
      s.pieces = pieces;
    }
    const pieceAt = (s, i) => { for (const pc of s.pieces) if (i <= pc.i1) return pc; return s.pieces[s.pieces.length - 1]; };

    // ── levels ──
    // The level of a line is its brightest pixel, when a second pixel vouches
    // for it (within 6 %). The two pixels at either end of a long side are
    // left out: a corner's transition, brighter than the line.
    const levelOf = values => {
      let m = -1, n = 0;
      for (const v of values) if (v > m) m = v;
      const near = Math.max(TOL, m * 0.06);
      for (const v of values) if (v >= m - near) n++;
      return n >= 2 ? m : -1;
    };
    const inner = (s, i) => s.len < 8 || (i >= 2 && i <= s.len - 3);
    const known = new Float32Array(w * h).fill(1);                 // what the settled levels take from each pixel
    const settle = (s, pc, d) => {
      const L = pc.L[d];
      // no rim: too bright, or black (nothing to divide by), or darker than the line before it, or beyond the rim's end
      if (L >= NO_EDGE || L < 1 || (d > 1 && (pc.L[d - 1] === 255 || L < pc.L[d - 1] - TOL))) { pc.L[d] = 255; return; }
      for (let i = pc.i0; i <= pc.i1; i++) if (s.px[d][i] >= 0) known[s.px[d][i]] *= L / 255;
    };
    const settleCorners = () => {
      for (const c of corners) {
        const hp = pieceAt(c.hs, c.hi), vp = pieceAt(c.vs, c.vi);
        for (const q of c.px) {
          if (q.t >= 0 || vp.L[q.dx] < 0 || hp.L[q.dy] < 0) continue;
          q.t = 1 - (1 - vp.L[q.dx] / 255) * (1 - hp.L[q.dy] / 255);       // the box covers ax · ay of the corner pixel
          known[q.p] *= q.t;
        }
      }
    };
    // First the lines with pixels of their own. A line shared from end to end
    // — a short step of the outline, a narrow gap between two boxes — waits,
    // and takes what is left once the known levels are divided out: nearest
    // lines first, longest sides first.
    const waiting = [];
    for (const s of sides)
      for (const pc of s.pieces)
        for (let d = 1; d <= DEPTH; d++) {
          if (pc.L[d] < 0) {
            const values = [];
            for (let i = pc.i0; i <= pc.i1; i++) { const p = s.px[d][i]; if (p >= 0 && cover[p] === 1 && inner(s, i)) values.push(gray[p]); }
            pc.L[d] = levelOf(values);
          }
          if (pc.L[d] >= 0) settle(s, pc, d);
          else if (s.px[d].some(p => p >= 0)) waiting.push({ s, pc, d });
          else pc.L[d] = 255;
        }
    settleCorners();
    waiting.sort((a, b) => a.d - b.d || b.s.len - a.s.len);
    for (const { s, pc, d } of waiting) {
      const values = [];
      for (let i = pc.i0; i <= pc.i1; i++) { const p = s.px[d][i]; if (p >= 0 && inner(s, i)) values.push(Math.min(255, Math.round(gray[p] / Math.max(known[p], 1 / 255)))); }
      pc.L[d] = levelOf(values);
      if (pc.L[d] < 0) pc.L[d] = 255;
      settle(s, pc, d);
      settleCorners();
    }
    for (const s of sides) for (const pc of s.pieces) for (let d = 2; d <= DEPTH; d++) if (pc.L[d - 1] === 255) pc.L[d] = 255;

    // ── paint ──
    const rims = new Uint8Array(w * h);                            // how many rims lie on a pixel
    for (const s of sides) {
      for (const pc of s.pieces) for (let d = 1; d <= DEPTH; d++) if (pc.L[d] < 255) for (let i = pc.i0; i <= pc.i1; i++) if (s.px[d][i] >= 0) rims[s.px[d][i]]++;
      for (let k = 0; k + 1 < s.pieces.length; k++)
        for (let d = 1; d <= DEPTH; d++)
          if (Math.min(s.pieces[k].L[d], s.pieces[k + 1].L[d]) < 255)
            for (let i = s.pieces[k].i1 + 1; i < s.pieces[k + 1].i0; i++) if (s.px[d][i] >= 0) rims[s.px[d][i]]++;
    }
    for (const c of corners) for (const q of c.px) if (q.t >= 0 && q.t < 1) rims[q.p]++;

    const T = new Float32Array(w * h).fill(1);
    // One line from i0 to i1 at level L. A pixel darker than L is text and
    // keeps its darkness. Under a DARK rim two things are the boxes' instead:
    //   · a dip of at most DIP_MAX pixels where two stacked boxes overlap —
    //     at a row where the region's outline shows a box ending, confined to
    //     the rim (white right beyond it), no darker than `floor`, a second
    //     such rim over the first;
    //   · the one pixel next to a convex corner, where the resampling rings.
    // Those are paper, whatever they read: t = 0, which the mask turns into
    // the white of the region itself (0 / t would stay black).
    const paintLine = (s, d, i0, i1, L, dark, floor, beyond, ends) => {
      const line = s.px[d], out = s.px[beyond];
      const lone = k => line[k] >= 0 && rims[line[k]] === 1;
      const dips = k => lone(k) && gray[line[k]] < L - SNAP;
      for (let i = i0; i <= i1;) {
        if (line[i] < 0) { i++; continue; }
        const rings = dark && lone(i) && gray[line[i]] < L && ((i === 0 && ends[0]) || (i === s.len - 1 && ends[1]));
        if (rings) { T[line[i]] = 0; i++; continue; }
        if (!dark || !dips(i)) { T[line[i]] *= L / 255; i++; continue; }
        let e = i;
        while (e + 1 <= i1 && dips(e + 1)) e++;
        for (let k = i; k <= e; k++) {
          const g = gray[line[k]];
          const overlap = e - i + 1 <= DIP_MAX && g >= floor && boxEndsNear(s, k) && out[k] >= 0 && rims[out[k]] === 0 && gray[out[k]] >= 255 - SNAP;
          T[line[k]] *= overlap ? 0 : L / 255;
        }
        i = e + 1;
      }
    };
    const NO_ENDS = [false, false];
    for (const s of sides) {
      const rimDepth = pc => { let d = 1; while (d <= DEPTH && pc.L[d] < 255) d++; return d; };      // the first line without a rim
      for (const pc of s.pieces)
        for (let d = 1; d <= DEPTH; d++)
          if (pc.L[d] < 255) paintLine(s, d, pc.i0, pc.i1, pc.L[d], pc.L[d] < DARK, pc.L[d] * pc.L[d] / 255 - SNAP, rimDepth(pc), s.convex);
      // Between two pieces the brighter level holds — the text-safe one. When one of them is a dark rim, the
      // few pixels of the step are that box's corner, and the rule of the dips holds through all its lines.
      for (let k = 0; k + 1 < s.pieces.length; k++) {
        const A = s.pieces[k], C = s.pieces[k + 1];
        if (A.i1 + 1 >= C.i0) continue;
        for (let d = 1; d <= DEPTH; d++)
          if (Math.min(A.L[d], C.L[d]) < 255) paintLine(s, d, A.i1 + 1, C.i0 - 1, Math.max(A.L[d], C.L[d]), Math.min(A.L[1], C.L[1]) < DARK, A.L[d] * C.L[d] / 255 - SNAP, Math.max(rimDepth(A), rimDepth(C)), NO_ENDS);
      }
    }
    // A corner under two dark rims is as good as inside the box, and the model is coarse there: paper.
    for (const c of corners)
      for (const q of c.px) {
        if (q.t < 0 || q.t >= 1) continue;
        const paper = q.t * 255 < DARK && gray[q.p] < q.t * 255 && rims[q.p] === 1;
        T[q.p] *= paper ? 0 : q.t;
      }
    return T;
  }

  // The blacked-out regions of a page: 1 inside, as a map; null when there are none.
  function regions(gray, w, h) {
    let black = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) black[p] = gray[p] <= 0 ? 1 : 0;
    black = filterComponents(removeDiscs(black, w, h), w, h);
    return black.includes(1) ? black : null;
  }

  // The mask the shader reads: 255 inside a region and where t is 0 (nothing to
  // recover: white), else 255 · (1 − t), so that page / (1 − mask) un-blends the rim.
  function buildMask(gray, w, h) {
    const B = regions(gray, w, h);
    if (!B) return null;
    const T = transmission(gray, w, h, B), mask = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) mask[p] = B[p] || T[p] === 0 ? 255 : Math.min(254, 255 - Math.round(255 * T[p]));
    return mask;
  }

  // Opaque RGBA → gray, for a page that arrives as an image instead of MuPDF's
  // gray samples. Integer weights that sum to 256: black stays 0, white 255.
  function grayOf(rgba) {
    const gray = new Uint8Array(rgba.length / 4);
    for (let p = 0, j = 0; p < gray.length; p++, j += 4) gray[p] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    return gray;
  }

  globalThis.MaskCore = { buildMask, regions, transmission, grayOf, labelComponents, filterComponents, removeDiscs };
})();
