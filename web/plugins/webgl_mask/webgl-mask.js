/* WebGL Mask Overlays extracted from pdf-viewer.js */
const webglContexts = new Map();
// pageNum -> mask Blob (a PNG from mask-worker.js), or null when the page has
// no redactions. Lives for the duration of a document, so page turns never
// re-run the detection. Owned by the document identified by
// maskCacheHash — validated against state.docHash on every use, because a
// page overlay can initialize before any document-change event lands here.
const maskBlobCache = new Map();
let maskCacheHash = null;

// Reveal is on: the overlays show, and a page's mask is built when the page
// comes into view (not before: detection costs a second or more a page). The
// state is the plugin's own — the button's `active` class only says its
// options bar is the open one, and opening any other bar clears it.
let revealOn = false;

const webglObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    const pageNum = parseInt(entry.target.dataset.pageNum);
    const canvas = entry.target.querySelector('.webgl-overlay');

    if (entry.isIntersecting) {
      if (revealOn && !webglContexts.has(pageNum) && canvas) {
        initWebGLOverlay(canvas, pageNum);
      }
    } else {
      if (webglContexts.has(pageNum)) {
        destroyWebGLOverlay(pageNum);
      }
    }
  });
}, { root: null, rootMargin: '100% 0px', threshold: 0 });

function setupWebGLOverlay(pageContainer, _webglCanvas, pageNum) {
  pageContainer.dataset.pageNum = pageNum;
  webglObserver.observe(pageContainer);
}

function clearWebGLContexts() {
  for (const [, ctx] of webglContexts.entries()) {
    if (ctx && ctx.gl) {
      const loseCtx = ctx.gl.getExtension('WEBGL_lose_context');
      if (loseCtx) loseCtx.loseContext();
    }
  }
  webglContexts.clear();
  webglObserver.disconnect();
}

// A canvas whose context was lost never draws again: getContext() hands the
// same lost context back. The page gets a fresh canvas in its place (same id,
// class and style), drawn on when the page is shown again.
function freshOverlayCanvas(canvas) {
  const fresh = canvas.cloneNode(false);
  canvas.replaceWith(fresh);
  return fresh;
}

