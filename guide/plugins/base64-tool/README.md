# Base64 attachment decoder (`base64_tool`)

An email printed to PDF often carries its attachments as base64: the wrapped-line body
under a `Content-Transfer-Encoding: base64` header. This plugin finds those bodies in the
document's text, decodes them in the browser and lists each in the **Attachments** panel,
docked at the right of the page, as a card to view or save.

| File | What it is |
|---|---|
| `web/plugins/base64_tool/b64-core.js` | `B64Core`: finding blocks, decoding, type sniffing, the declared name, how a type may be viewed. No DOM — `tests/plugins/base64_tool/core.test.mjs` loads this very file |
| `web/plugins/base64_tool/base64-tool.js` | gathering the text, the auto-scan, the panel and its cards |
| `web/plugins/base64_tool/panel.html` | the panel (`#b64-panel`, the `sidebar` slot) |
| `web/plugins/base64_tool/toolbar_button.html` | the tool (`#toggle-b64-tool`) and its count badge (`#b64-badge`) |

## The panel

| Control | id | What it does |
|---|---|---|
| Attachments (tool column) | `toggle-b64-tool` | shows / hides the panel; the badge counts the open document's attachments |
| Scan the text again | `b64-scan` | rescans the text layer now |
| Hide the panel | `b64-close` | |
| status line | `b64-status` | how many attachments, in which layer (OCR / embedded) |
| cards | `b64-cards` | one per attachment: type icon, the declared name (else the type), type · size · pages, a preview for an image, **View**, **Download** |

The page range on a card goes to the block's first page. **Download** saves under the name
the MIME headers declare, else `<document>-attachment-<n>.<ext>`. A card whose declared name
has an extension while its bytes sniff as nothing known says the text may hold misreads.

It is a side panel (`data-side-panel`): it shares the right side with the other side panels
one at a time (`sidepanel:shown` on the bus), 340 px wide by default and resizable by its
left edge; on a phone it is a sheet at the foot of the screen. Whether it was shown is kept
in `localStorage` (`recto.attachments.open`); the first time it is hidden. After a document
loads it waits for the text to settle (the `ocr_tool` state through a guarded global, else
two polls seeing the same amount of text), scans, and — when it found attachments and no
other side panel is showing — shows itself. It never takes the right side from another
panel; the badge says it instead.

## Finding a block

It reads exactly one text-box layer — the visible one of OCR / embedded — because the two
hold the same lines at the same places and would interleave. Pages not yet visited come
from `embedded_text_viewer`'s span cache (`window.etvSpanCache`, guarded).

A block is a run of consecutive base64-looking lines (whitespace and leading `>` quote marks
ignored) with at least one strong line — 40+ characters with lower case, upper case and
digits or `+/` — and 80+ characters in all. Runs carry on across pages; blank lines are
neutral. Read text adds three rules, so that one attachment comes out as one file:

- **A wrapped line's overflow** (1–3 characters on a line of their own) continues the run.
- **Padding closes a run but does not end it by itself.** The next line splits it off when it
  is prose (a MIME boundary line), a short base64-looking word ("Thanks"), or a body line
  that decodes to a new file header (two attachments back to back). A full body line that
  decodes to noise means the `=` was a misread: the run goes on.
- **A mid-stream `=` decodes as `A`**, so every later byte stays where it is: a misread costs
  1–2 bytes, not the rest of the file.

The declared name is the nearest `filename=` (Content-Disposition), else `name=`
(Content-Type), in the 12 lines above the block and below the previous one; RFC 2231's
`filename*=UTF-8''…` is decoded; a path and characters a file system refuses are dropped.

## Types, and how each may be viewed

The type is sniffed from the decoded bytes, never taken from the declared name, and decides
what **View** does. A blob URL opened in a new tab runs in Recto's own origin, so decoded
markup is never handed to the browser as markup.

| View | Types |
|---|---|
| **inline** — a new tab shows it as its type | PDF; PNG, JPEG, GIF, BMP, icon, WebP, AVIF; WAV, MP3, M4A/M4B, Ogg, FLAC; MP4, QuickTime, WebM; plain text (UTF-8) |
| **text** — a new tab shows it as `text/plain` | RTF, SVG, XML, HTML, JSON, an email (`.eml`) |
| **none** — Download only, View greyed | legacy Office (`.doc`), DOCX, XLSX, PPTX, EPUB, ZIP, 7-Zip, RAR, gzip, bzip2, TAR; TIFF, HEIC; AVI, Matroska; anything unrecognised (`.bin`) |

Text is a 512-byte window that is more than 90 % printable ASCII, tabs, line breaks and
well-formed UTF-8 sequences. A lone byte ≥ 128 does not count: counting it would pass most
random binary as text (226 of the 256 byte values). Random bytes measure at most 0.55 over a
full window (20,000 tries), at most 0.66 in a 60-byte file.

## What it needs from the text

A byte-exact read. On EFTA00382083 (`tests/samples/`) the OCR layer gives one block, pages
3–24: `Airmail.pdf`, 81,046 bytes, a 3-page PDF MuPDF opens — the suite holds it to its
SHA-256 (fixture: the OCR lines of the attachment, `tests/plugins/base64_tool/fixtures/`).
The same document's embedded OmniPage layer breaks that body into 84 blocks: its misreads
put `,` `-` `.` into body lines, which ends a run, and `O` for `0` inside them, which spoils
the bytes. The startup document's base64 email body is one 16.5 KB text file in the OCR
layer and 25 broken blocks in the embedded one.
