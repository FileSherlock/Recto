// text-tool.js
// Tool actions and OCR integration for the Unified Text Box system.
// Span fetching and embedded-text lifecycle are handled by etv-fetch.js (embedded_text_viewer).


// ── Tool: add redaction box ───────────────────────────────────

window.handleManualAddBox = function (pageNum, x, y) {
  if (typeof createNewRedaction === 'function') {
    const nearestLine = window._utbFindNearestLine?.(pageNum, y, 2.0);
    const finalY = nearestLine ? nearestLine.y : y - 10;
    const finalH = nearestLine ? nearestLine.h : 20;
    const finalLineId = nearestLine ? nearestLine.lineId : null;
    const lineFont = nearestLine?.font;
    const lineSizePt = nearestLine?.sizePt;
    createNewRedaction(pageNum, x - 50, finalY, 100, finalH, finalLineId, lineFont, lineSizePt);
    return;
  }

  // Fallback: pure UTB creation, when no plugin supplies createNewRedaction()
  const nearest = window._utbFindNearestLine?.(pageNum, y);
  const defaultFF = document.getElementById('fabric-font-family')?.value || 'Times New Roman';
  // Font-size input is in POINTS — no DPI conversion.
  const defaultSizePt = parseFloat(document.getElementById('fabric-font-size')?.value) || 12;

  const newBox = utbState.addBox(new UnifiedTextBox({
    type: 'redaction',
    page: pageNum,
    text: '',
    lineId: nearest ? nearest.lineId : null,
    x: x,
    y: nearest ? nearest.y : y - 10,
    w: nearest ? nearest.w : 100,
    h: nearest ? nearest.h : 20,
    fontFamily: nearest ? nearest.fontFamily : defaultFF,
    sizePt: nearest ? nearest.sizePt : defaultSizePt,
  }));

  renderBox(newBox);
  utbState.selectedId = newBox.id;
  selectBoxInSVG(newBox.id);
  if (typeof syncToolbarToBox === 'function') syncToolbarToBox(newBox);
};


// ── Tool: add editable text box ───────────────────────────────
// Creates a UnifiedTextBox of type 'embedded' at the click point and drops
// straight into inline-edit mode so the user can type immediately. This is the
// UTB-native replacement for the legacy etvState-based addEmbeddedTextSpan,
// which depended on the embedded-text-viewer overlay UI that isn't present here.

window.handleManualAddText = function (pageNum, x, y) {
  const nearest = window.utbFindNearestLine?.(pageNum, y);
  const defaultFF = document.getElementById('fabric-font-family')?.value || 'Times New Roman';
  // Font-size input is in POINTS — no DPI conversion.
  const defaultSizePt = parseFloat(document.getElementById('fabric-font-size')?.value) || 12;

  const newBox = utbState.addBox(new UnifiedTextBox({
    // 'harfbuzz' — text this editor shapes, not a span extracted from the
    // document. Type matters for visibility: the extracted layers ('embedded',
    // 'ocr') are shown/hidden wholesale by their layer toggles, and text the
    // user just typed must never vanish with them.
    type: 'harfbuzz',
    page: pageNum,
    text: 'Text',
    lineId: nearest ? nearest.lineId : null,
    x: x,
    y: nearest ? nearest.y : y - 10,
    w: nearest ? nearest.w : 100,
    h: nearest ? nearest.h : 20,
    fontFamily: nearest ? (nearest.font || nearest.fontFamily) : defaultFF,
    sizePt: nearest ? nearest.sizePt : defaultSizePt,
    autoWidth: true,  // size to text content; no manual resize handles
  }));

  renderBox(newBox);
  utbState.selectedId = newBox.id;
  selectBoxInSVG(newBox.id);
  if (typeof syncToolbarToBox === 'function') syncToolbarToBox(newBox);

  // Drop into inline edit so the placeholder is selected and ready to overwrite.
  if (typeof enterInlineEdit === 'function') enterInlineEdit(newBox);
};


// ── Tool: delete a box ────────────────────────────────────────
// One removal path for every box type, used by the toolbar's Delete button and
// by the Delete / Backspace keys. Any live session on the box is torn down
// first, so no id in utbState outlives the box it points at.

window.utbDeleteBox = function (id) {
  const box = id ? utbState.getBox(id) : null;
  if (!box) return;

  if (utbState.editingId === box.id && typeof cancelInlineEdit === 'function') cancelInlineEdit();
  if (utbState.microTypoId === box.id && typeof exitMicroTypo === 'function') exitMicroTypo();

  utbState.removeBox(box.id);
  removeBoxFromSVG(box.id);

  if (utbState.selectedId === box.id) {
    utbState.selectedId = null;
    deselectAllInSVG();
    document.getElementById('fabric-options-bar')?.classList.add('hidden');
  }

  // Let whichever plugins track boxes redraw what they own.
  window.refreshRuler?.();
  if (typeof renderCandidates === 'function') renderCandidates();
};

document.getElementById('utb-delete-box')?.addEventListener('click', () => {
  window.utbDeleteBox(utbState.selectedId);
});

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
