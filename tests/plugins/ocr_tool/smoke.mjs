// ocr_tool's steps in the browser smoke test (tests/smoke/smoke.mjs).

export const switches = ['ocr-toggle-text'];

// A short document is read to the end; a long one's automatic read is cut short.
export async function settle(page, doc) {
  if (doc.num_pages <= 7) { await page.waitForFunction(() => OCRTool.state.autoDone && !OCRTool.state.running); return; }
  await page.waitForFunction(() => OCRTool.state.running || OCRTool.state.autoDone);
  await quiesce(page);
}

// The pixel view, on and off; its verdict for page 1 goes into the report.
export async function exercise(page, doc, note) {
  if (!await page.$('#ocr-pixel-view')) return;
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
