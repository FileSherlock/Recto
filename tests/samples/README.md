# Sample documents

The two corpus documents the goldens under `tests/golden/` were recorded from
(the third, the startup document, is `web/assets/pdfs/`; the rest are generated
inputs in `tests/golden/_inputs/`). `tests/golden/documents.json` names each
with its SHA-256.

| file | pages | size | golden |
|---|---|---|---|
| `EFTA00382083.pdf` | 25 | 3.6 MB | `efta00382083` — every page |
| `EFTA01011184.pdf` | 340 | 66 MB | `efta01011184` — pages 1, 2, 3, 85, 170, 255, 340 |

A suite skips a document whose file is not in the checkout, so the large one
can be left out of a repository that should stay small; with it present the
suites also cover a multi-hundred-page scan.
