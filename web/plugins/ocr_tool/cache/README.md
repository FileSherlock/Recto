# Shipped OCR reads

One `<sha256-of-document>.json` per document: the slimmed result of a finished
whole-document read (`{ version, pages }`, see `ocr-result.js`). The OCR plugin
looks a document's hash up here first — the build's asset map tells it whether
the file exists — so visitors get the startup document's text boxes instantly
instead of waiting for the in-browser engine and its glyph bundle. Reads of
other documents are kept per browser in IndexedDB (`recto-ocr-cache`), never
here.

After swapping the startup PDF (`web/assets/pdfs/`): open the app, let the
automatic read finish, run `ocrExportCache()` in the browser console, and
commit the downloaded file here. Stale files for old documents can be deleted.
A file whose `version` is not the plugin's `OCR_CACHE_VERSION` is ignored.
