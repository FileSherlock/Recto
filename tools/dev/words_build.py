"""Build web/plugins/redaction_refiner/words.txt — the refiner's English word list.

    python3 tools/dev/words_build.py

One lowercase word per line, most frequent first. It is the intersection of

  * google-10000-english (20k variant) — Google Trillion Word Corpus n-gram
    frequencies, which gives the ORDER (the refiner ranks fragment completions
    by it: "nd" → "and" before "end", "find", …), and
  * SCOWL / ESDB size 60 (app.aspell.net/create, US + GB spellings) — a
    screened dictionary, which gives VALIDITY and drops the web junk the
    n-gram list carries ("www", "xxx", "pdf", …). Only its lowercase entries
    count: capitalised ones are proper nouns and uppercase ones abbreviations
    ("ND"), and either would smuggle junk like "nd" back in.

Single letters are dropped except the words "a" and "i". Re-run to refresh;
the output is committed so the app needs no network and no Python package.
"""
import re
import urllib.request
from pathlib import Path

GOOGLE_20K = 'https://raw.githubusercontent.com/first20hours/google-10000-english/master/20k.txt'
SCOWL_60 = ('http://app.aspell.net/create?max_size=60&spelling=US&spelling=GBs'
            '&max_variant=0&diacritic=strip&download=wordlist&encoding=utf-8&format=inline')
OUT = Path(__file__).resolve().parents[2] / 'web' / 'plugins' / 'redaction_refiner' / 'words.txt'
KEEP_SINGLE = {'a', 'i'}


def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read().decode('utf-8', errors='replace')


def main():
    ranked = [w.strip() for w in fetch(GOOGLE_20K).splitlines()]
    scowl = set()
    for line in fetch(SCOWL_60).splitlines():
        w = line.strip()
        if w and '---' not in w and w == w.lower():   # header ends with '---'
            scowl.add(w)

    words, seen = [], set()
    for w in ranked:
        if w in seen:
            continue
        if not (re.fullmatch(r'[a-z]{2,}', w) or w in KEEP_SINGLE):
            continue
        if w not in scowl:
            continue
        seen.add(w)
        words.append(w)

    OUT.write_text('\n'.join(words) + '\n', encoding='utf-8')
    print(f'{len(words)} words -> {OUT}')


if __name__ == '__main__':
    main()
