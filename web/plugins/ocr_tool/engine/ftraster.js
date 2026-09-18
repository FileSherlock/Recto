// ftraster.js — the certified glyph rasterizer, as an engine module.
//
// This is ftclone/{ftclone,ttf,cff}.mjs — the faithful port of the glyph
// pipeline inside mupdf 1.28 (FreeType 2.13 smooth rasterizer, FT_INT64
// build, FZ_BLEND over white), byte-certified 0-diff against mupdf fillText
// for TrueType and CFF (`npm run certify:ftclone`) — moved here so the SAME
// code runs in node and in a browser: it takes font BYTES, not paths, and
// reads them through a small big-endian view instead of node's Buffer. The
// ftclone/*.mjs files are now thin wrappers over this module, so the
// certification certifies what the browser runs.
//
// On top of the rasterizer:
//   loadFace(bytes)   any sfnt (TrueType glyf, or OpenType CFF) or a bare
//                     .cff → a face with cmap, hmtx, outlines and the
//                     decoration metrics (post underline, OS/2 strikeout)
//   makeSet(face, o)  a glyph SET in the exact in-memory shape the reader
//                     and render.js use (blindocr.js materializeSet), whose
//                     records are rasterized ON DEMAND: set.ensure('text')
//                     renders the four ¼-px x-phases of every character it
//                     has not drawn yet. A set is therefore no longer limited
//                     to the families, styles and sizes somebody generated in
//                     advance — any face file, any size, regular to bold
//                     italic, is drawn with mupdf's own bytes.
//   rectCoverage(…)   an axis-aligned filled rectangle under mupdf's path
//                     rasterizer (underline, strikethrough) — see the note at
//                     the function; certified by ftclone/certify-rect.mjs.
(function (root) {
  'use strict';

  // ---- a big-endian byte view with the handful of Buffer methods the
  // loaders were written against (so their bodies stay verbatim) ----
  class ByteView extends Uint8Array {
    readUInt16BE(o) { return (this[o] << 8) | this[o + 1]; }
    readInt16BE(o) { const v = (this[o] << 8) | this[o + 1]; return v & 0x8000 ? v - 0x10000 : v; }
    readUInt32BE(o) { return ((this[o] * 0x1000000) + ((this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3])) >>> 0; }
    readInt32BE(o) { return (this[o] << 24) | (this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]; }
    readInt8(o) { const v = this[o]; return v & 0x80 ? v - 0x100 : v; }
    latin1(a, b) { let s = ''; for (let i = a; i < b; i++) s += String.fromCharCode(this[i]); return s; }
  }
  // Uint8Array.prototype.subarray keeps the subclass (species), so a
  // subarray of a ByteView is a ByteView — the CFF INDEX items rely on it.
  function BV(input) {
    if (input instanceof ByteView) return input;
    if (input instanceof ArrayBuffer) return new ByteView(input);
    return new ByteView(input.buffer, input.byteOffset, input.byteLength);   // Uint8Array / node Buffer
  }

  function sfntTables(b) {
    const numTables = b.readUInt16BE(4);
    const tables = {};
    for (let i = 0; i < numTables; i++) {
      const o = 12 + 16 * i;
      tables[b.latin1(o, o + 4)] = { off: b.readUInt32BE(o + 8), len: b.readUInt32BE(o + 12) };
    }
    return tables;
  }

  // cmap: prefer 3/1 format 4 (the certified path, verbatim); a face that
  // only has a format-12 subtable (3/10) is read through it
  function cmapLookup(b, tables) {
    const cm = tables.cmap.off;
    const nSub = b.readUInt16BE(cm + 2);
    let sub = null, sub12 = null;
    for (let i = 0; i < nSub; i++) {
      const o = cm + 4 + 8 * i;
      const pid = b.readUInt16BE(o), eid = b.readUInt16BE(o + 2), soff = b.readUInt32BE(o + 4);
      const fmt = b.readUInt16BE(cm + soff);
      if (fmt === 12 && ((pid === 3 && eid === 10) || pid === 0)) sub12 = cm + soff;
      if (fmt !== 4) continue;
      if ((pid === 3 && (eid === 1 || eid === 10)) || (pid === 0)) { sub = cm + soff; if (pid === 3 && eid === 1) break; }
    }
    if (sub == null && sub12 == null) throw new Error('no usable cmap subtable (format 4 or 12)');
    if (sub == null) {
      const n = b.readUInt32BE(sub12 + 12);
      return function gidFor(cp) {
        let lo = 0, hi = n - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1, g = sub12 + 16 + 12 * mid;
          const s = b.readUInt32BE(g), e = b.readUInt32BE(g + 4);
          if (cp < s) hi = mid - 1; else if (cp > e) lo = mid + 1;
          else return b.readUInt32BE(g + 8) + (cp - s);
        }
        return 0;
      };
    }
    const segX2 = b.readUInt16BE(sub + 6);
    const endO = sub + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
    return function gidFor(cp) {
      for (let s = 0; s < segX2; s += 2) {
        if (cp <= b.readUInt16BE(endO + s)) {
          const start = b.readUInt16BE(startO + s);
          if (cp < start) return 0;
          const ro = b.readUInt16BE(rangeO + s);
          if (ro === 0) return (cp + b.readInt16BE(deltaO + s)) & 0xFFFF;
          const gi = b.readUInt16BE(rangeO + s + ro + (cp - start) * 2);
          return gi === 0 ? 0 : (gi + b.readInt16BE(deltaO + s)) & 0xFFFF;
        }
      }
      return 0;
    };
  }

  // ---- ttf.mjs ----
  function loadTTF(input, tableDir) {
    const b = BV(input);
    const tables = tableDir || sfntTables(b);
    const head = tables.head.off;
    const unitsPerEm = b.readUInt16BE(head + 18);
    const locFormat = b.readInt16BE(head + 50);
    const numGlyphs = b.readUInt16BE(tables.maxp.off + 4);
    const numHM = b.readUInt16BE(tables.hhea.off + 34);

    const gidFor = cmapLookup(b, tables);

    function locaOff(gid) {
      const lo = tables.loca.off;
      return locFormat ? [b.readUInt32BE(lo + 4 * gid), b.readUInt32BE(lo + 4 * gid + 4)]
                       : [2 * b.readUInt16BE(lo + 2 * gid), 2 * b.readUInt16BE(lo + 2 * gid + 2)];
    }

    function metrics(gid) {
      const hm = tables.hmtx.off;
      const i = Math.min(gid, numHM - 1);
      return { adv: b.readUInt16BE(hm + 4 * i), lsb: gid < numHM ? b.readInt16BE(hm + 4 * gid + 2) : b.readInt16BE(hm + 4 * numHM + 2 * (gid - numHM)) };
    }

    // returns array of contours, each = array of {x,y,on} in font units
    function glyphPoints(gid, depth = 0) {
      if (depth > 5) return [];
      const [o0, o1] = locaOff(gid);
      if (o1 <= o0) return [];
      const g = tables.glyf.off + o0;
      const nc = b.readInt16BE(g);
      if (nc >= 0) {
        const endPts = [];
        for (let i = 0; i < nc; i++) endPts.push(b.readUInt16BE(g + 10 + 2 * i));
        const nPts = endPts[nc - 1] + 1;
        let o = g + 10 + 2 * nc;
        o += 2 + b.readUInt16BE(o);               // instructions
        const flags = [];
        while (flags.length < nPts) {
          const f = b[o++]; flags.push(f);
          if (f & 8) { let r = b[o++]; while (r--) flags.push(f); }
        }
        const xs = [], ys = [];
        let v = 0;
        for (const f of flags) {
          if (f & 2) { const d = b[o++]; v += (f & 16) ? d : -d; }
          else if (!(f & 16)) { v += b.readInt16BE(o); o += 2; }
          xs.push(v);
        }
        v = 0;
        for (const f of flags) {
          if (f & 4) { const d = b[o++]; v += (f & 32) ? d : -d; }
          else if (!(f & 32)) { v += b.readInt16BE(o); o += 2; }
          ys.push(v);
        }
        const contours = [];
        let s = 0;
        for (const e of endPts) {
          const pts = [];
          for (let i = s; i <= e; i++) pts.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) });
          contours.push(pts);
          s = e + 1;
        }
        return contours;
      }
      // composite
      const out = [];
      let o = g + 10;
      while (true) {
        const flags = b.readUInt16BE(o), gi = b.readUInt16BE(o + 2);
        o += 4;
        let a1, a2;
        if (flags & 1) { a1 = b.readInt16BE(o); a2 = b.readInt16BE(o + 2); o += 4; }
        else { a1 = b.readInt8(o); a2 = b.readInt8(o + 1); o += 2; }
        let m = [1, 0, 0, 1];
        if (flags & 8) { const s2 = b.readInt16BE(o) / 16384; m = [s2, 0, 0, s2]; o += 2; }
        else if (flags & 0x40) { m = [b.readInt16BE(o) / 16384, 0, 0, b.readInt16BE(o + 2) / 16384]; o += 4; }
        else if (flags & 0x80) { m = [b.readInt16BE(o) / 16384, b.readInt16BE(o + 2) / 16384, b.readInt16BE(o + 4) / 16384, b.readInt16BE(o + 6) / 16384]; o += 8; }
        const dx = (flags & 2) ? a1 : 0, dy = (flags & 2) ? a2 : 0;   // ARGS_ARE_XY_VALUES
        for (const c of glyphPoints(gi, depth + 1))
          out.push(c.map(p => ({ x: m[0] * p.x + m[2] * p.y + dx, y: m[1] * p.x + m[3] * p.y + dy, on: p.on })));
        if (!(flags & 0x20)) break;
      }
      return out;
    }

    // contours (TT points) -> {start, segs[{ctrl?,to}]} list
    function toSegContours(ptContours) {
      const res = [];
      for (const pts of ptContours) {
        const n = pts.length;
        if (n < 2) continue;
        let s = pts.findIndex(p => p.on);
        let start, ordered;
        if (s === -1) {
          start = [(pts[0].x + pts[n - 1].x) / 2, (pts[0].y + pts[n - 1].y) / 2];
          ordered = [...pts];
        } else {
          start = [pts[s].x, pts[s].y];
          ordered = [];
          for (let i = 1; i <= n; i++) ordered.push(pts[(s + i) % n]);
        }
        const segs = [];
        let pend = null;
        for (const p of ordered) {
          if (p.on) {
            segs.push(pend ? { ctrl: [pend.x, pend.y], to: [p.x, p.y] } : { to: [p.x, p.y] });
            pend = null;
          } else {
            if (pend) segs.push({ ctrl: [pend.x, pend.y], to: [(pend.x + p.x) / 2, (pend.y + p.y) / 2] });
            pend = p;
          }
        }
        if (pend) segs.push({ ctrl: [pend.x, pend.y], to: start.slice() });
        else {
          const last = segs.length ? segs[segs.length - 1].to : start;
          if (last[0] !== start[0] || last[1] !== start[1]) segs.push({ to: start.slice() });
        }
        res.push({ start, segs });
      }
      return res;
    }

    return {
      unitsPerEm, tables, gidFor, metrics,
      outline(cp) {
        const gid = gidFor(cp);
        if (!gid) return null;
        return { contours: toSegContours(glyphPoints(gid)), ...metrics(gid), gid };
      },
      // raw TT points ({x,y,on} per contour) — for FT-exact decomposition where
      // implicit midpoints must be computed AFTER scaling, in 26.6 integers
      rawOutline(cp) {
        const gid = gidFor(cp);
        if (!gid) return null;
        return { contours: glyphPoints(gid), ...metrics(gid), gid };
      },
    };
  }

  // ---- cff.mjs ----
  function loadCFF(input) {
    const b = BV(input);
    if (b[0] !== 1) throw new Error('CFF major != 1');
    const hdrSize = b[2];

    function index(off) {
      const count = b.readUInt16BE(off);
      if (count === 0) return { items: [], end: off + 2 };
      const offSize = b[off + 2];
      const offAt = i => {
        let v = 0;
        for (let k = 0; k < offSize; k++) v = v * 256 + b[off + 3 + i * offSize + k];
        return v;
      };
      const dataStart = off + 3 + (count + 1) * offSize - 1;
      const items = [];
      for (let i = 0; i < count; i++) items.push(b.subarray(dataStart + offAt(i), dataStart + offAt(i + 1)));
      return { items, end: dataStart + offAt(count) };
    }

    const nameIdx = index(hdrSize);
    const topIdx = index(nameIdx.end);
    const stringIdx = index(topIdx.end);
    const gsubrIdx = index(stringIdx.end);

    function parseDict(data) {
      const d = {};
      const st = [];
      for (let i = 0; i < data.length;) {
        const b0 = data[i];
        if (b0 <= 21) {
          let op = b0;
          i++;
          if (b0 === 12) { op = 1200 + data[i]; i++; }
          d[op] = st.slice();
          st.length = 0;
        } else if (b0 === 28) { st.push(data.readInt16BE(i + 1)); i += 3; }
        else if (b0 === 29) { st.push(data.readInt32BE(i + 1)); i += 5; }
        else if (b0 === 30) {           // real
          let s = '';
          i++;
          loop: while (i < data.length) {
            for (const nib of [data[i] >> 4, data[i] & 15]) {
              if (nib <= 9) s += nib;
              else if (nib === 10) s += '.';
              else if (nib === 11) s += 'E';
              else if (nib === 12) s += 'E-';
              else if (nib === 14) s += '-';
              else if (nib === 15) { i++; break loop; }
            }
            i++;
          }
          st.push(parseFloat(s));
        }
        else if (b0 >= 32 && b0 <= 246) { st.push(b0 - 139); i++; }
        else if (b0 >= 247 && b0 <= 250) { st.push((b0 - 247) * 256 + data[i + 1] + 108); i += 2; }
        else if (b0 >= 251 && b0 <= 254) { st.push(-(b0 - 251) * 256 - data[i + 1] - 108); i += 2; }
        else throw new Error('dict op ' + b0);
      }
      return d;
    }

    const top = parseDict(topIdx.items[0]);
    const fontMatrix = top[1207] ?? [0.001, 0, 0, 0.001, 0, 0];
    const charStrings = index(top[17][0]);
    let subrs = { items: [] };
    if (top[18]) {
      const [pSize, pOff] = top[18];
      const priv = parseDict(b.subarray(pOff, pOff + pSize));
      if (priv[19]) subrs = index(pOff + priv[19][0]);
    }
    const bias = n => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);
    const gBias = bias(gsubrIdx.items.length), lBias = bias(subrs.items.length);

    function runCharstring(gid) {
      const cs = charStrings.items[gid];
      if (!cs) return null;
      const st = [];
      let x = 0, y = 0, nStems = 0, width = null;
      const contours = [];
      let cur = null;
      const moveTo = (nx, ny) => { if (cur && cur.segs.length) contours.push(cur); cur = { start: [nx, ny], segs: [] }; };
      const lineTo = (nx, ny) => cur && cur.segs.push({ to: [nx, ny] });
      const curveTo = (c1x, c1y, c2x, c2y, nx, ny) => cur && cur.segs.push({ c1: [c1x, c1y], c2: [c2x, c2y], to: [nx, ny] });
      const stems = () => { nStems += st.length >> 1; st.length = 0; };

      function exec(code, depth) {
        if (depth > 10) throw new Error('subr depth');
        for (let i = 0; i < code.length;) {
          const b0 = code[i];
          if (b0 >= 32 || b0 === 28) {
            if (b0 === 28) { st.push(code.readInt16BE(i + 1)); i += 3; }
            else if (b0 <= 246) { st.push(b0 - 139); i++; }
            else if (b0 <= 250) { st.push((b0 - 247) * 256 + code[i + 1] + 108); i += 2; }
            else if (b0 <= 254) { st.push(-(b0 - 251) * 256 - code[i + 1] - 108); i += 2; }
            else { st.push(code.readInt32BE(i + 1) / 65536); i += 5; }   // 16.16
            continue;
          }
          i++;
          switch (b0) {
            case 1: case 3: case 18: case 23:      // h/vstem(hm)
              if (width === null && st.length % 2 === 1) width = st.shift();
              stems(); break;
            case 19: case 20:                       // hintmask/cntrmask
              if (width === null && st.length % 2 === 1) width = st.shift();
              stems(); i += (nStems + 7) >> 3; break;
            case 21:                                // rmoveto
              if (width === null && st.length > 2) width = st.shift();
              x += st[0]; y += st[1]; moveTo(x, y); st.length = 0; break;
            case 22:                                // hmoveto
              if (width === null && st.length > 1) width = st.shift();
              x += st[0]; moveTo(x, y); st.length = 0; break;
            case 4:                                 // vmoveto
              if (width === null && st.length > 1) width = st.shift();
              y += st[0]; moveTo(x, y); st.length = 0; break;
            case 5:                                 // rlineto
              for (let k = 0; k + 1 < st.length; k += 2) { x += st[k]; y += st[k + 1]; lineTo(x, y); }
              st.length = 0; break;
            case 6: case 7: {                       // hlineto / vlineto (alternating)
              let horiz = b0 === 6;
              for (let k = 0; k < st.length; k++) { if (horiz) x += st[k]; else y += st[k]; lineTo(x, y); horiz = !horiz; }
              st.length = 0; break;
            }
            case 8:                                 // rrcurveto
              for (let k = 0; k + 5 < st.length; k += 6) rr(st, k);
              st.length = 0; break;
            case 24: {                              // rcurveline
              let k = 0;
              for (; k + 5 < st.length - 2; k += 6) rr(st, k);
              x += st[k]; y += st[k + 1]; lineTo(x, y); st.length = 0; break;
            }
            case 25: {                              // rlinecurve
              let k = 0;
              for (; k + 1 < st.length - 6; k += 2) { x += st[k]; y += st[k + 1]; lineTo(x, y); }
              rr(st, k); st.length = 0; break;
            }
            case 26: {                              // vvcurveto
              let k = 0, dx1 = 0;
              if (st.length % 4 === 1) { dx1 = st[0]; k = 1; }
              for (; k + 3 < st.length; k += 4) {
                const c1x = x + dx1, c1y = y + st[k];
                const c2x = c1x + st[k + 1], c2y = c1y + st[k + 2];
                x = c2x; y = c2y + st[k + 3];
                curveTo(c1x, c1y, c2x, c2y, x, y); dx1 = 0;
              }
              st.length = 0; break;
            }
            case 27: {                              // hhcurveto
              let k = 0, dy1 = 0;
              if (st.length % 4 === 1) { dy1 = st[0]; k = 1; }
              for (; k + 3 < st.length; k += 4) {
                const c1x = x + st[k], c1y = y + dy1;
                const c2x = c1x + st[k + 1], c2y = c1y + st[k + 2];
                x = c2x + st[k + 3]; y = c2y;
                curveTo(c1x, c1y, c2x, c2y, x, y); dy1 = 0;
              }
              st.length = 0; break;
            }
            case 30: case 31: {                     // vhcurveto / hvcurveto
              let horiz = b0 === 31;
              let k = 0;
              while (k + 3 < st.length) {
                const last = k + 8 > st.length;     // 5-arg tail?
                const extra = last && k + 5 === st.length ? st[k + 4] : 0;
                let c1x, c1y, c2x, c2y;
                if (horiz) {
                  c1x = x + st[k]; c1y = y;
                  c2x = c1x + st[k + 1]; c2y = c1y + st[k + 2];
                  y = c2y + st[k + 3]; x = c2x + extra;
                } else {
                  c1x = x; c1y = y + st[k];
                  c2x = c1x + st[k + 1]; c2y = c1y + st[k + 2];
                  x = c2x + st[k + 3]; y = c2y + extra;
                }
                curveTo(c1x, c1y, c2x, c2y, x, y);
                horiz = !horiz; k += 4;
              }
              st.length = 0; break;
            }
            case 10: { const idx = st.pop() + lBias; exec(subrs.items[idx], depth + 1); break; }
            case 29: { const idx = st.pop() + gBias; exec(gsubrIdx.items[idx], depth + 1); break; }
            case 11: return;                        // return
            case 14:                                // endchar
              if (width === null && st.length % 2 === 1) width = st.shift();
              if (cur && cur.segs.length) contours.push(cur);
              cur = null; return;
            default: throw new Error('charstring op ' + b0 + ' gid ' + gid);
          }
        }
      }
      function rr(s, k) {
        const c1x = x + s[k], c1y = y + s[k + 1];
        const c2x = c1x + s[k + 2], c2y = c1y + s[k + 3];
        x = c2x + s[k + 4]; y = c2y + s[k + 5];
        curveTo(c1x, c1y, c2x, c2y, x, y);
      }
      exec(cs, 0);
      if (cur && cur.segs.length) contours.push(cur);
      return contours;
    }

    // charset: gid -> SID. Predefined 0/1/2 are identity-ish (ISOAdobe: sid==gid);
    // otherwise format 0 (flat SID array) or 1/2 (ranges). Lets a caller resolve a
    // standard glyph name without mupdf — SID 78 is 'm' (66='a' + 12).
    function gidForSid(sid) {
      const off = top[15] ? top[15][0] : 0;
      const n = charStrings.items.length;
      if (off <= 2) return sid < n ? sid : -1;   // predefined: ISOAdobe order == gid
      const fmt = b[off];
      if (fmt === 0) {
        for (let gid = 1; gid < n; gid++) if (b.readUInt16BE(off + 1 + (gid - 1) * 2) === sid) return gid;
        return -1;
      }
      if (fmt === 1 || fmt === 2) {
        const step = fmt === 1 ? 3 : 4;
        let gid = 1, p = off + 1;
        while (gid < n) {
          const first = b.readUInt16BE(p);
          const nLeft = fmt === 1 ? b[p + 2] : b.readUInt16BE(p + 2);
          if (sid >= first && sid <= first + nLeft) return gid + (sid - first);
          gid += nLeft + 1; p += step;
        }
        return -1;
      }
      return -1;
    }

    return {
      unitsPerEm: Math.round(1 / fontMatrix[0]),
      fontMatrix,
      numGlyphs: charStrings.items.length,
      outline: runCharstring,
      gidForSid,
    };
  }

  // ---- ftclone.mjs ----
  const ONE_PIXEL = 256;
  const UPSCALE = x => x << 2;          // 26.6 -> 26.8
  const TRUNC = x => x >> 8;
  const FRACT = x => x & 255;
  const INT_MIN = -2147483648;

  // FT_MulFix: (a*b + 0x8000 - (ab<0)) >> 16, arithmetic shift = floor
  function mulfix(a, b) {
    const ab = a * b;                    // |ab| < 2^40 — exact in double
    return Math.floor((ab + (ab < 0 ? 0x7FFF : 0x8000)) / 65536);
  }

  class Raster {
    constructor(W, H) {
      this.W = W; this.H = H;
      this.rows = Array.from({ length: H }, () => new Map());  // ey -> (ex -> cell)
      this.cur = null;                   // current cell or null (dumpster)
      this.x = 0; this.y = 0;            // 26.8 current position
    }
    setCell(ex, ey) {
      if (ey < 0 || ey >= this.H || ex >= this.W) { this.cur = null; return; }
      ex = Math.max(ex, -1);
      const row = this.rows[ey];
      let c = row.get(ex);
      if (!c) { c = { x: ex, cover: 0, area: 0 }; row.set(ex, c); }
      this.cur = c;
    }
    integrate(a, b) {
      const c = this.cur;
      if (c) { c.cover += a; c.area += a * b; }
    }
    moveTo(x, y) {                       // 26.8 coords
      this.setCell(TRUNC(x), TRUNC(y));
      this.x = x; this.y = y;
    }
    // gray_render_line, FT_INT64 variant (prod walker)
    lineTo(to_x, to_y) {
      let ey1 = TRUNC(this.y), ey2 = TRUNC(to_y);
      if ((ey1 >= this.H && ey2 >= this.H) || (ey1 < 0 && ey2 < 0)) { this.x = to_x; this.y = to_y; return; }
      let ex1 = TRUNC(this.x), ex2 = TRUNC(to_x);
      let fx1 = FRACT(this.x), fy1 = FRACT(this.y);
      let fx2, fy2;
      const dx = to_x - this.x, dy = to_y - this.y;

      if (ex1 === ex2 && ey1 === ey2) { /* inside one cell */ }
      else if (dy === 0) { this.setCell(ex2, ey2); this.x = to_x; this.y = to_y; return; }
      else if (dx === 0) {
        if (dy > 0) do {
          fy2 = ONE_PIXEL;
          this.integrate(fy2 - fy1, fx1 * 2);
          fy1 = 0; ey1++;
          this.setCell(ex1, ey1);
        } while (ey1 !== ey2);
        else do {
          fy2 = 0;
          this.integrate(fy2 - fy1, fx1 * 2);
          fy1 = ONE_PIXEL; ey1--;
          this.setCell(ex1, ey1);
        } while (ey1 !== ey2);
      } else {
        let prod = dx * fy1 - dy * fx1;  // |dx|,|dy| < 2^15 — exact
        const dxr = ex1 !== ex2 ? Math.trunc(0xFFFFFFFF / dx) : 0;   // C signed div: trunc toward 0
        const dyr = ey1 !== ey2 ? Math.trunc(0xFFFFFFFF / dy) : 0;
        const udiv = (a, br) => Math.floor((a * br) / 4294967296);
        do {
          if (prod - dx * ONE_PIXEL > 0 && prod <= 0) {                    /* left */
            fx2 = 0;
            fy2 = udiv(-prod, -dxr);     // FT_UDIV(-prod, -dx): uses reciprocal of -dx
            prod -= dy * ONE_PIXEL;
            this.integrate(fy2 - fy1, fx1 + fx2);
            fx1 = ONE_PIXEL; fy1 = fy2; ex1--;
          } else if (prod - dx * ONE_PIXEL + dy * ONE_PIXEL > 0 &&
                     prod - dx * ONE_PIXEL <= 0) {                          /* up */
            prod -= dx * ONE_PIXEL;
            fx2 = udiv(-prod, dyr);
            fy2 = ONE_PIXEL;
            this.integrate(fy2 - fy1, fx1 + fx2);
            fx1 = fx2; fy1 = 0; ey1++;
          } else if (prod + dy * ONE_PIXEL >= 0 &&
                     prod - dx * ONE_PIXEL + dy * ONE_PIXEL <= 0) {         /* right */
            prod += dy * ONE_PIXEL;
            fx2 = ONE_PIXEL;
            fy2 = udiv(prod, dxr);
            this.integrate(fy2 - fy1, fx1 + fx2);
            fx1 = 0; fy1 = fy2; ex1++;
          } else {                                                          /* down */
            fx2 = udiv(prod, -dyr);
            fy2 = 0;
            prod += dx * ONE_PIXEL;
            this.integrate(fy2 - fy1, fx1 + fx2);
            fx1 = fx2; fy1 = ONE_PIXEL; ey1--;
          }
          this.setCell(ex1, ey1);
        } while (ex1 !== ex2 || ey1 !== ey2);
      }
      fx2 = FRACT(to_x); fy2 = FRACT(to_y);
      this.integrate(fy2 - fy1, fx1 + fx2);
      this.x = to_x; this.y = to_y;
    }
    // gray_render_cubic + gray_split_cubic (FT_INT64 build). controls/to in 26.6!
    cubicTo(c1x6, c1y6, c2x6, c2y6, tx6, ty6) {
      const stack = [];   // arc frames of 4 points, arc = top index
      const A = [];       // flat array of points {x,y}; arc window = A[ai..ai+3]
      for (let k = 0; k < 16 * 3 + 1; k++) A.push({ x: 0, y: 0 });
      let ai = 0;
      A[0].x = UPSCALE(tx6); A[0].y = UPSCALE(ty6);
      A[1].x = UPSCALE(c2x6); A[1].y = UPSCALE(c2y6);
      A[2].x = UPSCALE(c1x6); A[2].y = UPSCALE(c1y6);
      A[3].x = this.x; A[3].y = this.y;
      const H = this.H;
      const t0 = TRUNC(A[0].y), t1 = TRUNC(A[1].y), t2 = TRUNC(A[2].y), t3 = TRUNC(A[3].y);
      if ((t0 >= H && t1 >= H && t2 >= H && t3 >= H) || (t0 < 0 && t1 < 0 && t2 < 0 && t3 < 0)) {
        this.x = A[0].x; this.y = A[0].y; return;
      }
      const split = i => {
        let a, b, c;
        A[i + 6].x = A[i + 3].x;
        a = A[i].x + A[i + 1].x; b = A[i + 1].x + A[i + 2].x; c = A[i + 2].x + A[i + 3].x;
        A[i + 5].x = c >> 1; c += b; A[i + 4].x = c >> 2; A[i + 1].x = a >> 1;
        a += b; A[i + 2].x = a >> 2; A[i + 3].x = (a + c) >> 3;
        A[i + 6].y = A[i + 3].y;
        a = A[i].y + A[i + 1].y; b = A[i + 1].y + A[i + 2].y; c = A[i + 2].y + A[i + 3].y;
        A[i + 5].y = c >> 1; c += b; A[i + 4].y = c >> 2; A[i + 1].y = a >> 1;
        a += b; A[i + 2].y = a >> 2; A[i + 3].y = (a + c) >> 3;
      };
      for (;;) {
        if (Math.abs(2 * A[ai].x - 3 * A[ai + 1].x + A[ai + 3].x) > ONE_PIXEL / 2 ||
            Math.abs(2 * A[ai].y - 3 * A[ai + 1].y + A[ai + 3].y) > ONE_PIXEL / 2 ||
            Math.abs(A[ai].x - 3 * A[ai + 2].x + 2 * A[ai + 3].x) > ONE_PIXEL / 2 ||
            Math.abs(A[ai].y - 3 * A[ai + 2].y + 2 * A[ai + 3].y) > ONE_PIXEL / 2) {
          split(ai); ai += 3;
          if (ai + 6 >= A.length) for (let k = 0; k < 6; k++) A.push({ x: 0, y: 0 });
          continue;
        }
        this.lineTo(A[ai].x, A[ai].y);
        if (ai === 0) return;
        ai -= 3;
      }
    }
    // gray_render_conic, DDA (FT_INT64) variant. control/to in 26.6!
    conicTo(cx6, cy6, tx6, ty6) {
      const p0x = this.x, p0y = this.y;
      const p1x = UPSCALE(cx6), p1y = UPSCALE(cy6);
      const p2x = UPSCALE(tx6), p2y = UPSCALE(ty6);
      if ((TRUNC(p0y) >= this.H && TRUNC(p1y) >= this.H && TRUNC(p2y) >= this.H) ||
          (TRUNC(p0y) < 0 && TRUNC(p1y) < 0 && TRUNC(p2y) < 0)) {
        this.x = p2x; this.y = p2y; return;
      }
      const bx = p1x - p0x, by = p1y - p0y;
      const ax = p2x - p1x - bx, ay = p2y - p1y - by;
      let dx = Math.abs(ax), dyv = Math.abs(ay);
      if (dx < dyv) dx = dyv;
      if (dx <= ONE_PIXEL / 4) { this.lineTo(p2x, p2y); return; }
      let shift = 16;
      do { dx >>= 2; shift--; } while (dx > ONE_PIXEL / 4);
      let count = 0x10000 >>> shift;

      const P32 = 4294967296;
      let rx = ax * 2 ** (shift + shift), ry = ay * 2 ** (shift + shift);
      let qx = bx * 2 ** (shift + 17) + rx, qy = by * 2 ** (shift + 17) + ry;
      rx *= 2; ry *= 2;
      let px = p0x * P32, py = p0y * P32;
      do {
        px += qx; py += qy;
        qx += rx; qy += ry;
        this.lineTo(Math.floor(px / P32), Math.floor(py / P32));
      } while (--count);
    }
    // gray_sweep, nonzero rule (fill = INT_MIN) — writes coverage into out
    sweep(out) {
      for (let y = 0; y < this.H; y++) {
        const cells = [...this.rows[y].values()].sort((a, b) => a.x - b.x);
        if (!cells.length) continue;
        let x = 0, cover = 0, coverage;
        const fillRule = area => {
          let c = area >> 9;                       // PIXEL_BITS*2+1-8
          if (c & INT_MIN) c = ~c;
          if (c > 255) c = 255;
          return c;
        };
        for (const cell of cells) {
          if (cover !== 0 && cell.x > x) {
            coverage = fillRule(cover);
            for (let i = x; i < cell.x; i++) out[y * this.W + i] = coverage;
          }
          cover += cell.cover * (ONE_PIXEL * 2);
          const area = cover - cell.area;
          if (area !== 0 && cell.x >= 0) {
            coverage = fillRule(area);
            out[y * this.W + cell.x] = coverage & 255;
          }
          x = cell.x + 1;
        }
        if (cover !== 0) {
          coverage = fillRule(cover);
          for (let i = x; i < this.W; i++) out[y * this.W + i] = coverage;
        }
      }
    }
  }

  // FT_DivFix: ((a<<16)/b) with C truncation
  function divfix(a, b) {
    return Math.trunc((a * 65536) / b);
  }

  class FTClone {
    // font: a loaded face — {ttf} | {cff[, gidFor]} from loadFace / loadTTF /
    // loadCFF. (ftclone/ftclone.mjs wraps this with the path-taking constructor
    // the certification and fontgen use.)
    constructor(font, W = 40, H = 40) {
      this.W = W; this.H = H;
      if (font.cff) {
        this.cff = font.cff;
        this.upm = this.cff.unitsPerEm;
        this.gidMap = null;              // set via setGidMap (cp -> gid)
        this.gidFor = font.gidFor || null;   // an sfnt-wrapped CFF brings its own cmap
      } else {
        this.ttf = font.ttf;
        this.upm = this.ttf.unitsPerEm;
      }
      // FT loads at char size 65536/64 = 1024pt @72dpi: scale16.16 = DivFix(65536, upm)
      this.scale16 = divfix(65536, this.upm);
      this.cache = new Map();
    }
    setGidMap(map) { this.gidMap = map; }
    // coverage buffer for glyph cp at matrix [em64x,0,0,-em64y]/64 pen (px64,py64)/64
    coverage(cp, em64x, em64y, px64, py64) {
      const key = `${cp}|${em64x}|${em64y}|${px64}|${py64}`;
      let cov = this.cache.get(key);
      if (cov) return cov;
      const R = new Raster(this.W, this.H);
      // funits -> 26.6 at ppem 1024 via MulFix(u, scale16) (exact x32 for upm
      // 2048), then FT_Outline_Transform m=(em64x,-em64y) 16.16, then +v.
      const pre = u => mulfix(u, this.scale16);
      const TX = u => mulfix(pre(u), em64x) + px64;
      const TY = v => mulfix(pre(v), -em64y) + py64;
      if (this.cff) {
        const gid = this.gidMap ? this.gidMap.get(cp) : this.gidFor ? this.gidFor(cp) : cp;
        const contours = this.cff.outline(gid);
        if (!contours) return null;
        for (const { start, segs } of contours) {
          const sx = TX(start[0]), sy = TY(start[1]);
          R.moveTo(UPSCALE(sx), UPSCALE(sy));
          for (const s of segs) {
            if (s.c1) R.cubicTo(TX(s.c1[0]), TY(s.c1[1]), TX(s.c2[0]), TY(s.c2[1]), TX(s.to[0]), TY(s.to[1]));
            else R.lineTo(UPSCALE(TX(s.to[0])), UPSCALE(TY(s.to[1])));
          }
          R.lineTo(UPSCALE(sx), UPSCALE(sy));   // decompose closes every contour
        }
        cov = new Uint8Array(this.W * this.H);
        R.sweep(cov);
        this.cache.set(key, cov);
        return cov;
      }
      const o = this.ttf.rawOutline(cp);
      if (!o) return null;
      // Implicit conic midpoints are (a+b)/2 with C truncation, computed in 26.6.
      const half = (a, b) => Math.trunc((a + b) / 2);
      for (const raw of o.contours) {
        if (raw.length < 2) continue;
        // em64 may be fractional in 1/32 steps (16.16 scale granularity for
        // upm 2048): mulfix(p*32, em64) === mulfix(p, em64*32) for integers,
        // so this is a no-op for every integer em64 (certification holds).
        const pts = raw.map(p => ({
          x: mulfix(p.x, Math.round(em64x * 32)) + px64,
          y: mulfix(p.y, -Math.round(em64y * 32)) + py64,
          on: p.on,
        }));
        let limit = pts.length - 1;
        let vStart = pts[0], vLast = pts[limit];
        let i = 0;
        if (!pts[0].on) {
          if (pts[limit].on) { vStart = vLast; limit--; }
          else {
            vStart = { x: half(vStart.x, vLast.x), y: half(vStart.y, vLast.y), on: true };
            vLast = vStart;
          }
          i--;
        }
        R.moveTo(UPSCALE(vStart.x), UPSCALE(vStart.y));
        let closedByConic = false;
        while (i < limit) {
          i++;
          if (pts[i].on) { R.lineTo(UPSCALE(pts[i].x), UPSCALE(pts[i].y)); continue; }
          let vControl = pts[i];
          let done = false;
          while (i < limit) {
            i++;
            const vec = pts[i];
            if (vec.on) { R.conicTo(vControl.x, vControl.y, vec.x, vec.y); done = true; break; }
            const vMiddle = { x: half(vControl.x, vec.x), y: half(vControl.y, vec.y) };
            R.conicTo(vControl.x, vControl.y, vMiddle.x, vMiddle.y);
            vControl = vec;
          }
          if (!done) {          // ran out of points: close with conic to start
            R.conicTo(vControl.x, vControl.y, vStart.x, vStart.y);
            closedByConic = true;
            break;
          }
        }
        if (!closedByConic) R.lineTo(UPSCALE(vStart.x), UPSCALE(vStart.y));
      }
      cov = new Uint8Array(this.W * this.H);
      R.sweep(cov);
      this.cache.set(key, cov);
      return cov;
    }
    // N draws composited with mupdf's integer blend over white
    render(cp, em64x, em64y, px64, py64, draws = 1) {
      const cov = this.coverage(cp, em64x, em64y, px64, py64);
      if (!cov) return null;
      const dst = new Uint8Array(this.W * this.H).fill(255);
      for (let d = 0; d < draws; d++)
        for (let i = 0; i < dst.length; i++) {
          const g = cov[i];
          if (g) dst[i] = (dst[i] * (256 - (g + (g >> 7)))) >> 8;
        }
      return dst;
    }
  }

  // ---- faces ----
  // Any font file the catalogue serves: an sfnt with TrueType outlines, an
  // sfnt wrapping a CFF table (the URW .otf builds), or a bare .cff. The
  // face carries what a set needs beyond outlines: cp → gid, the hmtx
  // advance in font units, and the decoration metrics.
  function loadFace(input) {
    const b = BV(input);
    if (b[0] === 1 && b[1] === 0 && b.latin1(0, 4) !== '\x00\x01\x00\x00') {
      // a bare CFF (major 1, minor 0, and not the sfnt 0x00010000 magic)
      const cff = loadCFF(b);
      return { kind: 'cff', cff, unitsPerEm: cff.unitsPerEm, gidFor: null, advance: null, deco: null };
    }
    const tables = sfntTables(b);
    const rdU = (t, o) => b.readUInt16BE(tables[t].off + o), rdI = (t, o) => b.readInt16BE(tables[t].off + o);
    const unitsPerEm = rdU('head', 18);
    const numHM = rdU('hhea', 34);
    const advance = gid => b.readUInt16BE(tables.hmtx.off + 4 * Math.min(gid, numHM - 1));
    // post: underlinePosition is the y of the TOP of the underline, OS/2
    // yStrikeoutPosition the TOP of the strikeout stroke (OpenType spec);
    // font units, y up
    const deco = {
      underlinePosition: tables.post ? rdI('post', 8) : Math.round(-0.1 * unitsPerEm),
      underlineThickness: tables.post ? rdI('post', 10) : Math.round(0.05 * unitsPerEm),
      strikeoutSize: tables['OS/2'] ? rdI('OS/2', 26) : Math.round(0.05 * unitsPerEm),
      strikeoutPosition: tables['OS/2'] ? rdI('OS/2', 28) : Math.round(0.26 * unitsPerEm),
    };
    if (!(deco.underlineThickness > 0)) deco.underlineThickness = Math.round(0.05 * unitsPerEm);
    if (!(deco.strikeoutSize > 0)) deco.strikeoutSize = deco.underlineThickness;
    if (tables['CFF ']) {
      const cff = loadCFF(b.subarray(tables['CFF '].off, tables['CFF '].off + tables['CFF '].len));
      return { kind: 'cff', cff, unitsPerEm, gidFor: cmapLookup(b, tables), advance, deco };
    }
    if (!tables.glyf) throw new Error('font has neither glyf nor CFF outlines');
    const ttf = loadTTF(b, tables);
    return { kind: 'ttf', ttf, unitsPerEm, gidFor: ttf.gidFor, advance, deco };
  }

  // coverage → the standard-law raster byte over white, and back (the bundle's
  // alpha; glyph-bundle.mjs COV — the smaller coverage is canonical at gb 0)
  const byteOfCov = g => (255 * (256 - (g + (g >> 7)))) >> 8;

  // ---- sets rasterized on demand ----
  // The in-memory shape is blindocr.js materializeSet's, record for record
  // (ch, adv, phx, w, h, dx, dy, bytes, alpha, ink, inkC, inkR, inkB, inkA,
  // inkLeft under byPhy.get(0)) — generated the way tools/fontgen.mjs
  // generates an .npz: rasters at em64 = trunc(sizePx·64), advances at
  // sizePx (LAWS §6), x-phases 0 ¼ ½ ¾, y-phase 0 (LAWS §1). Character order
  // is first-use order, so a dynamic set is for DRAWING; a set the reader
  // scans with wants the registry's fixed order.
  const PHASES_X = [0, 0.25, 0.5, 0.75];
  function makeSet(face, o) {
    const sizePx = +o.sizePx;
    if (!(sizePx > 0)) throw new Error('makeSet: sizePx');
    const em64 = o.em64 ?? Math.trunc(sizePx * 64);
    const PENX = Math.ceil(sizePx) + 3, BASEY = Math.ceil(sizePx * 1.6) + 3;
    const W = PENX + Math.ceil(sizePx * 2.4), H = BASEY + Math.ceil(sizePx * 0.9);
    const clone = new FTClone(face.kind === 'cff' ? { cff: face.cff, gidFor: face.gidFor } : { ttf: face.ttf }, W, H);
    const records = [];
    const set = { name: o.name || `dyn${em64}`, sizePx, em64, linear: false, dynamic: true, face,
      byPhy: new Map([[0, records]]), maxAsc: 0, maxDesc: 0, _done: new Map() };
    // render the characters of `text` this set has not drawn yet; returns
    // the ones the face has no glyph for
    set.ensure = function (text) {
      const missing = [];
      let added = false;
      for (const ch of new Set(text)) {
        if (ch === ' ') continue;
        if (set._done.has(ch)) { if (!set._done.get(ch)) missing.push(ch); continue; }
        const cp = ch.codePointAt(0);
        const gid = face.gidFor ? face.gidFor(cp) : 0;
        if (!gid) { set._done.set(ch, false); missing.push(ch); continue; }
        const adv = face.advance(gid) * sizePx / face.unitsPerEm;
        for (const phx of PHASES_X) {
          const cov = clone.coverage(cp, em64, em64, PENX * 64 + Math.round(phx * 64), BASEY * 64);
          if (!cov) continue;
          let x0 = W, y0 = H, x1 = -1, y1 = -1;
          for (let r = 0; r < H; r++) for (let c = 0; c < W; c++)
            if (byteOfCov(cov[r * W + c]) < 255) { if (c < x0) x0 = c; if (c > x1) x1 = c; if (r < y0) y0 = r; if (r > y1) y1 = r; }
          if (x1 < 0) continue;                       // no ink (a space-like glyph)
          if (x0 === 0 || y0 === 0 || x1 === W - 1 || y1 === H - 1)
            throw new Error(`glyph '${ch}' phase ${phx} touches the render window edge`);
          const w = x1 - x0 + 1, h = y1 - y0 + 1;
          const bytes = new Uint8Array(w * h), alpha = new Uint8Array(w * h);
          for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
            const g = cov[(y0 + r) * W + x0 + c], gb = byteOfCov(g);
            bytes[r * w + c] = gb;
            alpha[r * w + c] = gb === 255 ? 0 : gb === 0 ? 254 : g;   // the bundle's canonical alpha (COV)
          }
          const ink = [];
          let inkLeft = w;
          for (let c = 0; c < w; c++) for (let r = 0; r < h; r++)
            if (bytes[r * w + c] < 255) { ink.push(r * w + c); if (c < inkLeft) inkLeft = c; }
          const inkC = new Int16Array(ink.length), inkR = new Int16Array(ink.length),
            inkB = new Uint8Array(ink.length), inkA = new Uint8Array(ink.length);
          for (let k = 0; k < ink.length; k++) { inkC[k] = ink[k] % w; inkR[k] = (ink[k] / w) | 0; inkB[k] = bytes[ink[k]]; inkA[k] = alpha[ink[k]]; }
          const dx = x0 - PENX, dy = y0 - BASEY;
          records.push({ ch, adv, phx, w, h, dx, dy, bytes, alpha, ink, inkC, inkR, inkB, inkA, inkLeft });
          if (-dy > set.maxAsc) set.maxAsc = -dy;
          if (dy + h > set.maxDesc) set.maxDesc = dy + h;
          added = true;
        }
        clone.cache.clear();
        set._done.set(ch, true);
      }
      if (added) { delete set._rix; delete set._grpCache; }   // render.js glyphIndex / the reader's anchor cache
      return missing;
    };
    set.decoration = (kind, x0, x1, baseline) => decoration(face, sizePx, kind, x0, x1, baseline);
    return set;
  }

  // The rectangle of an underline or a strikethrough under a run from x0 to
  // x1 (px, float) on `baseline` (the integer row the glyphs sit on), from the
  // face's own metrics at sizePx: {x0, y0, x1, y1} in page px, y down. Works
  // for any loaded face — a set from the bundle has no face of its own.
  function decoration(face, sizePx, kind, x0, x1, baseline) {
    const d = face?.deco; if (!d) return null;
    const s = sizePx / face.unitsPerEm;
    const top = kind === 'strikethrough' ? d.strikeoutPosition : d.underlinePosition;
    const th = kind === 'strikethrough' ? d.strikeoutSize : d.underlineThickness;
    return { x0, x1, y0: baseline - top * s, y1: baseline - (top - th) * s };
  }

  // ---- a filled axis-aligned rectangle under mupdf's path rasterizer ----
  // mupdf antialiases paths on a 17 × 15 sub-sample grid per pixel (fz_aa
  // level 8): an edge at x covers sub-columns from floor(x·17), an edge at y
  // sub-rows from floor(y·15), both in float32, and a pixel's coverage is
  // (sub-columns) × (sub-rows) — 255 when full. Measured against mupdf 1.28's
  // fillPath and certified by ftclone/certify-rect.mjs (0 differing bytes over
  // the sweep). Returns {x0, y0, w, h, cov: Uint8Array} in page px, or null.
  function rectCoverage(rx0, ry0, rx1, ry1) {
    const f = Math.fround;
    const c0 = Math.floor(f(f(Math.min(rx0, rx1)) * 17)), r0 = Math.floor(f(f(Math.min(ry0, ry1)) * 15));
    let c1 = Math.floor(f(f(Math.max(rx0, rx1)) * 17)), r1 = Math.floor(f(f(Math.max(ry0, ry1)) * 15));
    // a rectangle thinner than one sub-sample still inks it: mupdf never drops
    // a hairline (measured — a 1/64-px rule draws one sub-row)
    if (c1 === c0) c1 = c0 + 1;
    if (r1 === r0) r1 = r0 + 1;
    const x0 = Math.floor(c0 / 17), x1 = Math.floor((c1 - 1) / 17) + 1;
    const y0 = Math.floor(r0 / 15), y1 = Math.floor((r1 - 1) / 15) + 1;
    const w = x1 - x0, h = y1 - y0, cov = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const ny = Math.min(r1, (y0 + y + 1) * 15) - Math.max(r0, (y0 + y) * 15);
      for (let x = 0; x < w; x++) {
        const nx = Math.min(c1, (x0 + x + 1) * 17) - Math.max(c0, (x0 + x) * 17);
        cov[y * w + x] = nx * ny;
      }
    }
    return { x0, y0, w, h, cov };
  }

  const api = { ByteView, BV, sfntTables, loadTTF, loadCFF, loadFace, FTClone, mulfix, divfix, makeSet, decoration, rectCoverage, byteOfCov };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FTRaster = api;
})(typeof self !== 'undefined' ? self : this);
