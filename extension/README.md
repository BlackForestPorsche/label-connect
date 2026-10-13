# Black Forest Desk (browser extension)

One MV3 package for desk browsers (**Firefox**, **Chrome**, **Edge**) on **Windows** and **Linux**:

1. **AllData Manage Online** — on **Create R/O** success only, print customer **last name** + vehicle **model** via local Labels `POST /api/print-ro`.
2. **SSF Autoparts checkout** — Order reference (`PO # / RO #`) dropdown of **On the Lot** last names (never the book).

**Never** prints on Update R/O, Schedule New R/O, or Assign R/O.

Lives in this repo under `extension/` so desk installs stay one git pull with Labels.

## Download (install yourself — preferred)

Stable GitHub Release assets (tag `desk-extension`):

| Browser | File | URL |
| --- | --- | --- |
| **Firefox** | `Black.Forest.Desk.xpi` | https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/Black.Forest.Desk.xpi |
| **Chrome / Edge** | `Black.Forest.Desk-chromium.zip` | https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/Black.Forest.Desk-chromium.zip |

Release page / latest: https://github.com/BlackForestPorsche/label-connect/releases/latest

**Firefox:** open your normal profile → `about:addons` → gear → **Install Add-on From File…** → pick the XPI. Do **not** create a new Firefox profile.

**Chrome / Edge:** unzip the zip → `chrome://extensions` / `edge://extensions` → Developer mode → **Load unpacked** → select the unzipped folder.

Pack locally: `bash scripts/pack-desk-extension.sh` → `extension/dist/Black.Forest.Desk.xpi` (+ chromium zip).

---

## Auto-update (shop path)

AMO / Chrome Web Store signing is **not** required for the desk.

| Piece | Behavior |
| --- | --- |
| Source of truth | `~/label-connect` git tree (same as Labels) |
| Refresh script | `bash scripts/update-desk-extension.sh` |
| Tied to Labels update | `scripts/update-labels.sh` also runs the desk extension refresh |
| In-extension checker | Background fetches `extension/version.json` from GitHub `main`; badge `↑` + popup “Check for extension update” when newer |
| Firefox | Packs XPI → profile `extensions/` + `user.js` sideload prefs + optional `~/.mozilla/firefox/policies/policies.json` |
| Chrome / Edge | Keep **Load unpacked** pointed at `extension/chromium/` (git pull refreshes files; click Reload on the extensions page after a big bump) |

Desk does **not** need to browse GitHub releases. Pull Labels / run the update script.

## Requirements

1. Labels running locally (`http://127.0.0.1:8080` by default, or set `labelsBaseUrl` in extension storage).
2. For SSF lot names: shop widget person + PIN (extension popup) → Bearer to `GET /api/widget/views/lot` (never `book-today`).
3. Browser: Firefox, Chrome, or Edge.
4. Desk OS: Manjaro/Linux (CUPS `LabelWriter550`) or Windows (PrintTo to LabelWriter/DYMO / `LABELS_PRINTER`).

## Install — Manjaro Firefox (shell, no GUI tour)

```bash
cd ~/label-connect
git pull
npm install
bash scripts/install-desk-extension-firefox.sh
# restart Firefox once so the profile picks up the XPI
```

Later updates:

```bash
bash scripts/update-labels.sh
# or:
bash scripts/update-desk-extension.sh
```

Gecko id: `black-forest-desk@blackforestautomotive.com`.

**Note:** Release Firefox may still ignore unsigned sideloads. The install script sets profile prefs used by Developer Edition / Nightly / unbranded builds, drops the XPI into the default profile, and writes policies. If the add-on does not appear after restart, use **Load Temporary Add-on** once from `extension/firefox/manifest.json` (about:debugging) until AMO self-distribution exists — Create RO print still works the same.

## Install — Chrome / Edge (Chromium MV3)

Package folder: `extension/chromium/`

1. `npm run sync-extension`
2. `chrome://extensions` / `edge://extensions` → Developer mode → **Load unpacked** → `label-connect/extension/chromium`
3. Leave that path forever; after `git pull` / `update-desk-extension.sh`, click **Reload** on the card when the version badge shows `↑`

## Install — Firefox temporary (quick test)

1. `npm run sync-extension`
2. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → `extension/firefox/manifest.json`

## Windows desk checklist

1. Install / update Labels (`git pull` + `npm install` + `npm start`, port 8080).
2. Confirm a Windows printer named like **LabelWriter** / **DYMO** (or set `LABELS_PRINTER`).
3. `npm run sync-extension`, then load unpacked Chromium (Edge/Chrome) or Firefox temporary/sideload as above.
4. Optional: run Git Bash `bash scripts/update-desk-extension.sh` after pulls.

## AllData — what gets scraped

| Field | Source |
| --- | --- |
| Last name | “Last Name” / “Customer” field; else last token of customer name |
| Model | “Model” field; else Year/Make/Model line; else known Porsche model token on screen |
| RO number | Optional; used only for server idempotency |

If last name or model cannot be read after Create succeeds, the extension toasts **Label skipped** and does not print.

## SSF — On the Lot dropdown

1. Open the extension popup → shop **person** (lowercase, e.g. `logan`) + **desk PIN** (same as shop unlock / Plasma widget).
2. Go to `https://www.ssfautoparts.com/checkout`.
3. Next to Order reference, pick a last name — it fills `PO # / RO #`.
4. Empty lot → quiet empty state. Book appointments are never queried.

### If you see “Unauthorized”

The shop widget API returns the code `unauthorized` for a bad/missing PIN session. Desk **0.1.6+** maps that to “enter desk PIN” copy. Fix:

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
