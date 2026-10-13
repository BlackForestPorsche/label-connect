#!/usr/bin/env bash
# Pack Black Forest Desk Firefox + Chromium trees for desk install.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
DIST="$ROOT/extension/dist"
ID="black-forest-desk@blackforestautomotive.com"

mkdir -p "$DIST"
npm --prefix "$ROOT" run sync-extension >/dev/null

# Firefox XPI (zip of firefox/ with manifest at root)
XPI="$DIST/${ID}.xpi"
rm -f "$XPI"
(
  cd "$ROOT/extension/firefox"
  zip -qr "$XPI" . -x '*.DS_Store*'
)

# Chromium zip for archive / sideload notes
CHROME_ZIP="$DIST/black-forest-desk-chromium.zip"
rm -f "$CHROME_ZIP"
(
  cd "$ROOT/extension/chromium"
  zip -qr "$CHROME_ZIP" . -x '*.DS_Store*'
)

cp -f "$ROOT/extension/version.json" "$DIST/version.json"

printf '%s\n' "$XPI"
printf '%s\n' "$CHROME_ZIP"
