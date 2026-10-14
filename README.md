# Labels (LabelWriter 550)

## Merge into Black Forest Tools (in progress)

From **shop-desktop 1.5.7+**, Black Forest Tools **owns** the Labels HTTP server on `:8080` (vendors this tree under `labels/`, spawns `node server.mjs` when nothing is already listening — including adopting a leftover `labels.service`). Desk Create RO keeps calling `http://127.0.0.1:8080/api/print-ro` — no extension change for the merge.

- Prefer Tools autostart over the separate Labels desktop launcher day-to-day.
- A leftover `labels.service` / `start-labels.sh` is fine during transition: Tools **adopts** an already-healthy `:8080` instead of double-binding.
- This repo remains the source of truth for LabelWriter print code + Desk extension; Tools re-syncs with `npm run sync-labels`.
- Manjaro: disable the standalone Labels user unit later, once Tools autostart is the boot path.

Desktop label bench for the DYMO LabelWriter 550. Prints to the CUPS queue **LabelWriter550** on Linux, or the Windows LabelWriter/DYMO printer via PrintTo.

**0.1.15** - Black Forest Desk: Create R/O success confirm fixed (armed Create control, shadow DOM, disabled/busy, success banner, arm-time field fallback). Version skips **0.1.14** (Update button draft). Label layout unchanged.

**0.1.13** - Black Forest Desk Hub re-upload version (AMO rejected reusing 0.1.12 after delete). Same Create RO label layout + auto unlock; self-dist pack keeps `gecko.update_url` → GitHub `updates.json`.

**0.1.12** - Create RO label layout: `{LastName} - {Model}` then `Out Mileage _____________`. Strips glued first initial (`LWhatcott` → `Whatcott`); never prints VIN / `VIN:`. Still prints on every Create (dedupe unchanged).

**0.1.11** - Black Forest Desk: **background auto unlock** from shop `from-gate` (startup, alarm, idle→active, shop tab complete) with Tools `:8788` fallback. No need to open the popup and press Sync for the happy path; Sync buttons + Person/PIN remain.

**0.1.10** - Create RO labels: **last name only** + model; print on **every** Create (same customer / open RO OK). Dedupe per Create click or new RO id — not person. Open/baseline RO# is not sent to Labels (fixes “already printed this RO” on a new Create).

**0.1.6** - Black Forest Desk: map shop `unauthorized` to clear **desk PIN** unlock copy; lowercase person like the Plasma widget; host permissions include `127.0.0.1:8080`; SSF empty state points at the popup PIN. Keeps Firefox `strict_min_version` **140.0** + `data_collection_permissions` from 0.1.5.

**0.1.5** - Firefox `strict_min_version` raised to **140.0** (AMO requirement when `data_collection_permissions` is present).

**0.1.3** - AllData Create RO auto-print: `POST /api/print-ro` renders **customer last name + vehicle model** on 30252 (safe ImageableArea margins) and prints. Rejects Update / Schedule / Assign. Idempotent by `roNumber`. **Black Forest Desk** browser extension (Chrome/Edge/Firefox) in [`extension/`](extension/README.md): Create RO → Labels plus SSF checkout On-the-Lot last-name dropdown (same install).

**0.1.1** - Editor shows the CUPS/PPD safe print zone (dashed box) and keeps blocks inside it so edge content is not clipped on the LabelWriter 550 (30252 Address uses the driver ImageableArea, about 1-1.5 mm on the short sides and a larger inset on the feed end).

This public repo is the **release remote** for the shop PC install at `~/label-connect`. App source also lives under `label-connect/` on the private `blackforest-tools` branch `cursor/labelwriter-550-6410` ([PR #3](https://github.com/BlackForestPorsche/blackforest-tools/pull/3)).

## AllData Create RO → print

Hard rules:

- **Only Create R/O** prints. Never Update R/O, Schedule New R/O, or Assign R/O.
- Label lines: `{LastName} - {Model}` then `Out Mileage _____________` (handwriting blank). No first initial, no VIN / `VIN:`, no RO# on the label.
- Print on every Create R/O success, including when an open RO already exists for that customer.
- Local Labels URL: `http://127.0.0.1:8080` (or `PORT` / extension `labelsBaseUrl`).

Dry-run (no printer job):

```bash
curl -s -X POST 'http://127.0.0.1:8080/api/print-ro?dryRun=1' \
  -H 'content-type: application/json' \
  -d '{"event":"create-ro","lastName":"Owner","model":"Macan","roNumber":"J001094"}'
```

Real print (Create-only payload):

```bash
curl -s -X POST 'http://127.0.0.1:8080/api/print-ro' \
  -H 'content-type: application/json' \
  -d '{"event":"create-ro","lastName":"Owner","model":"Macan","roNumber":"J001094"}'
```

Update-shaped `event` values return **400**.

Browser extension install (Manjaro + Windows, Firefox/Chrome/Edge): see [extension/README.md](extension/README.md).

## Manjaro install

```bash
git clone https://github.com/BlackForestPorsche/label-connect.git ~/label-connect
cd ~/label-connect
npm install
bash scripts/install-desktop-entry.sh
```

Open **Labels** from the app menu, or run `scripts/start-labels.sh`.

## Update

```bash
cd ~/label-connect
bash scripts/update-labels.sh
```

Then reopen Labels so the server picks up the new files. Reload the browser extension if `extension/` changed.

## Windows note

Start Labels with Node (`npm start`, port 8080). Printing uses PowerShell **PrintTo** against a printer named `LabelWriter550` or any installed queue matching `LabelWriter|DYMO`. Override with env `LABELS_PRINTER`.
