/* Zoom Handlers */
function updateZoomLevelText() { els.zoomInputElem.value = `${Math.round(state.currentZoom * 100)}%`; }

function updateCSSZoom() {
  els.viewer.style.setProperty('--scale-factor', state.currentZoom);
  els.viewer.classList.toggle('zoom-in', state.currentZoom > 1.0);
  updateZoomLevelText();
  PDFHooks.emit('zoom:changed', { zoom: state.currentZoom });
}

function processZoomFromText(newZoom, mouseX = null, mouseY = null) {
  const constrainedZoom = Math.min(Math.max(newZoom, state.minZoom), state.maxZoom);
  if (constrainedZoom !== state.currentZoom) {
    const prevZoom = state.currentZoom;
    state.currentZoom = constrainedZoom;

    if (mouseX !== null && mouseY !== null) {
      const docX = (els.viewerContainer.scrollLeft + mouseX) / prevZoom;
      const docY = (els.viewerContainer.scrollTop + mouseY) / prevZoom;

      updateCSSZoom();
      els.viewerContainer.scrollLeft = (docX * state.currentZoom) - mouseX;
      els.viewerContainer.scrollTop = (docY * state.currentZoom) - mouseY;
    } else {
      updateCSSZoom();
    }
  } else {
    updateZoomLevelText();
  }
}

// No canvas re-render needed — the page is a static <img> that scales via CSS.

// SVG-native drag and resize is handled entirely by drag-resize.js.

/* Thumbnails */
function renderThumbnails() {
  els.thumbnailView.innerHTML = '';

  // Fixed dimensions + lazy loading: on a multi-thousand-page document only
  // the thumbnails scrolled into view are ever made (Doc.pageImageURL with
  // { thumb: true } — a small downscale of the page raster).
  renderThumbnails.observer?.disconnect();
  const hash = state.docHash;
  const observer = renderThumbnails.observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target;
      observer.unobserve(img);
      Doc.pageImageURL(+img.dataset.page, { thumb: true })
        .then(url => { if (hash === state.docHash) img.src = url; })
        .catch(() => { /* the document changed, or the page has no raster */ });
    }
  }, { root: els.thumbnailView, rootMargin: '400px 0px' });
  const thumbH = Math.round(180 * (state.pageHeight / (state.pageWidth || 1))) || 233;

  for (let i = 1; i <= state.numPages; i++) {
    const thumbCont = document.createElement('div');
    thumbCont.className = 'thumbnail-container' + (i === state.currentPage ? ' active' : '');

    const img = document.createElement('img');
    img.dataset.page = i;
    img.decoding = 'async';
    img.className = 'thumbnail';
    img.draggable = false;
    img.style.width = '180px';
    img.style.height = `${thumbH}px`;
    img.style.display = 'block';

    const lbl = document.createElement('div');
    lbl.className = 'thumbnail-page-num';
    lbl.textContent = i;

    thumbCont.appendChild(img);
    thumbCont.appendChild(lbl);
    els.thumbnailView.appendChild(thumbCont);

    thumbCont.addEventListener('click', () => goToPage(i));
    observer.observe(img);
  }
}