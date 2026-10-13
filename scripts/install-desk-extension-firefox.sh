#!/usr/bin/env bash
# Install Black Forest Desk into Firefox on the desk (shell/profile/policies).
# No GUI tour. No AllData/SSF browser automation.
#
# Strategy (unsigned / no AMO):
# 1) Pack XPI from git tree
# 2) Drop into the default Firefox profile extensions/ folder
# 3) Write user.js prefs so the profile accepts the sideloaded add-on when possible
#    (Firefox Developer Edition / Nightly / unbranded; Release may still require
#     Temporary Add-on until AMO self-distribution is wired)
# 4) Write optional policies.json under ~/.mozilla/firefox/ for force_install hints
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
ID="black-forest-desk@blackforestautomotive.com"
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

if ! command -v zip >/dev/null 2>&1; then
  notify "Desk extension install failed" "zip is required."
  exit 1
fi

bash "$ROOT/scripts/pack-desk-extension.sh" >/dev/null
XPI="$ROOT/extension/dist/${ID}.xpi"
if [[ ! -f "$XPI" ]]; then
  notify "Desk extension install failed" "Pack step did not create $XPI"
  exit 1
fi

FF_HOME="${FIREFOX_HOME:-$HOME/.mozilla/firefox}"
mkdir -p "$FF_HOME"

# Resolve default profile from profiles.ini (Install*/Default=1 or Profile*/Default=1)
profile_dir=""
if [[ -f "$FF_HOME/profiles.ini" ]]; then
  profile_dir="$(
    python3 - <<'PY' "$FF_HOME"
import configparser, pathlib, sys
home = pathlib.Path(sys.argv[1])
ini = configparser.ConfigParser()
ini.read(home / "profiles.ini")
# Prefer Install section Default= profile
for section in ini.sections():
    if section.startswith("Install") and ini.has_option(section, "Default"):
        rel = ini.get(section, "Default")
        path = pathlib.Path(rel)
        print(path if path.is_absolute() else home / path)
        raise SystemExit
for section in ini.sections():
    if not section.startswith("Profile"):
        continue
    if ini.get(section, "Default", fallback="0") != "1":
        continue
    if ini.get(section, "IsRelative", fallback="1") == "1":
        print(home / ini.get(section, "Path"))
    else:
        print(ini.get(section, "Path"))
    raise SystemExit
# Fallback: first Profile
for section in ini.sections():
    if section.startswith("Profile") and ini.has_option(section, "Path"):
        if ini.get(section, "IsRelative", fallback="1") == "1":
            print(home / ini.get(section, "Path"))
        else:
            print(ini.get(section, "Path"))
        raise SystemExit
PY
  )"
fi

if [[ -z "${profile_dir}" || ! -d "${profile_dir}" ]]; then
  # Create a dedicated desk profile path if Firefox has never been opened.
  profile_dir="$FF_HOME/blackforest-desk.default"
  mkdir -p "$profile_dir"
  if [[ ! -f "$FF_HOME/profiles.ini" ]]; then
    cat >"$FF_HOME/profiles.ini" <<EOF
[General]
StartWithLastProfile=1
Version=2

[Profile0]
Name=blackforest-desk
IsRelative=1
Path=blackforest-desk.default
Default=1
EOF
  fi
  notify "Desk extension" "Created Firefox profile at $profile_dir (open Firefox once so it binds)."
fi

ext_dir="$profile_dir/extensions"
mkdir -p "$ext_dir"
cp -f "$XPI" "$ext_dir/${ID}.xpi"

# user.js: allow sideload + keep extensions enabled (Dev/Nightly/unbranded; harmless elsewhere)
user_js="$profile_dir/user.js"
touch "$user_js"
python3 - <<'PY' "$user_js"
from pathlib import Path
import sys
path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8") if path.exists() else ""
lines = [
    'user_pref("xpinstall.signatures.required", false);',
    'user_pref("extensions.autoDisableScopes", 0);',
    'user_pref("extensions.enabledScopes", 15);',
    'user_pref("extensions.startupScanScopes", 15);',
]
out = text
for line in lines:
    key = line.split(",")[0]
    # drop prior copies of the same pref
    kept = [l for l in out.splitlines() if not l.strip().startswith(key)]
    kept.append(line)
    out = "\n".join(kept).rstrip() + "\n"
path.write_text(out, encoding="utf-8")
PY

# Optional policies (per-user) — force_installed from file URL
policies_dir="$HOME/.mozilla/firefox/policies"
mkdir -p "$policies_dir"
cat >"$policies_dir/policies.json" <<EOF
{
  "policies": {
    "ExtensionSettings": {
      "${ID}": {
        "installation_mode": "force_installed",
        "install_url": "file://${XPI}"
      }
    },
    "Extensions": {
      "Install": [
        "file://${XPI}"
      ]
    }
  }
}
EOF

# Also stage under distribution-style path for system firefox when writable
dist_ext="/usr/lib/firefox/distribution/extensions"
if [[ -d "$(dirname "$dist_ext")" ]] && [[ -w "$(dirname "$dist_ext")" ]]; then
  mkdir -p "$dist_ext"
  cp -f "$XPI" "$dist_ext/${ID}.xpi" || true
fi

notify "Black Forest Desk installed" "Firefox profile: $profile_dir — restart Firefox to load (no GUI tour)."
printf 'profile=%s\nxpi=%s\n' "$profile_dir" "$ext_dir/${ID}.xpi"
