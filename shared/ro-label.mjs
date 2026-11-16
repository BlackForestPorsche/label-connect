/**
 * AllData Create RO → Labels: last name + model on 30252.
 * Rejects Update / Schedule / Assign. Real print is owned by the server route.
 *
 * Label layout (Create RO only):
 *   Whatcott - Boxster
 *   Out Mileage _____________
 *
 * Never license plate, account #, VIN, or first initial.
 */

import { PDFDocument, PDFName, PDFString, StandardFonts, degrees, rgb } from "pdf-lib";
import QRCode from "qrcode";
import { FALLBACK_MEDIA, mediaBySku, pageSafeRect, prefersTurn, viewSafeRect, viewSize } from "./media.mjs";
import { approxTextWidth, fitTextLayout } from "./text-fit.mjs";

const MAX_LEN = {
  roNumber: 24,
  lastName: 40,
  model: 32,
  customerName: 48,
};

/** Handwriting blank on line 2 — never filled from AllData. */
export const OUT_MILEAGE_LINE = "Out Mileage _____________";

/** Existing shop lot board. There is no per-car route; the RO rides in the query. */
export const LOT_BOARD_URL = "https://shop.blackforestautomotive.com/lot";

export function lotCardUrl(roNumber) {
  const ro = clean(roNumber, MAX_LEN.roNumber);
  if (!ro) return LOT_BOARD_URL;
  return `${LOT_BOARD_URL}?ro=${encodeURIComponent(ro)}`;
}

/** Accept only the existing /lot board, with an optional ro query. */
export function sanitizeLotUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    return "";
  }
  if (url.origin !== "https://shop.blackforestautomotive.com") return "";
  if (url.pathname !== "/lot") return "";
  const keys = [...url.searchParams.keys()];
  if (keys.length > 1 || (keys.length === 1 && keys[0] !== "ro")) return "";
  const ro = url.searchParams.get("ro");
  if (ro == null || ro === "") return LOT_BOARD_URL;
  if (!/^[A-Za-z0-9-]{1,24}$/.test(ro)) return "";
  return lotCardUrl(ro);
}

/**
 * Extra inset (pt) inside ImageableArea for Create RO PDFs.
 * Bare PPD safe rect still clipped the top line on LabelWriter 550 — pad further.
 */
export const RO_LABEL_SAFE_INSET_PT = 8;

const FORBIDDEN_EVENT_RE = /update|schedule|assign|new[\s_-]*r\/?o/i;

const PORSCHE_MODELS = [
  "911",
  "718",
  "Boxster",
  "Cayman",
  "Cayenne",
  "Macan",
  "Panamera",
  "Taycan",
  "Carrera",
  "Targa",
  "Turbo",
  "GT3",
  "GT4",
  "GTS",
];

function clean(value, max) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.slice(0, max);
}

/** True for VIN labels / VIN numbers — never print these as name or model. */
export function isVinNoise(value) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  if (/^vin:?$/i.test(text)) return true;
  if (/^vin\s*:/i.test(text)) return true;
  const compact = text.replace(/[\s-]/g, "");
  // ISO-style VIN: 17 chars, no I/O/Q.
  if (/^[A-HJ-NPR-Z0-9]{17}$/i.test(compact)) return true;
  return false;
}

const STATE_CODES = new Set(
  (
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC " +
    "ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR VI GU AS MP " +
    "AB BC MB NB NL NS NT NU ON PE QC SK YT"
  ).split(" "),
);

/** A 1–2 letter token (state/region code like CA, or a stray trim letter) is never a model. */
export function isStateOrRegionNoise(value) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
  if (!text) return false;
  if (STATE_CODES.has(text.toUpperCase())) return true;
  return /^[A-Za-z]{1,2}$/.test(text);
}

function isKnownPorscheModel(value) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  return PORSCHE_MODELS.some((model) => new RegExp(`^${model}$`, "i").test(text));
}

function digitTokensAreModelCodes(text) {
  const digitTokens = text.split(/[\s,]+/).filter((t) => /\d/.test(t) && !/^(?:19|20)\d{2}$/.test(t));
  return digitTokens.length > 0 && digitTokens.every((t) => isNumericModel(t) || isModelCode(t));
}

/**
 * License plate / account # values — never print as lastName or model.
 * Same heuristic as the Desk scrape (0.1.17+).
 */
