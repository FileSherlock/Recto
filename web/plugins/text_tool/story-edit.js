// story-edit.js — editing Artistic and Frame text in place.
//
// The story's own markup (story-render.js) becomes editable: the browser
// places the caret, extends selections, moves with the arrow keys and runs
// input methods, but every change goes through the story model — each
// `beforeinput` is turned into a StoryCore edit (typing, Enter = new
// paragraph, Shift+Enter = line break, deleting, pasting plain text, Tab),
// the story is drawn again and the caret put back. The model is the one truth;
// the DOM is only ever its picture. An input method's composition is left to
// the browser and taken over when it ends.
//
// While a story is edited, utbState.editingId names its box (every key guard
// of text_tool already honours it) and the character and paragraph settings —
// the ribbon's and the Text panel's — apply to the selection, or to the text
// about to be typed when the selection is a caret (Affinity's rule). With the
// box selected but not edited they apply to all of its text.
//
// Undo: inside a session Ctrl+Z / Ctrl+Y step through the session's own edits
// (typing collapses into one step); leaving the session records it as one
// step on the box undo stack (utbUndo).
(function () {
  const SC = globalThis.StoryCore;
  let session = null;   // { box, flow, sel, pending, undo, redo, step, composing, compRange, lastKind, lastAt }

  const flowOf = box => document.querySelector(`.utb-group[data-id="${box.id}"] .tt-flow`);
  const groupOf = box => document.querySelector(`.utb-group[data-id="${box.id}"]`);

  // ── DOM ↔ model positions ─────────────────────────────────────────────────

  const elementOf = node => (node?.nodeType === 3 ? node.parentElement : node);
  const leafOf = node => elementOf(node)?.closest?.('[data-o]');
  const paraElOf = node => elementOf(node)?.closest?.('.tt-para');

  function domToPos(flow, node, offset) {
    if (!node || !flow.contains(node)) return null;
    const story = session?.box.story;
    const pe = paraElOf(node);
    if (!pe) {
      // the flow itself: the paragraph at or after child[offset]
      const kids = [...flow.children];
      const after = kids.slice(offset).find(k => k.classList.contains('tt-para'));
      if (after) return { p: +after.dataset.p, o: 0 };
      const p = (story?.paragraphs.length || 1) - 1;
      return { p, o: story ? SC.paraLength(story.paragraphs[p]) : 0 };
    }
    const p = +pe.dataset.p;
    if (node.nodeType === 3) {
      const lf = leafOf(node);
      if (lf) return { p, o: +lf.dataset.o + Math.min(offset, node.length) };
    }
    const leaves = [...pe.querySelectorAll('[data-o]')];
    for (const lf of leaves) {
      const r = document.createRange();
      r.selectNodeContents(lf);
      const c = r.comparePoint(node, offset);
      if (c < 0) return { p, o: +lf.dataset.o };
      if (c === 0) return { p, o: +lf.dataset.o + (node === lf && offset > 0 ? lf.textContent.length : 0) };
    }
    const last = leaves[leaves.length - 1];
    return { p, o: last ? +last.dataset.o + last.textContent.length : 0 };
  }

  // The DOM point of a model position. At the seam of two leaves the caret
  // stays with the text before it — unless that text ends in a line break or
  // sits in the drop cap, where it belongs at the start of what follows.
  function posToDom(flow, pos) {
    const pe = flow.querySelector(`.tt-para[data-p="${pos.p}"]`);
    if (!pe) return null;
    let atEnd = null, atStart = null;
    for (const lf of pe.querySelectorAll('[data-o]')) {
      const o0 = +lf.dataset.o, len = lf.textContent.length, node = lf.firstChild;
      if (!node) continue;
      if (pos.o > o0 && pos.o < o0 + len) return { node, offset: pos.o - o0 };
      if (pos.o === o0 + len && !atEnd) atEnd = { node, offset: len, lf };
      if (pos.o === o0 && !atStart) atStart = { node, offset: 0 };
    }
    if (atEnd && !(atStart && (/\n$/.test(atEnd.lf.textContent) || atEnd.lf.closest('.tt-drop') || atEnd.lf.classList.contains('tt-tab'))))
      return { node: atEnd.node, offset: atEnd.offset };
    if (atStart) return atStart;
    return { node: pe, offset: 0 };
  }

  function readSelection() {
    const sel = getSelection();
    if (!session || !sel?.rangeCount) return null;
    const a = domToPos(session.flow, sel.anchorNode, sel.anchorOffset);
    const f = domToPos(session.flow, sel.focusNode, sel.focusOffset);
    return a && f ? { start: a, end: f } : null;
  }

  function domRange(range) {
    const r = SC.ordered(range);
    const a = posToDom(session.flow, r.start), b = posToDom(session.flow, r.end);
    if (!a || !b) return null;
    const dr = document.createRange();
    dr.setStart(a.node, a.offset);
    dr.setEnd(b.node, b.offset);
    return dr;
  }

  // Put the session's selection on screen: the DOM selection while the
  // editor has the focus, a highlight of it while a panel has.
  function showSelection() {
    if (!session?.sel) return;
    const flow = session.flow = flowOf(session.box);
    if (!flow) return;
    const focused = document.activeElement === flow || flow.contains(document.activeElement);
    const a = posToDom(flow, session.sel.start), f = posToDom(flow, session.sel.end);
    if (focused && a && f) {
      try { getSelection().setBaseAndExtent(a.node, a.offset, f.node, f.offset); } catch { /* a node went away */ }
    }
    setHighlight(focused ? null : session.sel);
  }

  function setHighlight(range) {
    if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return;
    const dr = range && !SC.collapsed(range) && session ? domRange(range) : null;
    if (dr) CSS.highlights.set('tt-story-sel', new Highlight(dr));
    else CSS.highlights.delete('tt-story-sel');
  }

  // ── changes ───────────────────────────────────────────────────────────────

  // Make `story` the box's, with `sel` the selection after it. `kind` names
  // an edit that collapses with the one before it (typing, deleting).
  function change(story, sel, kind = null) {
    const s = session;
    const now = Date.now();
    const coalesce = kind && s.lastKind === kind && now - s.lastAt < 1500;
    if (!coalesce) {
      s.undo.push({ story: SC.clone(s.box.story), sel: s.sel });
      if (s.undo.length > 300) s.undo.shift();
    }
    s.redo.length = 0;
    s.lastKind = kind; s.lastAt = now;
    s.box.story = story;
    s.sel = sel;
    redraw();
  }
  function redraw() {
    const s = session;
    window.storySync?.(s.box);
    window.renderBox?.(s.box);
    s.flow = flowOf(s.box);
    showSelection();
    notify();
  }

  function stepBack(from, to) {
    const s = session;
    const e = from.pop();
    if (!e) return;
    to.push({ story: SC.clone(s.box.story), sel: s.sel });
    s.box.story = e.story;
    s.sel = e.sel;
    s.lastKind = null;
    redraw();
  }

  // The stored attributes new text is typed in: the caret's, with what was
  // chosen for it since the caret came there.
  function typingAttrs(range) {
    const r = SC.ordered(range);
    const para = session.box.story.paragraphs[r.start.p];
    const base = SC.collapsed(r) ? SC.runAttrsAt(para, r.start.o) : SC.runAttrsAt(para, r.start.o + 1);
    return { ...base, ...(session.pending || {}) };
  }

  function replace(range, text, kind) {
    const r = SC.ordered(range);
    const { story, pos } = SC.replaceRange(session.box.story, r, text, typingAttrs(r));
    session.pending = null;
    change(story, { start: pos, end: pos }, kind);
  }

  function remove(range, kind) {
    const r = SC.ordered(range);
    if (SC.collapsed(r)) return;
    const { story, pos } = SC.deleteRange(session.box.story, r);
    change(story, { start: pos, end: pos }, kind);
  }

  // One character (a whole grapheme) before or after a caret; across a
  // paragraph's end it is the paragraph break.
  function graphemeRange(pos, forward) {
    const story = session.box.story;
    const text = SC.paraText(story.paragraphs[pos.p]);
    if (forward) {
      if (pos.o >= text.length) return pos.p + 1 < story.paragraphs.length ? { start: pos, end: { p: pos.p + 1, o: 0 } } : null;
      let next = pos.o + 1;
      if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        for (const seg of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text))
          if (seg.index <= pos.o && seg.index + seg.segment.length > pos.o) { next = seg.index + seg.segment.length; break; }
      }
      return { start: pos, end: { p: pos.p, o: next } };
    }
    if (pos.o === 0) return pos.p > 0 ? { start: { p: pos.p - 1, o: SC.paraLength(story.paragraphs[pos.p - 1]) }, end: pos } : null;
    let prev = pos.o - 1;
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      for (const seg of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text))
        if (seg.index < pos.o && seg.index + seg.segment.length >= pos.o) { prev = seg.index; break; }
    }
    return { start: { p: pos.p, o: prev }, end: pos };
  }

  // The range a deleting input names (getTargetRanges), in the model.
  function targetRange(e) {
    const t = e.getTargetRanges?.()[0];
    if (!t) return null;
    const a = domToPos(session.flow, t.startContainer, t.startOffset), b = domToPos(session.flow, t.endContainer, t.endOffset);
    return a && b ? { start: a, end: b } : null;
  }

  function onBeforeInput(e) {
    if (!session || e.currentTarget !== session.flow) return;
    if (e.inputType === 'insertCompositionText' || e.isComposing) return;   // the input method's; taken at compositionend
    e.preventDefault();
    const sel = readSelection() || session.sel;
    session.sel = sel;
    const r = SC.ordered(sel);
    const data = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
    switch (e.inputType) {
      case 'insertText': if (data) replace(r, data, 'type'); break;
      case 'insertReplacementText': replace(targetRange(e) || r, data, null); break;
      case 'insertParagraph': replace(r, '\n', null); break;
      case 'insertLineBreak': replace(r, SC.LINE_BREAK, null); break;
      case 'insertFromPaste': case 'insertFromDrop': case 'insertFromYank':
        replace(r, data.replace(/\r\n?/g, '\n'), null); break;
      case 'insertTab': replace(r, '\t', 'type'); break;
      case 'deleteByCut': case 'deleteByDrag': case 'deleteContent':
        remove(r, null); break;
      case 'deleteContentBackward': case 'deleteContentForward': {
        if (!SC.collapsed(r)) { remove(r, 'delete'); break; }
        const g = graphemeRange(r.start, e.inputType === 'deleteContentForward');
        if (g) remove(g, 'delete');
        break;
      }
      case 'historyUndo': stepBack(session.undo, session.redo); break;
      case 'historyRedo': stepBack(session.redo, session.undo); break;
      case 'formatBold': toggle('bold'); break;
      case 'formatItalic': toggle('italic'); break;
      case 'formatUnderline': toggle('underline'); break;
      case 'formatStrikeThrough': toggle('strike'); break;
      default: {
        // word / line deletions and anything else: the range the browser names
        if (e.inputType.startsWith('delete')) {
          const t = targetRange(e);
          if (t && !SC.collapsed(SC.ordered(t))) remove(t, null);
          else if (!SC.collapsed(r)) remove(r, null);
        }
      }
    }
  }

  // Bold / Italic / Underline / Strikethrough flip as Affinity flips them:
  // on, unless all of the selection already has it.
  function toggle(key) {
    if (!session) return;
    const r = SC.ordered(session.sel);
    const eff = { ...SC.charSummary(session.box.story, r).attrs, ...(session.pending || {}) };
    const patch = key === 'underline' ? { underline: eff.underline === 'none' ? 'single' : 'none' }
      : key === 'strike' ? { strike: eff.strike === 'none' ? 'single' : 'none' }
      : { [key]: !eff[key] };
    applyCharToSession(patch);
  }

  function applyCharToSession(patch) {
    const r = SC.ordered(session.sel);
    if (SC.collapsed(r)) { session.pending = { ...(session.pending || {}), ...patch }; notify(); return; }
    change(SC.applyChar(session.box.story, r, patch), session.sel, null);
  }

  // ── the session ───────────────────────────────────────────────────────────

  function onKeyDown(e) {
    if (!session) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); commitStoryEdit(); return; }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      replace(readSelection() || session.sel, '\t', 'type');
    } else if (mod && !e.altKey && (k === 'z' || k === 'y')) {
      e.preventDefault();
      if (k === 'y' || e.shiftKey) stepBack(session.redo, session.undo); else stepBack(session.undo, session.redo);
    } else if (mod && !e.altKey && !e.shiftKey && (k === 'b' || k === 'i' || k === 'u')) {
      e.preventDefault();
      session.sel = readSelection() || session.sel;
      toggle(k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'underline');
    } else if (mod && e.shiftKey && !e.altKey && (e.code === 'Minus' || e.code === 'NumpadSubtract')) {
      // a discretionary (soft) hyphen: the word may break there, with a hyphen
      e.preventDefault();
      replace(readSelection() || session.sel, String.fromCharCode(0xAD), 'type');
    } else if (mod && e.shiftKey && (e.key === '>' || e.key === '<' || e.code === 'Period' || e.code === 'Comma')) {
      // Affinity: Ctrl+Shift+> / < make the text larger / smaller
      e.preventDefault();
      session.sel = readSelection() || session.sel;
      const up = e.key === '>' || e.code === 'Period';
      const size = SC.charSummary(session.box.story, session.sel).attrs.sizePt;
      applyCharToSession({ sizePt: Math.max(1, Math.round((size + (up ? 1 : -1)) * 100) / 100) });
    }
    e.stopPropagation();   // typing is the editor's, not the app's hotkeys
  }

  function onCopy(e, cut) {
    if (!session) return;
    const r = SC.ordered(readSelection() || session.sel);
    if (SC.collapsed(r)) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', SC.toText(SC.slice(session.box.story, r)));
    if (cut) remove(r, null);
  }

  function onPaste(e) {
    if (!session) return;
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') || '';
    if (text) replace(readSelection() || session.sel, text.replace(/\r\n?/g, '\n'), null);
  }

  function onCompositionStart() {
    if (!session) return;
    session.composing = true;
    session.compRange = SC.ordered(readSelection() || session.sel);
  }
  function onCompositionEnd(e) {
    if (!session) return;
    session.composing = false;
    const r = session.compRange || SC.ordered(session.sel);
    session.compRange = null;
    replace(r, e.data || '', null);
  }

  function onFocus() { setHighlight(null); }
  function onBlur() { if (session) setHighlight(session.sel); }

  // Begin editing a story box. `at` = { x, y } (client px) puts the caret
  // where the user clicked; `selectAll` selects all of its text.
  function enterStoryEdit(box, at = null, { selectAll = false } = {}) {
    if (!box?.textMode) return;
    if (session?.box === box) return;
    if (session) commitStoryEdit();
    if (typeof exitMicroTypo === 'function') exitMicroTypo();
    if (typeof commitInlineEdit === 'function') commitInlineEdit();

    session = { box, flow: null, sel: null, pending: null, undo: [], redo: [], step: window.utbUndo?.capture([box]),
      composing: false, compRange: null, lastKind: null, lastAt: 0 };
    utbState.editingId = box.id;
    utbState.selectedId = box.id;
    window.selectBoxInSVG?.(box.id);
    window.renderBox?.(box);
    const flow = session.flow = flowOf(box);
    if (!flow) { session = null; utbState.editingId = null; return; }
    groupOf(box)?.classList.add('editing');
    flow.setAttribute('contenteditable', 'true');
    flow.spellcheck = false;
    for (const [type, fn] of LISTENERS) flow.addEventListener(type, fn);

    const end = SC.endPos(box.story);
    session.sel = selectAll ? SC.whole(box.story) : { start: end, end };
    if (at && typeof document.caretPositionFromPoint === 'function') {
      const cp = document.caretPositionFromPoint(at.x, at.y);
      const pos = cp && domToPos(flow, cp.offsetNode, cp.offset);
      if (pos) session.sel = { start: pos, end: pos };
    }
    flow.focus({ preventScroll: true });
    showSelection();
    window.syncToolbarToBox?.(box);
    notify();
  }

  function commitStoryEdit() {
    const s = session;
    if (!s) return;
    session = null;
    setHighlight(null);
    if (s.flow) {
      for (const [type, fn] of LISTENERS) s.flow.removeEventListener(type, fn);
      s.flow.removeAttribute('contenteditable');
    }
    groupOf(s.box)?.classList.remove('editing');
    if (utbState.editingId === s.box.id) utbState.editingId = null;
    window.storySync?.(s.box);
    window.renderBox?.(s.box);
    window.utbUndo?.commit(s.step, 'edit text');
    try { if (s.flow?.contains(getSelection().anchorNode)) getSelection().removeAllRanges(); } catch { /* nothing selected */ }
    notify();
  }

  const LISTENERS = [
    ['beforeinput', onBeforeInput],
    ['keydown', onKeyDown],
    ['copy', e => onCopy(e, false)],
    ['cut', e => onCopy(e, true)],
    ['paste', onPaste],
    ['compositionstart', onCompositionStart],
    ['compositionend', onCompositionEnd],
    ['focus', onFocus],
    ['blur', onBlur],
    // the caret is placed by the browser, not by a drag of the box
    ['mousedown', e => e.stopPropagation()],
    ['dblclick', e => e.stopPropagation()],
  ];

  document.addEventListener('selectionchange', () => {
    if (!session || session.composing) return;
    const flow = session.flow;
    if (!flow || !(document.activeElement === flow || flow.contains(document.activeElement))) return;
    const s = readSelection();
    if (!s) return;
    const moved = !session.sel || SC.cmp(s.start, session.sel.start) || SC.cmp(s.end, session.sel.end);
    session.sel = s;
    if (moved) { session.pending = null; session.lastKind = null; notify(); }
  });

  // A press outside the edited box — on the page, on another box — ends the
  // session; the ribbon, the tool column and the Text panel do not.
  document.addEventListener('mousedown', e => {
    if (!session) return;
    const t = e.target;
    if (groupOf(session.box)?.contains(t)) return;
    if (t.closest?.('#unified-options-bar-container, #tool-column, .tt-studio, .floating-panel, #ribbon-overflow, #tools-sidebar')) return;
    commitStoryEdit();
  }, true);

  // ── what the panels read and write ────────────────────────────────────────

  const listeners = [];
  let notifyQueued = false;
  function notify() {
    if (notifyQueued) return;
    notifyQueued = true;
    requestAnimationFrame(() => {
      notifyQueued = false;
      for (const fn of listeners) { try { fn(); } catch (err) { console.warn('story listener', err); } }
    });
  }

  // The text the character and paragraph settings act on: { box, editing,
  // range } — range null means all of the box's text.
  function storyTarget() {
    if (session) return { box: session.box, editing: true, range: SC.ordered(session.sel) };
    const box = utbState.selectedId ? utbState.getBox(utbState.selectedId) : null;
    return box ? { box, editing: false, range: null } : null;
  }

  // The effective character attributes there, and the mixed keys.
  function storyCharState(box) {
    if (!box?.story) return null;
    if (session?.box === box) {
      const sum = SC.charSummary(box.story, session.sel);
      if (SC.collapsed(SC.ordered(session.sel)) && session.pending) sum.attrs = { ...sum.attrs, ...session.pending };
      return sum;
    }
    return SC.charSummary(box.story, null);
  }
  function storyParaState(box) {
    if (!box?.story) return null;
    return SC.paraSummary(box.story, session?.box === box ? session.sel : null);
  }

  // Character attributes onto what is selected. A plain box (no story yet)
  // becomes Artistic text first. `key` collapses repeated changes (a slider)
  // into one undo step.
  function storyApplyChar(box, patch, key = null) {
    if (!box) return;
    if (session?.box === box) { applyCharToSession(patch); return; }
    const step = window.utbUndo?.capture([box]);
    window.ensureStory?.(box);
    box.story = SC.applyChar(box.story, null, patch);
    window.storySync?.(box);
    window.renderBox?.(box);
    window.utbUndo?.commit(step, 'format', key);
    notify();
  }
  // A change of the whole story (or of the session's selection): `op(story,
  // range)` → story. What Change Case and the size steps go through.
  function storyTransform(box, op, label, key = null) {
    if (!box) return;
    if (session?.box === box) {
      const r = SC.ordered(session.sel);
      if (SC.collapsed(r)) return;
      change(op(box.story, r), session.sel, null);
      return;
    }
    const step = window.utbUndo?.capture([box]);
    window.ensureStory?.(box);
    box.story = op(box.story, null);
    window.storySync?.(box);
    window.renderBox?.(box);
    window.utbUndo?.commit(step, label, key);
    notify();
  }
  function storyMapChar(box, fn, key = null) {
    if (session?.box === box && SC.collapsed(SC.ordered(session.sel))) {
      // a caret: what is typed next takes it
      const a = { ...SC.charSummary(box.story, session.sel).attrs, ...(session.pending || {}) };
      session.pending = { ...(session.pending || {}), ...fn(a) };
      notify();
      return;
    }
    storyTransform(box, (s, r) => SC.mapChar(s, r, fn), 'format', key);
  }
  function storyChangeCase(box, mode) {
    storyTransform(box, (s, r) => SC.changeCase(s, r, mode), 'change case');
  }

  function storyApplyPara(box, patch, key = null) {
    if (!box) return;
    if (session?.box === box) {
      change(SC.applyPara(box.story, session.sel, patch), session.sel, null);
      return;
    }
    const step = window.utbUndo?.capture([box]);
    window.ensureStory?.(box);
    box.story = SC.applyPara(box.story, null, patch);
    window.storySync?.(box);
    window.renderBox?.(box);
    window.utbUndo?.commit(step, 'paragraph', key);
    notify();
  }
  function storyApplyFrame(box, patch, key = null) {
    if (!box?.textMode) return;
    const step = session?.box === box ? null : window.utbUndo?.capture([box]);
    box.frame = SC.clean({ ...SC.frameOf(box.frame), ...patch }, SC.FRAME_DEFAULTS);
    window.renderBox?.(box);
    if (step) window.utbUndo?.commit(step, 'text frame', key);
    if (session?.box === box) showSelection();
    notify();
  }

  window.storyAfterRender = box => { if (session?.box === box) showSelection(); };
  window.enterStoryEdit = enterStoryEdit;
  window.commitStoryEdit = commitStoryEdit;
  window.storyTarget = storyTarget;
  window.storyCharState = storyCharState;
  window.storyParaState = storyParaState;
  window.storyApplyChar = storyApplyChar;
  window.storyApplyPara = storyApplyPara;
  window.storyApplyFrame = storyApplyFrame;
  window.storyMapChar = storyMapChar;
  window.storyChangeCase = storyChangeCase;
  window.storyTransform = storyTransform;
  window.storyEditing = () => session?.box || null;
  window.onStoryChange = fn => listeners.push(fn);
  window.storyNotify = notify;

  window.PDFHooks?.on('document:opening', () => { session = null; setHighlight(null); });
})();
