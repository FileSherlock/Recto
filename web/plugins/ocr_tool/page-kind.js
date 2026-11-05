// page-kind.js — is a page paper and ink, the kind of page the reader reads?
// DOM-free (OCRPageKind; the node tests load this very file).
//
// The reader is made for pages of paper and ink. A photograph — a phone photo
// of a letter, 5032 × 3355 — or an image whose transparent background it reads
// as black sends the colour step and every pass of the reader through the
// whole page: minutes, the colour step alone freezing the page for 152 s, for
// nothing it can certify. A page is read when most of it is its own paper or
// dark ink. Measured 2026-11-06 on 345 pages of the project's documents
// (scans and renders, text and redaction bars) as the gate samples them: the
// paper share was 0.365–1.00 (0.365 on a page that is two-thirds redaction
// bars) and paper + ink 0.823–1.00; on a phone photo of a letter, another
// photograph and six wallpapers paper + ink was at most 0.75, or the paper
// share at most 0.26.
//
//   OCRPageKind.judge(rgba, w, h) → { paper, near, dark, document }
//     rgba      the page as the reader sees it (4 bytes a pixel; a transparent
//               pixel is the black the reader takes it for)
//     paper     the paper's level: the most frequent level of the bright half
//     near      share of pixels within NEAR_LEVELS of it
//     dark      share at or below DARK_MAX (ink, redaction bars)
//     document  near ≥ MIN_PAPER and near + dark ≥ MIN_PAGE
(function (root) {
  'use strict';

  const NEAR_LEVELS = 24;    // a pixel this close to the paper's level is paper
  const DARK_MAX = 80;       // at or below: ink
  const MIN_PAPER = 0.3;     // a page has paper (a black or a dark picture has none)
  const MIN_PAGE = 0.78;     // and paper and ink are most of it (photographs: mid-tones)

  function judge(rgba, w, h) {
    const n = w * h, hist = new Uint32Array(256);
    // the reader's own gray: the mean of the three channels (engine/core.js gray)
    for (let i = 0; i < n * 4; i += 4) hist[((rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3 + 0.5) | 0]++;
    let paper = 128;
    for (let v = 129; v < 256; v++) if (hist[v] > hist[paper]) paper = v;
    let near = 0, dark = 0;
    for (let v = 0; v < 256; v++) {
      if (Math.abs(v - paper) <= NEAR_LEVELS) near += hist[v];
      else if (v <= DARK_MAX) dark += hist[v];
    }
    near /= Math.max(1, n);
    dark /= Math.max(1, n);
    return { paper, near: +near.toFixed(3), dark: +dark.toFixed(3), document: near >= MIN_PAPER && near + dark >= MIN_PAGE };
  }

  root.OCRPageKind = { judge, NEAR_LEVELS, DARK_MAX, MIN_PAPER, MIN_PAGE };
})(typeof globalThis !== 'undefined' ? globalThis : this);
