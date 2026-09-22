// svg-renderer.js
// Renders UnifiedTextBox objects as SVG <text> elements in a per-page SVG layer.
// The SVG uses a fixed viewBox matching document pixel space so coordinates are
// always in the same space as box.x/y/w/h — zoom is handled by CSS sizing alone.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Global toggle: show numeric width label above each space character
let showSpaceWidthLabels = false;

// Type → fill color (rgba)
const UTB_TYPE_COLORS = {
  embedded: 'rgba(0, 100, 255, 0.82)',
  redaction: 'rgba(129, 201, 149, 0.90)',
  harfbuzz: 'rgba(255, 140, 0, 0.80)',
  ocr: 'rgba(0, 200, 255, 0.70)',
};

const UTB_TYPE_STROKE = {
  embedded: 'rgba(0, 100, 255, 0.6)',
  redaction: 'rgba(80, 180, 110, 0.8)',
  harfbuzz: 'rgba(220, 100, 0, 0.7)',
  ocr: 'rgba(0, 150, 200, 0.6)',
};


// ── SVG Layer ─────────────────────────────────────────────────

/**
 * Return the SVG text layer for a page, creating it if needed.
 * The SVG is absolutely positioned over the page image container.
 */
function getOrCreateSVGLayer(pageContainer, pageNum) {
  let svg = pageContainer.querySelector(`.text-layer[data-page="${pageNum}"]`);
  if (svg) return svg;

  const pw = state?.pageWidth || GEO.PAGE_WIDTH_PX;
  const ph = state?.pageHeight || GEO.PAGE_HEIGHT_PX;

  svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('text-layer');
  svg.dataset.page = pageNum;
  svg.setAttribute('viewBox', `0 0 ${pw} ${ph}`);
  svg.setAttribute('xmlns', SVG_NS);
  pageContainer.appendChild(svg);
  return svg;
}

/** Remove all SVG text layers. */
function clearAllSVGLayers() {
  document.querySelectorAll('.text-layer').forEach(el => el.remove());
}


// ── Coordinate computation ────────────────────────────────────

/**
 * Compute the array of absolute x positions for each character in a box.
 * When baseCharPositions is available, each char's x = box.x + char.x + charAdvances[i].
 * When not available, returns a single value [box.x].
 *
 * If box.spaceWidth is set (manual override, defaultSpaceWidth === false),
 * each space character's width is overridden and all subsequent characters
 * are shifted by the accumulated delta from the native space widths.
 */
function computeXPositions(box) {
  // measured positions belong to the face they were measured in
  if (!utbCharsValid(box)) {
    return [box.x];
  }

  // Determine if we need to apply a manual space-width override
  const hasSpaceOverride = box.spaceWidth != null && !box.defaultSpaceWidth;

  // Compute the average native space width from baseCharPositions
  let nativeSpaceW = null;
  if (hasSpaceOverride) {
    const spaceChars = box.baseCharPositions.filter(cp => cp.c === ' ');
    if (spaceChars.length > 0) {
      nativeSpaceW = spaceChars.reduce((sum, cp) => sum + (cp.w || 0), 0) / spaceChars.length;
    }
  }

  // charAdvances[i] is a manual per-character nudge.  We accumulate all prior
  // nudges so that shifting char i also shifts chars i+1, i+2, … by the same
  // amount — matching the SVG <text x="…"> array contract.
  let cumulativeDelta = 0;
  let spaceAdjust = 0; // accumulated shift from space-width overrides
  const xs = [];
  for (let i = 0; i < box.baseCharPositions.length; i++) {
    const cp = box.baseCharPositions[i];
    cumulativeDelta += (box.charAdvances[i] || 0);
    xs.push(box.x + cp.x + cumulativeDelta + spaceAdjust);

    // After placing a space character, accumulate the width delta for
    // all subsequent characters
    if (hasSpaceOverride && nativeSpaceW != null && cp.c === ' ') {
      spaceAdjust += (box.spaceWidth - nativeSpaceW);
    }
  }
  return xs;
}

