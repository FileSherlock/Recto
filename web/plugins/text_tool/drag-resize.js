// drag-resize.js
// SVG-native drag and resize for UnifiedTextBox elements.
// All deltas are computed in SVG coordinate space (= document pixel space)
// using getScreenCTM().inverse() — no manual zoom division needed.

(function initDragResize() {

  // Convert a screen (client) point to SVG document-space point
  function toSVGPoint(svgEl, clientX, clientY) {
    const pt = svgEl.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    return pt.matrixTransform(svgEl.getScreenCTM().inverse());
  }

  // Get the SVG layer that owns a group element
  function ownerSVG(el) {
    return el.closest('svg.text-layer');
  }

  // All boxes that share a lineId on the same page (for grouped vertical drag)
  function getLineBoxes(box) {
    if (!box.lineId) return [box];
    return utbState.boxes.filter(b => b.lineId === box.lineId && b.page === box.page);
  }

  // All redaction-type boxes linked to a given lineId + page
  function getLinkedRedactions(lineId, page) {
    if (!lineId) return [];
    return utbState.boxes.filter(b => b.type === 'redaction' && b.lineId === lineId && b.page === page);
  }

  // ── Drag ──────────────────────────────────────────────────────

  function initDrag(downEvent, box, svgEl) {
    downEvent.preventDefault();
    downEvent.stopPropagation();

    const start = toSVGPoint(svgEl, downEvent.clientX, downEvent.clientY);
    const origX = box.x;

    // Snapshot all line boxes' Y positions for grouped vertical move
    const lineBoxes = getLineBoxes(box);
    const origYs = lineBoxes.map(b => b.y);
    const linkedReds = getLinkedRedactions(box.lineId, box.page);
    const origRedYs = linkedReds.map(b => b.y);

    function onMove(e) {
      const cur = toSVGPoint(svgEl, e.clientX, e.clientY);
      const dx = cur.x - start.x;
      const dy = cur.y - start.y;

      // Dragged box: horizontal only
      box.x = origX + dx;
      renderBox(box);
      window.refreshRuler?.(); // keep the ruler marker glued to the box

      // Whole line: vertical only
      for (let i = 0; i < lineBoxes.length; i++) {
        lineBoxes[i].y = origYs[i] + dy;
        renderBox(lineBoxes[i]);
      }

      // Linked redactions: vertical sync
      for (let i = 0; i < linkedReds.length; i++) {
        linkedReds[i].y = origRedYs[i] + dy;
        renderBox(linkedReds[i]);
      }
    }

    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // ── Resize ────────────────────────────────────────────────────

  function initResize(downEvent, box, svgEl, edge) {
    downEvent.preventDefault();
    downEvent.stopPropagation();

    const start = toSVGPoint(svgEl, downEvent.clientX, downEvent.clientY);
    const origX = box.x;
    const origW = box.w;

    function onMove(e) {
      const cur = toSVGPoint(svgEl, e.clientX, e.clientY);
      const dx = cur.x - start.x;

      if (edge === 'r') {
        box.w = Math.max(4, origW + dx);
      } else {
        const clamped = Math.min(dx, origW - 4);
        box.x = origX + clamped;
        box.w = origW - clamped;
      }
      renderBox(box);

      // A resize only changes box.w — candidate widths (box.widths) are
      // invariant to it — so a width-matching plugin need only re-filter
      // against the live box.w, not re-measure.
      if (box.type === 'redaction') {
        if (typeof updateAllMatchesView === 'function') updateAllMatchesView(box.id);
        if (utbState.selectedId === box.id && typeof renderCandidates === 'function') {
          renderCandidates();
        }
      }
    }

    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (box.type === 'redaction' && typeof calculateWidthsForRedaction === 'function') {
        calculateWidthsForRedaction(box.id);
      }
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // ── Event delegation on SVG layers ───────────────────────────

  // We attach a single delegated listener to the document.
  // This avoids re-attaching on each renderBox call.

  document.addEventListener('mousedown', e => {
    const svgEl = e.target.closest('svg.text-layer');
    if (!svgEl) return;

    // Edge handle → resize
    if (e.target.classList.contains('utb-edge')) {
      const group = e.target.closest('.utb-group');
      if (!group) return;
      const box = utbState.getBox(group.dataset.id);
      if (!box) return;
      initResize(e, box, svgEl, e.target.dataset.edge);
      return;
    }

    // Text or bbox → select + drag
    const group = e.target.closest('.utb-group');
    if (!group) {
      // Clicked on SVG background — deselect
      if (utbState.selectedId) {
        utbState.selectedId = null;
        deselectAllInSVG();
        document.getElementById('fabric-options-bar')?.classList.add('hidden');
        if (typeof syncToolbarToSelection === 'function') syncToolbarToSelection();
        if (typeof syncNameSettingsUI === 'function') syncNameSettingsUI();
        if (typeof renderCandidates === 'function') renderCandidates();
      }
      return;
    }

    if (e.target.classList.contains('utb-char-hit')) return; // handled by micro-typo

    const box = utbState.getBox(group.dataset.id);
    if (!box) return;

    // Select the box
    utbState.selectedId = box.id;
    selectBoxInSVG(box.id);
    if (typeof syncToolbarToBox === 'function') syncToolbarToBox(box);

    // If it's a redaction, also select it in the sidebar
    if (box.type === 'redaction' && typeof selectRedaction === 'function') {
      selectRedaction(box.id);
    }

    initDrag(e, box, svgEl);
  });

  // Deselect when clicking outside any SVG layer, toolbar, or sidebar
  document.addEventListener('mousedown', e => {
    if (e.target.closest('svg.text-layer')) return;
    if (e.target.closest('svg.ruler-layer')) return; // ruler marker drag must not deselect
    if (e.target.closest('#fabric-options-bar')) return;
    if (e.target.closest('#unified-options-bar-container')) return;
    if (e.target.closest('#tools-sidebar')) return;
    if (e.target.closest('.utb-nudge-popover')) return;
    if (utbState.selectedId) {
      utbState.selectedId = null;
      deselectAllInSVG();
      document.getElementById('fabric-options-bar')?.classList.add('hidden');
      if (typeof syncToolbarToSelection === 'function') syncToolbarToSelection();
      if (typeof syncNameSettingsUI === 'function') syncNameSettingsUI();
      if (typeof renderCandidates === 'function') renderCandidates();
    }
  }, true); // capture phase so it fires before the SVG handler above

})();
