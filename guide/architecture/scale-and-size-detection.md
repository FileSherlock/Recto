# Scale & Size Detection

`Doc.open()` returns two auto-detected values that describe how the document's typography maps onto its page image. Both are computed by `web/core/pdf-document.js`, inside the MuPDF worker:

| Value | Computed by | Purpose |
|-------|-------------|---------|
| `suggestedScale` | `geometry()` — pass 1 of opening | Converts typographic advance widths (in pt) to image pixel widths, as a percentage |
| `suggestedSize` | `typography()` — pass 2 of opening | Dominant body-text size found in the document (in pt); pre-populates the **Font size** field |

They arrive at different moments. `suggestedScale` is part of the geometry the viewer needs to show page 1, so it is known when `Doc.open()`'s `early(info)` callback fires. `suggestedSize` needs the text of the leading pages and follows with the typography pass; the viewer hands it to plugins as `sizePt` in the `document:loaded` event.

---

## `suggestedScale` — Derivation

### The width formula

`Shaping.widths()` (`web/plugins/text_tool/shaping.js`) computes, per glyph:

```
pixel_width = (advance / upem) × font_size_pt × (scale / 100)
```

### What "pixel" means here

Box coordinates live in the **embedded image's pixel space**. For scanned government document corpora, page images are always 816 × 1056 px, placed on a 612 × 792 pt PDF page (standard US Letter at 72 dpi):

```
image_px / page_pt = 816 / 612 = 4/3 ≈ 1.3333
```

This equals 96 dpi (the standard screen resolution) expressed as a ratio: `96 / 72 = 4/3`.

### Required scale

For the calculated width to match the width of the same text on the page image, the two expressions must be equal:

```
(advance / upem) × font_size_pt × (scale / 100)  =  (advance / upem) × font_size_pt × (img_px / page_pt)
```

The `(advance / upem) × font_size_pt` terms cancel, leaving:

```
scale / 100  =  img_px / page_pt
scale        =  round(100 × img_px / page_pt)
             =  round(100 × 816 / 612)
             =  133
```

### Why the ratio is not squared, and why font size stays out of it

Two tempting corrections are both wrong, and both inflate widths:

```js
// WRONG — do not write this
suggestedScale = round((bodySize / 12.0) * (816 / 612) ** 2 * 100)   // → 178 for 12 pt
```

Squaring `(816/612)` produces ≈ 1.778 instead of 1.333: the scale converts a *length*, not an area. And mixing the font size into the scale double-counts a correction the formula already makes, because `font_size_pt` is its own factor. Together the two errors give widths ~33% too wide on standard documents. The scale is the px-per-pt ratio and nothing else.

### Implementation

`geometry()` determines the ratio empirically from the first usable raster of the document, rather than hardcoding 816/612:

```js
// web/core/pdf-document.js — geometry(), abridged (page loading and destroy() calls left out)
let ratio = null;
for (let i = 0; i < numPages && ratio === null; i++) {
  const entry = pageImages(page).find(isUsableRaster);      // not a JPEG / JPX stream
  if (!entry) continue;
  const r = placementOf(imagePlacements(page), image);      // where the image sits, in pt
  ratio = r && r[2] - r[0] > 0 ? image.getWidth() / (r[2] - r[0]) : undefined;   // e.g. 816 / 612
}
suggestedScale = pyRound(100 * (ratio ?? GEO.PT_TO_PX));    // → 133
```

The pages are walked only until the first one that carries a usable raster; a document with
none (a born-digital PDF) falls back to `GEO.PT_TO_PX`. `pyRound` rounds half to even, so
the integer is the same on every platform.

`GEO.PT_TO_PX` (`= 96/72 = 4/3`) is one of the page/DPI constants of the coordinate
contract: `web/core/geometry.js` (`window.GEO`) on the page, mirrored by the `GEO` export of
`web/core/pdf-document.js` inside the worker, which has no `window` (that mirror also names
the resulting percentage, `DEFAULT_SCALE: 133`). Measuring the ratio makes the formula
self-calibrating for unusual scan resolutions.

> **Image documents** (PNG, JPEG, TIFF, BMP, WebP) have no page geometry to measure, so
> `Doc.open()` gives them the same default as a PDF without a raster —
> `Math.round(100 × GEO.PT_TO_PX)` = 133 — and a `suggestedSize` of 12. Both kinds of
> document therefore agree on 96 dpi.

---

## `suggestedSize` — Derivation

### Goal

Find the dominant **body-text** font size so new text starts at the right pt value. Headers, footers, page numbers, and labels tend to be short single words or numbers; paragraph text is longer.

### Algorithm

