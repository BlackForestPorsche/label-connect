# Black Forest Desk (browser extension)

One install for the shop desk: **AllData Create R/O → Labels** plus **SSF checkout On-the-Lot last names**.

## Install

Prefer the signed Hub pack (Firefox) or Chromium load-unpacked. See shop docs.

## AllData — what gets scraped

| Field | Source |
| --- | --- |
| Last name | “Last Name” / “Customer” field; last name only (strips `J.` / `LAST, F` / glued `LWhatcott` → `Whatcott` — never first initial on the label). Never VIN, license plate, or account #. |
| Model | “Model” field; else Year/Make/Model line; else known Porsche model token on screen. Never VIN / `VIN:`, license plate, or account #. |
| RO number | Optional; AllData repair-order id for server idempotency only — **not printed** on the label |

**Printed label (Create only):**

```
Whatcott - Boxster
Out Mileage _____________
```

Line 2 is a handwriting blank (not mileage from AllData). Every **Create R/O** success prints, even when that customer already has an open RO or you Create again for the same tester person. Dedupe is per Create click / new RO id — never by customer. Pre-existing Update / old RO# is not treated as success and is not sent to Labels (that was causing “already printed this RO”). Update / Schedule New / Assign never print.

If Create UI succeeds but last name or model still cannot be scraped after the wait window, the extension toasts **Label skipped — could not read last name or model.** and does not call Labels (`/api/print-ro`). It keeps polling after UI confirm (does not abort on the first empty scrape). Plate / account / VIN filters stay fail-closed.
