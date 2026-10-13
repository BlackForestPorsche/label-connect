#!/usr/bin/env bash
# Create or update the stable GitHub Release tag `desk-extension`
# with Black.Forest.Desk.xpi + Black.Forest.Desk-chromium.zip.
# Intended for Actions (GH_TOKEN / GITHUB_TOKEN) or a logged-in gh CLI.
#
# Concurrent uploads of the same asset name can still 422 even with --clobber;
# we delete named assets first and retry once on name-already-exists.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
DIST="$ROOT/extension/dist"
TAG="desk-extension"
XPI="$DIST/Black.Forest.Desk.xpi"
CHROME="$DIST/Black.Forest.Desk-chromium.zip"

if [[ ! -f "$XPI" || ! -f "$CHROME" ]]; then
  bash "$ROOT/scripts/pack-desk-extension.sh" >/dev/null
fi

if [[ ! -f "$XPI" || ! -f "$CHROME" ]]; then
  echo "Missing packed assets under $DIST" >&2
  exit 1
fi

VER="$(python3 -c 'import json; print(json.load(open("'$ROOT'/extension/version.json"))["version"])')"
NOTES_FILE="$(mktemp)"
trap 'rm -f "$NOTES_FILE"' EXIT

cat >"$NOTES_FILE" <<NOTES
Black Forest Desk browser extension **v${VER}**

## Downloads (stable names)
- **Firefox:** [Black.Forest.Desk.xpi](https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/Black.Forest.Desk.xpi)
- **Chrome / Edge:** [Black.Forest.Desk-chromium.zip](https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/Black.Forest.Desk-chromium.zip)

Latest: https://github.com/BlackForestPorsche/label-connect/releases/latest

Install Firefox: about:addons → gear → Install Add-on From File → pick the XPI in your **normal** profile (never create a new profile).
Chrome/Edge: unzip → Load unpacked.

Unsigned XPI is expected until shop AMO credentials exist; GitHub Release is the desk update feed source.
NOTES

delete_named_assets() {
  # Best-effort: remove colliding asset names before upload.
  local name asset_id
  for name in "Black.Forest.Desk.xpi" "Black.Forest.Desk-chromium.zip"; do
    asset_id="$(
      gh api "repos/BlackForestPorsche/label-connect/releases/tags/${TAG}" \
        --jq ".assets[] | select(.name==\"${name}\") | .id" 2>/dev/null || true
    )"
    if [[ -n "${asset_id}" ]]; then
      gh api -X DELETE "repos/BlackForestPorsche/label-connect/releases/assets/${asset_id}" >/dev/null 2>&1 || true
    fi
  done
}

upload_assets() {
  gh release upload "$TAG" "$XPI" "$CHROME" --clobber
}

if gh release view "$TAG" >/dev/null 2>&1; then
  delete_named_assets
  if ! upload_assets; then
    echo "Upload failed; deleting assets and retrying once…" >&2
    sleep 2
    delete_named_assets
    upload_assets
  fi
  gh release edit "$TAG" \
    --title "Black Forest Desk v${VER}" \
    --notes-file "$NOTES_FILE" \
    --latest
else
  gh release create "$TAG" "$XPI" "$CHROME" \
    --title "Black Forest Desk v${VER}" \
    --notes-file "$NOTES_FILE" \
    --latest
fi

echo "Published $TAG v${VER}"
echo "https://github.com/BlackForestPorsche/label-connect/releases/download/${TAG}/Black.Forest.Desk.xpi"
echo "https://github.com/BlackForestPorsche/label-connect/releases/download/${TAG}/Black.Forest.Desk-chromium.zip"
