// mask-worker.js — builds page masks off the main thread (webgl_mask's own worker).
//
//   → { type: 'init', core }                          the content-hashed URL of mask-core.js
//   → { id, gray: Uint8Array, width, height }         one page's gray pixels (transferred)
//   → { id, image: Blob }                             or the page image of an image document, decoded here
//   ← { id, png: Blob | null, ms }                    the mask as a lossless PNG; null = no redaction on the page
//
// The mask goes back as a PNG blob because that is what the overlay loads into
// its texture; gray v is written as (v, v, v, 255), so nothing is premultiplied
// away and the texture's red channel is the mask.
'use strict';

self.onmessage = async e => {
  const m = e.data;
  if (m.type === 'init') { importScripts(m.core); return; }
  try {
    const t0 = performance.now();
    if (m.image) {
      // An image document's page: decoded here, on white — a transparent pixel
      // shows the paper-white page behind it, it is not black.
      const bitmap = await createImageBitmap(m.image);
      m.width = bitmap.width; m.height = bitmap.height;
      const ctx = new OffscreenCanvas(m.width, m.height).getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, m.width, m.height);
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      m.gray = MaskCore.grayOf(ctx.getImageData(0, 0, m.width, m.height).data);
    }
    const mask = MaskCore.buildMask(m.gray, m.width, m.height);
    let png = null;
    if (mask) {
      const rgba = new Uint8ClampedArray(m.width * m.height * 4);
      for (let i = 0, j = 0; i < mask.length; i++, j += 4) { rgba[j] = rgba[j + 1] = rgba[j + 2] = mask[i]; rgba[j + 3] = 255; }
      const canvas = new OffscreenCanvas(m.width, m.height);
      canvas.getContext('2d').putImageData(new ImageData(rgba, m.width, m.height), 0, 0);
      png = await canvas.convertToBlob({ type: 'image/png' });
    }
    self.postMessage({ id: m.id, png, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err?.message || err) });
  }
};