/**
 * Compute baseline Y: approximately 85% down from the top of the bounding box.
 * SVG <text> y is the baseline, not the top. TODO: -1 Temporary fix. 
 */
function computeBaseline(box) {
  return (box.y || 0) + (box.h || 0) * 0.85 - 1.3;
}


// ── Box rendering ─────────────────────────────────────────────

/**
 * Create or update the SVG group and text element for a single box.
 * Call this whenever box data changes (position, text, font, charAdvances…).
 */
function renderBox(box) {
  const pageContainer = document.getElementById(`pageContainer${box.page}`);
  if (!pageContainer) return;

  const svg = getOrCreateSVGLayer(pageContainer, box.page);

  // Find or create the <g> group for this box
  let g = svg.querySelector(`[data-id="${box.id}"]`);
  if (!g) {
    g = document.createElementNS(SVG_NS, 'g');
    g.dataset.id = box.id;
    g.dataset.type = box.type;
    g.classList.add('utb-group');
    svg.appendChild(g);
  }
  g.dataset.type = box.type;

  // Text first so _autoFitWidth can measure the rendered glyphs and set box.w
  // before the bounding box / handles are drawn from it.
  _updateText(g, box);
  _autoFitWidth(g, box);
  _updateBBox(g, box);
  _updateEdgeHandles(g, box);
  _updateSpaceLabels(g, box);
}

/**
 * Auto-size box.w to the measured width of its rendered text.
 * Only applies to boxes flagged autoWidth (manually-added text boxes); the
 * left edge (box.x) is preserved so text grows rightward by default. The
 * inline-edit commit handler may shift box.x afterwards to grow leftward.
 */
function _autoFitWidth(g, box) {
  if (!box.autoWidth) return;
  // A pixel renderer (see _applyPixelRender) knows the laid-out advance width
  // exactly; the hidden <text> would measure the wrong face.
  if (box._pixel && box._pixel.advanceW > 0) {
    box.w = Math.max(box._pixel.advanceW, 6);
    return;
  }
  const text = g.querySelector('.utb-text');
  if (!text) return;
  let measured;
  try {
    measured = text.getComputedTextLength();
  } catch (e) {
    return;  // not measurable (e.g. detached) — leave width untouched
  }
  box.w = Math.max(measured, 6);  // keep a clickable minimum for empty text
}

/** Update (or create) the bounding-box rect inside a group. */
function _updateBBox(g, box) {
  let rect = g.querySelector('.utb-bbox');
  if (!rect) {
    rect = document.createElementNS(SVG_NS, 'rect');
    rect.classList.add('utb-bbox');
    g.insertBefore(rect, g.firstChild);
  }
  rect.setAttribute('x', box.x || 0);
  rect.setAttribute('y', box.y || 0);
  rect.setAttribute('width', box.w || 0);
  rect.setAttribute('height', box.h || 0);
  rect.setAttribute('stroke', UTB_TYPE_STROKE[box.type] || 'rgba(128,128,128,0.6)');
}

