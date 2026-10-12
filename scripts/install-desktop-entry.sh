#!/usr/bin/env bash
# Install the Labels menu entry and icon for the current user.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"

mkdir -p "$APP_DIR" "$ICON_DIR"
install -m 644 "$ROOT/icons/labels.svg" "$ICON_DIR/labels.svg"
install -m 644 "$ROOT/scripts/labels.desktop" "$APP_DIR/labels.desktop"
# Rewrite Exec/Icon paths to absolute for this machine.
sed -i \
  -e "s|^Exec=.*|Exec=$ROOT/scripts/start-labels.sh|" \
  -e "s|^Icon=.*|Icon=labels|" \
  "$APP_DIR/labels.desktop"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" >/dev/null 2>&1 || true
fi

echo "Installed Labels launcher: $APP_DIR/labels.desktop"
echo "Icon: $ICON_DIR/labels.svg"
echo "Open from the app menu as “Labels”, or run: $ROOT/scripts/start-labels.sh"
