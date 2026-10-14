#!/usr/bin/env bash
# Local desk refresh only — NOT Firefox durable auto-update.
#
# What this does: sync-extension → pack XPI → call install-desk-extension-firefox.sh.
# That installer **skips** sideload when a Mozilla-signed Hub/AMO Desk is already in
# the default profile (so Labels updates do not clobber a durable install).
# Chromium/Edge: keep Load unpacked pointed at extension/chromium (files refresh in place).
# Safe to call from update-labels.sh or by hand. No GUI tour. Never creates profiles.
#
# Prefer durable auto-update instead:
#   A) AMO-hosted (“On this site”) — upload *-amo-hosted.xpi (no update_url) to Hub;
#      Firefox updates from AMO on later Hub versions.
#   B) Self-dist — Mozilla-signed XPI with gecko.update_url → GitHub updates.json.
# See docs/desk-extension-signing.md and extension/README.md.
#
# Flags: --quiet  --force-sideload (overwrite a signed Hub install — not recommended)
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export PATH

NOTIFY=1
INSTALL_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --quiet) NOTIFY=0; INSTALL_ARGS+=(--quiet) ;;
    --force-sideload) INSTALL_ARGS+=(--force-sideload) ;;
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

# Sync shared → browser trees; don't abort the whole update if cp is briefly busy.
npm --prefix "$ROOT" run sync-extension >/dev/null || true
bash "$ROOT/scripts/pack-desk-extension.sh" >/dev/null
set +e
INSTALL_OUT="$(bash "$ROOT/scripts/install-desk-extension-firefox.sh" ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"} 2>&1)"
INSTALL_RC=$?
set -e
printf '%s\n' "$INSTALL_OUT"
if [[ "$INSTALL_RC" -ne 0 ]]; then
  notify "Black Forest Desk update failed" "install-desk-extension-firefox.sh exited $INSTALL_RC"
  exit "$INSTALL_RC"
fi

# Chromium unpacked path marker for desks that Load unpacked once
mkdir -p "$ROOT/extension/chromium"
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ) synced" >"$ROOT/extension/chromium/.desk-synced"

VER="$(python3 -c 'import json; print(json.load(open("'$ROOT'/extension/version.json"))["version"])' 2>/dev/null || echo '?')"

if printf '%s\n' "$INSTALL_OUT" | grep -q '^skipped=signed-amo'; then
  notify "Black Forest Desk packed" "v${VER} — Hub/AMO signed install kept (not clobbered). Chromium: reload unpacked if needed."
elif printf '%s\n' "$INSTALL_OUT" | grep -q '^mode=unsigned-sideload'; then
  notify "Black Forest Desk sideloaded" "v${VER} — unsigned local XPI; may vanish on Firefox restart. Prefer Hub-signed Install from File."
else
  notify "Black Forest Desk updated" "v${VER} — see install output; Chromium reload unpacked if needed."
fi
