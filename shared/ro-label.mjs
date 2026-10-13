/**
 * Dry-run RO label payload for AllData Create RO -> Labels.
 * Never sends jobs to CUPS; callers must use POST /api/print with a PNG later.
 */

import { FALLBACK_MEDIA, mediaBySku, prefersTurn, viewSafeRect, viewSize } from "./media.mjs";

const MAX_LEN = {
  roNumber: 24,
  customerName: 48,
  year: 8,
  make: 24,
  model: 32,
  licensePlate: 16,
  licenseState: 4,
  keyTag: 16,
  vinLast8: 8,
};

function clean(value, max) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.slice(0, max);
}

function textBlock(id, text, x, y, w, h, size, bold) {
  return {
    id,
    kind: "text",
    x,
    y,
    w,
    h,
    text,
    size,
    bold,
    align: "left",
    fit: true,
    src: "",
  };
}

/**
 * Normalize a JSON body from an AllData bridge / extension.
 * @returns {{ ok: true, fields: object } | { ok: false, error: string }}
 */
export function normalizeRoPayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Send a JSON object with RO fields." };
  }

  const fields = {
    roNumber: clean(raw.roNumber ?? raw.ro ?? raw.documentNumber, MAX_LEN.roNumber),
    customerName: clean(raw.customerName ?? raw.customer ?? raw.name, MAX_LEN.customerName),
    year: clean(raw.year, MAX_LEN.year),
    make: clean(raw.make, MAX_LEN.make),
    model: clean(raw.model, MAX_LEN.model),
    licensePlate: clean(raw.licensePlate ?? raw.plate ?? raw.license, MAX_LEN.licensePlate),
    licenseState: clean(raw.licenseState ?? raw.state, MAX_LEN.licenseState).toUpperCase(),
    keyTag: clean(raw.keyTag ?? raw.vehicleTag ?? raw.tag, MAX_LEN.keyTag),
    vinLast8: clean(raw.vinLast8 ?? (typeof raw.vin === "string" ? raw.vin.slice(-8) : ""), MAX_LEN.vinLast8),
    source: clean(raw.source ?? "alldata", 32) || "alldata",
    event: clean(raw.event ?? "create-ro", 32) || "create-ro",
  };

  if (fields.event && /update/i.test(fields.event)) {
    return { ok: false, error: "Update RO is not allowed for auto-print." };
  }

  if (!fields.roNumber && !fields.customerName && !fields.licensePlate) {
    return { ok: false, error: "Need at least an RO number, customer name, or plate." };
  }

  return { ok: true, fields };
}

export function vehicleLine(fields) {
  return [fields.year, fields.make, fields.model].filter(Boolean).join(" ").trim();
}

export function plateLine(fields) {
  if (!fields.licensePlate) return "";
  if (fields.licenseState) return `${fields.licenseState} ${fields.licensePlate}`;
  return fields.licensePlate;
}

/** Human-readable lines for toasts / logs (no PII beyond the label itself). */
export function roLabelLines(fields) {
  const lines = [];
  if (fields.roNumber) lines.push(`RO ${fields.roNumber}`);
  if (fields.customerName) lines.push(fields.customerName);
  const vehicle = vehicleLine(fields);
  if (vehicle) lines.push(vehicle);
  const plate = plateLine(fields);
  if (plate) lines.push(plate);
  if (fields.keyTag) lines.push(`Tag ${fields.keyTag}`);
  if (fields.vinLast8 && lines.length < 5) lines.push(`VIN ...${fields.vinLast8}`);
  return lines.slice(0, 5);
}

/**
 * Build a Labels editor-shaped doc preview on the address roll (30252).
 * Coordinates match the editor's safe ImageableArea layout; not printed here.
 */
export function buildRoLabelDoc(fields, mediaList = FALLBACK_MEDIA) {
  const media = mediaBySku(mediaList, "30252") ?? FALLBACK_MEDIA[0];
  const turned = prefersTurn(media);
  const view = viewSize(media, turned);
  const safe = viewSafeRect(media, turned);
  const box = safe.w > 8 && safe.h > 6 ? safe : { x: 0, y: 0, w: view.widthPt, h: view.heightPt };
  const pad = Math.max(2, Math.min(box.w, box.h) * 0.06);
  const x0 = box.x + pad;
  const y0 = box.y + pad;
  const innerW = Math.max(8, box.w - pad * 2);
  const innerH = Math.max(6, box.h - pad * 2);

  const lines = roLabelLines(fields);
  const blocks = [];
  const rowH = innerH / Math.max(lines.length, 1);
  lines.forEach((text, index) => {
    const size = index === 0 ? 13 : 9;
    const bold = index === 0;
    blocks.push(
      textBlock(
        `line${index}`,
        text,
        x0,
        y0 + rowH * index,
        innerW,
        Math.max(10, rowH * 0.92),
        size,
        bold,
      ),
    );
  });

  return {
    id: `ro-${fields.roNumber || "draft"}`,
    name: fields.roNumber ? `RO ${fields.roNumber}` : "RO label",
    mediaKey: media.key,
    turned,
    copies: 1,
    blocks,
    dryRun: true,
  };
}

/**
 * Full dry-run response for POST /api/print-ro.
 * Always dryRun: true - this stub does not print.
 */
export function planRoPrint(raw, mediaList = FALLBACK_MEDIA) {
  const normalized = normalizeRoPayload(raw);
  if (!normalized.ok) return normalized;

  const { fields } = normalized;
  const lines = roLabelLines(fields);
  const doc = buildRoLabelDoc(fields, mediaList);

  return {
    ok: true,
    dryRun: true,
    printed: false,
    message: "Dry run only - no label was sent to the printer.",
    fields,
    lines,
    doc,
  };
}
