#!/usr/bin/env bash
# One-click Desk update for Labels POST /api/update-desk-extension (localhost only).
# Pulls label-connect (ff-only when possible), then runs update-desk-extension.sh.
# That script skips unsigned sideload when a Mozilla-signed Hub/AMO Desk is present
# (prints skipped=signed-amo). Labels must not treat skip as a successful apply.
# Idempotent. Never creates Firefox profiles. No GUI.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export PATH

DO_PULL=1
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=1 ;;
    --no-pull) DO_PULL=0 ;;
  esac
done

log() {
  if [[ "$QUIET" -eq 0 ]]; then
    printf '%s\n' "$*"
  fi
}

if [[ "$DO_PULL" -eq 1 ]] && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  cd "$ROOT"
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  PULL_REF=""
  if git rev-parse --abbrev-ref --symbolic-full-name @{u} >/dev/null 2>&1; then
    git fetch --quiet
    PULL_REF="@{u}"
  elif git fetch --quiet origin "$BRANCH" 2>/dev/null; then
    PULL_REF="origin/$BRANCH"
  elif git fetch --quiet origin main 2>/dev/null; then
    PULL_REF="origin/main"
  fi
  if [[ -n "$PULL_REF" ]]; then
    if git merge --ff-only "$PULL_REF" >/dev/null 2>&1; then
      log "Pulled $PULL_REF"
    else
      log "Skip pull (not fast-forward); applying local tree"
    fi
  fi
  /usr/bin/npm install --silent >/dev/null 2>&1 || /usr/bin/npm install >/dev/null 2>&1 || true
fi

chmod +x "$ROOT/scripts/"*.sh 2>/dev/null || true
bash "$ROOT/scripts/update-desk-extension.sh" --quiet
VER="$(python3 -c 'import json; print(json.load(open("'"$ROOT"'/extension/version.json"))["version"])' 2>/dev/null || echo '?')"
log "Desk v${VER} applied"
