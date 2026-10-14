# Black Forest Desk — Firefox signing & auto-update

Temporary add-ons (`about:debugging`) **cannot** auto-update. Do **not** create a new Firefox profile.

Shop preference: **On your own** + `gecko.update_url` self-dist (GitHub Release `updates.json`). Path A (AMO-hosted “On this site”) remains available but is not the current desk default.

**Never share a Mozilla password. Never paste AMO JWT issuer/secret into chat.** Use Developer Hub **API Keys** only, and store them as GitHub Actions secrets.

---

## If a JWT was pasted in chat

Treat it as **compromised**:

1. [Hub → API Keys](https://addons.mozilla.org/developers/addon/api/key/) → **revoke** the exposed credential.
2. Create a **new** JWT pair.
3. Add the new values only under GitHub → Settings → Secrets and variables → Actions (names below).
4. Tell the team secrets are set — **do not paste** values again.

---

## Two durable update paths

| Path | What it is | Durable auto-update? |
| --- | --- | --- |
| **B. Self-dist + GitHub `update_url` (preferred)** | Main pack keeps `update_url` → release `updates.json` + versioned XPI; needs a **Mozilla-signed** install once | **Yes** — after signed Install from File (Hub “On your own” or CI `web-ext sign`) |
| **A. AMO-hosted** | Developer Hub → **On this site** with `Black.Forest.Desk-<ver>-amo-hosted.xpi` (**no** `gecko.update_url`) | **Yes** — Firefox updates from AMO when you upload a newer version to the **same** add-on |
| **C. Local script** | `bash scripts/update-desk-extension.sh` | **No** — packs + optional unsigned sideload; **skips** when a Mozilla-signed Hub/AMO Desk is already in the default profile |

### Preferred (On your own)

1. Ship / download the **self-dist** XPI (`Black.Forest.Desk-<ver>.xpi` or `.zip` hub-upload) that **includes** `gecko.update_url` — not `*-amo-hosted.xpi`.
2. Either:
   - Hub → **Upload New Version** → **On your own**, then install the Hub-signed file once; or
   - Set AMO JWT secrets (below) so CI signs on every main Desk publish.
3. Install the **Mozilla-signed** XPI on the normal profile (`about:addons` → Install from File). Remove Temporary Desk add-ons.
4. Later bumps: CI signed release + `updates.json`, or another Hub “On your own” upload with a **new** version number.

### Self-dist wiring (already on main)

- Manifest: `browser_specific_settings.gecko.update_url` →  
  `https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/updates.json`
- Release tag `desk-extension` holds `updates.json`, `Black.Forest.Desk.xpi`, `Black.Forest.Desk-<ver>.xpi`, `Black.Forest.Desk-<ver>-amo-hosted.xpi`, chromium zip.
- Publish workflow: **main** only (+ `workflow_dispatch`). Feature-branch publish races fixed (PR #11).

Stock Firefox will not Install-from-File or auto-update an **unsigned** GitHub XPI. Until org AMO JWT secrets exist in CI, use Hub “On your own” for path B.

---

## CI secrets (required for auto Hub/API sign)

Workflow: `.github/workflows/publish-desk-extension.yml`  
Signing script: `scripts/sign-desk-extension.sh` (`web-ext sign --channel unlisted`)

Add **one** of these pairs on  
[Settings → Secrets and variables → Actions](https://github.com/BlackForestPorsche/label-connect/settings/secrets/actions):

| Preferred | Equivalent |
| --- | --- |
| `WEB_EXT_API_KEY` | `AMO_JWT_ISSUER` |
| `WEB_EXT_API_SECRET` | `AMO_JWT_SECRET` |

Create the JWT under the shop/org [Firefox Add-on Developer API Keys](https://addons.mozilla.org/developers/addon/api/key/) page (same account that owns Black Forest Desk).

When secrets are **missing**, `publish-desk-extension` stays **green**: packs unsigned XPI + `updates.json` (+ amo-hosted pack), prints a notice, skips `web-ext sign`.

When secrets are **present**, CI signs (AMO **unlisted** / self-dist) and publishes the signed artifact as `Black.Forest.Desk.xpi` (+ versioned copy) for path B.

Indirect check (no secret values): latest workflow run → step “Sign Firefox XPI” — notice “secrets missing” means not set; `signed=true` means working.

---

## Manual sign (optional, path B)

```bash
cd ~/label-connect
bash scripts/pack-desk-extension.sh
export WEB_EXT_API_KEY=... WEB_EXT_API_SECRET=...
bash scripts/sign-desk-extension.sh
bash scripts/generate-desk-updates-json.sh
bash scripts/gh-release-desk-extension.sh
```

Chrome / Edge stay Load unpacked (or optional Chrome Web Store later).
