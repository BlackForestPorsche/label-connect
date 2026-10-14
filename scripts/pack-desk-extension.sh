#!/usr/bin/env bash
# Pack Black Forest Desk Firefox + Chromium trees for desk install / GitHub Release.
# Stable public asset names (release downloads):
#   Black.Forest.Desk.xpi
#   Black.Forest.Desk-<ver>.xpi              (self-dist + update_url)
#   Black.Forest.Desk-<ver>-amo-hosted.xpi   (Hub “On this site”; no update_url)
#   Black.Forest.Desk-chromium.zip
#   updates.json  (Firefox gecko.update_url manifest)
# Also keeps the gecko-id XPI name for scripts/install-desk-extension-firefox.sh
# and a versioned XPI for update_link stability.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
DIST="$ROOT/extension/dist"
ID="black-forest-desk@blackforestautomotive.com"
STABLE_XPI_NAME="Black.Forest.Desk.xpi"
STABLE_CHROME_NAME="Black.Forest.Desk-chromium.zip"

mkdir -p "$DIST"
npm --prefix "$ROOT" run sync-extension >/dev/null

VER="$(python3 -c "import json; print(json.load(open('$ROOT/extension/version.json'))['version'])")"

# Firefox XPI (zip of firefox/ with manifest at root)
XPI_ID="$DIST/${ID}.xpi"
XPI_STABLE="$DIST/${STABLE_XPI_NAME}"
XPI_VERSIONED="$DIST/Black.Forest.Desk-${VER}.xpi"
XPI_AMO="$DIST/Black.Forest.Desk-${VER}-amo-hosted.xpi"
rm -f "$XPI_ID" "$XPI_STABLE" "$XPI_VERSIONED" "$XPI_AMO"
(
  cd "$ROOT/extension/firefox"
  zip -qr "$XPI_ID" . -x '*.DS_Store*'
)
cp -f "$XPI_ID" "$XPI_STABLE"
cp -f "$XPI_ID" "$XPI_VERSIONED"

# AMO-hosted pack: same bits, but strip gecko.update_url (AMO rejects listed uploads that keep it).
python3 - "$XPI_ID" "$XPI_AMO" <<'PY'
import json
import sys
import zipfile
from io import BytesIO

src, dst = sys.argv[1:3]
buf = BytesIO()
with zipfile.ZipFile(src, "r") as zin, zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zout:
    for info in zin.infolist():
        data = zin.read(info.filename)
        if info.filename == "manifest.json":
            manifest = json.loads(data.decode("utf-8"))
            gecko = (
                manifest.setdefault("browser_specific_settings", {}).setdefault("gecko", {})
            )
            gecko.pop("update_url", None)
            data = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
            info.file_size = len(data)
            info.CRC = zipfile.crc32(data) & 0xFFFFFFFF
        zout.writestr(info, data)
with open(dst, "wb") as f:
    f.write(buf.getvalue())
print(dst)
PY

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

# Firefox update manifest for browser_specific_settings.gecko.update_url
bash "$ROOT/scripts/generate-desk-updates-json.sh" >/dev/null

printf '%s\n' "$XPI_STABLE"
printf '%s\n' "$CHROME_STABLE"
printf '%s\n' "$XPI_VERSIONED"
printf '%s\n' "$XPI_AMO"
printf '%s\n' "$DIST/updates.json"
printf '%s\n' "$XPI_ID"
printf '%s\n' "$CHROME_LEGACY"