function destroyWebGLOverlay(pageNum) {
  const ctx = webglContexts.get(pageNum);
  if (!ctx) return;
  webglContexts.delete(pageNum);
  if (ctx.gl) {
    if (ctx.gl.canvas?.isConnected) freshOverlayCanvas(ctx.gl.canvas);
    ctx.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

// ── The mask worker ────────────────────────────────────────────
// mask-worker.js runs mask-core.js off the main thread. Only pages that carry
// a scan are masked — a born-digital page (shown as a render) has none. An
// image document is its own
// scan: Doc has no pixels for it, so the worker decodes the page image itself.
// One page at a time goes to the worker, the rest wait here: a job the
// document no longer wants (another one opened) or one that runs past
// MASK_TIMEOUT_MS ends with the worker — terminating it is the only way to
// stop a detection — and the next job gets a new one. A page whose detection
// is cut short has no mask.
let maskWorker = null, maskJobId = 0, maskBusy = null, maskGeneration = 0;
const maskQueue = [];          // { id, page, generation, message, transfer, resolve }
const MASK_TIMEOUT_MS = 60000;

function maskWorkerReady() {
  if (maskWorker) return maskWorker;
  const absolute = path => new URL(assetURL(path), document.baseURI).href;
  maskWorker = new Worker(assetURL('plugins/webgl_mask/mask-worker.js'));
  maskWorker.onmessage = e => {
    if (e.data.error) console.warn('webgl_mask: mask failed', e.data.error);
    if (maskBusy && e.data.id === maskBusy.id) maskDone(maskBusy, e.data.png || null);
  };
  maskWorker.onerror = e => {
    console.warn('webgl_mask: mask worker failed', e.message);
    if (maskBusy) maskDone(maskBusy, null);
  };
  maskWorker.postMessage({ type: 'init', core: absolute('plugins/webgl_mask/mask-core.js') });
  return maskWorker;
}

function maskStopWorker() {
  maskWorker?.terminate();
  maskWorker = null;
}

function maskDone(job, png) {
  clearTimeout(job.timer);
  if (maskBusy === job) maskBusy = null;
  job.resolve(png);
  maskNext();
}

function maskNext() {
  while (!maskBusy && maskQueue.length) {
    const job = maskQueue.shift();
    if (job.generation !== maskGeneration) { job.resolve(null); continue; }   // another document's page
    maskBusy = job;
    job.timer = setTimeout(() => {
      console.warn(`webgl_mask: page ${job.page}: no mask — detection ran past ${MASK_TIMEOUT_MS / 1000} s`);
      maskStopWorker();
      maskDone(job, null);
    }, MASK_TIMEOUT_MS);
    maskWorkerReady().postMessage(job.message, job.transfer);
  }
}

async function buildPageMask(pageNum) {
  const generation = maskGeneration;
  let raster = null, image = null;
  try {
    raster = await Doc.pagePixels(pageNum, { gray: true });
    if (!raster) image = await (await fetch(await Doc.pageImageURL(pageNum))).blob();   // an image document
  } catch { /* the document went away */ }
  if (raster ? raster.source !== 'embedded' : !image) return null;
  return new Promise(resolve => {
    const id = ++maskJobId;
    const message = raster ? { id, gray: raster.samples, width: raster.width, height: raster.height } : { id, image };
    maskQueue.push({ id, page: pageNum, generation, message, transfer: raster ? [raster.samples.buffer] : [], resolve });
    maskNext();
  });
}

// Another document: its pages' jobs are dropped, and a detection still running
// for the old one stops with its worker.
PDFHooks.on('document:opening', () => {
  maskGeneration++;
  if (maskBusy) { maskStopWorker(); maskDone(maskBusy, null); }
});

async function initWebGLOverlay(canvas, pageNum) {
  // This run's own entry. The page's overlay can be torn down while its mask
  // is still being built (scrolled away), and a new run started when it comes
  // back: a run that no longer finds its own entry stops, so two runs never
  // set up the same canvas.
  const run = { loading: true };
  const mine = () => webglContexts.get(pageNum) === run;
  try {
    webglContexts.set(pageNum, run);

    if (maskCacheHash !== state.docHash) {
      maskBlobCache.clear();
      maskCacheHash = state.docHash;
    }

    let blob;
    if (maskBlobCache.has(pageNum)) {
      blob = maskBlobCache.get(pageNum);
    } else {
      // Build this page's mask on demand, in the plugin's worker, from the
      // pixels the viewer shows (Doc.pagePixels). null = analysed, no
      // redactions on this page.
      const hash = state.docHash;
      if (!hash) {
        webglContexts.delete(pageNum);
        return;
      }
      blob = await buildPageMask(pageNum);
      if (state.docHash !== hash) {   // document changed mid-flight
        if (mine()) webglContexts.delete(pageNum);
        return;
      }
      maskBlobCache.set(pageNum, blob);
      if (!mine()) return;            // torn down meanwhile: the mask is kept, a newer run (if any) draws it
    }
    if (!blob) {
      webglContexts.delete(pageNum);
      return;
    }

    const img = new Image();
    // The mask's blob: URL is only the way into the <img>: once it has loaded
    // (or failed) the URL goes, or every page turn would leave one behind —
    // and with it a reference that keeps the PNG alive after the cache drops it.
    const maskURL = URL.createObjectURL(blob);
    img.onerror = () => URL.revokeObjectURL(maskURL);
    img.onload = () => {
      URL.revokeObjectURL(maskURL);
      if (!mine()) return; // torn down (or taken over by a newer run) before load

      const pageImg = document.getElementById(`page${pageNum}`);
      if (!pageImg) {
        webglContexts.delete(pageNum);
        return;
      }

      const proceed = () => {
        if (!mine()) return;

        const contextOf = c => c.getContext('webgl', { antialias: false }) || c.getContext('experimental-webgl', { antialias: false });
        let gl = contextOf(canvas);
        if (gl?.isContextLost() && canvas.isConnected) { canvas = freshOverlayCanvas(canvas); gl = contextOf(canvas); }
        if (!gl || gl.isContextLost()) {
          webglContexts.delete(pageNum);
          return;
        }
        // A texture larger than the GPU takes (an 8,300-px scan against 8,192,
        // common on phones) samples as black and blacked the whole page out:
        // past the limit both textures are drawn scaled down to it — the
        // page / (1 − mask) division holds for averages of both alike.
        const limit = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), ...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
        const k = Math.min(1, limit / Math.max(img.naturalWidth, img.naturalHeight));
        const W = Math.max(1, Math.floor(img.naturalWidth * k)), H = Math.max(1, Math.floor(img.naturalHeight * k));
        const fit = source => {
          const sw = source.naturalWidth, sh = source.naturalHeight;
          if (sw === W && sh === H && sw <= limit && sh <= limit) return source;
          const c = document.createElement('canvas');
          c.width = W; c.height = H;
          const g2 = c.getContext('2d');
          g2.imageSmoothingQuality = 'high';
          g2.drawImage(source, 0, 0, W, H);
          return c;
        };
        canvas.width = W;
        canvas.height = H;
        canvas.style.mixBlendMode = 'normal';

        // A context the browser takes away (GPU reset, too many contexts):
        // the page gets a fresh canvas and, while Reveal shows, a new overlay.
        canvas.addEventListener('webglcontextlost', () => {
          if (webglContexts.get(pageNum)?.gl !== gl) return;   // given up by the plugin itself
          webglContexts.delete(pageNum);
          const fresh = canvas.isConnected ? freshOverlayCanvas(canvas) : null;
          if (fresh && revealOn) initWebGLOverlay(fresh, pageNum);
        }, { once: true });

        const vsSource = `
          attribute vec2 aPosition;
          varying vec2 vTexCoord;
          void main() {
            gl_Position = vec4(aPosition, 0.0, 1.0);
            vTexCoord = vec2((aPosition.x + 1.0) / 2.0, 1.0 - (aPosition.y + 1.0) / 2.0);
          }
        `;

        const fsSource = `
          precision mediump float;
          varying vec2 vTexCoord;
          uniform sampler2D uPage;
          uniform sampler2D uMask;
          uniform float uStrength;
          void main() {
            // the page as the viewer shows it: over the page's white (a
            // transparent PNG's paper is transparent black, not black paper)
            vec4 pageRGBA = texture2D(uPage, vTexCoord);
            vec3 page = pageRGBA.rgb * pageRGBA.a + vec3(1.0 - pageRGBA.a);
            float mask = texture2D(uMask, vTexCoord).r;
            vec3 result;
            if (mask > 0.999) {
              // Fully redacted interior (mask == 1.0), or a rim pixel mask-core.js declared
              // paper outright: page ≈ 0 so division recovers nothing — just show white.
              result = vec3(1.0);
            } else {
              // A box's rim (mask = 1 − t, the page shows through as page · t) or a clear
              // pixel: divide t out again, per channel — the page stays in color, and
              // text under the rim comes back as dark as it was.
              result = min(page / max(1.0 - mask, 0.001), 1.0);
            }
            // Reveal Strength fades from the page as it is to the page revealed: linear in
            // brightness for the interior and the rims alike — the box thins out evenly.
            result = mix(page, result, uStrength);
            gl_FragColor = vec4(result, 1.0);
          }
        `;

        function createShader(gl, type, source) {
          const shader = gl.createShader(type);
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          return shader;
        }

        const vertexShader = createShader(gl, gl.VERTEX_SHADER, vsSource);
        const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fsSource);

        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        gl.useProgram(program);

        const positionLocation = gl.getAttribLocation(program, "aPosition");
        const positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
          -1, -1, 1, -1, -1, 1,
          -1, 1, 1, -1, 1, 1
        ]), gl.STATIC_DRAW);

        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

        const pageTexture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, pageTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        // RGBA, not LUMINANCE: the page raster is color (letterhead art,
        // hyperlink blue) and the overlay must not desaturate the view —
        // only the MASK below is inherently single-channel.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, fit(pageImg));

        const maskTexture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, maskTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, fit(img));

        gl.uniform1i(gl.getUniformLocation(program, "uPage"), 0);
        gl.uniform1i(gl.getUniformLocation(program, "uMask"), 1);

        gl.disable(gl.BLEND);

        const uStrengthLoc = gl.getUniformLocation(program, "uStrength");

        webglContexts.set(pageNum, { gl, program, uStrengthLoc });

        requestAnimationFrame(() => {
          updateWebGLUniforms(pageNum);
          if (revealOn) canvas.style.display = 'block';
        });
      };

      if (pageImg.complete) {
        proceed();
      } else {
        pageImg.addEventListener('load', proceed, { once: true });
      }
    };
    img.src = maskURL;
  } catch (e) {
    console.error("Could not load mask", e);
    canvas.remove();
    if (mine()) webglContexts.delete(pageNum);
  }
}



