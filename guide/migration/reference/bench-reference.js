// bench.js — drives the worker and measures what the user would feel:
// time from "show me page N" to pixels on a canvas, per document.
const DOCS = [
  { name: 'startup (5 p, scans)', url: 'docs/startup.pdf' },
  { name: 'word1 (1 p, vector)', url: 'docs/word1.pdf' },
  { name: 'scan25 (25 p, 3.6 MB)', url: 'docs/scan25.pdf' },
  { name: 'scan340 (340 p, 66 MB)', url: 'docs/scan340.pdf', sweep: true },
  { name: 'court943 (943 p, 24 MB, mixed)', url: 'docs/court943.pdf', sweep: true },
];
const log = s => { document.getElementById('log').textContent += s + '\n'; };
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
const max = a => a.length ? Math.max(...a) : null;
const r1 = v => v == null ? null : Math.round(v * 10) / 10;
async function totalMemMB() {
  if (!crossOriginIsolated || !performance.measureUserAgentSpecificMemory) return null;
  try { return (await performance.measureUserAgentSpecificMemory()).bytes / 1048576; } catch { return null; }
}

window.runBench = async function (opts = {}) {
  document.getElementById('log').textContent = '';
  const t0 = performance.now();
  const worker = new Worker('worker.js', { type: 'module' });
  let seq = 0; const waiters = new Map();
  let ready;
  const readyP = new Promise(r => ready = r);
  worker.onmessage = e => {
    const m = e.data;
    if (m.type === 'ready') return ready(m);
    if (m.type === 'progress') return;
    const w = waiters.get(m.id); if (w) { waiters.delete(m.id); m.type === 'error' ? w.reject(new Error(m.error)) : w.resolve(m); }
  };
  const call = (msg, transfer = []) => new Promise((resolve, reject) => { const id = ++seq; waiters.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }, transfer); });
  const rdy = await readyP;
  const result = { isolated: crossOriginIsolated, wasmInitMs: r1(performance.now() - t0), wasmInitInWorkerMs: r1(rdy.initMs), heapAfterInitMB: r1(rdy.heapMB), memBaselineMB: r1(await totalMemMB()), docs: [] };
  log(`wasm ready in ${result.wasmInitMs} ms (heap ${result.heapAfterInitMB} MB)`);
  const ctx = document.getElementById('c').getContext('2d');
  for (const d of DOCS) {
    if (opts.only && !d.name.startsWith(opts.only)) continue;
    const row = { name: d.name };
    let t = performance.now();
    const buf = await (await fetch(d.url)).arrayBuffer();
    row.fetchMs = r1(performance.now() - t); row.sizeMB = r1(buf.byteLength / 1048576);
    t = performance.now();
    const opened = await call({ type: 'open', buffer: buf }, [buf]);
    row.openMs = r1(performance.now() - t); row.pages = opened.pages; row.heapAfterOpenMB = r1(opened.heapMB);
    // sample pages: the first three (what the user sees first) and up to 12 spread over the document
    const picks = new Set([1, 2, 3].filter(p => p <= opened.pages));
    for (let k = 1; k <= 12; k++) picks.add(Math.max(1, Math.min(opened.pages, Math.round(k * opened.pages / 13))));
    const S = { load: [], decode: [], render: [], pack: [], text: [], toScreen: [], chars: [] };
    let images = 0, first = null;
    for (const pno of [...picks].sort((a, b) => a - b)) {
      const tt = performance.now();
      const pg = await call({ type: 'page', pno, wantPixels: true });
      const img = new ImageData(pg.rgba, pg.w, pg.h);
      const c = document.getElementById('c'); if (c.width !== pg.w || c.height !== pg.h) { c.width = pg.w; c.height = pg.h; }
      ctx.putImageData(img, 0, 0);
      const toScreen = performance.now() - tt;
      if (first == null) first = toScreen;
      S.load.push(pg.loadMs); S.render.push(pg.renderMs); S.pack.push(pg.packMs); S.text.push(pg.textMs); S.toScreen.push(toScreen); S.chars.push(pg.chars);
      if (pg.hasImage) { images++; S.decode.push(pg.decodeMs); }
    }
    Object.assign(row, { sampled: picks.size, pagesWithImage: images, firstPageToScreenMs: r1(first),
      renderMs: { median: r1(median(S.render)), max: r1(max(S.render)) },
      imageDecodeMs: { median: r1(median(S.decode)), max: r1(max(S.decode)) },
      textMs: { median: r1(median(S.text)), max: r1(max(S.text)) }, charsPerPage: median(S.chars),
      rgbaPackMs: r1(median(S.pack)), requestToCanvasMs: { median: r1(median(S.toScreen)), max: r1(max(S.toScreen)) },
      note: 'requestToCanvas = load + image decode + 96-dpi render + text + RGBA pack + transfer + putImageData (the bench does all of them per page; the app would do one of decode/render)' });
    row.heapAfterSampleMB = r1((await call({ type: 'page', pno: 1, wantPixels: false })).heapMB);
    row.memAfterSampleMB = r1(await totalMemMB());
    if (d.sweep && !opts.noSweep) {
      const sw = await call({ type: 'sweep', emptyEvery: opts.emptyEvery || 0 });
      row.sweep = { pages: sw.pages, totalS: r1(sw.ms / 1000), msPerPage: r1(sw.ms / sw.pages), decoded: sw.decoded, rendered: sw.rendered, chars: sw.chars, peakHeapMB: r1(sw.peakHeapMB) };
      row.memAfterSweepMB = r1(await totalMemMB());
    }
    const closed = await call({ type: 'close' });
    row.heapAfterCloseMB = r1(closed.heapMB);
    result.docs.push(row);
    log(JSON.stringify(row));
  }
  result.memEndMB = r1(await totalMemMB());
  result.totalS = r1((performance.now() - t0) / 1000);
  worker.terminate();
  window.benchResult = result;
  log('done in ' + result.totalS + ' s');
  return result;
};
document.getElementById('go').onclick = () => runBench();
