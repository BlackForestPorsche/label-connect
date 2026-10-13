# Black Forest Desk (browser extension)

One MV3 package for desk browsers (**Firefox**, **Chrome**, **Edge**) on **Windows** and **Linux**:

1. **AllData Manage Online** — on **Create R/O** success only, print customer **last name** + vehicle **model** via local Labels `POST /api/print-ro`.
2. **SSF Autoparts checkout** — Order reference (`PO # / RO #`) dropdown of **On the Lot** last names (never the book).

**Never** prints on Update R/O, Schedule New R/O, or Assign R/O.

Lives in this repo under `extension/` so desk installs stay one git pull with Labels.

## Requirements

1. Labels running locally (`http://127.0.0.1:8080` by default, or set `labelsBaseUrl` in extension storage).
2. For SSF lot names: shop widget person + PIN (extension popup) → Bearer to `GET /api/widget/views/lot`.
3. Browser: Firefox, Chrome, or Edge.
4. Desk OS: Manjaro/Linux (CUPS `LabelWriter550`) or Windows (PrintTo to LabelWriter/DYMO / `LABELS_PRINTER`).

## Install — Chrome / Edge (Chromium MV3)

Package folder: `extension/chromium/`

1. After pull: `npm run sync-extension` (copies shared scripts into both packages).
2. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
3. Enable **Developer mode**.
4. **Load unpacked** → select `label-connect/extension/chromium`.

## Install — Firefox (MV3)

Package folder: `extension/firefox/`

### Temporary (quick test)

1. `npm run sync-extension`
2. Open `about:debugging#/runtime/this-firefox`.
3. **Load Temporary Add-on…** → pick `extension/firefox/manifest.json`.

### Permanent (desk)

Use temporary load after each Labels update, or sign/self-distribute later. Gecko id: `black-forest-desk@blackforestautomotive.com`.

## Manjaro desk checklist

```bash
cd ~/label-connect
git pull
npm install
npm run sync-extension
bash scripts/update-labels.sh   # if you use the helper
# ensure Labels server is up (boot service or scripts/start-labels.sh)
```

Then load `extension/chromium` in Chrome/Edge **or** `extension/firefox` via `about:debugging`.

Do **not** automate the AllData or SSF GUI from the Manjaro agent — humans click in the browser.

## Windows desk checklist

1. Install / update Labels (`git pull` + `npm install` + `npm start`, port 8080).
2. Confirm a Windows printer named like **LabelWriter** / **DYMO** (or set `LABELS_PRINTER`).
3. `npm run sync-extension`, then load unpacked Chromium or Firefox add-on as above.

## AllData — what gets scraped

| Field | Source |
| --- | --- |
| Last name | “Last Name” / “Customer” field; else last token of customer name |
| Model | “Model” field; else Year/Make/Model line; else known Porsche model token on screen |
| RO number | Optional; used only for server idempotency |

If last name or model cannot be read after Create succeeds, the extension toasts **Label skipped** and does not print.

## SSF — On the Lot dropdown

1. Open the extension popup → person + PIN (same people as shop unlock).
2. Go to `https://www.ssfautoparts.com/checkout`.
3. Next to Order reference, pick a last name — it fills `PO # / RO #`.
4. Empty lot → quiet empty state. Book appointments are never queried.

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
