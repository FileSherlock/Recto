/* =========================================================
      PDF Viewer — single-page, PNG-based (no PDF.js)
      The document service (doc-service.js → a MuPDF worker)
      opens the document in the browser and hands out each
      page's raster — its own scan, or a 96-dpi render — on
      demand as a blob: URL (Doc.pageImageURL) — opening yields
      metadata only, so huge documents open instantly and the
      browser only ever holds the pages it shows. Each page is
      shown in its own pixel space (Doc.pageSize: 816×1056 for
      a US-Letter scan), and all coordinates of a page are in
      that space.
      ========================================================= */

// Open a document and bring it on screen. The first page shows as soon as the
// document service knows the page geometry (its `early` call); the typography
// pass — declared fonts, sampled body size — finishes behind it, and only then
// is 'document:loaded' announced. `file` is the user's File, null for the
// startup document. 'document:opening' goes out first: between it and
// 'document:loaded' the viewer already shows the new document's pages.
async function openDocument(source, name, file) {
  const turn = openDocument.turn = (openDocument.turn || 0) + 1;
  const check = () => { if (turn !== openDocument.turn) throw new Error('another document was opened meanwhile'); };
  try {
    // Before anything changes: per-document plugin state (a finished flag, a
    // run in progress) belongs to the document that is about to go away.
    await PDFHooks.emit('document:opening', { file, name, isDefault: !file });
    check();
    let shown = null;
    const data = await Doc.open(source, name, { early: info => { if (turn === openDocument.turn) shown = showDocument(info, turn); } });
    check();
    await (shown || showDocument(data, turn));
    check();
    await announceDocument(data, file);
    return data;
  } catch (e) {
    // An open that a later one overtook fails too ("another document was
    // opened meanwhile"); the caller must not report that one — the screen
    // belongs to the later open.
    e.superseded = turn !== openDocument.turn;
    throw e;
  }
}

// Nothing is open — what a failed open leaves behind. Doc.open() closed the
// previous document before it tried the new one, and plugins dropped their
// per-document state on 'document:opening'; the old page cannot stay up, it
// would look open while every page request fails.
function showNoDocument(message) {
  Doc.close();
  goToPage.turn = (goToPage.turn || 0) + 1;      // a page still on its way in is not shown
  state.numPages = 0;
  state.currentPage = 1;
  state.docHash = null;
  state.pxPerPt = null;
  state.hasPdf = false;
  state.currentFile = null;
  if (typeof utbState !== 'undefined') {
    utbState.reset();
    if (typeof clearAllSVGLayers === 'function') clearAllSVGLayers();
  }
  PDFHooks.emit('viewer:clear');

  els.titleElem.textContent = 'No PDF Loaded';
  els.pageCountElem.textContent = '/ 0';
  els.pageInputElem.value = 0;
  els.pageInputElem.max = 0;
  els.pdfFile.value = '';                        // the same file can be chosen again
  renderThumbnails();                            // none

  els.viewer.innerHTML = '';
  if (!els.placeholder) return;
  els.loader?.classList.add('hidden');
  els.placeholder.querySelector('.material-symbols-outlined')?.classList.remove('hidden');
  if (els.placeholderText) {
    els.placeholderText.textContent = message || 'Open a PDF or image to begin.';
    els.placeholderText.classList.toggle('error', !!message);
    els.placeholderText.classList.remove('hidden');
  }
  els.placeholder.classList.remove('hidden');
  els.viewer.appendChild(els.placeholder);
}

// `data` is Doc.open()'s result (or its early form). Page rasters are not part
// of it: whoever shows a page — the viewer, a thumbnail scrolled into view, an
// OCR pass — asks Doc.pageImageURL(n) at that moment.
async function showDocument(data, turn) {
  state.numPages = 0;
  if (typeof utbState !== 'undefined') {
    utbState.reset();
    if (typeof clearAllSVGLayers === 'function') clearAllSVGLayers();
  }
  state.numPages = data.numPages || 1;
  state.pageWidth = data.pageWidth || GEO.PAGE_WIDTH_PX;       // page 1's; goToPage sets each page's own
  state.pageHeight = data.pageHeight || GEO.PAGE_HEIGHT_PX;
  state.pxPerPt = data.pxPerPt || state.pageWidth / GEO.PAGE_WIDTH_PT;
  state.docHash = data.sha256 || null;

  els.pageCountElem.textContent = `/ ${state.numPages}`;
  els.pageInputElem.value = 1;
  els.pageInputElem.max = state.numPages;

  await goToPage(1);
  if (turn && turn !== openDocument.turn) return;
  renderThumbnails();
}

