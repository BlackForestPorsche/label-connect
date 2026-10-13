#!/usr/bin/env bash
# Install Black Forest Desk into Firefox on the desk (shell/profile/policies).
# No GUI tour. No AllData/SSF browser automation.
#
# Hard rule: NEVER create or switch Firefox profiles. Only install into the
# existing default profile that Firefox already uses.
#
# Strategy (unsigned / no AMO):
# 1) Pack XPI from git tree
# 2) Resolve the existing default profile (fail if none)
# 3) Drop XPI into that profile's extensions/ folder
# 4) Write user.js prefs so the profile accepts the sideloaded add-on when possible
# 5) Write optional policies.json under ~/.mozilla/firefox/ for force_install hints
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

# Resolve existing default profile only — never create/switch profiles.
# Searches FIREFOX_HOME (if set), then ~/.mozilla/firefox, then ~/.config/mozilla/firefox.
profile_dir="$(
  python3 - <<'PY'
import configparser
import os
import pathlib
import sys

candidates = []
env_home = os.environ.get("FIREFOX_HOME", "").strip()
if env_home:
    candidates.append(pathlib.Path(env_home))
home = pathlib.Path.home()
candidates.append(home / ".mozilla" / "firefox")
candidates.append(home / ".config" / "mozilla" / "firefox")

seen = set()
homes = []
for h in candidates:
    try:
        key = str(h.resolve()) if h.exists() else str(h)
    except OSError:
        key = str(h)
    if key in seen:
        continue
    seen.add(key)
    homes.append(h)


def resolve_from_ini(ff_home: pathlib.Path):
    ini_path = ff_home / "profiles.ini"
    if not ini_path.is_file():
        return None
    ini = configparser.ConfigParser()
    ini.read(ini_path)

    def path_for(section: str):
        rel = ini.get(section, "Path") if ini.has_option(section, "Path") else None
        if section.startswith("Install") and ini.has_option(section, "Default"):
            rel = ini.get(section, "Default")
        if not rel:
            return None
        path = pathlib.Path(rel)
        if ini.get(section, "IsRelative", fallback="1") == "1" or (
            section.startswith("Install") and not path.is_absolute()
        ):
            return ff_home / path
        return path

    # Prefer Install* Default (what Firefox actually launches)
    for section in ini.sections():
        if section.startswith("Install") and ini.has_option(section, "Default"):
            p = path_for(section)
            if p is not None and p.is_dir():
                return p

    # Then Profile* with Default=1
    for section in ini.sections():
        if not section.startswith("Profile"):
            continue
        if ini.get(section, "Default", fallback="0") != "1":
            continue
        if not ini.has_option(section, "Path"):
            continue
        rel = ini.get(section, "Path")
        path = pathlib.Path(rel)
        if ini.get(section, "IsRelative", fallback="1") == "1":
            path = ff_home / path
        if path.is_dir():
            return path

    return None


for ff_home in homes:
    profile = resolve_from_ini(ff_home)
    if profile is not None:
        print(profile)
        raise SystemExit(0)

print(
    "ERROR: No existing Firefox default profile found.\n"
    "Open Firefox once so it creates your real profile, then re-run this script.\n"
    "This installer will never create or switch profiles.",
    file=sys.stderr,
)
raise SystemExit(2)
PY
)" || {
  notify "Desk extension install failed" "No existing Firefox default profile — open Firefox once, then retry. Never creates profiles."
  exit 2
}

if [[ -z "${profile_dir}" || ! -d "${profile_dir}" ]]; then
  notify "Desk extension install failed" "Resolved profile missing: ${profile_dir:-<empty>}"
  exit 2
fi

# Never install into the legacy agent-created desk-only profile.
case "$(basename "$profile_dir")" in
  blackforest-desk.default|blackforest-desk)
    notify "Desk extension install failed" "Refusing blackforest-desk.default — fix profiles.ini Default to your real profile, then retry."
    exit 2
    ;;
esac

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

# Optional policies (per-user) — force_installed from file URL.
# Policies do not create or switch profiles.
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
