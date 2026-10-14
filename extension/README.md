# Black Forest Desk (browser extension)

One MV3 package for desk browsers (**Firefox**, **Chrome**, **Edge**) on **Windows** and **Linux**:

1. **AllData Manage Online** — on **Create R/O** success only, print customer **last name** + vehicle **model** via local Labels `POST /api/print-ro`.
2. **SSF Autoparts checkout** — Order reference (`PO # / RO #`) dropdown of **On the Lot** last names (never the book).

**Never** prints on Update R/O, Schedule New R/O, or Assign R/O.

Lives in this repo under `extension/` so desk installs stay one git pull with Labels.

## Download

Stable GitHub Release assets (tag `desk-extension`):

| Browser | File | URL |
| --- | --- | --- |
| **Firefox (AMO Hub)** | `Black.Forest.Desk-<ver>-amo-hosted.xpi` | https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/ (versioned `*-amo-hosted.xpi`) |
| **Firefox (self-dist)** | `Black.Forest.Desk.xpi` / `Black.Forest.Desk-<ver>.xpi` | https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/Black.Forest.Desk.xpi |
| **Firefox updates.json** | `updates.json` | https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/updates.json |
| **Chrome / Edge** | `Black.Forest.Desk-chromium.zip` | https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/Black.Forest.Desk-chromium.zip |

Release page / latest: https://github.com/BlackForestPorsche/label-connect/releases/latest

Pack locally: `bash scripts/pack-desk-extension.sh` → `extension/dist/` (main XPI with `update_url`, `*-amo-hosted.xpi` without it, chromium zip, `updates.json`).

---

## Auto-update (durable vs local script)

| Path | How | Durable? |
| --- | --- | --- |
| **A. AMO-hosted (preferred)** | Upload `*-amo-hosted.xpi` (no `update_url`) to Developer Hub → **On this site** on the **same** approved add-on; install Hub-signed once | **Yes** — Firefox updates from AMO on later Hub versions |
| **B. Self-dist + `update_url`** | Mozilla-signed main XPI once; CI publishes `updates.json` + versioned XPI on tag `desk-extension` | **Yes** — after signed Install from File (needs Hub “On your own” or CI AMO JWT) |
| **C. Local script** | `bash scripts/update-desk-extension.sh` (also from `update-labels.sh`) | **No** — sideload refresh only; not a substitute for A/B |

Details / secrets: [docs/desk-extension-signing.md](../docs/desk-extension-signing.md).

**Firefox durable install:** normal profile only → Hub-signed or Install from File → remove Temporary Add-ons. Do **not** create a new Firefox profile.

**Chrome / Edge:** unzip → Load unpacked (or keep Load unpacked on `extension/chromium/` after git pull / Reload).

In-extension checker (badge `↑` + popup “Check for extension update”) still fetches `extension/version.json` from GitHub `main` as a nudge — it does not replace A or B.

## Requirements

1. Labels running locally (`http://127.0.0.1:8080` by default, or set `labelsBaseUrl` in extension storage).
2. For SSF lot names: shop widget person + PIN (extension popup) → Bearer to `GET /api/widget/views/lot` (never `book-today`).
3. Browser: Firefox, Chrome, or Edge.
4. Desk OS: Manjaro/Linux (CUPS `LabelWriter550`) or Windows (PrintTo to LabelWriter/DYMO / `LABELS_PRINTER`).

## Install — Firefox durable (preferred after Hub approval)

