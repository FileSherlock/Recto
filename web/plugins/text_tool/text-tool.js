// text-tool.js
// Tool actions and OCR integration for the Unified Text Box system.
// Span fetching and embedded-text lifecycle are handled by etv-fetch.js (embedded_text_viewer).


// The font and size new text takes: the Text panel's (what it shows while
// nothing is selected — the document's face, or the user's own choice).
function newTextFont() {
  const t = window.TextPanel?.newText?.();
  if (t?.fontFamily) return t;
  return { fontFamily: document.getElementById('fabric-font-family')?.value || 'Times New Roman',
    sizePt: parseFloat(document.getElementById('fabric-font-size')?.value) || 12 };
}
window.newTextFont = newTextFont;

// ── Tool: add redaction box ───────────────────────────────────

window.handleManualAddBox = function (pageNum, x, y) {
  const had = new Set(utbState.boxes);
  try { addBox(pageNum, x, y); }
  finally { window.utbUndo?.recordAdd(utbState.boxes.filter(b => !had.has(b)), 'add box'); }
};
function addBox(pageNum, x, y) {
  // the nearest shown line (unified-text-box.js): its face, style, size and band
  const nearest = utbFindNearestLine(pageNum, { x, y });
  if (typeof createNewRedaction === 'function') {
    createNewRedaction(pageNum, x - 50, nearest ? nearest.y : y - 10, 100, nearest ? nearest.h : 20,
      nearest ? nearest.lineId : null, nearest?.font, nearest?.sizePt);
    return;
  }

  // Fallback: pure UTB creation, when no plugin supplies createNewRedaction()
  // — in the font and size new text takes (the Text panel's, in points)
  const fresh = newTextFont();
  const defaultFF = fresh.fontFamily, defaultSizePt = fresh.sizePt;

  const newBox = utbState.addBox(new UnifiedTextBox({
    type: 'redaction',
    page: pageNum,
    text: '',
    lineId: nearest ? nearest.lineId : null,
    x: x,
    y: nearest ? nearest.y : y - 10,
    w: nearest ? nearest.w : 100,
    h: nearest ? nearest.h : 20,
    fontFamily: nearest ? nearest.font : defaultFF,
    bold: !!nearest?.bold,
    italic: !!nearest?.italic,
    sizePt: nearest ? nearest.sizePt : defaultSizePt,
  }));

  renderBox(newBox);
  utbState.selectedId = newBox.id;
  selectBoxInSVG(newBox.id);
  if (typeof syncToolbarToBox === 'function') syncToolbarToBox(newBox);
}


// ── Tool: delete a box ────────────────────────────────────────
// One removal path for every box type, used by the toolbar's Delete button and
// by the Delete / Backspace keys. Any live session on the box is torn down
// first, so no id in utbState outlives the box it points at.

// `silent`: the undo stack itself is taking the box out — not a step of its own.
window.utbDeleteBox = function (id, { silent = false } = {}) {
  const box = id ? utbState.getBox(id) : null;
  if (!box) return;

  // Artistic / Frame text being edited: the edit is committed first, a step
  // before the delete's (Undo brings the text back as it was typed) — or,
  // when the undo stack itself takes the box out, ended without a step
  if (utbState.editingId === box.id) {
    if (box.textMode) window.commitStoryEdit?.({ record: !silent });
    else if (typeof cancelInlineEdit === 'function') cancelInlineEdit();
  }
  if (utbState.microTypoId === box.id && typeof exitMicroTypo === 'function') exitMicroTypo();

  if (!silent) window.utbUndo?.recordDelete(box, utbState.boxes.indexOf(box), 'delete box');
  utbState.removeBox(box.id);
  removeBoxFromSVG(box.id);

  if (utbState.selectedId === box.id) {
    utbState.selectedId = null;
    deselectAllInSVG();
    window.syncToolbarToSelection?.();
  }

  // Let whichever plugins track boxes redraw what they own.
  window.refreshRuler?.();
  if (typeof renderCandidates === 'function') renderCandidates();
};

// Delete / Backspace removes the selection — but never while the caret is in a
// field (the inline-edit input, the font-size box, the tolerance box…), where
// those keys mean "erase a character".
document.addEventListener('keydown', e => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  if (utbState.editingId) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
  if (!utbState.selectedId) return;
  e.preventDefault();
  window.utbDeleteBox(utbState.selectedId);
});
