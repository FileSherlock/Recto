// undo.js — one undo stack for what the user does to boxes: add, delete,
// move, resize, edit the text, change the formatting, nudge a character.
// What a plugin puts on the page on its own (an OCR read, the embedded text,
// a matcher's label) is not the user's doing and is not on the stack — it is
// regenerated, not undone. A new document empties the stack.
//
// An entry is a change to one or more boxes: their fields before and after
// (utbUndo.capture → utbUndo.commit), or an add / delete (recordAdd /
// recordDelete). Entries with the same `key` collapse while they follow each
// other — every drag of one box, every tick of one slider, every nudge of
// one character is one step (Word does the same with repeated typing); any
// other action in between starts a new step.
//
// The stack is text_tool's, the buttons are text_tool's (#tt-undo, #tt-redo),
// the keys are the platform's: Ctrl/⌘+Z undoes, Ctrl/⌘+Shift+Z and Ctrl/⌘+Y
// redo — never while a field has the caret, where they are the field's own.
(function initUndo() {
  const LIMIT = 200;
  const entries = [];      // done: entries[0 … index); undone (redo): entries[index …)
  let index = 0;
  const listeners = [];

  // A box's fields are the change; what a plugin derived from them — its
  // candidate widths, verdicts, the refiner's findings, the pixel raster — is
  // derived again after a restore, not kept.
  const DERIVED = new Set(['_pixel', '_refine', '_candidateOwners', 'candidates', 'widths', 'widthFace',
    'verdicts', 'refineInfo', 'refined', 'labelColor', 'picked']);
  function snapshot(box) {
    const out = {};
    for (const k of Object.keys(box)) if (!DERIVED.has(k)) out[k] = clone(box[k]);
    return out;
  }
  function clone(v) {
    if (v === null || typeof v !== 'object') return v;
    try { return structuredClone(v); } catch { return Array.isArray(v) ? [...v] : { ...v }; }
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // the fields a plugin measures text under — a restore that changes one of
  // them needs the widths measured again, a move does not
  const TYPO = ['text', 'fontFamily', 'bold', 'italic', 'sizePt', 'letterSpacing', 'kerning', 'kerningAuto',
    'spaceWidth', 'defaultSpaceWidth', 'uppercase', 'tolerance'];

  function notify() { for (const fn of listeners) { try { fn(); } catch (e) { console.warn('undo listener', e); } } }

  function push(entry) {
    entries.length = index;                        // a new action drops the redo branch
    const top = entries[index - 1];
    if (entry.key && top && top.key === entry.key && top.after) {
      top.after = entry.after;                     // the same action again: one step
      if (same(top.before, top.after)) { entries.pop(); index--; }   // …that ended where it began
      notify();
      return;
    }
    entries.push(entry);
    if (entries.length > LIMIT) entries.shift();
    index = entries.length;
    notify();
  }

  // ── the entries ──────────────────────────────────────────────

  function restore(snaps, other) {
    for (const [id, snap] of Object.entries(snaps)) {
      const box = utbState.getBox(id);
      if (!box) continue;
      const prev = other?.[id];
      Object.assign(box, clone(snap));
      refresh(box, !prev || TYPO.some(k => !same(prev[k], snap[k])));
    }
  }
  function refresh(box, remeasure) {
    if (typeof renderBox === 'function') renderBox(box);
    if (box.type === 'redaction') {
      if (remeasure) window.calculateWidthsForRedaction?.(box.id);
      else window.updateAllMatchesView?.(box.id);
    }
    if (utbState.selectedId === box.id) window.syncToolbarToBox?.(box);
    window.refreshRuler?.();
  }
  function tell() {
    window.renderCandidates?.();
    window.updateAllMatchesView?.();
    window.refreshRuler?.();
  }
  function takeOut(box) {
    if (utbState.selectedId === box.id) {
      utbState.selectedId = null;
      window.deselectAllInSVG?.();
      window.syncToolbarToSelection?.();
    }
    window.utbDeleteBox?.(box.id, { silent: true });
  }
  function putBack(box, at) {
    if (utbState.getBox(box.id)) return;
    utbState.boxes.splice(Math.min(at, utbState.boxes.length), 0, box);
    if (typeof renderBox === 'function') renderBox(box);
  }

  const api = {
    // the fields of these boxes now — commit() records what changed since
    capture(boxes) {
      const snaps = {};
      for (const b of boxes) if (b) snaps[b.id] = snapshot(b);
      return { snaps };
    },
    commit(token, label, key = null) {
      if (!token) return;
      const before = {}, after = {};
      for (const id of Object.keys(token.snaps)) {
        const box = utbState.getBox(id);
        if (!box) continue;
        const now = snapshot(box);
        if (same(token.snaps[id], now)) continue;
        before[id] = token.snaps[id];
        after[id] = now;
      }
      if (!Object.keys(before).length) return;
      push({ label, key, before, after,
        undo() { restore(this.before, this.after); },
        redo() { restore(this.after, this.before); } });
    },
    recordAdd(boxes, label = 'Add') {
      const added = boxes.filter(Boolean).map(b => ({ box: b, at: utbState.boxes.indexOf(b) }));
      if (!added.length) return;
      push({ label, key: null,
        undo() { for (const { box } of added) takeOut(box); tell(); },
        redo() { for (const { box, at } of added) putBack(box, at); tell(); } });
    },
    recordDelete(box, at, label = 'Delete') {
      if (!box) return;
      push({ label, key: null,
        undo() { putBack(box, at); tell(); },
        redo() { takeOut(box); tell(); } });
    },
    undo() {
      if (index === 0) return false;
      const e = entries[--index];
      try { e.undo(); } catch (err) { console.warn('undo failed', err); }
      notify();
      return true;
    },
    redo() {
      if (index >= entries.length) return false;
      const e = entries[index++];
      try { e.redo(); } catch (err) { console.warn('redo failed', err); }
      notify();
      return true;
    },
    canUndo: () => index > 0,
    canRedo: () => index < entries.length,
    peek: () => ({ undo: entries[index - 1]?.label || null, redo: entries[index]?.label || null, depth: index, length: entries.length }),
    clear() { entries.length = 0; index = 0; notify(); },
    onChange(fn) { listeners.push(fn); },
  };
  window.utbUndo = api;

  // ── keys and buttons ────────────────────────────────────────

  const inField = t => t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName));
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k !== 'z' && k !== 'y') return;
    if (utbState.editingId || inField(e.target)) return;
    e.preventDefault();
    if (k === 'y' || e.shiftKey) api.redo(); else api.undo();
  });

  function syncButtons() {
    const u = document.getElementById('tt-undo'), r = document.getElementById('tt-redo');
    const p = api.peek();
    if (u) { u.disabled = !api.canUndo(); u.title = p.undo ? `Undo ${p.undo} (Ctrl+Z)` : 'Undo (Ctrl+Z)'; }
    if (r) { r.disabled = !api.canRedo(); r.title = p.redo ? `Redo ${p.redo} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)'; }
  }
  api.onChange(syncButtons);
  document.getElementById('tt-undo')?.addEventListener('click', () => api.undo());
  document.getElementById('tt-redo')?.addEventListener('click', () => api.redo());
  syncButtons();

  window.PDFHooks?.on('document:opening', () => api.clear());
})();
