/**
 * AllData Create RO → Labels: last name + model on 30252.
 * Rejects Update / Schedule / Assign. Real print is owned by the server route.
 */

import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { FALLBACK_MEDIA, mediaBySku, pageSafeRect, prefersTurn, viewSafeRect, viewSize } from "./media.mjs";
import { approxTextWidth, fitTextLayout } from "./text-fit.mjs";

const MAX_LEN = {
  roNumber: 24,
  lastName: 40,
  model: 32,
  customerName: 48,
};

const FORBIDDEN_EVENT_RE = /update|schedule|assign|new[\s_-]*r\/?o/i;

function clean(value, max) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.slice(0, max);
}

/**
 * Customer last name only — never first name or first initial.
 * Handles "LAST, FIRST", "J. LAST", "J LAST", "J.LAST", and "FIRST LAST".
 * Same heuristic as the extension scrape.
 */
export function extractLastName(fullName) {
  let text = clean(fullName, MAX_LEN.customerName);
  if (!text) return "";
  // "LAST, FIRST" / "LAST, F." → LAST
  if (text.includes(",")) {
    text = text.split(",")[0].trim();
  }
  // Leading first initial: "J. Smith", "J Smith", "J.Smith"
  text = text.replace(/^[A-Za-z]\.?\s+/, "").replace(/^[A-Za-z]\.(?=[A-Za-z])/, "");
  const parts = text.split(" ").filter(Boolean);
  if (!parts.length) return "";
  // Drop a trailing bare initial if anything remains ("Smith J" → "Smith").
  if (parts.length > 1 && /^[A-Za-z]\.?$/.test(parts[parts.length - 1])) {
    parts.pop();
  }
  return parts[parts.length - 1] || "";
}

/**
 * Normalize a JSON body from the AllData extension / bridge.
 * @returns {{ ok: true, fields: object } | { ok: false, error: string }}
 */
export function normalizeRoPayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Send a JSON object with lastName and model." };
  }

  const event = clean(raw.event ?? "create-ro", 40) || "create-ro";
  if (FORBIDDEN_EVENT_RE.test(event)) {
    return { ok: false, error: "Only Create R/O may auto-print. Update, Schedule, Assign, and New R/O are blocked." };
  }
  if (event && !/^(create(-?r\/?o)?|create)$/i.test(event)) {
    return { ok: false, error: "Only Create R/O may auto-print. Unknown event was rejected." };
  }

  // Always run through extractLastName so "J. Owner" / "Owner, J" never print an initial.
  let lastName = extractLastName(raw.lastName ?? raw.last_name);
  const customerName = clean(raw.customerName ?? raw.customer ?? raw.name, MAX_LEN.customerName);
  if (!lastName && customerName) lastName = extractLastName(customerName);
  lastName = clean(lastName, MAX_LEN.lastName);

  const model = clean(raw.model, MAX_LEN.model);
  const roNumber = clean(raw.roNumber ?? raw.ro ?? raw.documentNumber, MAX_LEN.roNumber);
  const source = clean(raw.source ?? "alldata", 32) || "alldata";
  const dryRun = Boolean(raw.dryRun === true || raw.dryRun === "1" || raw.dryRun === 1);

  if (!lastName || !model) {
    return { ok: false, error: "Need lastName and model." };
  }

  return {
    ok: true,
    fields: {
      roNumber,
      lastName,
      model,
      customerName,
      source,
      event: "create-ro",
      dryRun,
    },
  };
}

