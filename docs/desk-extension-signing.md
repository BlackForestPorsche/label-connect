# Black Forest Desk — Firefox signing & auto-update

Temporary add-ons (`about:debugging`) **cannot** auto-update. Do **not** create a new Firefox profile. Do **not** ask Logan to create a personal Firefox Add-on Developer account — use the shop/org Hub add-on.

---

## Three update paths (pick one durable)

| Path | What it is | Durable auto-update? |
| --- | --- | --- |
| **A. AMO-hosted (preferred now)** | Developer Hub → **On this site** with `Black.Forest.Desk-<ver>-amo-hosted.xpi` (**no** `gecko.update_url`) | **Yes** — Firefox updates from AMO when you upload a newer version to the **same** add-on |
| **B. Self-dist + GitHub `update_url`** | Main pack keeps `update_url` → release `updates.json` + versioned XPI; needs a **Mozilla-signed** install once | **Yes** — after signed Install from File (Hub “On your own” or CI `web-ext sign`) |
| **C. Local script** | `bash scripts/update-desk-extension.sh` (also from `update-labels.sh`) | **No** — packs + optional unsigned sideload; **skips** when a Mozilla-signed Hub/AMO Desk is already in the default profile (avoids clobber → vanish-on-restart). Fallback / Dev Edition only; `--force-sideload` overrides |

### Preferred for Logan (extensions approved)

1. Pack or download **`Black.Forest.Desk-<ver>-amo-hosted.xpi`** from the `desk-extension` release (or `bash scripts/pack-desk-extension.sh` → `extension/dist/`).
2. Hub → same **Black Forest Desk** add-on → **Upload New Version** → **On this site**.
3. Install the Hub-signed build once on the normal profile; remove any Temporary Desk add-on.
4. Later bumps: upload a higher version the same way — Firefox auto-updates. No `about:debugging`, no per-release desk script.

### Self-dist wiring (already on main)

- Manifest: `browser_specific_settings.gecko.update_url` →  
  `https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/updates.json`
- Release tag `desk-extension` holds `updates.json`, `Black.Forest.Desk.xpi`, `Black.Forest.Desk-<ver>.xpi`, `Black.Forest.Desk-<ver>-amo-hosted.xpi`, chromium zip.
- Publish workflow: **main** only (+ `workflow_dispatch`). Feature-branch publish races fixed (PR #11).

Stock Firefox will not Install-from-File or auto-update an **unsigned** GitHub XPI. Until org AMO JWT secrets exist in CI, use Hub signing (path A or Hub “On your own” for path B).

---

## CI secrets (optional — self-dist signing)

Add **one** of these pairs on `BlackForestPorsche/label-connect` → Settings → Secrets and variables → Actions:

| Preferred | Equivalent |
| --- | --- |
| `WEB_EXT_API_KEY` | `AMO_JWT_ISSUER` |
| `WEB_EXT_API_SECRET` | `AMO_JWT_SECRET` |

Create the JWT pair under a **Black Forest / org** [Firefox Add-on Developer](https://addons.mozilla.org/developers/) account (shop infrastructure).

When secrets are **missing**, `publish-desk-extension` stays **green**: packs unsigned XPI + `updates.json` (+ amo-hosted pack), prints a notice, skips `web-ext sign`. Prefer Hub upload of the amo-hosted XPI for stock Firefox.

When secrets are **present**, CI runs `scripts/sign-desk-extension.sh` (AMO **unlisted** channel) and publishes the signed artifact as `Black.Forest.Desk.xpi` (+ versioned copy) for path B.

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