function updateWebGLUniforms(specificPage = null) {
  const edgeSlider = document.getElementById('edge-subtract');
  const strength = edgeSlider ? edgeSlider.value / 255.0 : 1.0;

  const pagesToUpdate = specificPage ? [specificPage] : Array.from(webglContexts.keys());

  pagesToUpdate.forEach(p => {
    const ctx = webglContexts.get(p);
    if (!ctx || !ctx.gl) return;
    const { gl, program, uStrengthLoc } = ctx;
    gl.useProgram(program);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(uStrengthLoc, strength);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  });
}

function refreshWebGLCanvases() {
  document.querySelectorAll('.page-container').forEach(pageContainer => {
    const pageNum = parseInt(pageContainer.dataset.pageNum);
    const canvas = pageContainer.querySelector('.webgl-overlay');
    if (!canvas) return;
    canvas.style.display = revealOn ? 'block' : 'none';

    if (!webglContexts.has(pageNum)) {
      if (revealOn) initWebGLOverlay(canvas, pageNum);   // masks are built for Reveal only
    } else if (webglContexts.get(pageNum)?.gl) {
      updateWebGLUniforms(pageNum);
    }
  });
}


/* ── Plugin lifecycle wiring ───────────────────────────────────
   Every integration point with the core viewer goes through PDFHooks, and
   this plugin owns its overlay canvas + toolbar wiring. Deleting the
   webgl_mask/ folder removes all of it with zero references left in the core. */

