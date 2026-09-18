// extract.js — embedded text spans from a page's raw structured text.
//
// The port of the server's extracted_text/logic/extract.py, line for line: it
// takes what the core hands out — Doc.structuredText(n) (MuPDF's structured
// text in PyMuPDF's "rawdict" shape) and the placement of the page image — and
// turns it into the spans the viewer draws, in image pixels:
//
//   { page, text, x, y, w, h,          left/top/width/height, px in the 816×1056 space
//     fontSize, sizePt,                font size in px, and in PDF points (see spanSizePt)
//     font, flags,                     raw PDF font name; PyMuPDF flag bits (bold=16, italic=2, …)
//     lineId, _blockLineId, blockId, isBlockEnd, blockW,
//     chars: [{ c, x, w }] }           per-character offsets and advances, relative to x
//
// Pure functions, no DOM and no document service in here: etv-fetch.js feeds
// it, tests/spans.test.mjs checks it against the recorded server answers
// (tests/golden/*/spans-*.json). Numbers are rounded the way Python rounds
// them (half to even on the exact binary value) — the goldens hold to the
// last printed digit.
(function () {
  const PAGE_W = 816, PAGE_H = 1056;   // the viewer's page space (GEO.PAGE_WIDTH_PX / PAGE_HEIGHT_PX)

  // The fields of a lean span — what a whole-document text scan needs.
  const LEAN_FIELDS = ['page', 'text', 'x', 'y', 'w', 'h', 'sizePt', 'font'];

  // Python's round(x, n): the double's exact value, rounded to n decimals,
  // an exact tie going to the even digit. toFixed() rounds the exact value
  // too but sends ties upward, so only a tie needs a second look.
  function pyRound(x, n) {
    if (!Number.isFinite(x)) return x;
    const a = Math.abs(x);
    let r = Number(a.toFixed(n));
    const scaled = a * 10 ** n;
    if (Math.abs(scaled - Math.floor(scaled) - 0.5) < 1e-6) {
      const exact = a.toFixed(100), dot = exact.indexOf('.');
      if (/^50*$/.test(exact.slice(dot + 1 + n))) {
        const kept = exact.slice(0, dot + 1 + n);
        const lastDigit = +kept[kept.length - 1 === dot ? dot - 1 : kept.length - 1];
        if (lastDigit % 2 === 0) r = Number(kept);
      }
    }
    return x < 0 ? -r : r;
  }

  // str.strip() leaves nothing: every character is one Python calls a space.
  const PY_SPACE = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/;
  const isBlank = text => PY_SPACE.test(text);

  // The span's font size (Tfs) in points.
  //
  // MuPDF's `size` is the text matrix expansion, sqrt(|det|), which an OCR
  // layer's horizontal scaling (Tz — one per word, 60..150 %) inflates by
  // sqrt(Tz): an 11.46 pt layer reads 11.7..11.95 word by word. The vertical
  // extent of the span is unscaled by Tz, so the size is exactly the bbox
  // height over the face's (ascender − descender).
  function spanSizePt(span) {
    const size = span.size ?? 12.0;
    const bbox = span.bbox, asc = span.ascender, desc = span.descender;
    if (bbox && asc != null && desc != null && (asc - desc) > 0) {
      const h = bbox[3] - bbox[1];
      if (h > 0) return h / (asc - desc);
    }
    return size;
  }

  // All text spans of one page, in image-pixel coordinates.
  //
  //   raw      Doc.structuredText(pageNum) — blocks → lines → spans → chars
  //   pageNum  1-based
  //   imgRect  [x0, y0, x1, y1] in PDF points: where the page image sits
  //            (Doc.pageImageRect), or the page rectangle when the page has no
  //            embedded raster and is shown as a 96-dpi render of itself.
  //
  // Scaling by PAGE_W / PAGE_H (not the raster's own pixels) keeps overlay
  // positions in the viewer's space whatever the embedded image's resolution.
  function extractSpans(raw, pageNum, imgRect) {
    const rectW = imgRect[2] - imgRect[0], rectH = imgRect[3] - imgRect[1];
    const scaleX = rectW ? PAGE_W / rectW : 1.0;
    const scaleY = rectH ? PAGE_H / rectH : scaleX;
    const maxY = PAGE_H;   // crop boundary in viewer pixel space
    const spans = [];

    (raw.blocks || []).forEach((block, bIdx) => {
      if (block.type !== 0) return;   // 0 = text block
      const lines = block.lines || [];
      lines.forEach((line, lIdx) => {
        // Merge adjacent spans on the same line that share font/size/flags/color.
        // PDFs often split a single visual run into many tiny spans; merging
        // them avoids spurious per-span coordinate noise.
        const merged = [];
        for (const span of line.spans || []) {
          if (!merged.length) { merged.push({ ...span }); continue; }
          const last = merged[merged.length - 1];
          if (span.font === last.font && Math.abs((span.size ?? 12) - (last.size ?? 12)) <= 1.0
              && span.flags === last.flags && span.color === last.color) {
            const b1 = last.bbox, b2 = span.bbox;
            const gap = (b1 && b2) ? b2[0] - b1[2] : 0;
            const emSize = span.size ?? 12;
            if (gap > emSize * 1.5) {
              merged.push({ ...span });   // suspiciously far apart: not one run
            } else {
              if (b1 && b2)
                last.bbox = [Math.min(b1[0], b2[0]), Math.min(b1[1], b2[1]), Math.max(b1[2], b2[2]), Math.max(b1[3], b2[3])];
              last.chars = (last.chars || []).concat(span.chars || []);
            }
          } else {
            merged.push({ ...span });
          }
        }

        for (const span of merged) {
          const bbox = span.bbox;
          if (!bbox) continue;

          // PDF-point bbox → image-pixel coordinates
          const y0 = (bbox[1] - imgRect[1]) * scaleY;
          const x1 = (bbox[2] - imgRect[0]) * scaleX;
          let y1 = (bbox[3] - imgRect[1]) * scaleY;

          // Skip spans below the crop boundary; clamp the bottom edge
          if (y0 >= maxY) continue;
          y1 = Math.min(y1, maxY);

          // The raw PDF font name: the viewer maps it through the font
          // catalogue. An OCR layer's names are the OCR producer's
          // substitutes, never the page's.
          const font = span.font ?? 'unknown';

          const rawChars = span.chars || [];
          const emPx = (span.size ?? 12.0) * scaleX;

          // Split the characters into groups at a tab or a wide gap
          const groups = [];
          let group = [];
          let consecutiveSpaces = 0;

          rawChars.forEach((ch, ci) => {
            if (!(ch.bbox && ch.c)) return;

            // Advance = distance to the next char's x; last char → span right edge
            const adv = (ci < rawChars.length - 1 && rawChars[ci + 1].bbox)
              ? (rawChars[ci + 1].bbox[0] - ch.bbox[0]) * scaleX
              : x1 - ((ch.bbox[0] - imgRect[0]) * scaleX);

            const c = ch.c;
            if (c === ' ') consecutiveSpaces += 1; else consecutiveSpaces = 0;

            // The true empty gap after the character's bounding box
            const naturalW = (ch.bbox[2] - ch.bbox[0]) * scaleX;
            const trueGap = adv - naturalW;

            // Split at an explicit tab, an unusually wide space, or a run of spaces
            if (c === '\t' || (c === ' ' && trueGap > emPx * 0.4) || consecutiveSpaces > 1) {
              if (group.length) { groups.push(group); group = []; }
            } else if (trueGap > emPx * 0.5) {
              // A huge invisible gap after a regular character: keep it, clamp its width, split.
              group.push([ch, naturalW]);
              if (group.length) groups.push(group);
              group = [];
            } else if (c !== ' ' || consecutiveSpaces === 1) {
              group.push([ch, adv]);
            }
          });
          if (group.length) groups.push(group);

          const sizePt = spanSizePt(span);

          for (const members of groups) {
            const chars = [];
            let text = '';
            let groupX0 = Infinity, groupX1 = -Infinity;

            for (const [ch, adv] of members) {
              const c = ch.c;
              const x0g = (ch.bbox[0] - imgRect[0]) * scaleX;
              const tail = x0g + adv;
              if (x0g < groupX0) groupX0 = x0g;
              if (tail > groupX1) groupX1 = tail;

              const naturalW = (ch.bbox[2] - ch.bbox[0]) * scaleX;
              const trueGap = adv - naturalW;

              // MuPDF omitted a space token: the gap says there was one
              const insertSpace = c !== ' ' && c !== '\t' && (0.15 * emPx) < trueGap && trueGap <= (0.5 * emPx);

              text += c;
              chars.push({ c, x: pyRound(x0g - groupX0, 2), w: pyRound(insertSpace ? naturalW : adv, 2) });
              if (insertSpace) {
                text += ' ';
                chars.push({ c: ' ', x: pyRound(x0g + naturalW - groupX0, 2), w: pyRound(trueGap, 2) });
              }
            }

            if (isBlank(text)) continue;

            const entry = {
              page: pageNum,
              text,
              x: pyRound(groupX0, 2),
              y: pyRound(y0, 2),
              w: pyRound(groupX1 - groupX0, 2),
              h: pyRound(y1 - y0, 2),
              fontSize: pyRound(sizePt * scaleY, 2),
              sizePt: pyRound(sizePt, 4),
              font,
              flags: span.flags ?? 0,
              lineId: null,   // assigned below by proximity grouping
              _blockLineId: `${pageNum}_${bIdx}_${lIdx}`,
              blockId: `${pageNum}_${bIdx}`,
              isBlockEnd: lIdx === lines.length - 1,
            };
            if (chars.length) entry.chars = chars;
            spans.push(entry);
          }
        }
      });
    });

    // Group spans into lines by vertical proximity (3 px tolerance)
    if (spans.length) {
      spans.sort((a, b) => a.y - b.y);
      let lineNum = 1, lastY = spans[0].y;
      for (const s of spans) {
        if (Math.abs(s.y - lastY) > 3.0) { lineNum += 1; lastY = s.y; }
        s.lineId = `${s.page ?? pageNum}_${lineNum}`;
      }
    }

    // blockW: the container width each span must fill under justification —
    // for a mid-line span the distance to the next span, for a line-terminal
    // one the distance to the block's widest right edge.
    const blockRights = new Map(), linesMap = new Map();
    for (const span of spans) {
      const r = span.x + span.w;
      if (!blockRights.has(span.blockId) || r > blockRights.get(span.blockId)) blockRights.set(span.blockId, r);
      if (!linesMap.has(span._blockLineId)) linesMap.set(span._blockLineId, []);
      linesMap.get(span._blockLineId).push(span);
    }
    for (const lineSpans of linesMap.values()) {
      lineSpans.sort((a, b) => a.x - b.x);
      lineSpans.forEach((span, i) => {
        span.blockW = i < lineSpans.length - 1
          ? pyRound(lineSpans[i + 1].x - span.x, 2)
          : pyRound(blockRights.get(span.blockId) - span.x, 2);
      });
    }

    return spans;
  }

  const leanSpan = span => Object.fromEntries(LEAN_FIELDS.map(k => [k, span[k]]));

  globalThis.EtvExtract = { extractSpans, leanSpan, spanSizePt, pyRound, LEAN_FIELDS, PAGE_W, PAGE_H };
})();
