# Labels (LabelWriter 550)

Desktop label bench for the DYMO LabelWriter 550. Prints to the CUPS queue **LabelWriter550**.

**0.1.2** - Dry-run `POST /api/print-ro` accepts AllData Create RO JSON and returns a label preview (`dryRun: true`, never calls CUPS). Rejects `event` values that look like Update RO. Real auto-print still goes through the existing PNG `POST /api/print` once a bridge renders the preview.

**0.1.1** - Editor shows the CUPS/PPD safe print zone (dashed box) and keeps blocks inside it so edge content is not clipped on the LabelWriter 550 (30252 Address uses the driver ImageableArea, about 1-1.5 mm on the short sides and a larger inset on the feed end).

This public repo is the **release remote** for the shop PC install at `~/label-connect`. App source also lives under `label-connect/` on the private `blackforest-tools` branch `cursor/labelwriter-550-6410` ([PR #3](https://github.com/BlackForestPorsche/blackforest-tools/pull/3)).

## AllData Create RO (dry-run)

```bash
curl -s -X POST http://127.0.0.1:8080/api/print-ro \
  -H 'content-type: application/json' \
  -d '{"roNumber":"J001094","customerName":"Ada Owner","year":"2018","make":"Porsche","model":"Macan","licensePlate":"7NYB225","licenseState":"CA","event":"create-ro"}'
```

Response always includes `"dryRun": true` and `"printed": false`. No label is sent to the LabelWriter from this route.

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

Then reopen Labels so the server picks up the new files.