async function announceDocument(data, file) {
  const autoSize = data.suggestedSize || 12;  // points, sampled from the leading pages

  if (typeof renderAllTextLayers === 'function') renderAllTextLayers();

  // Lifecycle: let plugins react to a freshly loaded document. Plugins that add
  // their own boxes or overlays hang off this event — the core names none of
  // them. `file === null` on the auto-loaded sample doc; `pdfFonts` are the
  // document's declared BaseFont names (most used first) and `sizePt` its
  // sampled body size — the facts a typography plugin turns into a default
  // face (the core keeps no font list of its own).
  await PDFHooks.emit('document:loaded', {
    file,
    isDefault: !file,
    pdfFonts: data.pdfFonts || [],
    sizePt: autoSize,
  });

  if (typeof renderAllTextLayers === 'function') renderAllTextLayers();
}

async function handleFileUpload(e) {
  const file = els.pdfFile.files[0] || (e && e.dataTransfer && e.dataTransfer.files[0]);
  if (!file) return;
  state.hasPdf = (file.name || '').split('.').pop().toLowerCase() === 'pdf';
  state.currentFile = file;
  els.titleElem.textContent = file.name;

  // Premium: Show loader and hide placeholder icons (the placeholder is on
  // screen only while nothing is open — otherwise the old page stays up
  // until the new one replaces it)
  const placeholder = els.placeholder;
  const loader = els.loader;
  const placeholderIcon = placeholder?.querySelector('.material-symbols-outlined');
  const placeholderText = els.placeholderText;

  if (loader) loader.classList.remove('hidden');
  if (placeholderText) placeholderText.classList.add('hidden');
  if (placeholderIcon) placeholderIcon.classList.add('hidden');

  try {
    await openDocument(file, file.name, file);

    // Hide placeholder entirely once loaded
    if (placeholder) placeholder.classList.add('hidden');
  } catch (e) {
    if (e.superseded) return;                    // a later open owns the screen, and reports its own outcome
    console.error('Error opening document:', e.message);
    showNoDocument(`Could not open ${file.name}: ${e.message}`);
  }
}


async function goToPage(pageNum) {
  if (!state.numPages || !Doc.info) return;
  pageNum = Math.max(1, Math.min(pageNum, state.numPages));

  // The raster first (a blob: URL from the document service), so the page
  // enters the DOM with its image and plugins reading #page<n> find pixels;
  // with it the page's own pixel space (pages of one document may differ).
  // A later goToPage() or another document overtakes this one while it waits.
  const turn = goToPage.turn = (goToPage.turn || 0) + 1;
  const hash = state.docHash;
  let src, size;
  try { [src, size] = await Promise.all([Doc.pageImageURL(pageNum), Doc.pageSize(pageNum)]); }
  catch (e) {
    console.error(`Page ${pageNum}:`, e.message);
    if (turn === goToPage.turn && hash === state.docHash) showPageError(pageNum, e.message);
    return;
  }
  if (turn !== goToPage.turn || hash !== state.docHash) return;

  showPage(pageNum);
  state.pageWidth = size.width;
  state.pageHeight = size.height;

  // Page container — dimensions match the page's pixel space
  const pageContainer = document.createElement('div');
  pageContainer.className = 'page-container';
  pageContainer.id = `pageContainer${pageNum}`;
  pageContainer.style.setProperty('--page-width', `${state.pageWidth}px`);
  pageContainer.style.setProperty('--page-height', `${state.pageHeight}px`);

  // Original embedded image as the page background
  const img = document.createElement('img');
  img.id = `page${pageNum}`;
  img.src = src;
  img.draggable = false;
  img.style.display = 'block';
  img.style.width = '100%';
  img.style.height = '100%';
  pageContainer.appendChild(img);

  els.viewer.appendChild(pageContainer);

  // Lifecycle: plugins draw their per-page overlays (webgl mask canvas, SVG
  // text layer, …) in response to this event. The core owns no overlay DOM.
  PDFHooks.emit('page:rendered', { pageContainer, pageNum });
  PDFHooks.emit('pages:refresh');
}

// The viewer turns to page `pageNum`: the old page's overlays and DOM go, the
// page number, scroll and active thumbnail follow.
function showPage(pageNum) {
  PDFHooks.emit('viewer:clear');

  state.currentPage = pageNum;
  els.pageInputElem.value = pageNum;
  els.viewer.innerHTML = '';
  els.viewerContainer.scrollTop = 0;
  updateCSSZoom();

  document.querySelectorAll('.thumbnail-container').forEach((c, i) => {
    c.classList.toggle('active', i + 1 === pageNum);
  });
}

// A page that cannot be shown says so in its place — the page before it does
// not stay up under another page number (or another document's title). The
// other pages still show; no 'page:rendered', as there is no page to draw on.
function showPageError(pageNum, message) {
  showPage(pageNum);
  const box = document.createElement('div');
  box.className = 'page-error';
  const icon = document.createElement('span');
  icon.className = 'material-symbols-outlined';
  icon.textContent = 'broken_image';
  const text = document.createElement('p');
  text.textContent = `Page ${pageNum} cannot be shown: ${message}`;
  box.append(icon, text);
  els.viewer.appendChild(box);
}