```js
// web/core/pdf-document.js (the counting loop abridged)
function spanSize(span) {                       // points
  const b = span.bbox, extent = span.ascender - span.descender;
  if (b && extent > 0 && b[3] > b[1]) return (b[3] - b[1]) / extent;
  return span.size;
}

function suggestedSize(sample) {                // sample: [{ length, size }] of the leading pages
  const sizesOf = minLen => sample
    .filter(s => s.length >= minLen && s.size > 0)
    .map(s => pyRound(s.size * 2) / 2);         // round to nearest 0.5 pt
  let sizes = sizesOf(20);
  if (!sizes.length) sizes = sizesOf(1);
  if (!sizes.length) return 12.0;
  // … the most frequent value; the first one seen wins a tie
}
```

The sample is every span of the first 25 pages (`SPAN_SAMPLE_PAGES`), read from MuPDF's
structured text without the image blocks — the text comes out the same and a scanned page
costs half as much. A span's `length` is the number of characters of its trimmed text. Twenty-five
pages are plenty for a mode, and the bound keeps opening a multi-thousand-page file fast.

**Step 1 — Prefer long spans.**
The 20-character threshold excludes short labels (e.g., "From:", "Page 1"). Paragraph text usually produces spans of several words concatenated. When long spans exist, only their sizes are considered.

**Step 2 — Fall back to all spans.**
Email documents and some word processors produce one span per word. If no span reaches 20 characters, the filter is relaxed to ≥ 1 character (all non-empty spans). A document with no text at all gets 12.

**Step 3 — Mode over median.**
Taking the median can return a size that bridges two distinct clusters (e.g., headers at 14 pt and body at 12 pt could produce a median of 13 pt). The mode always returns an actually-observed size, and it naturally favours whichever size appears most often in the document.

**Step 4 — Round to 0.5 pt.**
Each span's size is the bbox height over the face's (ascender − descender), not MuPDF's `size`: that field is the text-matrix expansion, which an OCR layer's per-word horizontal scaling (`Tz`) inflates by sqrt(Tz), so an 11.46 pt layer reads 11.7–11.95 word by word. The exact value still carries sub-point noise on some producers; the original font size is almost always a whole or half-point value. Rounding `× 2 / 2` snaps each span's size to the nearest 0.5 pt before the frequency count, so `10.86`, `10.90`, and `10.94` all vote for `11.0` rather than splitting into three separate bins.

> **Where ascender and descender come from.** The MuPDF JavaScript API exposes neither, so
> `pdf-document.js` reads them from the font's FreeType face in the wasm heap, with a sanity
> check that falls back to MuPDF's defaults (0.8 / −0.2). That fallback would change every
> span size and therefore `suggestedSize` — which is why a MuPDF upgrade is followed by
> `node --test "tests/**/*.test.mjs"`: `tests/documents.test.mjs` holds both values to the
> goldens for every reference document. See `web/vendor/README.md`.

### How the frontend uses these values

```js
// web/core/pdf-viewer.js — announceDocument(), after Doc.open()
await PDFHooks.emit('document:loaded', {
  file, isDefault: !file,
  pdfFonts: data.pdfFonts || [],
  sizePt: data.suggestedSize || 12,          // e.g. 12.0 (pt)
});

// web/plugins/text_tool/fonts.js — the subscriber (abridged)
PDFHooks.on('document:loaded', async e => {
  const declared = (e?.pdfFonts || []).map(familyForPdfName).find(Boolean);
  select(declared || catalog.default, e?.sizePt, 'declared');   // sets #fabric-font-size
});
```

The core keeps no font list and no size field of its own: it reports the facts, and the
typography plugin turns them into the default for new boxes. A box added next to an existing
text line takes that line's size instead; the field is the default when there is none. A plugin
that *measures* the page's face can override the default later by emitting
`typography:detected`.

When `text_tool` measures a string, size and scale flow into `Shaping.widths()`:

```js
// web/plugins/text_tool/toolbar.js (abridged)
await Shaping.widths({ strings, family, bold, italic,
                       size:  box.sizePt,        // points
                       scale: GEO.docScale() }); // px-per-pt × 100 for this document
```

```
pixel_width = (advance / upem) × size × (scale / 100)
            = (advance / upem) × 12.0 × (816/612)
```

which exactly reproduces the image-space pixel width of that text.

`GEO.docScale()` is the same ratio as `suggestedScale`, taken from the page the viewer shows
(`state.pageWidth / 612 × 100`) and **not rounded** — 133.33… rather than 133 for a standard
page. The measurer uses the unrounded value on purpose: a quarter of a percent is a full pixel
on a 400-px line. `suggestedScale` is the integer percentage reported with the document's
metadata (`Doc.info.suggestedScale`), and 133 is also what `Shaping.widths()` assumes for a
request that carries no `scale`.

---

## Summary

| Parameter | Value (standard letter) | Formula |
|-----------|------------------------|---------|
| `suggestedScale` | **133** | `pyRound(100 × img_w_px / img_placed_w_pt)`, from the first usable raster; `100 × 96/72` without one |
| `suggestedSize` | e.g. **12.0** | mode of span sizes ≥ 20 chars over the first 25 pages (falls back to all spans, then to 12), each rounded to 0.5 pt |
