#!/usr/bin/env bash
# Test, build web/ and publish it to unbarpdf.com — the same steps as .github/workflows/deploy.yml.
# Run from anywhere on the dev machine (needs the `unbarpdf` ssh alias). Publishes what is committed:
# a working tree with changes under web/ or tools/ is refused (DEPLOY_DIRTY=1 publishes it anyway).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${DEPLOY_DIRTY:-}" ] && [ -n "$(git status --porcelain -- web tools)" ]; then
  echo "uncommitted changes under web/ or tools/ — commit them first (or DEPLOY_DIRTY=1 $0)" >&2
  git status --short -- web tools >&2
  exit 1
fi

node --test "tests/**/*.test.mjs"
node tools/build.mjs
# Assets first, index.html last: a visitor never gets a page that points at files not uploaded yet.
# Compared by content (-c): unchanged files keep their place, times and validators on the server.
rsync -rcz --delete --chmod=D755,F644 --exclude=/index.html web/ unbarpdf:/var/www/unbarpdf/
rsync -cz --chmod=F644 web/index.html unbarpdf:/var/www/unbarpdf/index.html
# The site serves this very build.
curl -sf https://unbarpdf.com/ | cmp - web/index.html && echo "unbarpdf.com serves this build"
