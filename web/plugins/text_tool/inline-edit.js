// inline-edit.js
// Double-click an embedded or harfbuzz text span to edit its text inline.
// Uses a <foreignObject> overlay with a styled <input> that matches the
// span's font / size / color for a WYSIWYG experience.
// Redaction spans are excluded (their text is machine-managed).

(function initInlineEdit() {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XHTML_NS = 'http://www.w3.org/1999/xhtml';

  // ── Enter inline edit ─────────────────────────────────────────

  function enterInlineEdit(box) {
    // Guard: only embedded / harfbuzz spans are editable
    if (box.type === 'redaction') return;

    // Exit any active micro-typo or prior edit session
    if (typeof exitMicroTypo === 'function') exitMicroTypo();
    commitInlineEdit();

    utbState.editingId = box.id;

    const group = document.querySelector(`.utb-group[data-id="${box.id}"]`);
    if (!group) return;

    group.classList.add('editing');

    // Hide the SVG <text> so it doesn't render behind the input
    const textEl = group.querySelector('.utb-text');
    if (textEl) textEl.style.display = 'none';

    // Create <foreignObject> sized to the bounding box
    const fo = document.createElementNS(SVG_NS, 'foreignObject');
    fo.classList.add('utb-inline-edit');
    fo.setAttribute('x', box.x);
    fo.setAttribute('y', box.y);
    // Make the foreignObject wider than the box so text can extend
    fo.setAttribute('width', Math.max(box.w * 2, 300));
    fo.setAttribute('height', box.h);

    // Inner <input> styled to match the span
    const input = document.createElementNS(XHTML_NS, 'input');
    input.setAttribute('type', 'text');
    input.setAttribute('value', box.text);
    input.className = 'utb-edit-input';

    // WYSIWYG styling. The input lives in the same image-px space as the SVG,
    // so convert the canonical point size to px the same way svg-renderer does.
    const pxSize = GEO.docPtToPx(box.sizePt);
    input.style.fontFamily = `"${box.fontFamily}"`;
    input.style.fontSize = `${pxSize}px`;
    input.style.color = box.color || _typeColor(box.type);
    input.style.fontWeight = box.bold ? 'bold' : 'normal';
    input.style.fontStyle = box.italic ? 'italic' : 'normal';
    input.style.width = '100%';
    input.style.height = '100%';

    fo.appendChild(input);
    group.appendChild(fo);

    // Focus and select all text
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });

    // ── Event listeners on the input ──────────────────────────

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitInlineEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelInlineEdit();
      }
      // Stop propagation so typing doesn't trigger app-level hotkeys
      e.stopPropagation();
    });

    // Prevent click/mousedown from bubbling to drag-resize
    fo.addEventListener('mousedown', e => e.stopPropagation());
    fo.addEventListener('click', e => e.stopPropagation());

    input.addEventListener('blur', () => {
      // Commit on blur (click-away). Use a micro-delay so that
      // if blur was caused by clicking another span, the new
      // dblclick handler fires cleanly after the commit.
      setTimeout(() => commitInlineEdit(), 0);
    });
  }

  // ── Commit ──────────────────────────────────────────────────

  function commitInlineEdit() {
    if (!utbState.editingId) return;

    const box = utbState.getBox(utbState.editingId);
    const group = document.querySelector(`.utb-group[data-id="${utbState.editingId}"]`);
    const step = box ? window.utbUndo?.capture([box]) : null;

    // Snapshot for the optional "grow leftward when text is prepended" behavior.
    const prevText  = box ? box.text : '';
    const prevRight = box ? box.x + box.w : 0;

    if (group) {
      const fo = group.querySelector('.utb-inline-edit');
      const input = fo?.querySelector('input');
      if (input && box) {
        box.text = input.value;
      }
      fo?.remove();

      // Unhide the SVG <text>
      const textEl = group.querySelector('.utb-text');
      if (textEl) textEl.style.display = '';

      group.classList.remove('editing');
    }

    utbState.editingId = null;

    if (box) {
      // When an embedded/harfbuzz span's text actually changes, its extracted
      // per-character positions no longer match the new text — drop them and
      // switch the box to auto-size, so it resizes to content from now on just
      // like a manually-added text box.
      if (box.type !== 'redaction' && box.text !== prevText) {
        box.autoWidth = true;
        box.baseCharPositions = null;
        box.charAdvances = {};
      }

      renderBox(box);  // auto-width boxes recompute box.w from the new text here

      // If the edit only prepended characters (new text ends with the old
      // text), keep the RIGHT edge fixed so the box grows leftward instead of
      // always rightward. Auto-width boxes only.
      if (box.autoWidth && prevText && box.text.length > prevText.length &&
          box.text.endsWith(prevText)) {
        box.x = prevRight - box.w;
        renderBox(box);
      }
      window.utbUndo?.commit(step, 'edit text');
    }
  }

  // ── Cancel ──────────────────────────────────────────────────

  function cancelInlineEdit() {
    if (!utbState.editingId) return;

    const group = document.querySelector(`.utb-group[data-id="${utbState.editingId}"]`);
    if (group) {
      const fo = group.querySelector('.utb-inline-edit');
      fo?.remove();

      const textEl = group.querySelector('.utb-text');
      if (textEl) textEl.style.display = '';

      group.classList.remove('editing');
    }

    const box = utbState.getBox(utbState.editingId);
    utbState.editingId = null;

    if (box) renderBox(box);
  }

  // ── Helpers ─────────────────────────────────────────────────

  function _typeColor(type) {
    const colors = {
      embedded: 'rgba(0, 100, 255, 0.82)',
      ocr: 'rgba(0, 200, 255, 0.70)',
      harfbuzz: 'rgba(255, 140, 0, 0.80)',
    };
    return colors[type] || '#000';
  }

  // ── Event wiring ──────────────────────────────────────────

  // Double-click on a utb-text element → enter inline edit (for non-redaction)
  document.addEventListener('dblclick', e => {
    // Don't trigger if clicking inside an active edit input
    if (e.target.closest('.utb-inline-edit')) return;

    const textEl = e.target.closest('.utb-text') || e.target.closest('.utb-bbox') ||
      e.target.closest('.utb-pixel');   // pixel-rendered box (svg-renderer seam)
    if (!textEl) {
      // Double-click outside → commit any active edit
      commitInlineEdit();
      return;
    }
    const group = textEl.closest('.utb-group');
    if (!group) return;
    const box = utbState.getBox(group.dataset.id);
    if (!box) return;

    // Redactions are not editable
    if (box.type === 'redaction') return;

    enterInlineEdit(box);
  });

  // Escape key → cancel edit
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && utbState.editingId) {
      cancelInlineEdit();
    }
  });

  // Expose for external use
  window.enterInlineEdit  = enterInlineEdit;
  window.commitInlineEdit = commitInlineEdit;
  window.cancelInlineEdit = cancelInlineEdit;

})();
