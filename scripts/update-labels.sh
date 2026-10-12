#!/usr/bin/env bash
# Pull Labels from its git remote and refresh dependencies / menu entry.
# Safe to run by hand from a terminal or after menu note “Update Labels”.
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
    notify-send -a "Labels" -u low "$summary" "$body" 2>/dev/null || true
  else
    printf '%s\n' "$summary${body:+ — $body}"
  fi
}

if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  notify "Labels update failed" "~/label-connect is not a git checkout."
  exit 1
fi

cd "$ROOT"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
OLD="$(git rev-parse HEAD)"
PULL_REF=""

if git rev-parse --abbrev-ref --symbolic-full-name @{u} >/dev/null 2>&1; then
  git fetch --quiet
  PULL_REF="@{u}"
elif git fetch --quiet origin "$BRANCH" 2>/dev/null; then
  PULL_REF="origin/$BRANCH"
elif git fetch --quiet origin main 2>/dev/null; then
  PULL_REF="origin/main"
else
  notify "Labels update skipped" "No upstream for $BRANCH yet."
  exit 0
fi

if ! git merge --ff-only "$PULL_REF" >/dev/null 2>&1; then
  notify "Labels update skipped" "Local changes blocked a fast-forward."
  exit 0
fi

NEW="$(git rev-parse HEAD)"
/usr/bin/npm install --silent >/dev/null 2>&1 || /usr/bin/npm install
chmod +x "$ROOT/scripts/"*.sh 2>/dev/null || true
bash "$ROOT/scripts/install-desktop-entry.sh" >/dev/null

if [[ "$OLD" == "$NEW" ]]; then
  notify "Labels up to date" "No new commits on $BRANCH."
else
  notify "Labels updated" "Pulled $(git rev-parse --short HEAD). Reopen Labels to use the new build."
fi
