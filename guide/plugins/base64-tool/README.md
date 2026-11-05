# Base64 attachment decoder (`base64_tool`)

An email printed to PDF often carries its attachments as base64: the wrapped-line body
under a `Content-Transfer-Encoding: base64` header. A form printed to PDF carries them in an
element or an attribute. This plugin finds those bodies in the document's OCR read, decodes
them in the browser and lists each in the **Attachments** panel, docked at the right of the
page, as a card to view or save, saying how far the file can be trusted.

| File | What it is |
|---|---|
| `web/plugins/base64_tool/b64-core.js` | `B64Core`: finding bodies, decoding, type sniffing, the declared name, the verdict, how a type may be viewed. No DOM — `tests/plugins/base64_tool/core.test.mjs` loads this very file |
| `web/plugins/base64_tool/base64-tool.js` | gathering the boxes, the auto-scan, the panel and its cards |
| `web/plugins/base64_tool/panel.html` | the panel (`#b64-panel`, the `sidebar` slot) |
| `web/plugins/base64_tool/toolbar_button.html` | the tool (`#toggle-b64-tool`) and its count badge (`#b64-badge`) |

The rules are tol0's (`tools/b64/blocks.mjs`, `sniff.mjs`, what `decode.mjs` does with a
body), where they are measured over its archive and a 15,000-document sample. They are a
copy kept by hand, not a synced file: `tools/sync-recto.mjs` carries the OCR engine only. A
change to one should go to the other.

## The panel

| Control | id | What it does |
|---|---|---|
| Attachments (tool column) | `toggle-b64-tool` | shows / hides the panel; the badge counts the open document's attachments, not the values that are no files |
| Scan the OCR read again | `b64-scan` | rescans the read now |
| Hide the panel | `b64-close` | |
| status line | `b64-status` | how many attachments, by verdict, and how many values that are no files |
| cards | `b64-cards` | one per attachment: type icon, the declared name (else the type), type · size · pages, the verdict, why when it is not exact, a preview for an image, **View**, **Download**; last, a closed list of the values that are no files |

The page range on a card goes to the body's first page. **Download** saves under the name
the MIME headers or the form's header declare, else `<document>-attachment-<n>.<ext>`. A card
whose declared name has an extension while its bytes sniff as nothing known says so.

It is a side panel (`data-side-panel`): it shares the right side with the other side panels
one at a time (`sidepanel:shown` on the bus), 340 px wide by default and resizable by its
left edge; on a phone it is a sheet at the foot of the screen. Whether it was shown is kept
in `localStorage` (`recto.attachments.open`); the first time it is hidden. After a document
loads it waits for the read to settle (the `ocr_tool` state through a guarded global), however
long that takes, scans, and — when it found attachments and no other side panel is showing —
shows itself. **Scan** during the read shows what it has so far, and says so. It never
takes the right side from another panel; the badge says it instead.

## The text it reads

The `ocr` boxes and nothing else (`B64Core.linesFromBoxes`), whichever layer is on screen. The
embedded layer is another OCR's text: nothing certifies its characters, and one wrong
character is a wrong byte. On EFTA00382083 it breaks the body that the OCR read gives whole
into 84 blocks. A document with no OCR read lists nothing and says why.

