// micro-typo.js
// Enter Micro-Typography Mode via the toolbar Nudge button.
// Each character gets an invisible hit rect; clicking shows a nudge slider
// that adjusts charAdvances[i] — the per-character x delta.
// A single SVG <text> x-attribute write reflects the change with no DOM reflow.

(function initMicroTypo() {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let activePopover = null;

  // ── Enter / exit mode ─────────────────────────────────────────

  function enterMicroTypo(box) {
    if (!utbCharsValid(box)) return; // nothing to adjust without char positions of the box's current face
    if (utbState.editingId) return; // don't enter while inline-edit is active

    exitMicroTypo(); // clean up previous session

    // Exit inline edit if somehow still lingering
    if (typeof commitInlineEdit === 'function') commitInlineEdit();

    utbState.microTypoId = box.id;

    const group = document.querySelector(`.utb-group[data-id="${box.id}"]`);
    if (!group) return;

    group.classList.add('micro-typo');

    const xs = computeXPositions(box);
    const baseline = computeBaseline(box);

    box.baseCharPositions.forEach((cp, i) => {
      const hitX = xs[i];
      const hitW = cp.w > 0 ? cp.w : (xs[i + 1] ? xs[i + 1] - xs[i] : GEO.docPtToPx(box.sizePt) * 0.6);

      const r = document.createElementNS(SVG_NS, 'rect');
      r.classList.add('utb-char-hit');
      r.dataset.charIdx = i;
      r.setAttribute('x',      hitX);
      r.setAttribute('y',      box.y);
      r.setAttribute('width',  hitW);
      r.setAttribute('height', box.h);
      group.appendChild(r);
    });
  }

  function exitMicroTypo() {
    if (!utbState.microTypoId) return;

    const group = document.querySelector(`.utb-group[data-id="${utbState.microTypoId}"]`);
    if (group) {
      group.classList.remove('micro-typo');
      group.querySelectorAll('.utb-char-hit').forEach(r => r.remove());
    }

    _closePopover();
    utbState.microTypoId     = null;
    utbState.microTypoCharIdx = null;
  }

  // ── Popover ───────────────────────────────────────────────────

  function _closePopover() {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
  }

  function showNudgePopover(box, charIdx, anchorEl) {
    _closePopover();

    const delta = box.charAdvances[charIdx] || 0;
    const ch    = box.baseCharPositions[charIdx]?.c || '?';

    const pop = document.createElement('div');
    pop.className = 'utb-nudge-popover';
    pop.innerHTML = `
      <div class="nudge-char-preview">${ch}</div>
      <label>x nudge (px)</label>
      <input type="range" min="-20" max="20" step="0.1" value="${delta}">
      <div class="nudge-value">${delta.toFixed(1)} px</div>
    `;

    const slider   = pop.querySelector('input[type=range]');
    const valLabel = pop.querySelector('.nudge-value');

    slider.addEventListener('input', e => {
      const newDelta = parseFloat(e.target.value);
      valLabel.textContent = `${newDelta.toFixed(1)} px`;
      applyNudge(box, charIdx, newDelta);
    });

    // Position the popover near the anchor rect
    const svgEl  = anchorEl.closest('svg.text-layer');
    const pageEl = svgEl?.parentElement;
    if (pageEl) {
      const svgRect    = svgEl.getBoundingClientRect();
      const pageRect   = pageEl.getBoundingClientRect();
      const charX      = parseFloat(anchorEl.getAttribute('x'));
      const charY      = parseFloat(anchorEl.getAttribute('y'));
      const scaleX     = svgRect.width  / (state?.pageWidth  || GEO.PAGE_WIDTH_PX);
      const scaleY     = svgRect.height / (state?.pageHeight || GEO.PAGE_HEIGHT_PX);
      const screenLeft = svgRect.left - pageRect.left + charX * scaleX;
      const screenTop  = svgRect.top  - pageRect.top  + charY * scaleY;

      pop.style.position = 'absolute';
      pop.style.left = `${Math.min(screenLeft, pageRect.width - 180)}px`;
      pop.style.top  = `${screenTop - 100}px`;
      pageEl.style.position = 'relative'; // ensure anchor
      pageEl.appendChild(pop);
    } else {
      document.body.appendChild(pop);
    }

    activePopover = pop;
    utbState.microTypoCharIdx = charIdx;
  }

  // ── Apply nudge ───────────────────────────────────────────────

  function applyNudge(box, charIdx, delta) {
    const step = window.utbUndo?.capture([box]);
    if (Math.abs(delta) < 0.01) {
      delete box.charAdvances[charIdx];
    } else {
      box.charAdvances[charIdx] = delta;
    }

    // Update only the x attribute on the SVG <text> node — single attribute write
    const group = document.querySelector(`.utb-group[data-id="${box.id}"]`);
    if (!group) return;

    const textEl = group.querySelector('.utb-text');
    if (textEl) {
      const xs = computeXPositions(box);
      textEl.setAttribute('x', xs.length === 1 ? xs[0] : xs.join(' '));
    }

    // Also reposition the char hit rects for subsequent clicks
    const hits = group.querySelectorAll('.utb-char-hit');
    const xs   = computeXPositions(box);
    hits.forEach(r => {
      const i = parseInt(r.dataset.charIdx);
      if (!isNaN(i) && xs[i] !== undefined) {
        r.setAttribute('x', xs[i]);
      }
    });
    window.utbUndo?.commit(step, 'nudge', `nudge:${box.id}:${charIdx}`);
  }

  // ── Event wiring ──────────────────────────────────────────────

  // Click on a char hit rect → show nudge popover
  document.addEventListener('click', e => {
    const hitEl = e.target.closest('.utb-char-hit');
    if (!hitEl) {
      if (!e.target.closest('.utb-nudge-popover')) _closePopover();
      return;
    }
    e.stopPropagation();
    const group = hitEl.closest('.utb-group');
    if (!group) return;
    const box = utbState.getBox(group.dataset.id);
    if (!box) return;
    const charIdx = parseInt(hitEl.dataset.charIdx);
    showNudgePopover(box, charIdx, hitEl);
  });

  // Escape key → exit mode
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (activePopover) { _closePopover(); return; }
      exitMicroTypo();
    }
  });

  // Expose for testing
  window.enterMicroTypo = enterMicroTypo;
  window.exitMicroTypo  = exitMicroTypo;

})();

