// b64-core.js — base64 attachments in a document's text: found, decoded,
// typed and named.
//
// A block is a run of consecutive base64-looking lines with at least one
// "strong" line (the length and alphabet mix of a wrapped attachment body);
// runs continue across pages. Three realities of read text shape the rules —
// a wrapped attachment body is ONE file and must come out as one file:
// - A long line wraps, dropping its overflow (1–3 characters, a lone "F")
//   onto a line of its own. Such a fragment continues the run.
// - '=' padding ends an attachment, but a misread can plant '=' mid-body. So
//   padding only closes the run: the next line splits it off when it is prose
//   (a MIME boundary line), a short base64-looking word, or base64 that
//   decodes to a recognisable NEW file header (two attachments back to back).
//   A full body line that decodes to noise means the '=' was a misread and the
//   run goes on — splitting a file in half ruins both halves, while a merged
//   file survives with 1–2 wrong bytes.
// - Decoding swaps a mid-stream '=' for 'A' instead of deleting it: deleting
//   shifts every later byte by 6 bits and ruins the rest of the file.
//
// The type is sniffed from the decoded bytes, never taken from the name the
// email declares, and it decides how the file may be viewed: 'inline' (the
// browser shows its real type — PDF, images, audio, video, plain text),
// 'text' (markup — HTML, SVG, XML, RTF, an email — shown as text/plain: a
// blob URL runs in the page's own origin, so decoded markup must never run
// script there) or 'none' (archives, Office files, TIFF: saved, not viewed).
//
// No DOM: base64-tool.js gathers the text and draws the panel; the node tests
// load this very file (globalThis.B64Core).
(function () {
  const CONTENT = /^[A-Za-z0-9+/]+={0,2}$/;
  const MIN_BLOCK = 80;        // total chars — anything shorter is a false positive
  const NAME_LOOKBACK = 12;    // lines above a block searched for its file name

  // A line without whitespace (a reader may insert spaces) and without
  // leading '>' quote marks (a forwarded email quotes the body line by line).
  function stripped(text) {
    return (text || '').replace(/^\s*(?:>\s*)+/, '').replace(/\s+/g, '');
  }
  const isCandidate = s => s.length >= 4 && CONTENT.test(s);
  // strong enough to make a run a block: body length + mixed alphabet
  const isStrong = s => s.length >= 40 && CONTENT.test(s) &&
    /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9+/]/.test(s);

  // Reading-order lines [{ page, text }] → blocks
  // [{ chars, pages: [first, last], lines: [first, last], name }].
  function findBlocks(lines) {
    const blocks = [];
    let run = null;
    const flush = () => {
      if (run && run.strong && run.chars.length >= MIN_BLOCK)
        blocks.push({ chars: run.chars, pages: [run.firstPage, run.lastPage], lines: [run.first, run.last], name: null });
      run = null;
    };
    lines.forEach((line, i) => {
      const s = stripped(line.text);
      if (run && !s) return;                          // a blank line or a reader hiccup: neutral
      const cand = isCandidate(s);
      const frag = !cand && run && s.length < 4 && /^[A-Za-z0-9+/=]+$/.test(s);
      if (!cand && !frag) { flush(); return; }
      const strong = isStrong(s);
      if (run?.padEnded && cand && (!strong || startsNewFile(s))) flush();
      if (!run) run = { chars: '', strong: false, firstPage: line.page, lastPage: line.page, first: i, last: i };
      run.chars += s;
      run.strong = run.strong || strong;
      run.lastPage = line.page;
      run.last = i;
      run.padEnded = s.endsWith('=');
    });
    flush();
    let floor = 0;
    for (const b of blocks) { b.name = nameBefore(lines, b.lines[0], floor); floor = b.lines[1] + 1; }
    return blocks;
  }

  // Would this base64 line open a NEW file? Its first bytes must carry a
  // sniffable header: text and unknown bytes say no — after mid-stream
  // padding, a continuation that decodes to noise must merge.
  function startsNewFile(chars) {
    if (chars.length < 8) return false;
    try {
      return !['txt', 'bin', 'xml', 'json', 'html', 'eml'].includes(sniff(decode(chars.slice(0, 24))).ext);
    } catch { return false; }
  }

  // The file name the MIME headers above a block declare — Content-Disposition's
  // filename, else Content-Type's name — the nearest one, looking no further
  // up than the previous block's end. A header the reader wrapped ("attachment;"
  // then 'filename="…"' on the next line) is found on its own line.
  function nameBefore(lines, start, floor) {
    for (let i = start - 1; i >= Math.max(floor, start - NAME_LOOKBACK); i--) {
      const t = lines[i]?.text || '';
      const m = t.match(/\bfilename\*?\s*=\s*"?([^";]+)/i) || t.match(/\bname\s*=\s*"?([^";]+)/i);
      if (m) return cleanName(m[1]);
    }
    return null;
  }

  // A declared name made safe to save under: RFC 2231's charset'' prefix and
  // %-escapes undone, no path, no characters a file system refuses.
  function cleanName(raw) {
    let n = raw.trim().replace(/"+$/, '');
    const ext = n.match(/^[\w-]+'[\w-]*'(.*)$/);
    if (ext) { try { n = decodeURIComponent(ext[1]); } catch { n = ext[1]; } }
    n = n.split(/[\\/]/).pop().replace(/[:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
    return n && n.length <= 200 ? n : null;
  }

  // ── decoding ────────────────────────────────────────────────────────────

  function decode(chars) {
    // Only TRAILING padding is stripped; an '=' mid-stream is a misread —
    // swapped for 'A' so every later byte stays where it is (cost: 1–2
    // wrong bytes at the misread, not a ruined tail).
    let s = chars.replace(/=+$/, '').replace(/=/g, 'A');
    if (s.length % 4 === 1) s = s.slice(0, -1);       // a stray character
    s += '='.repeat((4 - s.length % 4) % 4);
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // ── type sniffing ───────────────────────────────────────────────────────

  // bytes [i, i + len) as Latin-1, in chunks (a spread of a big array
  // overflows the call stack)
  function latin1(bytes, i, len) {
    const end = Math.min(bytes.length, i + len);
    let s = '';
    for (let k = i; k < end; k += 8192) s += String.fromCharCode(...bytes.subarray(k, Math.min(end, k + 8192)));
    return s;
  }

  // The share of the first `limit` bytes that is text: printable ASCII, tab,
  // line breaks, and well-formed UTF-8 sequences. A lone high byte is not
  // text — counting every byte ≥ 128 as printable would pass most random
  // binary (226 of 256 byte values) as a text file.
  function textShare(bytes, limit = 512) {
    const n = Math.min(bytes.length, limit);
    let good = 0;
    for (let i = 0; i < n;) {
      const c = bytes[i];
      if (c === 9 || c === 10 || c === 12 || c === 13 || (c >= 32 && c < 127)) { good++; i++; continue; }
      const len = c >= 0xC2 && c <= 0xDF ? 2 : c >= 0xE0 && c <= 0xEF ? 3 : c >= 0xF0 && c <= 0xF4 ? 4 : 0;
      let ok = len > 0 && i + len <= bytes.length;
      for (let k = 1; ok && k < len; k++) ok = bytes[i + k] >= 0x80 && bytes[i + k] <= 0xBF;
      if (ok) {                                       // no overlong forms, no surrogates, nothing past U+10FFFF
        const c1 = bytes[i + 1];
        ok = !(c === 0xE0 && c1 < 0xA0) && !(c === 0xED && c1 > 0x9F) && !(c === 0xF0 && c1 < 0x90) && !(c === 0xF4 && c1 > 0x8F);
      }
      if (ok) { good += Math.min(len, n - i); i += len; } else i++;
    }
    return n ? good / n : 0;
  }

  // Magic bytes → { mime, ext, label, icon (a Material Symbols name), view }.
  function sniff(bytes) {
    const at = (i, ...vals) => vals.every((v, k) => bytes[i + k] === v);
    const str = (i, len) => latin1(bytes, i, len);
    const has = (needle, limit) => str(0, limit).includes(needle);
    const t = (mime, ext, label, icon, view = 'inline') => ({ mime, ext, label, icon, view });

    // documents
    if (str(0, 4) === '%PDF') return t('application/pdf', 'pdf', 'PDF', 'picture_as_pdf');
    if (str(0, 5) === '{\\rtf') return t('application/rtf', 'rtf', 'RTF document', 'description', 'text');
    if (at(0, 0xD0, 0xCF, 0x11, 0xE0)) return t('application/msword', 'doc', 'Office document (legacy)', 'description', 'none');

    // images
    if (at(0, 0x89, 0x50, 0x4E, 0x47)) return t('image/png', 'png', 'PNG image', 'image');
    if (at(0, 0xFF, 0xD8, 0xFF)) return t('image/jpeg', 'jpg', 'JPEG image', 'image');
    if (at(0, 0x47, 0x49, 0x46, 0x38)) return t('image/gif', 'gif', 'GIF image', 'image');
    if (at(0, 0x42, 0x4D)) return t('image/bmp', 'bmp', 'BMP image', 'image');
    if (at(0, 0x00, 0x00, 0x01, 0x00)) return t('image/x-icon', 'ico', 'Icon', 'image');
    if (at(0, 0x49, 0x49, 0x2A, 0x00) || at(0, 0x4D, 0x4D, 0x00, 0x2A))
      return t('image/tiff', 'tif', 'TIFF image', 'image', 'none');   // browsers don't render TIFF

    // RIFF container: WebP / WAV / AVI
    if (str(0, 4) === 'RIFF') {
      const kind = str(8, 4);
      if (kind === 'WEBP') return t('image/webp', 'webp', 'WebP image', 'image');
      if (kind === 'WAVE') return t('audio/wav', 'wav', 'WAV audio', 'audio_file');
      if (kind === 'AVI ') return t('video/x-msvideo', 'avi', 'AVI video', 'video_file', 'none');
      return t('application/octet-stream', 'riff', 'RIFF file', 'attach_file', 'none');
    }

    // ISO media (an ftyp box): m4a / mp4 / mov / heic / avif
    if (str(4, 4) === 'ftyp') {
      const brand = str(8, 4);
      if (brand.startsWith('M4A')) return t('audio/mp4', 'm4a', 'M4A audio', 'audio_file');
      if (brand.startsWith('M4B')) return t('audio/mp4', 'm4b', 'M4B audiobook', 'audio_file');
      if (brand.startsWith('qt')) return t('video/quicktime', 'mov', 'QuickTime video', 'video_file');
      if (brand === 'avif' || brand === 'avis') return t('image/avif', 'avif', 'AVIF image', 'image');
      if (brand.startsWith('hei') || brand === 'mif1') return t('image/heic', 'heic', 'HEIC image', 'image', 'none');
      return t('video/mp4', 'mp4', 'MP4 video', 'video_file');
    }

    // audio
    if (str(0, 3) === 'ID3' || (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0))
      return t('audio/mpeg', 'mp3', 'MP3 audio', 'audio_file');
    if (str(0, 4) === 'OggS') return t('audio/ogg', 'ogg', 'Ogg audio', 'audio_file');
    if (str(0, 4) === 'fLaC') return t('audio/flac', 'flac', 'FLAC audio', 'audio_file');

    // video (EBML: WebM or Matroska)
    if (at(0, 0x1A, 0x45, 0xDF, 0xA3))
      return has('webm', 64) ? t('video/webm', 'webm', 'WebM video', 'video_file')
        : t('video/x-matroska', 'mkv', 'Matroska video', 'video_file', 'none');

    // archives — OOXML and EPUB are ZIPs whose member paths show early on
    if (str(0, 2) === 'PK') {
      const head = str(0, 4096);
      if (head.includes('word/')) return t('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx', 'Word document', 'description', 'none');
      if (head.includes('xl/')) return t('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx', 'Excel spreadsheet', 'table_chart', 'none');
      if (head.includes('ppt/')) return t('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx', 'PowerPoint', 'slideshow', 'none');
      if (head.includes('mimetypeapplication/epub')) return t('application/epub+zip', 'epub', 'EPUB book', 'menu_book', 'none');
      return t('application/zip', 'zip', 'ZIP archive', 'folder_zip', 'none');
    }
    if (at(0, 0x37, 0x7A, 0xBC, 0xAF)) return t('application/x-7z-compressed', '7z', '7-Zip archive', 'folder_zip', 'none');
    if (str(0, 4) === 'Rar!') return t('application/vnd.rar', 'rar', 'RAR archive', 'folder_zip', 'none');
    if (at(0, 0x1F, 0x8B)) return t('application/gzip', 'gz', 'Gzip archive', 'folder_zip', 'none');
    if (str(0, 3) === 'BZh') return t('application/x-bzip2', 'bz2', 'Bzip2 archive', 'folder_zip', 'none');
    if (str(257, 5) === 'ustar') return t('application/x-tar', 'tar', 'TAR archive', 'folder_zip', 'none');

    // text — markup is viewed as text/plain, so it can never run
    if (bytes.length && textShare(bytes) > 0.9) {
      const head = str(0, 512).trimStart().toLowerCase();
      if (head.startsWith('<?xml'))
        return has('<svg', 2048) ? t('image/svg+xml', 'svg', 'SVG image', 'code', 'text')
          : t('application/xml', 'xml', 'XML file', 'code', 'text');
      if (head.startsWith('<svg')) return t('image/svg+xml', 'svg', 'SVG image', 'code', 'text');
      if (head.startsWith('<!doctype html') || head.startsWith('<html'))
        return t('text/html', 'html', 'HTML file', 'code', 'text');
      if ((head.startsWith('{') || head.startsWith('[')) && bytes.length <= 4 << 20) {
        try { JSON.parse(new TextDecoder().decode(bytes)); return t('application/json', 'json', 'JSON file', 'data_object', 'text'); }
        catch { /* not JSON — plain text */ }
      }
      if (/^(from|received|return-path|mime-version|date|subject):/.test(head))
        return t('message/rfc822', 'eml', 'Email message', 'mail', 'text');
      return t('text/plain', 'txt', 'Text file', 'article');
    }
    return t('application/octet-stream', 'bin', 'File', 'attach_file', 'none');
  }

  // The type a View opens a block as: its own for 'inline', plain text for
  // 'text' (and UTF-8 for any text), nothing for 'none'.
  function viewMime(kind) {
    if (kind.view === 'none') return null;
    if (kind.view === 'text' || kind.mime === 'text/plain') return 'text/plain;charset=utf-8';
    return kind.mime;
  }

  function formatSize(n) {
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }

  globalThis.B64Core = { findBlocks, decode, sniff, textShare, viewMime, formatSize, stripped, MIN_BLOCK };
})();
