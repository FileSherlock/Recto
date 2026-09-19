#!/usr/bin/env bash
# Build web/ and publish it to unbarpdf.com. Run from anywhere on the dev machine (needs the `unbarpdf` ssh alias).
set -euo pipefail
cd "$(dirname "$0")/.."

node tools/build.mjs
# Assets first, index.html last: a visitor never gets a page that points at files not uploaded yet.
rsync -rtz --delete --chmod=D755,F644 --exclude=/index.html web/ unbarpdf:/var/www/unbarpdf/
rsync -tz --chmod=F644 web/index.html unbarpdf:/var/www/unbarpdf/index.html
curl -sI https://unbarpdf.com/ | head -1
