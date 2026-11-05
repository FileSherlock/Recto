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
change to one should go to the other. **The stricter rules of 2026-11-05** (a body's weak
first lines taken back, starts and ends proven only across nothing that could be the body's,
a vCard property as a marker, `midway` signatures, whole groups under padding, the format's
header behind a short magic number, linear patterns, names without bidi controls, a page's
furniture) are this copy's so far: tol0's `tools/b64` does not have them yet.

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
and a page's furniture are neutral (below). A run starts on a clean, full line — 40+
characters, upper and lower case and digits or `+/`, changing class at least every fifth
character — or on a marker.

**A file's first lines need not be strong.** A legacy Office file (`.doc`, `.xls`, `.msg`), a
TAR, a font, anything that starts with zeros opens with lines of `AAAA…` that change class too
seldom to start a run. The lines right above the first strong line that are whole lines of the
body's width (or a wrapped line's pieces summing to it) and hold base64 alone are taken back
into the body; a line with a lost cluster is taken back as one line, its characters put back
as damage. A band nobody read, a line of another width, prose or a marker stops it.

What a line is to a body (`pieceOf`):

- **Markers** open and close a body on the same line: an armor line (`-----BEGIN …-----`), an
  XML tag or the end of one the printer wrapped, an HTML attribute (`VALUE="…`), a `data:` URI,
  a vCard property that holds a file (`PHOTO;ENCODING=b;TYPE=JPEG:` — vCard 3.0 starts the photo
  on the property's own line). The body's first and last characters may share the marker's
  line. A band nobody read right under a marker alone on its line is the body's first line.
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
place. A band nobody read is one line of them (in a body with no width — soft-wrapped, or
re-flowed by the printer — a guess at its length, recorded as such; a band that was no body
line at all, a stamp the reader lost, adds a line that was not there). A form's hidden field
keeps no place: nothing depends on its bytes.

**A page's furniture** — its number (`2`, `Page 2 of 3`, `2/3`, `- 2 -`) or a production's stamp
(`EFTA00012345`, `HOUSE_OVERSIGHT_012345`, `ABC-0001234`, `DOJ-OGR-00012345`), alone or together
on a line of at most 60 characters — is printed between two pages of a body and is none of it.
As prose it is passed over. As a piece of base64 (`2`, `2/3`, `ABC0001234`) it is dropped where a
new line of the body would start; where the line before it is short it is that line's
overflow and kept; as the body's last line it is dropped and proves no end. A soft-wrapped
body ends every line but its last in the printer's hyphen, so a piece without one is the
page's; in a re-flowed body, which has no width, there is no telling, and the file is
damaged. Other running heads and footers (a browser's date, title and URL) still end a run:
such a body is listed in two parts, neither exact.

Two rules are this plugin's own, for a line the read did not certify: an `=` at its end does
not close the body when a full line that opens no new file follows, and an `=` mid-stream
decodes as `A`, so a misread costs 1–2 bytes and not the rest of the file.

The declared name is the nearest `filename=` (Content-Disposition), else `name=` (Content-Type),
in the 40 lines above the body, below the previous one and below its part's boundary; RFC 2231's
`filename*=UTF-8''…` and RFC 2047's `=?utf-8?…?=` are decoded; a path and characters a file system
refuses are dropped. Above a marker, a `name=` belongs to some other element and declares nothing.
A control that reorders text on screen (the bidi marks, embeddings, overrides and isolates,
U+061C, U+200E–200F, U+202A–202E, U+2066–2069, and the line and paragraph separators) becomes
`_` in a name and is dropped from a form field's: `invoice<RLO>fdp.exe` would show on the card as
`invoiceexe.pdf`; it shows, and saves, as `invoice_fdp.exe`.

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
| **Incomplete** | every character certified, and the body itself is cut short: a check refused it, it holds less than its declared size, it is a fragment (JPEG scan data with no header), its last base64 group is not whole, or it is padded and yet does not come out in whole groups of four (characters were lost or added inside it) |
| **Unproven** | every character certified, and nothing says whether that is all of the file |
| **Damaged** | some characters are not certified: a cluster, a band (in a body with no width, a band of a guessed length), a line read above tolerance 0, an edit, a glyph wider than read |

A wrong **Exact** is the worst outcome, so a start or an end counts only where something shows
it, and nothing shows it across what could hold the body's characters.

A start is proven by:

- a marker on the body's first line, or alone on the line above it;
- MIME headers right above, **with nothing between them and the body's first line that could
  be the body's**: no band nobody read, no line of base64 the body did not take (a page's
  furniture aside). A body whose first lines went unread is not exact, whatever its headers
  say (`unproven`, "a band nobody read stands between its MIME header and its first line");
- an attachment header (an InfoPath form's);
- the format's magic number, **where only a file's first bytes carry it**. A signature that
  stands mid-file as often proves nothing (`midway` in `sniff`): an HTML file that opens with
  `<div>`, `<p>`, `<head>`, `<body>`, `<table>`, `<meta>`, `<style>` or a comment (one that opens
  with `<!doctype html` or `<html` counts), a mail's header line, a vCard (a file of several
  begins each one so), an Ogg page that does not begin its stream, an MP3 frame with no ID3 tag.

An end is proven by padding, a closing marker, a MIME boundary, a short last line, a declared
size, or the format's own last bytes (`</html>`, RTF's `}`, `%%EOF`, a JPEG's end marker, GIF's
trailer, a ZIP's end record) — **but not by a marker, a boundary or a short line that stands
after a band nobody read** (the lost band may be the body's last line), nor where the body's
last line may be a page's number. A card that is not exact says which end is missing and why.

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

A magic number of two or three bytes is a word of text as often as a file — `PK`, `BM`, `ID3`
and `BZh` open lines of prose (`PKI enrolment notes`, `BMW service history`) — and a NUL-led
one turns up in any binary, so the format's header must stand behind it: BMP a DIB header of a
size the format has, the pixels after both headers; an icon its first directory entry (planes,
depth, size, offset); MP3 an ID3 version 2–4 and a size in 7-bit bytes; ZIP a local file header
(`PK 03 04`) or an empty archive's end record; gzip the deflate method and no reserved flag;
bzip2 a block size and its first block's magic; RAR its six-byte signature; AMR `#!AMR`; TAR its
header checksum.

Every pattern that reads a line runs in time linear in it. A text attachment is read again for
the bodies inside it, and the OCR read is replayed on every open, so a hostile line (`-----BEGIN`
and thousands of spaces, a 64,000-character word before `="`) must cost no more than a long
one: before, a 2 KB attachment froze the tab for seconds on every open of its document.

## What it was measured on

tol0's certified reads, shaped as `linesFromBoxes` shapes the boxes. On its archive and its new
reads (423 documents, 1,324 files) every file that came out byte-identical has tol0's status:
1,291 exact, 17 incomplete, 6 unproven, 3 damaged. Seven do not come out byte-identical, and all
seven are Damaged here: four tol0 settled by reading glyphs again on the page, three it calls
damaged too, the lost characters placed differently. Over 15,000 documents it shows cards on 4 and
lists 7 header values; the earlier rules showed cards on 168, 157 of them false.

Measured again with the rules of 2026-11-05 on the same reads: the same in every count, but for
one file. EFTA00685493's JPEG fragment keeps a wrapped line (68 + 8 characters) that the run had
left above its first strong line: 867 bytes, tol0's 810 the last of them byte for byte, still
incomplete. The 15,000 are unchanged.

The suite holds EFTA00382083's OCR read (`tests/samples/`) to one body, pages 3–24:
`Airmail.pdf`, 81,046 bytes, a 3-page PDF MuPDF opens, by its SHA-256 (fixture: the OCR lines of
the attachment, `tests/plugins/base64_tool/fixtures/`). Everything else there is synthetic,
among it one test for each wrong verdict the review of 2026-11-05 found: a file missing its
first lines called exact (a `.doc` short of 513 bytes, a font of 285), a lost last line before
the boundary, a band under a lone marker, a vCard photo short of its first line, an HTML file
short of its first, a padded body of an impossible length, text typed as ZIP, BMP, MP3 or
bzip2, regexes that took seconds, a name with an RLO, a page number inside a body.
