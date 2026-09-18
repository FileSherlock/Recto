# Goldens — what the server-based version returned

These files are frozen. They were recorded from the original server-based Recto
(the `main` branch: PyMuPDF, uharfbuzz, OpenCV, Pillow behind HTTP endpoints)
by calling every endpoint in-process and writing down the answer. Every part of
the static site that took over a piece of server work is held to them by the
suites in `tests/` — page rasters and masks pixel for pixel, spans within 1e-6,
HarfBuzz numbers to the last digit. Nothing here is edited by hand except this
README and the `source` paths in `documents.json`.

The recorder needed the server's Python and left the tree with it: it is
`tools/golden/record.py` at commit `01cb580` of the `client-side-rewrite`
branch (`record.py --check` re-recorded and compared byte for byte; it answered
`identical` to the end). The library versions of the recording are in
`versions.json` (MuPDF 1.28.2, HarfBuzz 14.4.0, OpenCV 5.0.0, Pillow 12.3.0).
The endpoint names below are the recorded server's.

## Layout

```
index.html                the page the server rendered at / (script order, plugin insertion points)
documents.json            the golden documents: name, source path, sha256, page count, recorded pages
versions.json             library versions of the recording
_inputs/                  generated input documents (built by the recorder from fixed numbers)
<document>/
  open-document.json      the /open-document response, verbatim
  open-default.json       startup document only: the /open-default response
  pages.json              per recorded page: image, thumb, mask, raster (below)
  spans-lean.json         { "<page>": /extract-spans?start=<page>&count=1&lean=1 response }
  spans-full.json.gz      the same without lean=1 (per-character positions)
  mask-<page>.png         the /webgl/mask PNG, for pages that have one (status 200)
fonts-list.json           the /fonts-list response
font-metrics/
  index.json              one row per table: file, request, face file, counts
  <family>.<style>.<size>.json.gz     { request, response } of /font-metrics
widths/
  strings.json            the fixed 200 strings
  index.json              case names
  <case>.json.gz          { request, response } of POST /widths — request is complete, replay it as is
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
| `scan-tall` | `_inputs/scan-tall.pdf` | 1 | a 1000×1320 raster, taller than 8.5×11, so `crop_to_page_ratio` really crops (to 1294 rows); invisible text layer; bars, a disc and an edge bar for the mask rules |
| `image-png`, `image-jpg` | `_inputs/image.png`, `image.jpg` | 1 | image documents |

`scan-tall` is not in the plan's list: every corpus raster is exactly
816×1056, so without it the crop is never exercised.

## `pages.json`

- `image`, `thumb` — `/page-image/<hash>/<n>` and `?thumb=1`: `mime`, `width`,
  `height`, Pillow's `mode`, and the hashes of the **decoded pixels** (PNG
  bytes are not compared — encoders differ):
  - `sha256_rgba` — SHA-256 over `width*height*4` bytes, row-major, R G B A,
    8 bits each, straight alpha, raw sample values (no colour management;
    gray is R=G=B, a palette is expanded).
  - `sha256_gray` — SHA-256 over `width*height` bytes, present only when every
    pixel is achromatic and opaque, else `null`. Same pixels; the form a gray
    pixmap hashes to directly.
  - `sha256_bytes` — image documents only: the response bytes, which are the
    stored file (equal to the document's sha256). For the JPEG this is the
    contract; its pixel hash is Pillow's decode and only indicative, because
    JPEG decoders disagree by a level or two.
- `mask` — `/webgl/mask/<hash>/<n>`: `status` (200, or 204 for "no mask"),
  and for 200 the size, `sha256_gray` of the decoded mask, `nonzero` (count of
  white pixels) and the PNG's file name.
- `raster` (PDFs) — not an endpoint's output; what a port needs to know to
  reproduce one: `source` (`embedded` raster or 96-dpi `render`), the embedded
  image's size/colourspace/filter **before** the crop, `page_rect`,
  `rotation`, `rect` (placement of the first usable raster —
  `suggested_scale` is measured from it) and `text_rect` (placement of the
  largest image — the text transform of `extract.py` uses it; `null` means the
  page rectangle is used).

## What the recorder also asserted (so it is not stored)

- A lean span is the full span restricted to `page, text, x, y, w, h, sizePt, font`.
- A multi-page `extract-spans` chunk equals the per-page answers laid end to end.
- `/page-image` for page 0 and page `num_pages + 1` is a 404.
- The reported `sha256` is the SHA-256 of the file.

## Behaviour worth knowing before porting

- Plugin order in `index.html` is the server's registration order, which was
  `os.listdir` order of the app folders on the recording machine; the
  `order` values in the `plugin.json` files reproduce it.
- `/open-document` reports 816×1056 for every PDF, whatever its raster size.
- The mask is computed on the **uncropped** first image of the page
  (`scan-tall`: page image 1000×1294, mask 1000×1320).
- Thumbnails are Pillow LANCZOS downscales to 180 px; a different resampler
  will not reproduce their hashes.
