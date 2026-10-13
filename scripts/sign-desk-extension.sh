#!/usr/bin/env bash
# Optionally sign the Firefox tree with AMO (unlisted / self-distribution).
# Credentials (repo Actions secrets or env):
#   WEB_EXT_API_KEY + WEB_EXT_API_SECRET
#   or AMO_JWT_ISSUER + AMO_JWT_SECRET
# Exits 0 with SIGN_SKIPPED=1 when credentials are missing (pipeline still publishes unsigned).
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
DIST="$ROOT/extension/dist"
SOURCE="$ROOT/extension/firefox"
ID="black-forest-desk@blackforestautomotive.com"

API_KEY="${WEB_EXT_API_KEY:-${AMO_JWT_ISSUER:-}}"
API_SECRET="${WEB_EXT_API_SECRET:-${AMO_JWT_SECRET:-}}"

mkdir -p "$DIST"

if [[ -z "${API_KEY}" || -z "${API_SECRET}" ]]; then
  echo "SIGN_SKIPPED=1"
  echo "AMO / web-ext credentials not set — leaving unsigned XPI in $DIST" >&2
  exit 0
fi

VER="$(python3 -c 'import json; print(json.load(open("'$ROOT'/extension/version.json"))["version"])')"
ART="$DIST/signed"
rm -rf "$ART"
mkdir -p "$ART"

# Ensure firefox/ tree is synced before signing.
npm --prefix "$ROOT" run sync-extension >/dev/null

npx --yes web-ext@8 sign \
  --source-dir "$SOURCE" \
  --channel unlisted \
  --api-key "$API_KEY" \
  --api-secret "$API_SECRET" \
  --artifacts-dir "$ART" \
  --no-input

SIGNED="$(ls -t "$ART"/*.xpi 2>/dev/null | head -1 || true)"
if [[ -z "$SIGNED" || ! -f "$SIGNED" ]]; then
  echo "web-ext sign produced no XPI under $ART" >&2
  exit 1
fi

cp -f "$SIGNED" "$DIST/Black.Forest.Desk.xpi"
cp -f "$SIGNED" "$DIST/Black.Forest.Desk-${VER}.xpi"
cp -f "$SIGNED" "$DIST/${ID}.xpi"

echo "SIGN_SKIPPED=0"
echo "Signed: $SIGNED"
echo "Published copies: Black.Forest.Desk.xpi Black.Forest.Desk-${VER}.xpi"
