# Vendored binaries

Third-party builds the site loads at run time. They are copied in verbatim and
pinned; nothing here is edited.

| folder | what | version | from | licence |
|---|---|---|---|---|
| `mupdf/` | MuPDF as WebAssembly: `mupdf.js`, `mupdf-wasm.js`, `mupdf-wasm.wasm` | 1.28.0 | npm `mupdf@1.28.0`, `dist/` | AGPL-3.0 (`mupdf/LICENSE`) |
| `harfbuzz/` | HarfBuzz as WebAssembly: `index.mjs`, `harfbuzz.js`, `harfbuzz.wasm` | harfbuzzjs 1.6.1 = HarfBuzz 14.4.0 | npm `harfbuzzjs@1.6.1`, `dist/` (without the subset build) | MIT (`harfbuzz/LICENSE`) |

Upgrading MuPDF is not a drop-in: `web/core/pdf-document.js` reads two MuPDF
structs from the wasm heap (a font's FreeType face for its ascender/descender,
and `fz_stext_char` for the per-character flags — mupdf.js exposes neither).
The character layout is verified at run time and falls back to the accessors;
the font offset (`FONT_FT_FACE`) is sanity-checked and falls back to MuPDF's
default metrics (0.8 / −0.2), which would change `suggestedSize` and every
span size. After an upgrade run `node --test tests/*.test.mjs` — the goldens
catch either.

harfbuzzjs is a *minimal* HarfBuzz: it has GSUB and GPOS but not the legacy
`kern` table, which is all the kerning the older Windows faces carry.
`web/plugins/text_tool/shaping.js` applies that table itself, under HarfBuzz's
own rule (kerning requested, and GPOS has no `kern` feature for the text's
script). HarfBuzz 14.4.0 is also what the goldens were recorded with
(uharfbuzz 0.56.1); `tests/shaping.test.mjs` requires equality to the last
digit and checks the version, so an upgrade that changes a number shows.

Cache note (the same holds for `harfbuzz/index.mjs` → `./harfbuzz.js` and its
`.wasm`): the page asks for `mupdf.js` and the `.wasm` with content-hashed
URLs (`assetURL`), but `mupdf.js` imports `./mupdf-wasm.js` by a plain relative
URL. On a host that caches forever, give that one file a short lifetime or
rename the folder with the version on an upgrade.
