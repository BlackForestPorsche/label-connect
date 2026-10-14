#!/usr/bin/env bash
# Launch Labels (LabelWriter 550 bench) as a desktop app.
# Prefer Black Forest Tools 1.5.5+ (Labels → status / restart): Tools owns :8080.
# This script remains for transition / manual bench use.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
PORT="${LABELS_PORT:-8080}"
URL="http://127.0.0.1:${PORT}/"
PID_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/labels/server.pid"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/labels"
LOG_FILE="$LOG_DIR/launch.log"
NODE="${LABELS_NODE:-/usr/bin/node}"

mkdir -p "$LOG_DIR"

notify_fail() {
  local msg=$1
  echo "$msg" | tee -a "$LOG_FILE" >&2
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --title="Labels" --text="$msg" --width=420 2>/dev/null || true
  elif command -v kdialog >/dev/null 2>&1; then
    kdialog --error "$msg" 2>/dev/null || true
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send -u critical "Labels" "$msg" 2>/dev/null || true
  fi
}

{
  echo "---- $(date -Is) ----"
  echo "ROOT=$ROOT"
  echo "PORT=$PORT"
  echo "NODE=$NODE ($("$NODE" -v 2>/dev/null || echo missing))"
} >>"$LOG_FILE"

if [[ ! -x "$NODE" ]]; then
  notify_fail "Node.js is missing at $NODE.\nInstall nodejs, then try Labels again."
  exit 1
fi

if [[ ! -d "$ROOT/node_modules" ]]; then
  if ! (cd "$ROOT" && /usr/bin/npm install >>"$LOG_FILE" 2>&1); then
    notify_fail "Could not install Labels dependencies.\n\nLog: $LOG_FILE"
    exit 1
  fi
fi

server_up() {
  curl -fsS --max-time 1 "$URL" >/dev/null 2>&1
}

start_server() {
  cd "$ROOT"
  # Prefer a free local bind; do not touch shop-desktop.
  nohup env PORT="$PORT" "$NODE" "$ROOT/server.mjs" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
}

if ! server_up; then
  # Drop a stale pid file if the process is gone.
  if [[ -f "$PID_FILE" ]] && ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    rm -f "$PID_FILE"
  fi
  start_server
  for _ in $(seq 1 40); do
    if server_up; then
      break
    fi
    sleep 0.15
  done
fi

if ! server_up; then
  notify_fail "Labels did not start on port $PORT.\n\nIn a terminal:\ncd ~/label-connect && npm start\n\nLog: $LOG_FILE"
  exit 1
fi

# Dedicated window when possible; fall back to the default browser.
if command -v firefox >/dev/null 2>&1; then
  firefox --new-window "$URL" >>"$LOG_FILE" 2>&1 &
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >>"$LOG_FILE" 2>&1 &
else
  notify_fail "Labels is running at $URL, but no browser was found to open it."
  exit 1
fi