/** Update (or create) the SVG <text> element inside a group. */
function _updateText(g, box) {
  let text = g.querySelector('.utb-text');
  if (!text) {
    text = document.createElementNS(SVG_NS, 'text');
    text.classList.add('utb-text');
    g.appendChild(text);
  }

  // Kerning nobody chose yet follows the page: an analysis plugin may know
  // whether this page's producer kerned (guarded seam, like utbPixelRender).
  if (box.kerningAuto && typeof window.utbAutoKerning === 'function') {
    try { const k = window.utbAutoKerning(box); if (typeof k === 'boolean') box.kerning = k; }
    catch (e) { console.warn('utbAutoKerning failed for', box.id, e); }
  }

  const xs = computeXPositions(box);
  const baseline = computeBaseline(box);

  text.setAttribute('y', baseline);
  // The one and only pt -> px conversion: box.sizePt (points) into the SVG's
  // image-pixel viewBox space.
  text.setAttribute('font-size', GEO.docPtToPx(box.sizePt));
  text.setAttribute('font-family', _svgFontFamily(box));

  // Use inline style to ensure it overrides the CSS stylesheet colors
  text.style.fill = box.color || box.labelColor || UTB_TYPE_COLORS[box.type] || 'rgba(0,0,255,0.8)';

  if (box.bold) text.setAttribute('font-weight', 'bold');
  else text.removeAttribute('font-weight');
  if (box.italic) text.setAttribute('font-style', 'italic');
  else text.removeAttribute('font-style');

  const textDecorations = [];
  if (box.underline) textDecorations.push('underline');
  if (box.strikethrough) textDecorations.push('line-through');
  if (textDecorations.length > 0) {
    text.setAttribute('text-decoration', textDecorations.join(' '));
  } else {
    text.removeAttribute('text-decoration');
  }

  if (box.letterSpacing) text.setAttribute('letter-spacing', `${box.letterSpacing}em`);
  else text.removeAttribute('letter-spacing');

  text.style.fontKerning = box.kerning ? 'normal' : 'none';

  // Word spacing: for boxes without per-character positions (Path B),
  // use the SVG word-spacing attribute as a delta from native width.
  // For boxes WITH per-character positions, the override is applied
  // inside computeXPositions() above.
  if (xs.length === 1 && box.spaceWidth != null && !box.defaultSpaceWidth) {
    // word-spacing is additive: it adds to the default space advance.
    // If nativeSpaceWidth is cached, compute the delta; otherwise use
    // spaceWidth directly as an approximation.
    const delta = box.nativeSpaceWidth != null
      ? (box.spaceWidth - box.nativeSpaceWidth)
      : box.spaceWidth;
    text.setAttribute('word-spacing', `${delta}px`);
  } else {
    text.removeAttribute('word-spacing');
  }

  // Per-character x array or single x position
  if (xs.length === 1) {
    text.setAttribute('x', xs[0]);
  } else {
    text.setAttribute('x', xs.join(' '));
  }

  text.textContent = box.text;

  _applyPixelRender(g, box, xs, baseline);
}

/**
 * Optional pixel-renderer seam. A plugin may define
 * `window.utbPixelRender(box, xs, baseline)` and return
 * `{href, x, y, w, h, advanceW}` — a raster of this box in image-pixel
 * space — or `null` to decline. When it returns a raster, the group gets the
 * `utb-pixel-mode` class (CSS hides the <text> without touching its inline
 * style, which inline-edit owns) and an <image> shows the pixels at their
 * exact viewBox coordinates. With no plugin defining the seam, or on `null`,
 * the SVG text renders exactly as before. The result rides on `box._pixel`
 * (transient) so _autoFitWidth can size auto-width boxes from it.
 */
function _applyPixelRender(g, box, xs, baseline) {
  let pix = null;
  if (typeof window.utbPixelRender === 'function') {
    try { pix = window.utbPixelRender(box, xs, baseline); }
    catch (e) { console.warn('utbPixelRender failed for', box.id, e); pix = null; }
  }
  box._pixel = pix || null;
  let img = g.querySelector('.utb-pixel');
  g.classList.toggle('utb-pixel-mode', !!pix);
  if (!pix) { if (img) img.remove(); return; }
  if (!img) {
    img = document.createElementNS(SVG_NS, 'image');
    img.classList.add('utb-pixel');
    img.setAttribute('preserveAspectRatio', 'none');
    g.appendChild(img);
  }
  img.setAttribute('x', pix.x);
  img.setAttribute('y', pix.y);
  img.setAttribute('width', pix.w);
  img.setAttribute('height', pix.h);
  if (img.getAttribute('href') !== pix.href) img.setAttribute('href', pix.href);
}

