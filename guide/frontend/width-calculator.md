# Text Measurement — `shaping.js`

`web/plugins/text_tool/shaping.js` provides precision text-width measurement: how wide a string is, to a fraction of a pixel, in a given face at a given size. It shapes the text with **HarfBuzz 14.4.0**, compiled to WebAssembly (`web/vendor/harfbuzz/`, harfbuzzjs 1.6.1), over the very face files the page draws its SVG text with — so what is measured and what is shown come from one file.

Everything runs in the page. The first call loads HarfBuzz and the font catalogue; each face file is fetched once, from the same content-hashed URL the `@font-face` rule uses, so the browser downloads it a single time for both purposes.

The file is a classic script with two layers:

| Layer | Global | Contents |
|-------|--------|----------|
| The measuring core | `ShapingCore` (`createShaper`, `parseKernTable`, `CHARS`) | No DOM, no `fetch`. `createShaper({ hb, catalogue, loadFont })` takes the HarfBuzz module, the catalogue object and a function that loads a face file's bytes, and returns `{ widths, fontMetrics, resolve }`. The `node:test` suite loads this very file |
| The browser glue | `window.Shaping` (`widths`, `fontMetrics`) | Builds one shaper lazily from `vendor/harfbuzz/index.mjs` (through `assetURL`) and `generated/fonts.json` |

Other plugins call it guarded — `typeof Shaping !== 'undefined'` — so they keep working when `text_tool` is absent.

---

## Functions

### `Shaping.widths(request)` → `Promise<{ results }>`

Calculates pixel widths for a list of text strings.

