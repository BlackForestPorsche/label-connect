# Labels (LabelWriter 550)

Desktop label bench for the DYMO LabelWriter 550. Prints to the CUPS queue **LabelWriter550** on Linux, or the Windows LabelWriter/DYMO printer via PrintTo.

**0.1.6** - Black Forest Desk: map shop `unauthorized` to clear **desk PIN** unlock copy; lowercase person like the Plasma widget; host permissions include `127.0.0.1:8080`; SSF empty state points at the popup PIN. Keeps Firefox `strict_min_version` 140.0 + `data_collection_permissions`.

**0.1.5** - Firefox `strict_min_version` 140.0 (required for `data_collection_permissions`).

This public repo is the **release remote** for the shop PC install at `~/label-connect`. App source also lives under `label-connect/` on the private `blackforest-tools` branch `cursor/labelwriter-550-6410` ([PR #3](https://github.com/BlackForestPorsche/blackforest-tools/pull/3)).

## AllData Create RO → print

Hard rules:

- **Only Create R/O** prints. Never Update R/O, Schedule New R/O, or Assign R/O.
- Label lines: **last name** + **model** (e.g. `Owner` / `Macan`).
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
