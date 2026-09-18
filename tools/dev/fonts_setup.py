"""Build web/assets/fonts/ from the catalogue (web/assets/fonts/fonts.json).

    python3 tools/dev/fonts_setup.py [--tol0 PATH] [--windows-fonts PATH] [--check]

A development script — the site itself needs no Python. It is only run after
the catalogue gains a face (the built files are committed).

For every file the catalogue names:
  * NimbusRoman-*.otf, NimbusSans-*.otf, NimbusMonoPS-*.otf — converted from
    tol0's certified bare CFFs (tol0/fonts/*.cff — the very outlines the OCR
    glyph sets were rendered from) into OpenType wrappers browsers and
    HarfBuzz accept. Needs fontTools.
  * cambria.ttf — the first face of Windows' cambria.ttc.
  * everything else — copied from the Windows font folder (case-insensitive
    lookup, e.g. CENSCBK.TTF → censcbk.ttf).

Files already present are left alone (delete one to rebuild it). --check
only reports what is missing and exits 1 if anything is. The Windows faces
are proprietary: the script copies them for local use the way the repo has
always shipped them; do not redistribute beyond that.
"""
import argparse
import io
import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FONT_DIR = ROOT / 'web' / 'assets' / 'fonts'


def cff_to_otf(src, dst, family, bold=False, italic=False):
    from fontTools.agl import toUnicode
    from fontTools.cffLib import CFFFontSet
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.boundsPen import BoundsPen
    from fontTools.ttLib import newTable

    with open(src, 'rb') as f:
        data = f.read()
    cff = CFFFontSet()
    cff.decompile(io.BytesIO(data), None)
    td = cff[0]
    order = list(td.charset)
    upm = int(round(1 / td.FontMatrix[0])) if getattr(td, 'FontMatrix', None) else 1000

    fb = FontBuilder(upm, isTTF=False)
    fb.setupGlyphOrder(order)
    cmap = {}
    for name in order:
        u = toUnicode(name)
        if len(u) == 1 and ord(u) not in cmap:
            cmap[ord(u)] = name
    fb.setupCharacterMap(cmap)

    metrics = {}
    for name in order:
        cs = td.CharStrings[name]
        pen = BoundsPen(None)
        cs.draw(pen)
        lsb = pen.bounds[0] if pen.bounds else 0
        metrics[name] = (int(round(cs.width)), int(round(lsb)))
    fb.setupHorizontalMetrics(metrics)

    table = newTable('CFF ')
    table.cff = cff
    fb.font['CFF '] = table

    bbox = getattr(td, 'FontBBox', [0, -200, 1000, 800])
    ascent, descent = int(bbox[3]), int(bbox[1])
    style = ' '.join(s for s, on in (('Bold', bold), ('Italic', italic)) if on) or 'Regular'
    ps = f"{family.replace(' ', '')}-{style.replace(' ', '')}"
    fb.setupHorizontalHeader(ascent=ascent, descent=descent)
    fb.setupNameTable({'familyName': family, 'styleName': style, 'psName': ps,
                       'fullName': f'{family} {style}', 'uniqueFontIdentifier': ps})
    fb.setupOS2(sTypoAscender=ascent, sTypoDescender=descent, sTypoLineGap=0,
                usWinAscent=ascent, usWinDescent=-descent,
                usWeightClass=700 if bold else 400,
                fsSelection=(0x20 if bold else 0) | (0x01 if italic else 0) | (0x40 if not (bold or italic) else 0))
    fb.setupPost()
    fb.font['head'].macStyle = (1 if bold else 0) | (2 if italic else 0)
    fb.save(str(dst))


def main():
    ap = argparse.ArgumentParser(description='Build the font files the catalogue (web/assets/fonts/fonts.json) names')
    ap.add_argument('--tol0', default=str(ROOT.parent / 'tol0'), help='the tol0 repo (its fonts/*.cff are the URW sources)')
    ap.add_argument('--windows-fonts', default=os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts'))
    ap.add_argument('--check', action='store_true', help='report missing files only')
    opts = ap.parse_args()

    tol0 = Path(opts.tol0)
    winfonts = Path(opts.windows_fonts)
    win_index = {}
    if winfonts.is_dir():
        win_index = {p.name.lower(): p for p in winfonts.iterdir() if p.is_file()}
    FONT_DIR.mkdir(parents=True, exist_ok=True)
    families = json.loads((FONT_DIR / 'fonts.json').read_text(encoding='utf-8')).get('families', [])

    built, present, missing = [], [], []
    for fam in families:
        for style, name in fam.get('files', {}).items():
            dst = FONT_DIR / name
            if dst.is_file():
                present.append(name)
                continue
            if opts.check:
                missing.append(name)
                continue
            try:
                if name.lower().endswith('.otf') and name.startswith('Nimbus'):
                    src = tol0 / 'fonts' / (name[:-4] + '.cff')
                    if not src.is_file():
                        raise FileNotFoundError(src)
                    cff_to_otf(src, dst, fam['family'], bold=style in ('bold', 'bolditalic'),
                               italic=style in ('italic', 'bolditalic'))
                elif name == 'cambria.ttf':
                    from fontTools.ttLib import TTCollection
                    ttc = win_index.get('cambria.ttc')
                    if not ttc:
                        raise FileNotFoundError('cambria.ttc')
                    TTCollection(str(ttc)).fonts[0].save(str(dst))
                elif name == 'DejaVuSerif.ttf':
                    src = tol0 / 'fonts' / name
                    if not src.is_file():
                        src = win_index.get(name.lower())
                    if not src:
                        raise FileNotFoundError(name)
                    shutil.copyfile(src, dst)
                else:
                    src = win_index.get(name.lower())
                    if not src:
                        raise FileNotFoundError(name)
                    shutil.copyfile(src, dst)
                built.append(name)
            except Exception as e:  # one missing source must not stop the rest
                missing.append(f'{name} ({e})')

    print(f'{len(present)} present, {len(built)} built, {len(missing)} missing')
    for n in built:
        print(f'  built   {n}')
    for n in missing:
        print(f'  MISSING {n}')
    if missing:
        sys.exit('some catalogue files are missing — the font menu falls back for those families')


if __name__ == '__main__':
    main()
