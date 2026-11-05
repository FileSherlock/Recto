// ocr_tool's steps in the browser smoke test (tests/smoke/smoke.mjs).

export const switches = ['ocr-toggle-text'];

// A short document is read to the end; a long one's automatic read is cut
// short — after page 1, whose boxes the pixel view then judges (cut as soon as
// it started, page 1 came or did not by timing: 62/62 one run, 0/0 the next).
export async function settle(page, doc) {
  if (doc.num_pages <= 7) { await page.waitForFunction(() => OCRTool.state.autoDone && !OCRTool.state.running); return; }
  await page.waitForFunction(() => OCRTool.state.autoDone ||
    utbState.boxes.some(b => b.page === 1 && (b.type === 'ocr' || b.ocrSource)), { timeout: 180000 });
  await quiesce(page);
}

// A read stored by this browser is replayed only with the engine, bundle and
// worker that made it: one stamped with others is passed over. The startup
// document has a shipped read instead, and no engine runs for it.
async function storedReadStamp(page, note) {
  const seen = await page.evaluate(async () => {
    const get = async () => !!(await ocrFetchCache(state.docHash));
    if (window.RECTO_ASSETS[`${OCR_CACHE_DIR}${state.docHash}.json`])
      return { current: await get(), stale: false, restored: OCRTool.state.readVia === null, shipped: true };
    for (let i = 0; i < 40 && !await get(); i++) await new Promise(r => setTimeout(r, 100));    // the store is fire-and-forget
    const current = await get();
    const db = await ocrCacheDb();
    const row = await ocrIdb(db.transaction('documents').objectStore('documents').get(state.docHash));
    const put = async r => { const tx = db.transaction('documents', 'readwrite'); tx.objectStore('documents').put(r); await new Promise(d => { tx.oncomplete = d; }); };
    await put({ ...row, readWith: `${row.readWith} synced` });
    const stale = await get();
    await put(row);
    const restored = await get();
    db.close();
    return { current, stale, restored };
  });
  if (!seen.current || seen.stale || !seen.restored) throw new Error(`stored read stamp: ${JSON.stringify(seen)}`);
  note.push(seen.shipped ? 'shipped read, no engine' : 'stale read passed over');
}

// The pixel view, on and off; its verdict for page 1 goes into the report.
export async function exercise(page, doc, note) {
  if (!await page.$('#ocr-pixel-view')) return;
  if (doc.num_pages <= 7) await storedReadStamp(page, note);
  await page.evaluate(() => document.getElementById('ocr-pixel-view').click());
  await page.waitForFunction(() => PixelView.state.on && !PixelView.state.loading);
  note.push(await page.evaluate(() => { const v = PixelView.verdict(1); return `pixel view ${v.certExact}/${v.cert} exact`; }));
  await page.evaluate(() => document.getElementById('ocr-pixel-view').click());
  await page.waitForFunction(() => !PixelView.state.on);
}

export async function quiesce(page) {
  await page.evaluate(() => OCRTool.cancel());
  await page.waitForFunction(() => !OCRTool.state.running);
}
