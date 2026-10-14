#!/usr/bin/env bash
# Install Black Forest Desk into Firefox on the desk (shell/profile/policies).
# No GUI tour. No AllData/SSF browser automation.
#
# Hard rule: NEVER create or switch Firefox profiles. Only install into the
# existing default profile that Firefox already uses.
#
# Durable path (preferred): Mozilla-signed Hub / AMO install via about:addons →
# Install Add-on From File. This script must NOT overwrite that with an unsigned
# git-tree sideload (Release Firefox removes/disables unsigned XPIs on restart).
#
# Sideload strategy (fallback only — Dev Edition / Nightly / unbranded, or
# --force-sideload):
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
FORCE_SIDELOAD=0
for arg in "$@"; do
  case "$arg" in
    --quiet) NOTIFY=0 ;;
    --force-sideload) FORCE_SIDELOAD=1 ;;
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
profile_xpi="$ext_dir/${ID}.xpi"

# Detect a Mozilla-signed Hub/AMO install already in this profile.
# Unsigned git sideloads must not overwrite those — Release Firefox drops them on restart.
signed_state="$(
  FORCE_SIDELOAD="$FORCE_SIDELOAD" ID="$ID" PROFILE_DIR="$profile_dir" PROFILE_XPI="$profile_xpi" DIST_XPI="$XPI" python3 - <<'PY'
import json
import os
import sys
import zipfile
from pathlib import Path

addon_id = os.environ["ID"]
profile = Path(os.environ["PROFILE_DIR"])
profile_xpi = Path(os.environ["PROFILE_XPI"])
force = os.environ.get("FORCE_SIDELOAD", "0") == "1"


def xpi_mozilla_signed(path: Path) -> bool:
    if not path.is_file():
        return False
    try:
        with zipfile.ZipFile(path) as z:
            names = set(z.namelist())
    except (OSError, zipfile.BadZipFile):
        return False
    # Hub / AMO / web-ext sign layout
    if "META-INF/mozilla.rsa" in names or "META-INF/mozilla.sf" in names:
        return True
    return any(
        n.startswith("META-INF/") and n.endswith(".rsa") for n in names
    )


def extensions_json_signed() -> tuple[bool, str]:
    path = profile / "extensions.json"
    if not path.is_file():
        return False, ""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False, ""
    addons = data.get("addons") or []
    for addon in addons:
        if addon.get("id") != addon_id:
            continue
        # Skip stale disabled entries that are not actually present
        signed = addon.get("signedState")
        # 2=SIGNED, 3=SYSTEM, 4=PRIVILEGED (AMO/Hub installs use 2+)
        if isinstance(signed, int) and signed >= 2:
            loc = str(addon.get("location") or "")
            src = str(addon.get("sourceURI") or addon.get("rootURI") or "")
            detail = f"signedState={signed}"
            if loc:
                detail += f" location={loc}"
            if src:
                detail += f" source={src}"
            return True, detail
    return False, ""


xpi_signed = xpi_mozilla_signed(profile_xpi)
json_signed, json_detail = extensions_json_signed()
signed = xpi_signed or json_signed

if signed and not force:
    why = []
    if xpi_signed:
        why.append(f"signed XPI at {profile_xpi}")
    if json_signed:
        why.append(json_detail or "extensions.json signedState>=2")
    print("SIGNED|" + "; ".join(why))
    raise SystemExit(0)

if signed and force:
    print("FORCE_OVER_SIGNED|" + (json_detail or str(profile_xpi)))
    raise SystemExit(0)

print("UNSIGNED_OR_MISSING|ok")
PY
)"

if [[ "$signed_state" == SIGNED\|* ]]; then
  # Drop local force_installed policies that re-point Desk at an unsigned git XPI.
  policies_json="$HOME/.mozilla/firefox/policies/policies.json"
  if [[ -f "$policies_json" ]]; then
    ID="$ID" DIST_XPI="$XPI" POLICIES="$policies_json" python3 - <<'PY'
import json
import os
from pathlib import Path
from urllib.parse import unquote, urlparse

addon_id = os.environ["ID"]
dist = Path(os.environ["DIST_XPI"]).resolve()
path = Path(os.environ["POLICIES"])
try:
    data = json.loads(path.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError):
    raise SystemExit(0)
policies = data.get("policies") or {}
changed = False

ext_settings = policies.get("ExtensionSettings") or {}
entry = ext_settings.get(addon_id)
if isinstance(entry, dict):
    url = str(entry.get("install_url") or "")
    local = False
    if url.startswith("file:"):
        parsed = urlparse(url)
        file_path = Path(unquote(parsed.path)).resolve()
        if file_path == dist or str(file_path).endswith(f"/{addon_id}.xpi"):
            local = True
    if local or entry.get("installation_mode") == "force_installed":
        # Only strip when it looks like our unsigned sideload policy
        if local or (isinstance(entry.get("install_url"), str) and "label-connect" in entry.get("install_url", "")):
            ext_settings.pop(addon_id, None)
            changed = True
if ext_settings:
    policies["ExtensionSettings"] = ext_settings
elif "ExtensionSettings" in policies:
    policies.pop("ExtensionSettings", None)
    changed = True

installs = (policies.get("Extensions") or {}).get("Install")
if isinstance(installs, list):
    kept = []
    for item in installs:
        s = str(item)
        if addon_id in s or "label-connect" in s and s.startswith("file:"):
            changed = True
            continue
        kept.append(item)
    if kept:
        policies.setdefault("Extensions", {})["Install"] = kept
    else:
        ext = policies.get("Extensions") or {}
        ext.pop("Install", None)
        if ext:
            policies["Extensions"] = ext
        else:
            policies.pop("Extensions", None)

if changed:
    if policies:
        data["policies"] = policies
        path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    else:
        # Leave an empty policies shell rather than delete the file unexpectedly
        path.write_text(json.dumps({"policies": {}}, indent=2) + "\n", encoding="utf-8")
PY
  fi
  detail="${signed_state#SIGNED|}"
  notify "Black Forest Desk unchanged" "Mozilla-signed install kept ($detail). Not sideloading unsigned git XPI. Prefer Hub/AMO updates."
  printf 'profile=%s\nskipped=signed-amo\ndetail=%s\n' "$profile_dir" "$detail"
  exit 0
fi

if [[ "$signed_state" == FORCE_OVER_SIGNED\|* ]]; then
  notify "Black Forest Desk force sideload" "Overwriting Mozilla-signed install (--force-sideload). May vanish on Firefox restart."
fi

mkdir -p "$ext_dir"
cp -f "$XPI" "$profile_xpi"

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
# Note: on stock Firefox Release this often still fails for unsigned XPIs and can
# fight a later Hub install — prefer Hub/AMO; use --force-sideload consciously.
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

notify "Black Forest Desk sideloaded" "Firefox profile: $profile_dir — unsigned local XPI; may not persist on Release restart. Prefer Hub-signed Install from File."
printf 'profile=%s\nxpi=%s\nmode=unsigned-sideload\n' "$profile_dir" "$profile_xpi"
