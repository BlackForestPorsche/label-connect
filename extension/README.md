# AllData Create RO → Labels (browser extension)

On **Create R/O** success in ALLDATA Manage Online, posts customer **last name** + vehicle **model** to the local Labels app and prints a 30252 label.

**Never** prints on Update R/O, Schedule New R/O, or Assign R/O.

Lives in this repo under `extension/` (not a separate `alldata-ro-labels` repo) so desk installs stay one git pull with Labels.

## Requirements

1. Labels running locally (`http://127.0.0.1:8080` by default, or set `labelsBaseUrl` in extension storage).
2. Browser: **Firefox**, **Chrome**, or **Edge**.
3. Desk OS: **Manjaro/Linux** (CUPS `LabelWriter550`) or **Windows** (PrintTo to a LabelWriter/DYMO printer).

## Install — Chrome / Edge (Chromium MV3)

Package folder: `extension/chromium/`

1. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
2. Enable **Developer mode**.
3. **Load unpacked** → select `label-connect/extension/chromium`.
4. Open `https://manageonline.alldata.com` and create a test R/O once Labels is up.

Optional custom Labels URL (default `http://127.0.0.1:8080`):

```js
// DevTools console on any page, or an extension service-worker console:
chrome.storage.local.set({ labelsBaseUrl: "http://127.0.0.1:8080" })
```

## Install — Firefox (MV3)

Package folder: `extension/firefox/`

### Temporary (quick test)

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → pick `extension/firefox/manifest.json`.
3. Reloads clear temporary add-ons — use a permanent profile install for the desk.

### Permanent (desk)

1. Zip the `extension/firefox` folder contents (manifest at zip root), or keep the unpacked tree.
2. Prefer `about:debugging` → **Load Temporary Add-on** after each Labels update, **or** sign/self-distribute later.
3. For shop Manjaro Firefox: Load Temporary Add-on at login is enough if Labels + this tree live under `~/label-connect`.

## Manjaro desk checklist

```bash
cd ~/label-connect
git pull
npm install
bash scripts/update-labels.sh   # if you use the helper
# ensure Labels server is up (boot service or scripts/start-labels.sh)
```

Then load `extension/chromium` in Chrome/Edge **or** `extension/firefox` via `about:debugging`.

Do **not** automate the AllData GUI from the Manjaro agent — humans click Create R/O in the browser.

## Windows desk checklist

1. Install / update Labels the same way as Linux (`git clone` / pull + `npm install` + `npm start`, port 8080).
2. Confirm a Windows printer named like **LabelWriter** / **DYMO** exists (or set `LABELS_PRINTER` to the exact queue name before starting Labels).
3. Load unpacked extension in Edge or Chrome from `extension/chromium`, or Firefox from `extension/firefox`.

## What gets scraped

| Field | Source |
| --- | --- |
| Last name | “Last Name” / “Customer” field; else last token of customer name |
| Model | “Model” field; else Year/Make/Model line; else known Porsche model token on screen |
| RO number | Optional; used only for server idempotency |

If last name or model cannot be read after Create succeeds, the extension toasts **Label skipped** and does not print.

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
