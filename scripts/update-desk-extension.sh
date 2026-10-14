#!/usr/bin/env bash
# Local desk refresh only — NOT Firefox durable auto-update.
#
# What this does: sync-extension → pack XPI → sideload into the existing Firefox
# default profile (extensions/ + user.js prefs) via install-desk-extension-firefox.sh.
# Chromium/Edge: keep Load unpacked pointed at extension/chromium (files refresh in place).
# Safe to call from update-labels.sh or by hand. No GUI tour. Never creates profiles.
#
# Prefer durable auto-update instead:
#   A) AMO-hosted (“On this site”) — upload *-amo-hosted.xpi (no update_url) to Hub;
#      Firefox updates from AMO on later Hub versions.
#   B) Self-dist — Mozilla-signed XPI with gecko.update_url → GitHub updates.json.
# See docs/desk-extension-signing.md and extension/README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export PATH

NOTIFY=1
for arg in "$@"; do
  case "$arg" in
    --quiet) NOTIFY=0 ;;
  esac
done

notify() {
  local summary="$1"
  local body="${2:-}"
  if [[ "$NOTIFY" -eq 0 ]]; then
    printf '%s\n' "$summary${body:+ — $body}"
    return 0
  fi
  if command -v notify-send >/dev/null 2>&1; then
    notify-send -a "Black Forest Desk" -u low "$summary" "$body" 2>/dev/null || true
  else
    printf '%s\n' "$summary${body:+ — $body}"
  fi
}

npm --prefix "$ROOT" run sync-extension >/dev/null
bash "$ROOT/scripts/pack-desk-extension.sh" >/dev/null
bash "$ROOT/scripts/install-desk-extension-firefox.sh" --quiet

# Chromium unpacked path marker for desks that Load unpacked once
mkdir -p "$ROOT/extension/chromium"
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ) synced" >"$ROOT/extension/chromium/.desk-synced"

VER="$(python3 -c 'import json; print(json.load(open("'"$ROOT"'/extension/version.json"))["version"])' 2>/dev/null || echo '?')"
notify "Black Forest Desk updated" "v${VER} — restart Firefox; Chromium reload unpacked if needed."