/** Label content: last name, then model — nothing else. */
export function roLabelLines(fields) {
  return [String(fields.lastName || "").trim(), String(fields.model || "").trim()].filter(Boolean);
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
 * Labels editor-shaped doc preview on the address roll (30252).
 * Coordinates use the turned editor view + ImageableArea-safe rect.
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
  const rowH = innerH / Math.max(lines.length, 1);
  const blocks = lines.map((text, index) =>
    textBlock(
      `line${index}`,
      text,
      x0,
      y0 + rowH * index,
      innerW,
      Math.max(10, rowH * 0.92),
      index === 0 ? 18 : 14,
      index === 0,
    ),
  );

  return {
    id: `ro-${fields.roNumber || "draft"}`,
    name: fields.roNumber ? `RO ${fields.roNumber}` : "RO label",
    mediaKey: media.key,
    turned,
    copies: 1,
    blocks,
  };
}

/**
 * Plan / preview for POST /api/print-ro.
 * dryRun comes from query or body; this helper never talks to the printer.
 */
export function planRoPrint(raw, mediaList = FALLBACK_MEDIA) {
  const normalized = normalizeRoPayload(raw);
  if (!normalized.ok) return normalized;

  const { fields } = normalized;
  const lines = roLabelLines(fields);
  const doc = buildRoLabelDoc(fields, mediaList);
  const dryRun = Boolean(fields.dryRun);

  return {
    ok: true,
    dryRun,
    printed: false,
    message: dryRun ? "Dry run only — no label was sent to the printer." : "Ready to print.",
    fields,
    lines,
    doc,
  };
}

/**
 * Render a one-page 30252 PDF. Text is laid out in the turned editor view
 * (wide × short), then drawn onto the physical page with a 90° rotation so it
 * reads along the long edge inside the PPD ImageableArea.
 */
export async function renderRoLabelPdf(fields, mediaList = FALLBACK_MEDIA) {
  const media = mediaBySku(mediaList, "30252") ?? FALLBACK_MEDIA[0];
  const lines = roLabelLines(fields);
  if (lines.length < 2) {
    throw new Error("Need lastName and model to render.");
  }

  const viewSafe = viewSafeRect(media, true);
  const pageSafe = pageSafeRect(media);

  const doc = await PDFDocument.create();
  const page = doc.addPage([media.widthPt, media.heightPt]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Layout in turned view space (matches buildRoLabelDoc), then map each
  // baseline into page space. Editor CW: view(x,y) = (pageY, pageW - pageX).
  // Inverse: page(x,y) = (pageW - viewY, viewX).
  const box = viewSafe.w > 8 && viewSafe.h > 6 ? viewSafe : { x: 0, y: 0, w: media.heightPt, h: media.widthPt };
  const rowH = box.h / lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    const face = i === 0 ? fontBold : font;
    const row = { x: box.x, y: box.y + rowH * i, w: box.w, h: rowH };
    const measure = (t, size) => {
      try {
        return face.widthOfTextAtSize(String(t ?? ""), size);
      } catch {
        return approxTextWidth(t, size);
      }
    };
    const layout = fitTextLayout(text, row.w, row.h, measure, { min: 8, max: i === 0 ? 28 : 22 });
    layout.lines.forEach((line, lineIndex) => {
      const textW = measure(line, layout.size);
      const vx = row.x + (row.w - textW) / 2;
      const vyTop = row.y + layout.startY + lineIndex * layout.lineHeight;
      // Baseline in view coords (y grows downward in editor; PDF y grows up).
      // Convert editor-top-left view point to PDF page bottom-left via the
      // same CW turn the Labels paint() uses, then rotate glyphs +90°.
      const viewBaselineY = vyTop + layout.size * 0.8;
      const pageX = media.widthPt - viewBaselineY;
      const pageY = vx;
      // Clamp lightly into page safe zone so ImageableArea is respected.
      const x = Math.min(Math.max(pageX, pageSafe.x), pageSafe.x + pageSafe.w);
      const y = Math.min(Math.max(pageY, pageSafe.y), pageSafe.y + pageSafe.h - 1);
      page.drawText(line, {
        x,
        y,
        size: layout.size,
        font: face,
        color: rgb(0, 0, 0),
        rotate: degrees(90),
      });
    });
  }

  const pdf = await doc.save();
  return { pdf: Buffer.from(pdf), media };
}
