# Reference outputs

Frozen recordings the suites in `tests/` hold the code to: page rasters and masks pixel
for pixel, spans within 1e-6, HarfBuzz numbers to the last digit. Nothing here is edited
by hand except this README and the `source` paths in `documents.json`.

Where the numbers come from: an earlier, Python-based implementation of Recto ran the
same computations (PyMuPDF over MuPDF 1.28.2, uharfbuzz over HarfBuzz 14.4.0, OpenCV
5.0.0, Pillow 12.3.0 — `versions.json`) behind HTTP endpoints, and every endpoint's answer
was recorded in-process. The file names keep the name of the request each answers. The
vendored MuPDF 1.28.0 reproduces every recorded raster, and the vendored HarfBuzz is the
recording's own version — which is why widths and metrics are held to equality rather
than closeness.

## Layout

```
index.html                the recorded page: the script order the plugins were written against (tests/index-page.test.mjs)
documents.json            the reference documents: name, source path, sha256, page count, recorded pages
versions.json             library versions of the recording
_inputs/                  generated input documents (built from fixed numbers)
<document>/
  open-document.json      the document's metadata — what Doc.open() must report
  open-default.json       startup document only: the same, as the startup load reported it
  pages.json              per recorded page: image, thumb, mask, raster (below)
  spans-lean.json         { "<page>": the lean spans of that page }
  spans-full.json.gz      the same with per-character positions
  mask-<page>.png         the mask of every page that has one (status 200)
fonts-list.json           the font catalogue as the build must generate it
font-metrics/
  index.json              one row per table: file, request, face file, counts
  <family>.<style>.<size>.json.gz     { request, response } of a font-metrics request (Shaping.fontMetrics)
widths/
  strings.json            the fixed 200 strings
  index.json              case names
  <case>.json.gz          { request, response } of a widths request (Shaping.widths) — request is complete, replay it as is
```

`.json.gz` files are compact JSON under gzip (fixed header); in Node:
`JSON.parse(zlib.gunzipSync(fs.readFileSync(path)))`.

## Documents

| name | source | pages recorded | why |
|---|---|---|---|
| `startup` | `web/assets/pdfs/EFTA00434905.pdf` | all 5 | the startup document; scans with an OCR text layer |
| `efta00382083` | `tests/samples/EFTA00382083.pdf` | all 25 | |
| `efta01011184` | `tests/samples/EFTA01011184.pdf` (340 p, 66 MB) | 1, 2, 3, 85, 170, 255, 340 | the large document |
| `vector` | `_inputs/vector.pdf` | both | born-digital: base-14 Times/Helvetica/Courier, mixed sizes, black rectangles — takes the 96-dpi render path |
| `scan-tall` | `_inputs/scan-tall.pdf` | 1 | a 1000×1320 raster, taller than 8.5×11, so the ratio crop really crops (to 1294 rows); invisible text layer; bars, a disc and an edge bar for the mask rules |
| `image-png`, `image-jpg` | `_inputs/image.png`, `image.jpg` | 1 | image documents |

`scan-tall` exists because every corpus raster is exactly 816×1056: without it the crop
would never be exercised.

## `pages.json`

- `image`, `thumb` — the page raster and its 180 px thumbnail: `mime`, `width`,
  `height`, the recording's pixel `mode`, and the hashes of the **decoded pixels** (PNG
  bytes are not compared — encoders differ):
  - `sha256_rgba` — SHA-256 over `width*height*4` bytes, row-major, R G B A,
    8 bits each, straight alpha, raw sample values (no colour management;
    gray is R=G=B, a palette is expanded).
  - `sha256_gray` — SHA-256 over `width*height` bytes, present only when every
    pixel is achromatic and opaque, else `null`. Same pixels; the form a gray
    pixmap hashes to directly.
  - `sha256_bytes` — image documents only: the served bytes, which are the
    stored file (equal to the document's sha256). For the JPEG this is the
    contract; its pixel hash is one decoder's and only indicative, because
    JPEG decoders disagree by a level or two.
- `mask` — the page's mask: `status` (200 = a mask, 204 = no mask), and for 200
  the size, `sha256_gray` of the decoded mask, `nonzero` (count of white pixels)
  and the PNG's file name.
- `raster` (PDFs) — what is needed to reproduce the raster: `source` (`embedded`
  raster or 96-dpi `render`), the embedded image's size/colourspace/filter
  **before** the crop, `page_rect`, `rotation`, `rect` (placement of the first
  usable raster — `suggestedScale` is measured from it) and `text_rect`
  (placement of the largest image — the span extractor's transform uses it;
  `null` means the page rectangle is used).

## What the recording also asserted (so it is not stored)

- A lean span is the full span restricted to `page, text, x, y, w, h, sizePt, font`.
- A multi-page span extraction equals the per-page answers laid end to end.
- Page 0 and page `num_pages + 1` do not exist (`Doc.pageImageURL` rejects them).
- The reported `sha256` is the SHA-256 of the file.

## Behaviour worth knowing

- The plugin order of `index.html` is reproduced by the `order` values in the
  `plugin.json` files.
- The metadata reports 816×1056 for every PDF, whatever its raster size.
- The recorded masks were computed on the **uncropped** first image of the page
  (`scan-tall`: page image 1000×1294, mask 1000×1320); `mask-core.js` masks the
  cropped raster the viewer shows, so `tests/masks.test.mjs` compares the top rows
  there. They were also filled — whatever a region enclosed is mask. No recorded
  page has an enclosed gap, so the unfilled regions `mask-core.js` produces agree.
- Thumbnails are LANCZOS downscales to 180 px; a different resampler does not
  reproduce their hashes, so `tests/documents.test.mjs` holds a thumbnail to its
  size, not its hash.
