// ruler.js
// A Microsoft Word–style horizontal ruler shown directly above the rendered
// page. Ticks every 1/8 inch (longer tick + number at each full inch) and a
// single draggable "indent" marker at the selected box's left edge (box.x).
//
// The ruler is an SVG child of the page-container with viewBox in document
// pixel space and preserveAspectRatio="none", so its x axis maps doc-space x
// onto the page width at any zoom — perfectly aligned with the page columns.
// Vertical size is fixed (viewBox height == CSS height) so ticks/marker keep a
// constant height regardless of zoom. Self-contained: removing this file (and
// the css + plugin.json entries) leaves no dangling references — all calls into the
// host go through window.fn?.() optional-chaining.

(function initRuler() {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const RULER_H = 20;        // ruler height in both viewBox units and CSS px
  const TICK_FULL = 10;      // full-inch tick length
  const TICK_HALF = 7;       // half-inch tick length
  const TICK_EIGHTH = 4;     // 1/8-inch tick length

  // ── doc-space metrics (derived from GEO, never hardcoded) ───────
  function eighthPx() { return window.GEO ? GEO.docPtToPx(9)  : 12; }   // 1/8 inch

  function pageWidthPx() {
    return (typeof state !== 'undefined' && state.pageWidth) || (window.GEO?.PAGE_WIDTH_PX) || 816;
  }

  // ── Pointer → document-space (handles zoom + scroll) ────────────
  function toSVGPoint(svgEl, clientX, clientY) {
    const pt = svgEl.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    return pt.matrixTransform(svgEl.getScreenCTM().inverse());
  }

  // ── Build the ruler for a page container ────────────────────────
  function buildRuler(pageContainer, pageNum) {
    let svg = pageContainer.querySelector(`.ruler-layer[data-page="${pageNum}"]`);
    if (svg) svg.remove(); // rebuild fresh

    const pw = pageWidthPx();

    svg = document.createElementNS(SVG_NS, 'svg');
    svg.classList.add('ruler-layer');
    svg.dataset.page = pageNum;
    svg.setAttribute('viewBox', `0 0 ${pw} ${RULER_H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('xmlns', SVG_NS);

    // ── Ticks + inch labels ───────────────────────────────────────
    const ticks = document.createElementNS(SVG_NS, 'g');
    ticks.classList.add('ruler-ticks');

    const eighth = eighthPx();
    let i = 0;
    for (let x = 0; x <= pw + 0.5; x += eighth, i++) {
      const isFull = (i % 8 === 0);
      const isHalf = (i % 8 === 4);
      const len = isFull ? TICK_FULL : (isHalf ? TICK_HALF : TICK_EIGHTH);

      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', x);
      line.setAttribute('x2', x);
      line.setAttribute('y1', RULER_H - len);
      line.setAttribute('y2', RULER_H);
      line.setAttribute('vector-effect', 'non-scaling-stroke'); // keep ticks crisp at any zoom
      ticks.appendChild(line);

      if (isFull && i > 0) {
        const label = document.createElementNS(SVG_NS, 'text');
        label.classList.add('ruler-label');
        label.setAttribute('x', x);
        label.setAttribute('y', RULER_H - TICK_FULL - 2);
        label.setAttribute('text-anchor', 'middle');
        label.textContent = String(i / 8);
        ticks.appendChild(label);
      }
    }
    svg.appendChild(ticks);

    // ── Draggable indent marker (one per page, hidden by default) ──
    const marker = document.createElementNS(SVG_NS, 'g');
    marker.classList.add('ruler-marker');
    marker.style.display = 'none';
    const path = document.createElementNS(SVG_NS, 'path');
    // A downward "house" pointer whose tip sits at x=0 (box.x), y=RULER_H.
    const w = 5;
    const top = 1;
    const shoulder = RULER_H - 7;
    path.setAttribute('d', `M ${-w} ${top} L ${w} ${top} L ${w} ${shoulder} L 0 ${RULER_H} L ${-w} ${shoulder} Z`);
    marker.appendChild(path);
    svg.appendChild(marker);

    pageContainer.appendChild(svg);
    refreshRuler();
    return svg;
  }

  function setMarkerX(marker, x) {
    marker.setAttribute('transform', `translate(${x}, 0)`);
  }

  // ── Show / refresh the marker from current selection ────────────
  function refreshRuler() {
    const selId = (typeof utbState !== 'undefined') ? utbState.selectedId : null;
    const box = (selId != null && typeof utbState !== 'undefined') ? utbState.getBox(selId) : null;

    document.querySelectorAll('.ruler-layer').forEach(svg => {
      const marker = svg.querySelector('.ruler-marker');
      if (!marker) return;
      const pageNum = Number(svg.dataset.page);
      if (box && box.page === pageNum) {
        setMarkerX(marker, box.x || 0);
        marker.style.display = '';
      } else {
        marker.style.display = 'none';
      }
    });
  }

  // ── Drag the marker to move box.x ───────────────────────────────
  document.addEventListener('mousedown', e => {
    const marker = e.target.closest('.ruler-marker');
    if (!marker) return;
    const svgEl = marker.closest('svg.ruler-layer');
    if (!svgEl || typeof utbState === 'undefined') return;
    const box = utbState.getBox(utbState.selectedId);
    if (!box) return;

    e.preventDefault();
    e.stopPropagation();

    const start = toSVGPoint(svgEl, e.clientX, e.clientY);
    const origX = box.x || 0;
    const eighth = eighthPx();

    function onMove(ev) {
      const cur = toSVGPoint(svgEl, ev.clientX, ev.clientY);
      let x = origX + (cur.x - start.x);
      if (!ev.altKey) x = Math.round(x / eighth) * eighth; // snap unless Alt
      box.x = Math.max(0, x);                              // clamp to page left
      window.renderBox?.(box);
      setMarkerX(marker, box.x);
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  // ── Lifecycle: (re)build the ruler whenever a page is rendered ──
  if (window.PDFHooks) {
    PDFHooks.on('page:rendered', ({ pageContainer, pageNum }) => buildRuler(pageContainer, pageNum));
  }

  // Exposed so the selection chokepoint (svg-renderer.js) and the box drag
  // (drag-resize.js) can keep the marker glued to the selected box.
  window.refreshRuler = refreshRuler;
})();