// Tear down GL contexts before the viewer swaps pages.
PDFHooks.on('viewer:clear', () => clearWebGLContexts());

// Build this plugin's overlay canvas when the core renders a page.
PDFHooks.on('page:rendered', ({ pageContainer, pageNum }) => {
  const canvas = document.createElement('canvas');
  canvas.id = `webgl-overlay-${pageNum}`;
  canvas.className = 'webgl-overlay';
  canvas.style.position = 'absolute';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvas.style.pointerEvents = 'none';
  canvas.width = state.pageWidth;
  canvas.height = state.pageHeight;
  canvas.style.display = revealOn ? 'block' : 'none';
  pageContainer.appendChild(canvas);

  setupWebGLOverlay(pageContainer, canvas, pageNum);
});

PDFHooks.on('pages:refresh', () => refreshWebGLCanvases());

// No document:loaded work needed: per-page masks are fetched lazily when a
// page's overlay initializes, and the blob cache invalidates itself the
// moment state.docHash changes (see initWebGLOverlay).

// Attach the mask toggle + reveal-strength slider once the core toolbar exists.
PDFHooks.on('ui:ready', () => {
  const toggleBtn = document.getElementById('toggle-webgl');
  const optionsBar = document.getElementById('webgl-options-bar');
  const edgeSlider = document.getElementById('edge-subtract');

  if (toggleBtn) {
    window.registerSubtoolbar?.(toggleBtn);
    // Off → on, with its options bar. On with the bar open → off. On while
    // another bar took the ribbon → its bar again, Reveal stays on (the
    // button keeps the "on" colour, webgl-mask.css).
    toggleBtn.addEventListener('click', () => {
      const barOpen = !optionsBar?.classList.contains('hidden');
      if (revealOn && barOpen) {
        revealOn = false;
        window.openSubtoolbar?.(null, null);
      } else {
        revealOn = true;
        window.openSubtoolbar?.(optionsBar, toggleBtn);
      }
      toggleBtn.classList.toggle('reveal-on', revealOn);
      refreshWebGLCanvases();
    });
  }

  if (edgeSlider) edgeSlider.addEventListener('input', () => updateWebGLUniforms());
});