export function isPlateOrAccountNoise(value) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  if (/^\s*(license\s*plate|account\s*#?|acct\.?\s*#?)\s*:?\s*$/i.test(text)) return true;
  if (/^(license\s*plate|account\s*#?|acct\.?\s*#?)\b/i.test(text)) return true;
  if (isKnownPorscheModel(text)) return false;
  // GLC300 / RX350 / M340i are real model codes that look like a short plate.
  if (!/\s/.test(text) && /^[A-Za-z]/.test(text) && isModelCode(text)) return false;
  if (/\s/.test(text) && /^[A-Za-z]/.test(text) && digitTokensAreModelCodes(text)) return false;
  if (/^[A-Z]?[a-z]{2,}\s+(?:\d{1,3}|[1-4]500)$/.test(text)) return false;
  const compact = text.replace(/[\s-]/g, "");
  if (/^[A-Z]?\d{4,}$/i.test(compact)) return true;
  if (/^(?=.*\d)[A-Z0-9]{5,8}$/i.test(compact)) return true;
  return false;
}

/**
 * Customer last name only — never first name or first initial.
 * Handles "LAST, FIRST", "J. LAST", "J LAST", "J.LAST", "FIRST LAST",
 * and glued shop codes like "LWhatcott" → "Whatcott".
 * Same heuristic as the extension scrape.
 */
export function extractLastName(fullName) {
  let text = clean(fullName, MAX_LEN.customerName);
  if (!text) return "";
  if (isVinNoise(text) || isPlateOrAccountNoise(text)) return "";
  // "LAST, FIRST" / "LAST, F." → LAST
  if (text.includes(",")) {
    text = text.split(",")[0].trim();
  }
  // Leading first initial: "J. Smith", "J Smith", "J.Smith"
  text = text.replace(/^[A-Za-z]\.?\s+/, "").replace(/^[A-Za-z]\.(?=[A-Za-z])/, "");
  // Glued initial + PascalCase last: "LWhatcott" → "Whatcott" (not "McDonald")
  if (/^[A-Z][A-Z][a-z]/.test(text) && !/\s/.test(text)) {
    text = text.slice(1);
  }
  const parts = text.split(" ").filter(Boolean);
  if (!parts.length) return "";
  // Drop a trailing bare initial if anything remains ("Smith J" → "Smith").
  if (parts.length > 1 && /^[A-Za-z]\.?$/.test(parts[parts.length - 1])) {
    parts.pop();
  }
  const last = parts[parts.length - 1] || "";
  if (isVinNoise(last) || isPlateOrAccountNoise(last) || /^vin:?$/i.test(last)) return "";
  if (/\d/.test(last)) return "";
  return last;
}

const NUMERIC_MODELS = new Set(
  "356 718 911 912 914 924 928 930 944 959 964 968 981 982 986 987 991 992 996 997".split(" "),
);

function isNumericModel(token) {
  return NUMERIC_MODELS.has(token);
}

/** M3, X5, Q50, RX350, F-150, CX-5 (letters then digits) or 328i, 530xi (digits then letters). */
function isModelCode(token) {
  return (
    /^[A-Za-z]{1,3}-?\d{1,3}[A-Za-z]{0,2}$/.test(token) ||
    /^[A-Za-z]{1,3}\d{1,2}[A-Za-z]{1,2}\d{0,2}[A-Za-z]{0,2}$/.test(token) ||
    /^\d{3}[A-Za-z]{1,2}$/.test(token)
  );
}

const OTHER_MAKE_RE =
  /\b(audi|bmw|mercedes(?:-benz)?|mini|volkswagen|vw|volvo|jaguar|land[\s-]*rover|ford|chevrolet|chevy|dodge|jeep|chrysler|ram|gmc|cadillac|buick|lincoln|toyota|lexus|honda|acura|nissan|infiniti|mazda|subaru|mitsubishi|hyundai|kia|genesis|tesla|fiat|alfa[\s-]*romeo|maserati|ferrari|lamborghini|bentley|aston[\s-]*martin|mclaren|lotus|saab|suzuki|scion|pontiac|saturn|isuzu)\b/i;

/** A bare number that can follow a model word: "Silverado 1500", "Model 3". */
function isModelNumberSuffix(prevToken, token) {
  return Boolean(prevToken && /^(?:\d{1,3}|[1-4]500)$/.test(token) && /^[A-Z]?[a-z]{2,}$/.test(prevToken));
}

/** Drop VIN / plate / account / empty junk; keep a short vehicle model token. */
export function cleanModel(value) {
  let model = clean(value, MAX_LEN.model);
  if (!model) return "";
  if (isVinNoise(model) || isPlateOrAccountNoise(model)) return "";
  if (/^vin:?$/i.test(model)) return "";
  // Strip a leading "VIN:" if a scraper glued it onto the model field.
  model = model.replace(/^vin\s*:\s*/i, "").trim();
  if (!model || isVinNoise(model) || isPlateOrAccountNoise(model)) return "";
  const tesla = /(?:^|\s)model\s+([3SXY])(?=\s|$)/i.exec(model);
  if (tesla) return `Model ${tesla[1].toUpperCase()}`;
  // Prefer a known Porsche model token when the scraper's string is messy (not for other makes).
  if (!OTHER_MAKE_RE.test(model)) {
    for (const known of PORSCHE_MODELS) {
      if (new RegExp(`\\b${known}\\b`, "i").test(model)) return known;
    }
  }
  // Drop standalone state/region codes ("Camry CA" → "Camry"; "CA" → "").
  model = model
    .split(/[\s,]+/)
    .filter((token) => token && !isStateOrRegionNoise(token) && !/^(?:19|20)\d{2}$/.test(token))
    .join(" ");
  if (!model) return "";
  // Bare numbers and plate-shaped codes ("123", "7ABC 123") are never a model. Real codes: M3, X5, 328i, 944.
  const tokens = model.split(/\s+/).filter(Boolean);
  const plateShaped = tokens.some(
    (token, i) =>
      /\d/.test(token) &&
      !isKnownPorscheModel(token) &&
      !isNumericModel(token) &&
      !isModelCode(token) &&
      !isModelNumberSuffix(tokens[i - 1], token),
  );
  if (plateShaped) return "";
  return model.slice(0, MAX_LEN.model);
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

  // Always run through extractLastName so "J. Owner" / "LWhatcott" never print an initial.
  let lastName = extractLastName(raw.lastName ?? raw.last_name);
  const customerName = clean(raw.customerName ?? raw.customer ?? raw.name, MAX_LEN.customerName);
  if (!lastName && customerName && !isVinNoise(customerName)) {
    lastName = extractLastName(customerName);
  }
  lastName = clean(lastName, MAX_LEN.lastName);
  if (isVinNoise(lastName) || isPlateOrAccountNoise(lastName)) lastName = "";

  const model = cleanModel(raw.model);
  const roNumber = clean(raw.roNumber ?? raw.ro ?? raw.documentNumber, MAX_LEN.roNumber);
  const lotUrl = sanitizeLotUrl(raw.lotUrl) || lotCardUrl(roNumber);
  // Per-Create click id from the Desk extension — never used as a customer/person key.
  const createArmId = clean(raw.createArmId ?? raw.create_arm_id ?? raw.createId, 64);
  const source = clean(raw.source ?? "alldata", 32) || "alldata";
  const dryRun = Boolean(raw.dryRun === true || raw.dryRun === "1" || raw.dryRun === 1);

  // Every Create R/O prints: a missing/unsafe model prints blank ("{LastName} - ").
  if (!lastName) {
    return { ok: false, error: "Need lastName." };
  }

  return {
    ok: true,
    fields: {
      roNumber,
      lotUrl,
      lastName,
      model,
      customerName,
      createArmId,
      source,
      event: "create-ro",
      dryRun,
    },
  };
}

/**
 * Label content — exactly two lines:
 *   {LastName} - {Model}
 *   Out Mileage _____________
 * Never VIN, RO#, mileage value, or first initial.
 */
export function roLabelLines(fields) {
  const lastName = String(fields.lastName || "").trim();
  const model = String(fields.model || "").trim();
  if (!lastName) return [];
  return [`${lastName} - ${model}`, OUT_MILEAGE_LINE];
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
function layoutRoLabel(fields, mediaList = FALLBACK_MEDIA) {
  const media = mediaBySku(mediaList, "30252") ?? FALLBACK_MEDIA[0];
  const turned = prefersTurn(media);
  const view = viewSize(media, turned);
  const safe = viewSafeRect(media, turned);
  const outer = safe.w > 8 && safe.h > 6 ? safe : { x: 0, y: 0, w: view.widthPt, h: view.heightPt };
  const pad = Math.max(RO_LABEL_SAFE_INSET_PT, Math.min(outer.w, outer.h) * 0.1);
  const box = {
    x: outer.x + pad,
    y: outer.y + pad,
    w: Math.max(8, outer.w - pad * 2),
    h: Math.max(6, outer.h - pad * 2),
  };
  const gap = 4;
  const minText = Math.min(box.w * 0.55, 140);
  let qr = Math.min(box.h, box.w - minText - gap);
  if (qr < 24) qr = Math.min(box.h, Math.max(24, box.w * 0.28));
  const qrBox = {
    x: box.x + box.w - qr,
    y: box.y + Math.max(0, (box.h - qr) / 2),
    w: qr,
    h: qr,
  };
  const textW = Math.max(8, qrBox.x - gap - box.x);
  const lines = roLabelLines(fields);
  const rowH = box.h / Math.max(lines.length, 1);
  const url = fields.lotUrl || lotCardUrl(fields.roNumber);
  return { media, turned, box, qrBox, textW, rowH, lines, url };
}

export function buildRoLabelDoc(fields, mediaList = FALLBACK_MEDIA) {
  const layout = layoutRoLabel(fields, mediaList);
  const blocks = layout.lines.map((text, index) =>
    textBlock(
      `line${index}`,
      text,
      layout.box.x,
      layout.box.y + layout.rowH * index,
      layout.textW,
      Math.max(10, layout.rowH * 0.92),
      index === 0 ? 16 : 12,
      index === 0,
    ),
  );

  return {
    id: `ro-${fields.roNumber || "draft"}`,
    name: fields.roNumber ? `RO ${fields.roNumber}` : "RO label",
    mediaKey: layout.media.key,
    turned: layout.turned,
    copies: 1,
    blocks,
    qr: { url: layout.url, ...layout.qrBox },
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
async function drawLotQr(doc, page, media, qrBox, url) {
  try {
    const px = Math.max(96, Math.round(qrBox.w * 4));
    const png = await QRCode.toBuffer(url, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: px,
      color: { dark: "#000000", light: "#ffffff" },
    });
    const image = await doc.embedPng(png);
    // Same 90° turn as the type: image-up follows the label's reading direction.
    page.drawImage(image, {
      x: media.widthPt - qrBox.y,
      y: qrBox.x,
      width: qrBox.w,
      height: qrBox.h,
      rotate: degrees(90),
    });
    const llx = media.widthPt - (qrBox.y + qrBox.h);
    const lly = qrBox.x;
    const urx = media.widthPt - qrBox.y;
    const ury = qrBox.x + qrBox.w;
    const link = doc.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [llx, lly, urx, ury],
      Border: [0, 0, 0],
      A: {
        Type: "Action",
        S: "URI",
        URI: PDFString.of(url),
      },
    });
    const annots = page.node.lookup(PDFName.of("Annots"));
    if (annots) annots.push(link);
    else page.node.set(PDFName.of("Annots"), doc.context.obj([link]));
  } catch {
    // A QR failure must not stop the two text lines.
  }
}

export async function renderRoLabelPdf(fields, mediaList = FALLBACK_MEDIA) {
  const layout = layoutRoLabel(fields, mediaList);
  const { media, lines, qrBox, textW, rowH, url, box } = layout;
  if (lines.length < 2) {
    throw new Error("Need lastName to render.");
  }

  const pageSafe = pageSafeRect(media);

  const doc = await PDFDocument.create();
  const page = doc.addPage([media.widthPt, media.heightPt]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Layout in turned view space (matches buildRoLabelDoc), then map each
  // baseline into page space. Editor CW: view(x,y) = (pageY, pageW - pageX).
  // Inverse: page(x,y) = (pageW - viewY, viewX).
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    const face = i === 0 ? fontBold : font;
    const row = { x: box.x, y: box.y + rowH * i, w: textW, h: rowH };
    const measure = (t, size) => {
      try {
        return face.widthOfTextAtSize(String(t ?? ""), size);
      } catch {
        return approxTextWidth(t, size);
      }
    };
    const layout = fitTextLayout(text, row.w, row.h, measure, { min: 7, max: i === 0 ? 22 : 14 });
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

  await drawLotQr(doc, page, media, qrBox, url);

  const pdf = await doc.save({ useObjectStreams: false });
  return { pdf: Buffer.from(pdf), media };
}