/** Thin edge handle rects (left / right) for resize interaction. */
function _updateEdgeHandles(g, box) {
  // Remove existing handles
  g.querySelectorAll('.utb-edge').forEach(h => h.remove());

  // Only redaction boxes are manually resized. Text boxes (embedded / harfbuzz)
  // auto-size to their content — see _autoFitWidth — so they get no handles.
  if (box.type !== 'redaction') return;

  const handleW = 4; // px in SVG space
  for (const edge of ['l', 'r']) {
    const h = document.createElementNS(SVG_NS, 'rect');
    h.classList.add('utb-edge', `utb-edge-${edge}`);
    h.dataset.edge = edge;
    h.setAttribute('y', box.y);
    h.setAttribute('height', box.h);
    h.setAttribute('width', handleW);
    h.setAttribute('x', edge === 'l' ? box.x : box.x + box.w - handleW);
    h.setAttribute('fill', 'transparent');
    h.style.cursor = 'ew-resize';
    g.appendChild(h);
  }
}

/** Append a single space-width badge to group g, centred at midX. */
function _spacebadge(g, midX, topY, label, color) {
  const LABEL_H = 7;
  const FONT_SZ = 5;
  const badgeW = label.length * 3.6 + 3;

  const labelG = document.createElementNS(SVG_NS, 'g');
  labelG.classList.add('utb-space-label');
  labelG.style.pointerEvents = 'none';

  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('x', midX - badgeW / 2);
  bg.setAttribute('y', topY);
  bg.setAttribute('width', badgeW);
  bg.setAttribute('height', LABEL_H);
  bg.setAttribute('fill', color);
  bg.setAttribute('rx', '1.5');

  const txt = document.createElementNS(SVG_NS, 'text');
  txt.setAttribute('x', midX);
  txt.setAttribute('y', topY + LABEL_H - 1.5);
  txt.setAttribute('text-anchor', 'middle');
  txt.setAttribute('font-size', FONT_SZ);
  txt.setAttribute('font-family', 'sans-serif');
  txt.setAttribute('fill', '#111');
  txt.textContent = label;

  labelG.appendChild(bg);
  labelG.appendChild(txt);
  g.appendChild(labelG);
}

// ── A bar's gaps to the text on either side ──────────────────
// The distance from the last glyph before a redaction box to its left edge,
// and from its right edge to the first glyph after it, in that neighbour's
// own space (the space its line was set with) and in px. The neighbour is
// any text box on the same line — an OCR line, the embedded text, typed
// text — on a layer that is shown; its glyphs' extent comes from its
// measured character positions when it has them (a span's own box may run
// on past its last glyph). The neighbour's space is the median of its
// measured space characters, else its face's natural space, else what a
// reader calibrated for its line (box.ocr.spaceAdv), else a quarter em.
// Returns { left, right }, each { gap, space } or null when nothing is there.
function utbBarGaps(box) {
  if (typeof utbState === 'undefined') return { left: null, right: null };
  const cl = document.body.classList;
  const shown = b => !(b.type === 'embedded' && cl.contains('hide-embedded-text')) &&
                     !(b.type === 'ocr' && cl.contains('hide-ocr-text'));
  const extent = b => {
    const cps = (b.baseCharPositions || []).filter(cp => cp.c !== ' ' && cp.w > 0);
    if (!cps.length) return { x0: b.x, x1: b.x + b.w };
    return { x0: b.x + Math.min(...cps.map(cp => cp.x)), x1: b.x + Math.max(...cps.map(cp => cp.x + cp.w)) };
  };
  const spaceOf = b => {
    const ws = (b.baseCharPositions || []).filter(cp => cp.c === ' ' && cp.w > 0).map(cp => cp.w).sort((p, q) => p - q);
    if (ws.length) return ws[ws.length >> 1];
    if (b.nativeSpaceWidth > 0) return b.nativeSpaceWidth;
    if (b.ocr?.spaceAdv > 0) return b.ocr.spaceAdv;
    return GEO.docPtToPx(b.sizePt || 12) * 0.25;
  };
  const sameLine = b => (box.lineId && b.lineId === box.lineId) ||
    Math.min(box.y + box.h, b.y + b.h) - Math.max(box.y, b.y) >= Math.min(box.h, b.h) * 0.5;
  let left = null, right = null, lx = -Infinity, rx = Infinity;
  for (const b of utbState.boxes) {
    if (b === box || b.page !== box.page || !b.text || !sameLine(b) || !shown(b)) continue;
    if (b.type !== 'ocr' && b.type !== 'embedded' && b.type !== 'harfbuzz') continue;
    const { x0, x1 } = extent(b);
    if (x1 <= box.x + 1 && x1 > lx) { lx = x1; left = b; }
    if (x0 >= box.x + box.w - 1 && x0 < rx) { rx = x0; right = b; }
  }
  return {
    left: left ? { gap: box.x - lx, space: spaceOf(left) } : null,
    right: right ? { gap: rx - (box.x + box.w), space: spaceOf(right) } : null,
  };
}
window.utbBarGaps = utbBarGaps;

