# Black Forest Desk (browser extension)

One unpacked install for **Firefox / Chrome / Edge** covering:

1. **AllData Create R/O → Labels** (first ship) — print customer last name + vehicle model on Create only.
2. **SSF Autoparts checkout** — Order reference (`PO # / RO #`) dropdown of **On the Lot** customer last names (not the book).

Lives in `label-connect/extension/` so desk updates stay one git pull with Labels.

## Requirements

1. Labels running locally for AllData print (`http://127.0.0.1:8080`, or `labelsBaseUrl` in extension storage).
2. Browser: Firefox, Chrome, or Edge.
3. Optional for SSF live names: shop widget bearer in `shopWidgetToken` (On the Lot API). Without it the dropdown mounts empty until names are cached.

## Install — Chrome / Edge

Folder: `extension/chromium/`

1. `chrome://extensions` or `edge://extensions` → Developer mode → **Load unpacked** → select that folder.
2. AllData: open Manage Online, Create R/O once Labels is up.
3. SSF: open `https://www.ssfautoparts.com/checkout` — dropdown appears under Order reference when the field is found.

## Install — Firefox

Folder: `extension/firefox/`

1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → `manifest.json`.
2. Same hosts as Chromium (AllData + SSF).

## Storage keys

| Key | Purpose |
| --- | --- |
| `labelsBaseUrl` | Labels loopback (default `http://127.0.0.1:8080`) |
| `shopBaseUrl` | Shop origin (default `https://shop.blackforestautomotive.com`) |
| `shopWidgetToken` | Bearer for `GET /api/widget/views/lot` |
| `lotLastNames` | Cached last names from On the Lot |

Seed cache for a smoke test without shop auth:

```js
chrome.storage.local.set({ lotLastNames: ["Owner", "Smith"] })
```

## AllData hard rules

- Print **only** on Create R/O success.
- **Never** Update R/O, Schedule New R/O, Assign R/O.
- Label lines: last name + model.

## SSF rules (Logan)

- Names from **On the Lot only** (car `owner` → last token). **Not** shop book appointments.
- Same extension package / one install.
- Does not block or depend on Create RO print succeeding.

## Manjaro + Windows

See repo root README. Load this extension after Labels update; reload the add-on when `extension/` changes. Do not automate AllData or SSF GUIs from the Manjaro agent.

## Smoke — Labels dry-run

```bash
curl -s -X POST 'http://127.0.0.1:8080/api/print-ro?dryRun=1' \
  -H 'content-type: application/json' \
  -d '{"event":"create-ro","lastName":"Owner","model":"Macan","roNumber":"TEST001"}'
```
