#!/usr/bin/env bash
# Build Firefox self-distribution update manifest (updates.json) for gecko.update_url.
# Points at the versioned XPI on the stable desk-extension release tag.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
DIST="$ROOT/extension/dist"
ID="black-forest-desk@blackforestautomotive.com"
TAG="desk-extension"
REPO="BlackForestPorsche/label-connect"

mkdir -p "$DIST"

VER="$(python3 -c 'import json; print(json.load(open("'$ROOT'/extension/version.json"))["version"])')"
XPI_STABLE="$DIST/Black.Forest.Desk.xpi"
XPI_VERSIONED="$DIST/Black.Forest.Desk-${VER}.xpi"

if [[ ! -f "$XPI_STABLE" ]]; then
  echo "Missing $XPI_STABLE — run pack-desk-extension.sh first" >&2
  exit 1
fi

# Prefer a versioned asset URL so update_link + hash stay stable after later clobbers.
if [[ ! -f "$XPI_VERSIONED" ]]; then
  cp -f "$XPI_STABLE" "$XPI_VERSIONED"
fi

HASH="$(sha256sum "$XPI_VERSIONED" | awk '{print $1}')"
LINK="https://github.com/${REPO}/releases/download/${TAG}/Black.Forest.Desk-${VER}.xpi"
OUT="$DIST/updates.json"

python3 - "$OUT" "$ID" "$VER" "$LINK" "$HASH" <<'PY'
import json
import sys
from pathlib import Path

out, addon_id, version, link, digest = sys.argv[1:6]
payload = {
    "addons": {
        addon_id: {
            "updates": [
                {
                    "version": version,
                    "update_link": link,
                    "update_hash": f"sha256:{digest}",
                    "browser_specific_settings": {
                        "gecko": {
                            "strict_min_version": "140.0",
                        }
                    },
                }
            ]
        }
    }
}
path = Path(out)
path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
print(path)
print(f"version={version} hash=sha256:{digest}")
PY