/**
 * Show or hide numeric space-width labels for a single box.
 *
 * Embedded/harfbuzz boxes: yellow badge above each space character.
 * Redaction boxes: a cyan badge in the gap on either side, with the gap in
 *   that line's spaces and in px (utbBarGaps) — live, so a bar being moved
 *   or resized shows where it stands. A bar touching the text (under half a
 *   space) shows no badge on that side: a gap the redactor did not leave is
 *   not a space.
 */
function _updateSpaceLabels(g, box) {
  g.querySelectorAll('.utb-space-label').forEach(el => el.remove());

  if (!showSpaceWidthLabels) return;

  const LABEL_H = 7;
  const labelTopY = box.y - LABEL_H - 1;

  // ── Redaction boxes ───────────────────────────────────────────
  if (box.type === 'redaction') {
    const gaps = utbBarGaps(box);
    const badge = (side, atX) => {
      if (!side || !(side.space > 0) || side.gap < side.space * 0.5) return;
      _spacebadge(g, atX, labelTopY, `${(side.gap / side.space).toFixed(1)} sp · ${side.gap.toFixed(1)} px`, 'rgba(80,200,255,0.92)');
    };
    badge(gaps.left, box.x - gaps.left?.gap / 2);
    badge(gaps.right, box.x + box.w + gaps.right?.gap / 2);
  }

  // ── All boxes with text positions ─────────────────────────────────
  if (!box.baseCharPositions?.length) {
    if (!box.text || typeof box.text !== 'string' || !box.text.includes(' ')) return;

    const textEl = g.querySelector('.utb-text');
    if (!textEl) return;

    const hasSpaceOverride = box.spaceWidth != null && !box.defaultSpaceWidth;

    let i = 0;
    while (i < box.text.length) {
      if (box.text[i] !== ' ') { i++; continue; }

      // Merge a run of consecutive spaces into one badge (summed width)
      let end = i;
      while (end + 1 < box.text.length && box.text[end + 1] === ' ') end++;

      // Trailing spaces (no text after the run) get no badge
      if (end + 1 >= box.text.length) break;

      let spX = 0;
      let runW = 0;
      try {
        spX = textEl.getStartPositionOfChar(i).x;
        for (let k = i; k <= end; k++) {
          const measured = textEl.getSubStringLength(k, 1);
          runW += hasSpaceOverride ? box.spaceWidth : (box.nativeSpaceWidth || measured || 0);
        }
      } catch (e) {
        i = end + 1;
        continue;
      }

      _spacebadge(g, spX + runW / 2, labelTopY, runW.toFixed(1), 'rgba(255,210,0,0.92)');
      i = end + 1;
    }
    return;
  }

  const xs = computeXPositions(box);
  const hasSpaceOverride = box.spaceWidth != null && !box.defaultSpaceWidth;

  let i = 0;
  while (i < box.baseCharPositions.length) {
    if (box.baseCharPositions[i].c !== ' ') { i++; continue; }

    // Extend over the whole run of consecutive spaces (OCR encodes wide
    // gaps as multiple space chars) — one badge with the summed width.
    let end = i;
    while (end + 1 < box.baseCharPositions.length && box.baseCharPositions[end + 1].c === ' ') end++;

    // Trailing spaces (no text after the run) get no badge
    if (end + 1 >= box.baseCharPositions.length) break;

    let runW = 0;
    for (let k = i; k <= end; k++) {
      runW += hasSpaceOverride ? box.spaceWidth : (box.baseCharPositions[k].w || 0);
    }
    _spacebadge(g, xs[i] + runW / 2, labelTopY, runW.toFixed(1), 'rgba(255,210,0,0.92)');
    i = end + 1;
  }
}

