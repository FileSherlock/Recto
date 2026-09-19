/* WebGL Mask Overlays extracted from pdf-viewer.js */
const webglContexts = new Map();
// pageNum -> mask Blob (a PNG from mask-worker.js), or null when the page has
// no redactions. Lives for the duration of a document, so page turns never
// re-run the detection. Owned by the document identified by
// maskCacheHash — validated against state.docHash on every use, because a
// page overlay can initialize before any document-change event lands here.
const maskBlobCache = new Map();
let maskCacheHash = null;

const webglObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    const pageNum = parseInt(entry.target.dataset.pageNum);
    const canvas = entry.target.querySelector('.webgl-overlay');

    if (entry.isIntersecting) {
      if (!webglContexts.has(pageNum) && canvas) {
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

function destroyWebGLOverlay(pageNum) {
  const ctx = webglContexts.get(pageNum);
  if (!ctx) return;
  if (ctx.gl) {
    const loseCtx = ctx.gl.getExtension('WEBGL_lose_context');
    if (loseCtx) loseCtx.loseContext();
  }
  webglContexts.delete(pageNum);
}

// ── The mask worker ────────────────────────────────────────────
// mask-worker.js runs mask-core.js (the port of the server's masking) off the
// main thread. Only pages that carry a scan are masked — a born-digital page
// (shown as a render) has none, as on the server. An image document is its own
// scan: Doc has no pixels for it, so the worker decodes the page image itself.
let maskWorker = null, maskJobId = 0;
const maskJobs = new Map();   // id -> resolve

function maskWorkerReady() {
  if (maskWorker) return maskWorker;
  const absolute = path => new URL(assetURL(path), document.baseURI).href;
  maskWorker = new Worker(assetURL('plugins/webgl_mask/mask-worker.js'));
  maskWorker.onmessage = e => {
    const resolve = maskJobs.get(e.data.id);
    maskJobs.delete(e.data.id);
    if (e.data.error) console.warn('webgl_mask: mask failed', e.data.error);
    resolve?.(e.data.png || null);
  };
  maskWorker.onerror = e => {
    console.warn('webgl_mask: mask worker failed', e.message);
    for (const resolve of maskJobs.values()) resolve(null);
    maskJobs.clear();
  };
  maskWorker.postMessage({ type: 'init', core: absolute('plugins/webgl_mask/mask-core.js') });
  return maskWorker;
}

async function buildPageMask(pageNum) {
  let raster = null, image = null;
  try {
    raster = await Doc.pagePixels(pageNum, { gray: true });
    if (!raster) image = await (await fetch(await Doc.pageImageURL(pageNum))).blob();   // an image document
  } catch { /* the document went away */ }
  if (raster ? raster.source !== 'embedded' : !image) return null;
  return new Promise(resolve => {
    const id = ++maskJobId;
    maskJobs.set(id, resolve);
    if (raster) maskWorkerReady().postMessage({ id, gray: raster.samples, width: raster.width, height: raster.height }, [raster.samples.buffer]);
    else maskWorkerReady().postMessage({ id, image });
  });
}

async function initWebGLOverlay(canvas, pageNum) {
  try {
    webglContexts.set(pageNum, { loading: true });

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
        webglContexts.delete(pageNum);
        return;
      }
      maskBlobCache.set(pageNum, blob);
    }
    if (!blob) {
      webglContexts.delete(pageNum);
      return;
    }

    const img = new Image();
    img.onload = () => {
      if (!webglContexts.has(pageNum)) return; // Was destroyed before load

      const pageImg = document.getElementById(`page${pageNum}`);
      if (!pageImg) {
        webglContexts.delete(pageNum);
        return;
      }

      const proceed = () => {
        if (!webglContexts.has(pageNum)) return;

        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.style.mixBlendMode = 'normal';

        const gl = canvas.getContext('webgl', { antialias: false }) || canvas.getContext('experimental-webgl', { antialias: false });
        if (!gl) {
          webglContexts.delete(pageNum);
          return;
        }

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
            vec3 page = texture2D(uPage, vTexCoord).rgb;
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
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pageImg);

        const maskTexture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, maskTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, img);

        gl.uniform1i(gl.getUniformLocation(program, "uPage"), 0);
        gl.uniform1i(gl.getUniformLocation(program, "uMask"), 1);

        gl.disable(gl.BLEND);

        const uStrengthLoc = gl.getUniformLocation(program, "uStrength");

        webglContexts.set(pageNum, { gl, program, uStrengthLoc });

        requestAnimationFrame(() => {
          updateWebGLUniforms(pageNum);
          const isActive = document.getElementById('toggle-webgl')?.classList.contains('active');
          if (isActive) canvas.style.display = 'block';
        });
      };

      if (pageImg.complete) {
        proceed();
      } else {
        pageImg.addEventListener('load', proceed, { once: true });
      }
    };
    img.src = URL.createObjectURL(blob);
  } catch (e) {
    console.error("Could not load mask", e);
    canvas.remove();
    webglContexts.delete(pageNum);
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
  const webglActive = document.getElementById('toggle-webgl')?.classList.contains('active');

  document.querySelectorAll('.page-container').forEach(pageContainer => {
    const pageNum = parseInt(pageContainer.dataset.pageNum);
    const canvas = pageContainer.querySelector('.webgl-overlay');
    if (!canvas) return;

    if (!webglContexts.has(pageNum)) {
      initWebGLOverlay(canvas, pageNum);
    } else if (webglContexts.get(pageNum)?.gl) {
      updateWebGLUniforms(pageNum);
      canvas.style.display = webglActive ? 'block' : 'none';
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
  const active = document.getElementById('toggle-webgl')?.classList.contains('active');
  canvas.style.display = active ? 'block' : 'none';
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
    toggleBtn.addEventListener('click', () => {
      const isActive = toggleBtn.classList.contains('active');
      document.querySelectorAll('.webgl-overlay').forEach(c => {
        c.style.display = !isActive ? 'block' : 'none';
      });
      if (!isActive) {
        window.openSubtoolbar?.(optionsBar, toggleBtn);
        refreshWebGLCanvases();
      } else {
        window.openSubtoolbar?.(null, null);
      }
    });
  }

  if (edgeSlider) edgeSlider.addEventListener('input', () => updateWebGLUniforms());
});