A box carries what the reader knows about its characters, and a line takes it along: `fails`
(ink clusters no glyph explained, each a `□` in the text), `tol` (the rung it was read on),
`unread` (a band no set read), `entries` (its glyphs' pens). A box whose text no longer spells
its entries was edited by hand, and is treated as not read.

## Finding a body

A body is a run of base64 lines of one width (76 for MIME, 72 for vCard photos), quote marks
(`>`) stripped; it may end in one shorter line, and padding ends it. Blank lines, page breaks
and Bates stamps are neutral. A run starts on a clean, full line — 40+ characters, upper and
lower case and digits or `+/`, changing class at least every fifth character — or on a marker.

What a line is to a body (`pieceOf`):

- **Markers** open and close a body on the same line: an armor line (`-----BEGIN …-----`), an
  XML tag or the end of one the printer wrapped, an HTML attribute (`VALUE="…`), a `data:` URI.
  The body's first and last characters may share the marker's line.
- **The printer's soft hyphen** at the end of a line is not base64. Such a body has no width:
  the printer also breaks after a `/`, anywhere, so a short line in it loses nothing.
- **The printer's spaces and the reader's** stay inside a body: few, between long tokens of
  random-looking characters. Prose has a space every few letters and is not base64 because its
  words join up into the alphabet (`Iamwritingasto…`).
- **Quoted-printable is not base64**: a line ending in `=` beside another such line is a soft
  break, and a body right under a non-base64 `Content-Transfer-Encoding` is that part's text.

A printer wraps a line wider than its page, so one 76-character line can arrive as 75 + 1;
pieces are summed back to the body's width. A line that comes out short in the middle of a
body lost characters: they are put back as `A` and recorded, so every later byte keeps its
place. A band nobody read is one line of them (in a soft-wrapped body a guess at its length,
recorded as such; a band that was no body line at all, a stamp the reader lost, adds a line
that was not there). A form's hidden field keeps no place: nothing depends on its bytes.

Two rules are this plugin's own, for a line the read did not certify: an `=` at its end does
not close the body when a full line that opens no new file follows, and an `=` mid-stream
decodes as `A`, so a misread costs 1–2 bytes and not the rest of the file.

The declared name is the nearest `filename=` (Content-Disposition), else `name=` (Content-Type),
in the 40 lines above the body, below the previous one and below its part's boundary; RFC 2231's
`filename*=UTF-8''…` and RFC 2047's `=?utf-8?…?=` are decoded; a path and characters a file system
refuses are dropped. Above a marker, a `name=` belongs to some other element and declares nothing.

**Containers and what is inside.** An attachment in an InfoPath form (`x0lGQ…`, bytes
`C7 49 46 41`) starts with a header giving its name and size: the file is what follows it, and
shorter than declared is `incomplete`. A text file holding more base64 (an image in an element
of an XML form, a `data:` URI in an HTML mail) gives cards of its own, three levels down, each
saying what it is inside; only what a marker opens counts there, or 256+ characters.

**Not files.** A form's hidden field (`VIEWSTATE`, `EVENTVALIDATION`) and a short value of
unknown bytes that no MIME part or marker opens (a DKIM signature, Exchange diagnostics) are
listed at the end of the cards, and neither counts on the badge nor shows the panel.

## The verdict

| Verdict | Means |
|---|---|
| **Exact** | every character certified, and the file known to be whole: a check of its format passed, or both ends of the body are proven |
| **Incomplete** | every character certified, and the body itself is cut short: a check refused it, it holds less than its declared size, it is a fragment (JPEG scan data with no header), or its last base64 group is not whole |
| **Unproven** | every character certified, and nothing says whether that is all of the file |
| **Damaged** | some characters are not certified: a cluster, a band, a line read above tolerance 0, an edit, a glyph wider than read |

A start is proven by a marker, MIME headers right above, an attachment header, or the format's
magic number. An end by padding, a closing marker, a MIME boundary, a short last line, a
declared size, or the format's own last bytes (`</html>`, RTF's `}`, `%%EOF`, a JPEG's end
marker, GIF's trailer, a ZIP's end record).

The checks are the ones bytes alone can make in a browser. DER: the outer length is the whole
body and every inner length nests. PNG: every chunk's CRC-32, up to `IEND`. A JPEG with no end
marker, a PDF with no `%%EOF` and a ZIP with no end record are refused. Nothing here renders a
PDF or decodes an image, so on such a file exact rests on its two ends.

A **wide glyph** makes a file damaged. A base64 line has no spaces, so every pen step is the
advance of the glyph before it; a step wider than its character's advance means a wider glyph
stood there and the exact read took a pixel subset of it (an `I` inside an `L`). The line is
certified and wrong. tol0 settles these by reading the glyph again and by the file's own
checksums; here they are only found and the card says how many. Those two repairs are not ported.

A CMS EnvelopedData file is exact as an envelope, and its card says it is encrypted: its content
cannot be read without the key.

## Types, and how each may be viewed

The type is sniffed from the decoded bytes, never taken from the declared name, and decides
what **View** does. A blob URL opened in a new tab runs in Recto's own origin, so decoded
markup is never handed to the browser as markup.

| View | Types |
|---|---|
| **inline** — a new tab shows it as its type | PDF; PNG, JPEG, GIF, BMP, icon, WebP, AVIF; WAV, MP3, M4A/M4B, Ogg, FLAC; MP4, QuickTime, WebM; plain text (UTF-8) |
| **text** — a new tab shows it as `text/plain` | RTF, SVG, XML, HTML, JSON, a calendar invitation, a vCard, an email (`.eml`) |
| **none** — Download only, View greyed | legacy Office (`.doc`), DOCX, XLSX, PPTX, EPUB, ZIP, 7-Zip, RAR, gzip, bzip2, TAR; TIFF, HEIC; AVI, Matroska, AMR; CMS (`.p7m`), DER; JPEG scan data with no header; anything unrecognised (`.bin`) |

Text is a 4,096-byte window that is more than 90 % printable ASCII, tabs, line breaks and
well-formed UTF-8 sequences. A lone byte ≥ 128 does not count: counting it would pass most
random binary as text (226 of the 256 byte values). An MP3 with no ID3 tag needs two frame
headers a frame apart: one `FF Ex` pair is 1 in 2,000 of random bytes.

## What it was measured on

tol0's certified reads, shaped as `linesFromBoxes` shapes the boxes. On its archive and its new
reads (423 documents, 1,324 files) every file that came out byte-identical has tol0's status:
1,291 exact, 17 incomplete, 6 unproven, 3 damaged. Seven do not come out byte-identical, and all
seven are Damaged here: four tol0 settled by reading glyphs again on the page, three it calls
damaged too, the lost characters placed differently. Over 15,000 documents it shows cards on 4 and
lists 7 header values; the earlier rules showed cards on 168, 157 of them false.

The suite holds EFTA00382083's OCR read (`tests/samples/`) to one body, pages 3–24:
`Airmail.pdf`, 81,046 bytes, a 3-page PDF MuPDF opens, by its SHA-256 (fixture: the OCR lines of
the attachment, `tests/plugins/base64_tool/fixtures/`). Everything else there is synthetic.