/** Resolve the font family string for SVG, accounting for renderFont override. */
function _svgFontFamily(box) {
  if (box.renderFont) return `"etv_${box.renderFont}", ${box.fontFamily}`;
  return `"${box.fontFamily}"`;
}


// ── Page-level rendering ──────────────────────────────────────

/**
 * Render all UTB boxes for a single page into its SVG layer.
 * Called by pdf-viewer.js via the window.renderTextLayer hook.
 */
function renderTextLayer(pageContainer, pageNum) {
  const svg = getOrCreateSVGLayer(pageContainer, pageNum);
  // Clear existing groups (will be re-built) — except the group of a box in a
  // live session. Inline edit hangs a <foreignObject> input off its group and
  // micro-typo hangs char-hit rects off its own; renderBox rebuilds neither,
  // so removing the group would silently drop the session's DOM while
  // utbState.editingId / microTypoId still claim it is open. renderBox is safe
  // to run over a kept group: it only updates the text / bbox / handles.
  const keep = new Set([utbState.editingId, utbState.microTypoId].filter(Boolean));
  svg.querySelectorAll('.utb-group').forEach(g => {
    if (!keep.has(g.dataset.id)) g.remove();
  });

  utbState.getPageBoxes(pageNum).forEach(box => renderBox(box));

  // Selection lives in utbState, not in the markup we just threw away.
  if (utbState.selectedId) selectBoxInSVG(utbState.selectedId);
}

/** Re-render every box on every currently-rendered page. */
function renderAllTextLayers() {
  for (let p = 1; p <= (state?.numPages || 1); p++) {
    const container = document.getElementById(`pageContainer${p}`);
    if (container) renderTextLayer(container, p);
  }
}

/** Remove a single box's group from its SVG layer. */
function removeBoxFromSVG(id) {
  document.querySelectorAll(`.utb-group[data-id="${id}"]`).forEach(g => g.remove());
}


// ── Selection state in SVG ────────────────────────────────────

function selectBoxInSVG(id) {
  document.querySelectorAll('.utb-group.selected').forEach(g => g.classList.remove('selected'));
  if (id) {
    document.querySelectorAll(`.utb-group[data-id="${id}"]`).forEach(g => g.classList.add('selected'));
  }
  window.refreshRuler?.(); // covers select + deselect (id === null)
}

function deselectAllInSVG() {
  selectBoxInSVG(null);
}


// ── Expose globals ────────────────────────────────────────────

window.renderTextLayer = renderTextLayer;
window.renderAllTextLayers = renderAllTextLayers;
window.renderBox = renderBox;
window.removeBoxFromSVG = removeBoxFromSVG;
window.selectBoxInSVG = selectBoxInSVG;
window.deselectAllInSVG = deselectAllInSVG;
window.computeXPositions = computeXPositions;
window.computeBaseline = computeBaseline;
window.getOrCreateSVGLayer = getOrCreateSVGLayer;
window.clearAllSVGLayers = clearAllSVGLayers;
window.setShowSpaceWidthLabels = function (val) {
  showSpaceWidthLabels = val;
  renderAllTextLayers();
};


// ── Lifecycle wiring ──────────────────────────────────────────
// The core emits 'page:rendered' for each page container; build that page's
// SVG text layer in response rather than being invoked by name.
if (window.PDFHooks) {
  PDFHooks.on('page:rendered', ({ pageContainer, pageNum }) => renderTextLayer(pageContainer, pageNum));
}
