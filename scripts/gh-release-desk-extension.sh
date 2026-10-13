#!/usr/bin/env bash
# Create or update the stable GitHub Release tag `desk-extension`
# with Black.Forest.Desk.xpi (+ versioned), updates.json, and chromium zip.
# Intended for Actions (GH_TOKEN / GITHUB_TOKEN) or a logged-in gh CLI.
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

if [[ ! -f "$XPI_VERSIONED" ]]; then
  cp -f "$XPI" "$XPI_VERSIONED"
fi

if [[ ! -f "$UPDATES" ]]; then
  bash "$ROOT/scripts/generate-desk-updates-json.sh" >/dev/null
fi

if [[ ! -f "$XPI" || ! -f "$CHROME" || ! -f "$UPDATES" ]]; then
  echo "Missing packed assets under $DIST" >&2
  exit 1
fi

SIGNED_NOTE="Unsigned build (AMO credentials not used for this publish). Stock Firefox needs a Mozilla-signed XPI for Install from File + auto-update."
if unzip -l "$XPI" 2>/dev/null | grep -qiE 'META-INF/(mozilla|manifest|cose)'; then
  SIGNED_NOTE="Mozilla-signed (unlisted / self-distribution). Install once from File; later versions auto-update via updates.json."
fi

NOTES_FILE="$(mktemp)"
trap 'rm -f "$NOTES_FILE"' EXIT

cat >"$NOTES_FILE" <<NOTES
Black Forest Desk browser extension **v${VER}**

## Downloads (stable names)
- **Firefox:** [Black.Forest.Desk.xpi](https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/Black.Forest.Desk.xpi)
- **Firefox (versioned):** [Black.Forest.Desk-${VER}.xpi](https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/Black.Forest.Desk-${VER}.xpi)
- **Firefox update manifest:** [updates.json](https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/updates.json)
- **Chrome / Edge:** [Black.Forest.Desk-chromium.zip](https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/Black.Forest.Desk-chromium.zip)

Signing: ${SIGNED_NOTE}

Latest: https://github.com/BlackForestPorsche/label-connect/releases/latest

### Firefox (permanent + auto-update)
1. Use a **Mozilla-signed** XPI (org AMO unlisted). Stock Firefox Release rejects unsigned Install from File.
2. **Normal profile only** — never create a new Firefox profile.
3. \`about:addons\` → gear → **Install Add-on From File…** → pick the XPI **once**.
4. Later Desk releases: Firefox reads \`updates.json\` via \`gecko.update_url\` and installs the new signed XPI automatically. No \`about:debugging\` reload.

**Temporary add-ons** (\`about:debugging\` → Load Temporary Add-on) **cannot auto-update**. Remove the temp add-on after the signed install.

### Chrome / Edge
Unzip → Load unpacked (Developer mode). No Chrome Web Store listing yet — reload the card after a zip refresh, or keep Load unpacked pointed at \`extension/chromium/\` after git pull.
NOTES

UPLOAD_ARGS=("$XPI" "$XPI_VERSIONED" "$UPDATES" "$CHROME")

# Delete existing assets by name first so concurrent/clobber races do not 422.
delete_release_assets() {
  local names=("Black.Forest.Desk.xpi" "Black.Forest.Desk-${VER}.xpi" "updates.json" "Black.Forest.Desk-chromium.zip")
  local json id name
  json="$(gh api "repos/BlackForestPorsche/label-connect/releases/tags/${TAG}" 2>/dev/null || true)"
  [[ -z "$json" ]] && return 0
  for name in "${names[@]}"; do
    id="$(printf '%s' "$json" | python3 -c 'import json,sys; name=sys.argv[1]; data=json.load(sys.stdin); print(next((a["id"] for a in data.get("assets",[]) if a.get("name")==name), ""))' "$name")"
    if [[ -n "$id" ]]; then
      gh api -X DELETE "repos/BlackForestPorsche/label-connect/releases/assets/${id}" >/dev/null 2>&1 || true
    fi
  done
}

upload_with_retry() {
  local attempt=1
  local max=4
  while true; do
    if gh release upload "$TAG" "${UPLOAD_ARGS[@]}" --clobber; then
      return 0
    fi
    if [[ "$attempt" -ge "$max" ]]; then
      echo "gh release upload failed after ${max} attempts" >&2
      return 1
    fi
    echo "Upload race/conflict — deleting assets and retrying (${attempt}/${max})…" >&2
    delete_release_assets
    sleep $((attempt * 3))
    attempt=$((attempt + 1))
  done
}

if gh release view "$TAG" >/dev/null 2>&1; then
  delete_release_assets
  upload_with_retry
  gh release edit "$TAG" \
    --title "Black Forest Desk v${VER}" \
    --notes-file "$NOTES_FILE" \
    --latest
else
  gh release create "$TAG" "${UPLOAD_ARGS[@]}" \
    --title "Black Forest Desk v${VER}" \
    --notes-file "$NOTES_FILE" \
    --latest
fi

echo "Published $TAG v${VER}"
echo "https://github.com/BlackForestPorsche/label-connect/releases/download/${TAG}/Black.Forest.Desk.xpi"
echo "https://github.com/BlackForestPorsche/label-connect/releases/download/${TAG}/updates.json"
echo "https://github.com/BlackForestPorsche/label-connect/releases/download/${TAG}/Black.Forest.Desk-chromium.zip"
