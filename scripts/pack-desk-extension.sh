#!/usr/bin/env bash
# Pack Black Forest Desk Firefox + Chromium trees for desk install / GitHub Release.
# Stable public asset names (release downloads):
#   Black.Forest.Desk.xpi
#   Black.Forest.Desk-chromium.zip
# Also keeps the gecko-id XPI name for scripts/install-desk-extension-firefox.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
DIST="$ROOT/extension/dist"
ID="black-forest-desk@blackforestautomotive.com"
STABLE_XPI_NAME="Black.Forest.Desk.xpi"
STABLE_CHROME_NAME="Black.Forest.Desk-chromium.zip"

mkdir -p "$DIST"
npm --prefix "$ROOT" run sync-extension >/dev/null

# Firefox XPI (zip of firefox/ with manifest at root)
XPI_ID="$DIST/${ID}.xpi"
XPI_STABLE="$DIST/${STABLE_XPI_NAME}"
rm -f "$XPI_ID" "$XPI_STABLE"
(
  cd "$ROOT/extension/firefox"
  zip -qr "$XPI_ID" . -x '*.DS_Store*'
)
cp -f "$XPI_ID" "$XPI_STABLE"

# Chromium zip for Load unpacked / archive
CHROME_LEGACY="$DIST/black-forest-desk-chromium.zip"
CHROME_STABLE="$DIST/${STABLE_CHROME_NAME}"
rm -f "$CHROME_LEGACY" "$CHROME_STABLE"
(
  cd "$ROOT/extension/chromium"
  zip -qr "$CHROME_STABLE" . -x '*.DS_Store*'
)
cp -f "$CHROME_STABLE" "$CHROME_LEGACY"

cp -f "$ROOT/extension/version.json" "$DIST/version.json"

printf '%s\n' "$XPI_STABLE"
printf '%s\n' "$CHROME_STABLE"
printf '%s\n' "$XPI_ID"
printf '%s\n' "$CHROME_LEGACY"