1. Download `Black.Forest.Desk-<ver>-amo-hosted.xpi` from the `desk-extension` release (or pack with `bash scripts/pack-desk-extension.sh`).
2. [Developer Hub](https://addons.mozilla.org/developers/) → your **Black Forest Desk** add-on → **Upload New Version** → **On this site**.
3. Install the Hub-signed build once on the **normal** profile (`about:addons` or Hub download). Remove any Temporary Desk add-on.
4. Later versions: upload a higher `*-amo-hosted.xpi` to the same add-on — Firefox auto-updates.

Gecko id: `black-forest-desk@blackforestautomotive.com`.

## Install — Manjaro Firefox (local sideload fallback)

Use only when Hub signing is unavailable (Dev Edition / Nightly / unbranded) — **not** the durable auto-update path:

```bash
cd ~/label-connect
git pull
npm install
bash scripts/install-desk-extension-firefox.sh
# restart Firefox once so the profile picks up the XPI
```

Later local refreshes (still not AMO/GitHub auto-update):

```bash
bash scripts/update-labels.sh
# or:
bash scripts/update-desk-extension.sh
```

**Note:** Release Firefox may ignore unsigned sideloads. Prefer Hub **On this site** (amo-hosted pack) or a Mozilla-signed self-dist XPI.

## Install — Chrome / Edge (Chromium MV3)

Package folder: `extension/chromium/` (same sibling layout as Firefox: `manifest.json` + `popup.html` at folder root).

1. `npm run sync-extension`
2. `chrome://extensions` / `edge://extensions` → Developer mode → **Load unpacked** → `label-connect/extension/chromium` (the folder that contains `manifest.json` and `popup.html`)
3. Leave that path forever; after `git pull` / `update-desk-extension.sh`, click **Reload** on the card when the version badge shows `↑`

## Install — Firefox temporary (desk day-to-day)

1. `npm run sync-extension` (or `git pull` so `extension/firefox/popup.html` is present).
2. `about:debugging#/runtime/this-firefox`
3. If **Black Forest Desk** is already listed under Temporary Extensions, **Remove** it first (clears a stale/wrong root).
4. **Load Temporary Add-on…** → pick **exactly one** of:
   - `extension/firefox/manifest.json` (must be the file **inside** `extension/firefox/` so `popup.html` / `popup.js` resolve as siblings), or
   - a packed `Black.Forest.Desk.xpi` (`extension/dist/` or `~/Downloads/`)
5. Do **not** load `extension/manifest.json`, the parent `extension/` folder, or a symlink outside `firefox/`.

If the toolbar popup shows `File not found` / `moz-extension://…/popup.html`, the pack is fine — **Remove** the temporary add-on and load again from step 4.

## Windows desk checklist

1. Install / update Labels (`git pull` + `npm install` + `npm start`, port 8080).
2. Confirm a Windows printer named like **LabelWriter** / **DYMO** (or set `LABELS_PRINTER`).
3. `npm run sync-extension`, then load unpacked Chromium (Edge/Chrome) or Firefox temporary/sideload as above.
4. Optional: run Git Bash `bash scripts/update-desk-extension.sh` after pulls.

## AllData — what gets scraped

| Field | Source |
| --- | --- |
| Last name | “Last Name” / “Customer” field; last name only (strips `J.` / `LAST, F` / glued `LWhatcott` → `Whatcott` — never first initial on the label). Never VIN. |
| Model | “Model” field; else Year/Make/Model line; else known Porsche model token on screen. Never VIN / `VIN:`. |
| RO number | Optional; AllData repair-order id for server idempotency only — **not printed** on the label |

**Printed label (Create only):**

```
Whatcott - Boxster
Out Mileage _____________
```

Line 2 is a handwriting blank (not mileage from AllData). Every **Create R/O** success prints, even when that customer already has an open RO or you Create again for the same tester person. Dedupe is per Create click / new RO id — never by customer. Pre-existing Update / old RO# is not treated as success and is not sent to Labels (that was causing “already printed this RO”). Update / Schedule New / Assign never print.

If last name or model cannot be read after Create succeeds, the extension toasts **Label skipped** and does not print.

## SSF — On the Lot dropdown

1. Open the extension popup → shop **person** (lowercase, e.g. `logan`) + **desk PIN** (same as shop unlock / Plasma widget).
2. Go to `https://www.ssfautoparts.com/checkout`.
3. Next to Order reference, pick a last name — it fills `PO # / RO #`.
4. Empty lot → quiet empty state. Book appointments are never queried.

### If you see “Unauthorized”

The shop widget API returns the code `unauthorized` for a bad/missing PIN session. Desk **0.1.4+** maps that to “enter desk PIN” copy. Fix:

1. Click the **Black Forest Desk** toolbar icon (badge may show `PIN`).
2. Person = lowercase shop unlock name; **Desk PIN** = same PIN as the site / plasmoid.
3. **Unlock with desk PIN**, then on SSF checkout click **Refresh**.
4. Create RO print does **not** use the desk PIN — only local Labels at `http://127.0.0.1:8080`.

## Smoke test (no AllData)

With Labels running:

```bash
curl -s -X POST 'http://127.0.0.1:8080/api/print-ro?dryRun=1' \
  -H 'content-type: application/json' \
  -d '{"event":"create-ro","lastName":"Owner","model":"Macan","roNumber":"TEST001"}'
```

Update-shaped payloads must fail:

```bash
curl -s -X POST 'http://127.0.0.1:8080/api/print-ro?dryRun=1' \
  -H 'content-type: application/json' \
  -d '{"event":"update-ro","lastName":"Owner","model":"Macan"}'
```
