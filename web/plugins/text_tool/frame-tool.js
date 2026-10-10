// frame-tool.js — Affinity's Frame Text Tool.
//
// "Add a text frame which acts as a container for paragraph text. |DRAG| to
// create Frame text. |CLICK| an object to select it." Armed from the tool
// column (#tt-frame-text-btn) it stays armed, as Affinity's tools do, until
// it is clicked again or another placing tool is chosen:
//
//   - a drag on the page draws a frame and puts the caret in it. Shift keeps
//     it square, Ctrl draws it from the centre (Affinity's modifiers on
//     Windows); the arrow keys during the drag make a grid of frames — Left /
//     Right one column fewer / more, Down / Up one row more / fewer — and with
//     Ctrl held they widen or narrow the gap between them;
//   - a press that does not drag creates nothing (Affinity makes no frame of
//     zero size): on an object it selects it, on the page it deselects;
//   - a press on Artistic or Frame text puts the caret there (drag-resize.js);
//   - Escape leaves the text being edited (story-edit.js), then deselects, and
//     with nothing selected puts the tool down.
//
// A frame is a 'harfbuzz' box (text the user added — never hidden with the
// extracted layers) with textMode 'frame'; its first characters take the
// ribbon's font and size, as the Add Text tool's do.
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SC = globalThis.StoryCore;
  const btn = document.getElementById('tt-frame-text-btn');
  if (!btn || !SC) return;

  const OTHER_TOOLS = ['tool-add-box'];
  const armed = () => state.activeTool === 'frame-text';

  function arm(on) {
    if (on) {
      state.activeTool = 'frame-text';
      for (const id of OTHER_TOOLS) document.getElementById(id)?.classList.remove('active');
      els.viewer.style.cursor = 'crosshair';
    } else if (armed()) {
      state.activeTool = null;
      els.viewer.style.cursor = 'default';
    }
    btn.classList.toggle('active', armed());
  }
  btn.addEventListener('click', () => arm(!armed()));
  // the other placing tools take over (their own handlers set state.activeTool)
  for (const id of OTHER_TOOLS) document.getElementById(id)?.addEventListener('click', () => btn.classList.remove('active'));

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !armed() || utbState.editingId || drawing) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
    if (utbState.selectedId) {
      utbState.selectedId = null;
      deselectAllInSVG();
      document.getElementById('fabric-options-bar')?.classList.add('hidden');
      window.syncToolbarToSelection?.();
      return;
    }
    arm(false);
  });

  function toDoc(svg, e) {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }

  // ── drawing a frame (or a grid of them) ──────────────────────────────────

  let drawing = null;   // { svg, pageNum, a, last, cols, rows, gap, preview: <g> }

  // The rectangle the pointer spans, with Affinity's modifiers.
  function spanned(d, ev) {
    const b = toDoc(d.svg, ev);
    let w = b.x - d.a.x, h = b.y - d.a.y;
    if (ev.shiftKey) { const s = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s; }
    let x = Math.min(d.a.x, d.a.x + w), y = Math.min(d.a.y, d.a.y + h);
    w = Math.abs(w); h = Math.abs(h);
    if (ev.ctrlKey || ev.metaKey) { x = d.a.x - w; y = d.a.y - h; w *= 2; h *= 2; }
    return { x, y, w, h };
  }

  // The frames of the grid inside a rectangle: cols × rows, gap between them.
  function cells(r, cols, rows, gap) {
    const w = (r.w - gap * (cols - 1)) / cols, h = (r.h - gap * (rows - 1)) / rows;
    const out = [];
    if (w <= 0 || h <= 0) return out;
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) out.push({ x: r.x + i * (w + gap), y: r.y + j * (h + gap), w, h });
    return out;
  }

  function drawPreview(d) {
    d.preview.replaceChildren();
    if (!d.rect) return;
    for (const c of cells(d.rect, d.cols, d.rows, d.gap)) {
      const r = document.createElementNS(SVG_NS, 'rect');
      r.classList.add('tt-frame-draft');
      r.setAttribute('x', c.x); r.setAttribute('y', c.y);
      r.setAttribute('width', c.w); r.setAttribute('height', c.h);
      d.preview.appendChild(r);
    }
  }

  els.viewer.addEventListener('mousedown', e => {
    if (!armed() || e.button !== 0) return;
    if (e.target.closest('.utb-group')) return;              // an object: drag-resize.js selects / edits it
    const pageEl = e.target.closest('.page-container');
    const svg = pageEl?.querySelector('svg.text-layer');
    if (!svg) return;
    e.preventDefault();
    window.commitStoryEdit?.();
    const preview = document.createElementNS(SVG_NS, 'g');
    svg.appendChild(preview);
    const d = drawing = {
      svg, pageNum: parseInt(pageEl.id.replace('pageContainer', ''), 10), a: toDoc(svg, e),
      last: e, rect: null, cols: 1, rows: 1, gap: 0, preview,
    };

    function onMove(ev) {
      d.last = ev;
      d.rect = spanned(d, ev);
      drawPreview(d);
    }
    function onKey(ev) {
      const k = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[ev.key];
      if (!k) { if (ev.key === 'Escape') { ev.preventDefault(); end(false); } return; }
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.ctrlKey || ev.metaKey) {
        // the gap between the frames, a nudge at a time (1 px; Shift: 10)
        d.gap = Math.max(0, d.gap + (k[0] || -k[1]) * (ev.shiftKey ? 10 : 1));
      } else {
        d.cols = Math.max(1, d.cols + k[0]);
        d.rows = Math.max(1, d.rows + k[1]);
      }
      d.rect = spanned(d, d.last);
      drawPreview(d);
    }
    function end(commit) {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey, true);
      preview.remove();
      drawing = null;
      const min = 4 / (state.currentZoom || 1);
      if (!commit || !d.rect || d.rect.w < min || d.rect.h < min) return;
      const frames = cells(d.rect, d.cols, d.rows, d.gap).filter(c => c.w >= 1 && c.h >= 1);
      // a drag that starts on a line of the page takes its face, style and size
      if (frames.length) createFrames(d.pageNum, frames, window.utbFindNearestLine?.(d.pageNum, d.a));
    }
    const onUp = () => end(true);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey, true);
  });

  // One frame per rectangle; the caret goes into the first.
  function createFrames(pageNum, rects, near = null) {
    const family = near?.font || document.getElementById('fabric-font-family')?.value || 'Times New Roman';
    const sizePt = near?.sizePt || parseFloat(document.getElementById('fabric-font-size')?.value) || 12;
    const bold = !!near?.bold, italic = !!near?.italic;
    const boxes = rects.map(r => {
      const box = utbState.addBox(new UnifiedTextBox({
        type: 'harfbuzz',
        page: pageNum,
        text: '',
        x: r.x, y: r.y, w: Math.max(r.w, 8), h: Math.max(r.h, 8),
        fontFamily: family,
        bold,
        italic,
        sizePt,
        kerning: true,
        textMode: 'frame',
        // Affinity's default fill is black (a plain typed box keeps Recto's orange)
        story: SC.fromText('', { fontFamily: family, bold, italic, sizePt, color: '#000000' }),
        frame: {},
      }));
      window.storySync?.(box);
      renderBox(box);
      return box;
    });
    window.utbUndo?.recordAdd(boxes, boxes.length > 1 ? 'add text frames' : 'add text frame');
    utbState.selectedId = boxes[0].id;
    selectBoxInSVG(boxes[0].id);
    window.enterStoryEdit?.(boxes[0]);
    return boxes;
  }

  window.createTextFrame = (pageNum, rect) => createFrames(pageNum, [rect])[0];
})();