**Request:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `strings` | array | `[]` | Strings to measure |
| `family` | string | — | Catalogue family name (see [Font Resolution](#font-resolution)) |
| `bold`, `italic` | bool | `false` | The style asked for |
| `font` | string | — | Legacy form, read only when `family` is absent: a catalogue file name such as `'times.ttf'` |
| `size` | number | `12` | Font size in **points** |
| `scale` | number | `133` | px-per-pt as a percentage (see [Scale Factor](#scale-factor)); callers pass `GEO.docScale()` |
| `kerning` | bool | `true` | Enable the `kern` feature — and the face's legacy `kern` table (below) |
| `ligatures` | bool | `true` | Let HarfBuzz form standard ligatures (`liga`, `clig`); `false` gives the plain advances, as a page set without ligatures was laid. Calibri's `ff` / `tt` differ by half a pixel |
| `force_uppercase` | bool | `false` | Convert text to uppercase before measuring |
| `space_width` | number \| `null` | `null` | Substitute this advance (image px) for every space glyph |

**Response:**

```js
{ results: [
    { text: 'Hamburgefonstiv', width: 111.40828125000002,
      chars: [{ c: 'H', x: 0 }, { c: 'a', x: 11.52580078125 }, /* … */] },
] }
```

`width` is in image pixels. `chars` has one entry per shaped **glyph** — `c` is the first character of the glyph's cluster (clusters count code points), `x` the pen position before the glyph — so a caller can place characters as well as measure them. An empty string answers `{ text, width: 0 }`. When no face can be resolved or loaded, every result is `{ text, width: 0, error }`; the call itself does not throw.

**Justified mode.** With `mode: 'justified'` and `block_w` the call answers a different question — which space advance makes the line exactly `block_w` pixels wide:

```js
await Shaping.widths({ strings: [line], family, bold, italic, size, scale, kerning, mode: 'justified', block_w: 480 })
// → { space_width: 27.45 }      null: no space in the text, block_w not positive, or no face
```

It shapes `strings[0]`, sums every glyph that is not the space glyph, and divides what is left of `block_w` by the number of spaces (never below 0).

### `Shaping.fontMetrics({ family, bold, italic, size_px })` → `Promise<object | null>`

A face's own advances and every kern pair at one pixel size:

```js
{ family: 'Times New Roman', bold: false, italic: false,
  file: 'times.ttf', sizePx: 16, upem: 2048,
  space: 4,
  adv:  { A: 11.5546875, V: 11.5546875, e: 7.1015625, /* … */ },
  kern: { AV: -2.0625, Yo: -1.6015625, Ve: -1.7734375, /* … */ },
  missing: [] }
```

`adv` covers 150 characters (`ShapingCore.CHARS`: printable ASCII, typographic punctuation, the accented Latin letters, `ﬁ` and `ﬂ`); a character the face has no glyph for goes to `missing`. `kern` is measured, not read: every ordered pair is shaped with kerning on, and `width − adv[a] − adv[b]` is kept when it is not zero. Ligatures and contextual substitutions are off (`liga`, `clig`, `calt`, `dlig`), and a pair that still came out as anything but two glyphs is skipped — the table describes plain pairs.

This is the table a plugin judges a page's measured pen positions against to learn whether the document's producer kerned, and lays typed text with when it did. `text_tool` exposes it cached as `FontCatalog.metrics(family, bold, italic, sizePx)`.

`size_px` defaults to `16` and must lie in `(0, 512]`; `bold` / `italic` accept `true`, `1` or `'1'`. The answer is `null` when the size is out of range or no file is installed for the family. Tables are cached per face file and size — the first call shapes every pair once (up to 150 × 150 shapings), later calls are free.

---

## Font Resolution

The catalogue is `generated/fonts.json`: every family with its style files and a `present` map saying which of them are installed ([shape](../api-reference/api-reference.md#webgeneratedfontsjson)). A request names a **family and a style**, never a path, and `resolve(family, bold, italic)` walks a fixed chain until it finds an installed file:

| Asked for | Tried in order |
|-----------|----------------|
| bold italic | `bolditalic` → `bold` → `italic` → `regular` |
| bold | `bold` → `regular` |
| italic | `italic` → `regular` |
| regular | `regular` |

When the family has none of them — or is not in the catalogue at all — the same chain runs over **Times New Roman**. Only when that fails too is there no face, and the request answers with an `error` per string.

So `Nimbus Mono PS` bold measures with `NimbusMonoPS-Regular.otf` (the family ships no bold), `Tahoma` italic with `tahoma.ttf`, and an unknown family in bold with `timesbd.ttf`. The fallback is deliberate: a width from the nearest real face is useful, and a synthesized bold would match no page.

The legacy `font: 'times.ttf'` form is looked up among the catalogue's installed files (with or without `.ttf`); an unknown name falls back to the catalogue's default family, regular.

Only the catalogue's faces are ever measured. System fonts are out of reach by design — a width must not depend on the machine that computed it.

---

## The HarfBuzz call

```js
const features = [new hb.Feature('kern', kern ? 1 : 0)];
if (!ligatures) features.push(new hb.Feature('liga', 0), new hb.Feature('clig', 0));

buffer.reset();
buffer.addCodePoints(codePoints);          // clusters count code points
buffer.guessSegmentProperties();           // direction, script, language from the text
hb.shape(font, buffer, features);

// per glyph: { gid, cluster, advance }     advance = xAdvance, in font units
width = Σ (advance / upem) × size × (scale / 100)
```

One `hb.Face`, `hb.Font` and `hb.Buffer` are kept per face file and reused.

**Features controlled:**

| Feature | Enabled | Disabled |
|---------|---------|----------|
| `kern` | Default | `kerning: false` |
| `liga`, `clig` | Default | `ligatures: false` |
| `calt`, `dlig` | Default | always off in `fontMetrics` |

### The legacy `kern` table

OpenType fonts carry kerning in one of two places: the `GPOS` table (a `kern` *feature*, the modern way) or the old `kern` *table*. The older Windows faces — Times New Roman, Arial, Georgia and their kin — kern through the `kern` table and nothing else.

harfbuzzjs is a *minimal* HarfBuzz build: it has `GSUB` and `GPOS`, but the code that applies the legacy `kern` table is left out. With that build alone, `kerning: true` and `kerning: false` would measure the same for exactly the faces most documents are set in — "AV" in 12 pt Times New Roman is 2.06 px narrower kerned than unkerned, and over a line those pixels decide whether a candidate fits.

`shaping.js` therefore applies the table itself, the way HarfBuzz's own kern machine does:

1. **Parse** (`parseKernTable`): the face's `kern` table is read through `hbFace.referenceTable('kern')`. Version 0 tables are understood; of their subtables the horizontal format-0 ones (plain pair lists) become a `Map` keyed by `left glyph × 65536 + right glyph`. Anything else — Apple's version 1, format 2, cross-stream or minimum subtables — is left alone, as rare as it is in the faces a document names.
2. **Apply** (`applyKernTable`): after `hb.shape()`, for each glyph and the next glyph that is not a mark, the pair's value is split over the two advances — the first half (`kern >> 1`) goes to the left glyph, the rest to the right one. The split is HarfBuzz's; it is what makes the per-glyph `x` positions, not only the total, come out the same.

### The per-script rule

HarfBuzz applies the `kern` table only when the font offers no `GPOS` kerning **for the script of the text** — and a face may answer differently per script: Tahoma kerns Arabic through `GPOS` and Latin through the `kern` table. A per-font yes/no would therefore be wrong in one of the two.

`shaping.js` follows the same rule:

- `scriptOf(text)` names the script HarfBuzz will shape the string in — the first character that has one, among Latin, Cyrillic, Greek, Arabic, Hebrew, Thai and Armenian (`latn` when none).
- `gposKerns(face, script)` looks the script up in the face's `GPOS` script list the way HarfBuzz chooses it — the text's script, else `DFLT`, `dflt`, `latn` — and asks whether the default language system of that script lists a `kern` feature.
- The table is applied when kerning was asked for, the face has a `kern` table, **and** `GPOS` does not kern that script. The answer is cached per face and script.

---

## Scale Factor

`scale / 100` is the multiplier that converts a typographic advance (in points) into the **image pixel width** every box coordinate uses.

### Formula

```
pixel_width = (advance / upem) × size_pt × (scale / 100)
```

For the width to match a box measured in the 816 × 1056 px page images:

```
scale / 100 = PAGE_WIDTH_PX / PAGE_WIDTH_PT
            = 816 / 612
            = 4/3
            ≈ 1.3333
```

This is equivalent to converting from 72 dpi (PDF points) to 96 dpi (image pixels): `96 / 72 = 4/3`.

All of these constants — `PAGE_WIDTH_PX`, `PAGE_WIDTH_PT`, `PT_TO_PX` — live in one place, `web/core/geometry.js` (`window.GEO`). Read them instead of re-deriving `816` / `612` / `0.75` in calling code.

### How callers set the scale

Callers pass `GEO.docScale()` — `state.pageWidth / 612 × 100` for the document on screen. For a PDF that is `133.33…`; for an image document it follows the image's own pixel width, so a measurement stays in that document's pixel space. `size` is always the point size (`box.sizePt`); nothing converts it beforehand.

A request without `scale` measures at `133`, the rounded letter-page value. In normal operation every caller supplies the exact scale, so the default is rarely used.

`Doc.open()` also reports a `suggestedScale` measured from the document's first placed raster; for the derivation of the scale value see [Scale & Size Detection](../architecture/scale-and-size-detection.md).

---

## How it is tested

`tests/shaping.test.mjs` loads the same `shaping.js` in Node — the measuring core has no DOM in it — together with the vendored HarfBuzz and the catalogue the build generates, and reads face files straight from `web/assets/fonts/`.

The `widths` and `font-metrics` folders of `tests/golden/` hold recorded `{ request, response }` pairs: what a native HarfBuzz 14.4.0 returned for the same requests (`tests/golden/README.md` describes the recording). Each `request` is complete and is replayed as is:

| Golden folder | Cases | What they pin down |
|---------------|-------|--------------------|
| `widths` | 23, listed in its `index.json`; most measure the 200 fixed strings of `strings.json` | Times New Roman with kerning on/off × uppercase on/off × two scales (letter page, 150 dpi); Calibri with and without ligatures; a manual `space_width`; bold, italic and monospaced faces; the natural space; both justified answers (a number, and `null` for a line with no space); the legacy `font` form; a request with nothing but `strings`; the three fallbacks (a missing italic, a missing bold italic, an unknown family) |
| `font-metrics` | 16 tables, listed in its `index.json` | Times New Roman, Arial, Courier New and Nimbus Roman, regular and bold, at 16 px and 13.3333 px — the kern pair count and every advance and pair |

The assertion is **equality to the last digit**: the largest numeric difference between the answer and the recording must be `0`, and the two must have the same keys. That is achievable only because both sides run the same HarfBuzz — so the suite first checks that the vendored build reports the version in `tests/golden/versions.json`. An upgrade that moves a number by one unit in the last place fails the suite, and so would any deviation of `applyKernTable` from HarfBuzz's own kern machine: the Times New Roman and Arial cases kern through the legacy table only.

The suite also checks the generated catalogue (MuPDF's faces first, every family's regular file present) and the resolution chain above.

```bash
node --test tests/shaping.test.mjs          # this suite
node --test "tests/**/*.test.mjs"           # everything
```
