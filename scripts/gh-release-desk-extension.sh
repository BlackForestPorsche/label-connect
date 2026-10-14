#!/usr/bin/env bash
# Create or update the stable GitHub Release tag `desk-extension`
# with Black.Forest.Desk.xpi (+ versioned + amo-hosted), updates.json, and chromium zip.
# Intended for Actions (GH_TOKEN / GITHUB_TOKEN) or a logged-in gh CLI.
#
# Concurrent uploads of the same asset name can still 422 even with --clobber;
# we delete named assets first and retry once on name-already-exists (PR #11).
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
DIST="$ROOT/extension/dist"
TAG="desk-extension"
XPI="$DIST/Black.Forest.Desk.xpi"
CHROME="$DIST/Black.Forest.Desk-chromium.zip"
UPDATES="$DIST/updates.json"

if [[ ! -f "$XPI" || ! -f "$CHROME" ]]; then
  bash "$ROOT/scripts/pack-desk-extension.sh" >/dev/null
fi

VER="$(python3 -c "import json; print(json.load(open('$ROOT/extension/version.json'))['version'])")"
XPI_VERSIONED="$DIST/Black.Forest.Desk-${VER}.xpi"
XPI_AMO="$DIST/Black.Forest.Desk-${VER}-amo-hosted.xpi"
XPI_HUB_ZIP="$DIST/Black.Forest.Desk-${VER}-hub-upload.zip"

if [[ ! -f "$XPI_VERSIONED" ]]; then
  cp -f "$XPI" "$XPI_VERSIONED"
fi

if [[ ! -f "$XPI_AMO" || ! -f "$XPI_HUB_ZIP" ]]; then
  bash "$ROOT/scripts/pack-desk-extension.sh" >/dev/null
fi

if [[ ! -f "$UPDATES" ]]; then
  bash "$ROOT/scripts/generate-desk-updates-json.sh" >/dev/null
fi

if [[ ! -f "$XPI" || ! -f "$CHROME" || ! -f "$UPDATES" || ! -f "$XPI_AMO" || ! -f "$XPI_HUB_ZIP" ]]; then
  echo "Missing packed assets under $DIST" >&2
  exit 1
fi

SIGNED_NOTE="Unsigned build (AMO credentials not used for this publish). Hub “On your own” must re-sign the self-dist pack; unsigned GitHub update_link will not replace a Hub-signed install. Add AMO JWT secrets for CI signing."
if unzip -l "$XPI" 2>/dev/null | grep -qiE 'META-INF/(mozilla|manifest|cose)'; then
  SIGNED_NOTE="Mozilla-signed (unlisted / self-distribution). Install once from File; later versions auto-update via updates.json when the update_link XPI is also signed."
fi

NOTES_FILE="$(mktemp)"
trap 'rm -f "$NOTES_FILE"' EXIT

cat >"$NOTES_FILE" <<NOTES
Black Forest Desk browser extension **v${VER}**

## Downloads (stable names)
- **Firefox Hub “On your own” upload:** [Black.Forest.Desk-${VER}-hub-upload.zip](https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/Black.Forest.Desk-${VER}-hub-upload.zip) — self-dist with \`update_url\` (same bytes as \`.xpi\`)
- **Firefox (self-dist + update_url):** [Black.Forest.Desk.xpi](https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/Black.Forest.Desk.xpi) / [Black.Forest.Desk-${VER}.xpi](https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/Black.Forest.Desk-${VER}.xpi)
- **Firefox (AMO Hub “On this site”):** [Black.Forest.Desk-${VER}-amo-hosted.xpi](https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/Black.Forest.Desk-${VER}-amo-hosted.xpi) — no \`update_url\`
- **Firefox update manifest:** [updates.json](https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/updates.json)
- **Chrome / Edge:** [Black.Forest.Desk-chromium.zip](https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/Black.Forest.Desk-chromium.zip)

Signing: ${SIGNED_NOTE}

Latest: https://github.com/BlackForestPorsche/label-connect/releases/latest

### Firefox — Hub “On your own” (shop path)
1. Upload \`Black.Forest.Desk-${VER}-hub-upload.zip\` (or \`.xpi\`) to Developer Hub → **On your own** (keeps \`update_url\`).
2. Download the **Mozilla-signed** XPI from Hub → \`about:addons\` → gear → **Install Add-on From File…**.
3. Until CI AMO JWT signs release XPIs, each version jump needs Hub re-sign + Install from File (unsigned GitHub \`update_link\` will not apply over Hub-signed).

### Firefox — alternate AMO-hosted (“On this site”)
1. Upload \`Black.Forest.Desk-${VER}-amo-hosted.xpi\` → **On this site**.
2. Install Hub-signed once; later versions auto-update from AMO.

**Temporary add-ons** and unsigned \`update-desk-extension.sh\` sideloads are **not** durable auto-update. Sideload **skips** when a Hub-signed Desk is already installed.

### Chrome / Edge
Unzip → Load unpacked (Developer mode). No Chrome Web Store listing yet — reload the card after a zip refresh, or keep Load unpacked pointed at \`extension/chromium/\` after git pull.
NOTES

delete_named_assets() {
  local name asset_id
  for name in \
    "Black.Forest.Desk.xpi" \
    "Black.Forest.Desk-${VER}.xpi" \
    "Black.Forest.Desk-${VER}-amo-hosted.xpi" \
    "Black.Forest.Desk-${VER}-hub-upload.zip" \
    "updates.json" \
    "Black.Forest.Desk-chromium.zip"
  do
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
  gh release upload "$TAG" "$XPI" "$XPI_VERSIONED" "$XPI_AMO" "$XPI_HUB_ZIP" "$UPDATES" "$CHROME" --clobber
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
  gh release create "$TAG" "$XPI" "$XPI_VERSIONED" "$XPI_AMO" "$UPDATES" "$CHROME" \
    --title "Black Forest Desk v${VER}" \
    --notes-file "$NOTES_FILE" \
    --latest
fi

echo "Published $TAG v${VER}"
echo "https://github.com/BlackForestPorsche/label-connect/releases/download/${TAG}/Black.Forest.Desk.xpi"
echo "https://github.com/BlackForestPorsche/label-connect/releases/download/${TAG}/updates.json"
echo "https://github.com/BlackForestPorsche/label-connect/releases/download/${TAG}/Black.Forest.Desk-chromium.zip"
