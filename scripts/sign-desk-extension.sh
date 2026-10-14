#!/usr/bin/env bash
# Optionally sign the Firefox tree with AMO (unlisted / self-distribution).
# Credentials (repo Actions secrets or env):
#   WEB_EXT_API_KEY + WEB_EXT_API_SECRET
#   or AMO_JWT_ISSUER + AMO_JWT_SECRET
# Exits 0 with SIGN_SKIPPED=1 when credentials are missing (pipeline still publishes unsigned).
# When AMO returns "Version X already exists", reuse the signed XPI already on the
# desk-extension GitHub Release (same version cannot be re-signed) so the job stays
# green and Logan is not flooded with expected Conflict emails.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
DIST="$ROOT/extension/dist"
SOURCE="$ROOT/extension/firefox"
ID="black-forest-desk@blackforestautomotive.com"
RELEASE_REPO="${DESK_RELEASE_REPO:-BlackForestPorsche/label-connect}"
RELEASE_TAG="${DESK_RELEASE_TAG:-desk-extension}"

API_KEY="${WEB_EXT_API_KEY:-${AMO_JWT_ISSUER:-}}"
API_SECRET="${WEB_EXT_API_SECRET:-${AMO_JWT_SECRET:-}}"

mkdir -p "$DIST"

if [[ -z "${API_KEY}" || -z "${API_SECRET}" ]]; then
  echo "SIGN_SKIPPED=1"
  echo "AMO / web-ext credentials not set — leaving unsigned XPI in $DIST" >&2
  exit 0
fi

VER="$(python3 -c "import json; print(json.load(open('$ROOT/extension/version.json'))['version'])")"
ART="$DIST/signed"
rm -rf "$ART"
mkdir -p "$ART"

reuse_signed_from_release() {
  local asset="Black.Forest.Desk-${VER}.xpi"
  local dest="$ART/$asset"
  echo "AMO already has version ${VER} — reusing signed XPI from ${RELEASE_TAG} release." >&2
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh CLI missing; cannot download ${asset}" >&2
    return 1
  fi
  if gh release download "$RELEASE_TAG" \
    --repo "$RELEASE_REPO" \
    --pattern "$asset" \
    --dir "$ART" \
    --clobber >/dev/null 2>&1 \
    && [[ -f "$dest" ]]; then
    echo "Reused: $dest"
    return 0
  fi
  echo "Could not download ${asset} from ${RELEASE_REPO}@${RELEASE_TAG}" >&2
  return 1
}

install_signed() {
  local signed="$1"
  cp -f "$signed" "$DIST/Black.Forest.Desk.xpi"
  cp -f "$signed" "$DIST/Black.Forest.Desk-${VER}.xpi"
  cp -f "$signed" "$DIST/${ID}.xpi"
}

# Ensure firefox/ tree is synced before signing.
npm --prefix "$ROOT" run sync-extension >/dev/null

SIGN_LOG="$(mktemp)"
trap 'rm -f "$SIGN_LOG"' EXIT

set +e
npx --yes web-ext@8 sign \
  --source-dir "$SOURCE" \
  --channel unlisted \
  --api-key "$API_KEY" \
  --api-secret "$API_SECRET" \
  --artifacts-dir "$ART" \
  --no-input 2>&1 | tee "$SIGN_LOG"
SIGN_RC=${PIPESTATUS[0]}
set -e

if [[ "$SIGN_RC" -ne 0 ]]; then
  if grep -qE 'Version[[:space:]]+[0-9.]+[[:space:]]+already exists' "$SIGN_LOG" \
    || grep -qE '"version"[[:space:]]*:[[:space:]]*\[[^]]*already exists' "$SIGN_LOG"; then
    if reuse_signed_from_release; then
      SIGNED="$(ls -t "$ART"/*.xpi 2>/dev/null | head -1 || true)"
      if [[ -n "$SIGNED" && -f "$SIGNED" ]]; then
        install_signed "$SIGNED"
        echo "SIGN_SKIPPED=0"
        echo "SIGN_REUSED=1"
        echo "Signed (reused from release): $SIGNED"
        echo "Published copies: Black.Forest.Desk.xpi Black.Forest.Desk-${VER}.xpi"
        exit 0
      fi
    fi
    echo "AMO version ${VER} already exists and release reuse failed." >&2
    exit 1
  fi
  echo "web-ext sign failed (exit ${SIGN_RC})" >&2
  exit "$SIGN_RC"
fi

SIGNED="$(ls -t "$ART"/*.xpi 2>/dev/null | head -1 || true)"
if [[ -z "$SIGNED" || ! -f "$SIGNED" ]]; then
  echo "web-ext sign produced no XPI under $ART" >&2
  exit 1
fi

install_signed "$SIGNED"

echo "SIGN_SKIPPED=0"
echo "SIGN_REUSED=0"
echo "Signed: $SIGNED"
echo "Published copies: Black.Forest.Desk.xpi Black.Forest.Desk-${VER}.xpi"
