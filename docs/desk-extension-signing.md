# Black Forest Desk — Firefox signing (org AMO)

Day-to-day install after secrets exist: **signed XPI** → `about:addons` → Install Add-on From File (normal profile) → Firefox auto-updates from GitHub Releases `updates.json`.

Temporary add-ons **cannot** auto-update. Do **not** ask Logan to create a personal Firefox Add-on Developer account.

---

## CI secrets (required for installable / auto-updating XPI)

Add **one** of these pairs on `BlackForestPorsche/label-connect` → Settings → Secrets and variables → Actions:

| Preferred | Equivalent |
| --- | --- |
| `WEB_EXT_API_KEY` | `AMO_JWT_ISSUER` |
| `WEB_EXT_API_SECRET` | `AMO_JWT_SECRET` |

Create the JWT pair under a **Black Forest / org** [Firefox Add-on Developer](https://addons.mozilla.org/developers/) account (shop infrastructure).

When secrets are **missing**, `publish-desk-extension` stays **green**: packs unsigned XPI + `updates.json`, prints a notice, skips `web-ext sign`. Stock Firefox still cannot Install-from-File an unsigned build.

When secrets are **present**, CI runs `scripts/sign-desk-extension.sh` (AMO **unlisted** channel) and publishes the signed artifact as `Black.Forest.Desk.xpi` (+ versioned copy).

---

## Manual sign (optional)

```bash
cd ~/label-connect
bash scripts/pack-desk-extension.sh
export WEB_EXT_API_KEY=... WEB_EXT_API_SECRET=...
bash scripts/sign-desk-extension.sh
bash scripts/generate-desk-updates-json.sh
bash scripts/gh-release-desk-extension.sh
```

---

## Auto-update wiring

- Manifest: `browser_specific_settings.gecko.update_url` →  
  `https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/updates.json`
- Release tag `desk-extension` always holds latest `updates.json` + XPI assets.
- Publish workflow runs on **main** only (avoids feature-branch release races / red emails).

Chrome / Edge stay Load unpacked (or optional Chrome Web Store later).
