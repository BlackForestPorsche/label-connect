/**
 * AllData Create RO → Labels.
 * Label content is customer last name + vehicle model only.
 * Prints only for create-ro events; rejects update / schedule / assign.
 */

import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { FALLBACK_MEDIA, mediaBySku, pageSafeRect, prefersTurn, viewSafeRect, viewSize } from "./media.mjs";
import { approxTextWidth, fitFontSize } from "./text-fit.mjs";

const MAX_LEN = {
  roNumber: 24,
  lastName: 40,
  model: 32,
  customerName: 48,
};

/** Events that must never auto-print. */
const FORBIDDEN_EVENT = /\b(update|schedule|assign)\b|new[\s_-]*r\/?o/i;

function clean(value, max) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.slice(0, max);
}

/** Last token of a full name; keeps hyphenated surnames intact. */
export function extractLastName(fullName) {
  const text = clean(fullName, MAX_LEN.customerName);
  if (!text) return "";
  const parts = text.split(" ").filter(Boolean);
  return parts.at(-1) || text;
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
    align: "center",
    fit: true,
    src: "",
  };
}

/**
 * Normalize a JSON body from the AllData extension bridge.
 * @returns {{ ok: true, fields: object } | { ok: false, error: string }}
 */
export function normalizeRoPayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Send a JSON object with RO fields." };
  }

  const event = clean(raw.event ?? "create-ro", 40) || "create-ro";
  if (FORBIDDEN_EVENT.test(event)) {
    return { ok: false, error: "Only Create R/O may auto-print. Update / Schedule / Assign are blocked." };
  }
  if (!/^(create-ro|create|create_ro)$/i.test(event)) {
    return { ok: false, error: "Only Create R/O may auto-print. Unknown event was rejected." };
  }

  const customerName = clean(raw.customerName ?? raw.customer ?? raw.name, MAX_LEN.customerName);
  const lastName =
    clean(raw.lastName ?? raw.customerLastName ?? raw.surname, MAX_LEN.lastName) ||
    extractLastName(customerName);
  const model = clean(raw.model ?? raw.vehicleModel ?? raw.carModel, MAX_LEN.model);
  const roNumber = clean(raw.roNumber ?? raw.ro ?? raw.documentNumber, MAX_LEN.roNumber);

  if (!lastName || !model) {
    return { ok: false, error: "Need customer last name and vehicle model." };
  }

  return {
    ok: true,
    fields: {
      roNumber,
      lastName,
      model,
      customerName: customerName || lastName,
      source: clean(raw.source ?? "alldata", 32) || "alldata",
      event: event.toLowerCase().replace(/_/g, "-"),
      dryRun: Boolean(raw.dryRun),
    },
  };
}

/** Two lines for toasts / logs: last name, then model. */
export function roLabelLines(fields) {
  return [fields.lastName, fields.model].filter(Boolean);
}

/**
 * Build a Labels editor-shaped doc on 30252 (turned address roll).
 * Two centered, fit text blocks inside the CUPS ImageableArea.
 */
export function buildRoLabelDoc(fields, mediaList = FALLBACK_MEDIA) {
  const media = mediaBySku(mediaList, "30252") ?? FALLBACK_MEDIA[0];
  const turned = prefersTurn(media);
  const view = viewSize(media, turned);
  const safe = viewSafeRect(media, turned);
  const box = safe.w > 8 && safe.h > 6 ? safe : { x: 0, y: 0, w: view.widthPt, h: view.heightPt };
  const pad = Math.max(2, Math.min(box.w, box.h) * 0.08);
  const x0 = box.x + pad;
  const y0 = box.y + pad;
  const innerW = Math.max(8, box.w - pad * 2);
  const innerH = Math.max(6, box.h - pad * 2);

  const nameH = innerH * 0.55;
  const modelH = innerH * 0.4;
  const blocks = [
    textBlock("lastName", fields.lastName, x0, y0, innerW, nameH, 18, true),
    textBlock("model", fields.model, x0, y0 + nameH + pad * 0.35, innerW, modelH, 14, false),
  ];

  return {
    id: `ro-${fields.roNumber || "draft"}`,
    name: fields.roNumber ? `RO ${fields.roNumber}` : `${fields.lastName} ${fields.model}`,
    mediaKey: media.key,
    turned,
    copies: 1,
    blocks,
  };
}

/**
 * Render last name + model onto a 30252 PDF in page coordinates.
 * Text runs along the long edge (90°) inside the PPD ImageableArea.
 */
export async function renderRoLabelPdf(fields, mediaList = FALLBACK_MEDIA) {
  const media = mediaBySku(mediaList, "30252") ?? FALLBACK_MEDIA[0];
  const safe = pageSafeRect(media);
  const pad = Math.max(2, Math.min(safe.w, safe.h) * 0.06);
  // After 90° rotation, the "line length" is along page height; "stack" is along page width.
  const lineMax = Math.max(8, safe.h - pad * 2);
  const stackInner = Math.max(6, safe.w - pad * 2);
  const nameSlot = stackInner * 0.55;
  const modelSlot = stackInner * 0.4;

  const measure = (text, size) => approxTextWidth(text, size);
  const nameSize = fitFontSize(fields.lastName, lineMax, nameSlot, measure, { min: 8, max: 36 });
  const modelSize = fitFontSize(fields.model, lineMax, modelSlot, measure, { min: 7, max: 28 });

  const doc = await PDFDocument.create();
  const page = doc.addPage([media.widthPt, media.heightPt]);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({
    x: 0,
    y: 0,
    width: media.widthPt,
    height: media.heightPt,
    color: rgb(1, 1, 1),
  });

  const pageH = media.heightPt;
  // Safe rect is top-left origin → PDF bottom-left.
  const safeBottom = pageH - safe.y - safe.h;
  const midY = safeBottom + safe.h / 2;

  function drawRotatedCentered(text, size, bold, xCenter) {
    const font = bold ? fontBold : fontReg;
    const width = font.widthOfTextAtSize(text, size);
    // rotate 90° CCW: text advances in +Y; center that run on midY.
    page.drawText(text, {
      x: xCenter - size * 0.35,
      y: midY - width / 2,
      size,
      font,
      color: rgb(0.08, 0.07, 0.05),
      rotate: degrees(90),
    });
  }

  const nameX = safe.x + pad + nameSlot / 2;
  const modelX = safe.x + pad + nameSlot + pad * 0.5 + modelSlot / 2;
  drawRotatedCentered(fields.lastName, nameSize, true, nameX);
  drawRotatedCentered(fields.model, modelSize, false, modelX);

  return {
    pdf: Buffer.from(await doc.save()),
    media,
    nameSize,
    modelSize,
  };
}

/** Plan-only (no print). Used by unit tests and dryRun responses. */
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
    skipped: false,
    message: "Dry run — no label was sent to the printer.",
    fields,
    lines,
    doc,
  };
}
