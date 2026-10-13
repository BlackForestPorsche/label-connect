/** Page sizes from the DYMO LW5xx PPD (lw550.ppd). Key is the CUPS PageSize value. */

export const QUEUE = "LabelWriter550";

/** Typical LabelWriter edge inset (~1.5 mm) when ImageableArea is unknown. */
export const DEFAULT_SAFE_PT = 4.32;

/**
 * ImageableArea from lw550.ppd: [llx, lly, urx, ury] in PostScript points
 * (origin bottom-left of the page). Content outside this box is clipped by
 * the driver / die-cut.
 */
export const FALLBACK_MEDIA = [
  { key: "w79h252", sku: "30252", name: "30252 Address", widthPt: 79, heightPt: 252, imageable: [4.32, 4.32, 76.08, 235.44] },
  { key: "w79h252.1", sku: "30320", name: "30320 Address", widthPt: 79, heightPt: 252, imageable: [4.32, 4.32, 76.08, 235.44] },
  { key: "w54h144.1", sku: "30330", name: "30330 Return Address", widthPt: 54, heightPt: 144, imageable: [4.08, 4.32, 51.12, 127.68] },
  { key: "w102h252", sku: "30321", name: "30321 Large Address", widthPt: 102, heightPt: 251, imageable: [4.32, 3.84, 98.4, 234.48] },
  { key: "w154h286", sku: "30323", name: "30323 Shipping", widthPt: 154, heightPt: 286, imageable: [4.32, 4.32, 150.24, 270.48] },
  { key: "w167h288", sku: "30256", name: "30256 Large Shipping", widthPt: 167, heightPt: 288, imageable: [4.08, 4.32, 163.68, 271.2] },
  { key: "w57h248", sku: "30327", name: "30327 File Folder", widthPt: 57, heightPt: 248, imageable: [0, 4.32, 53.52, 231.6] },
  { key: "w72h72.1", sku: "30332", name: "30332 1 in x 1 in", widthPt: 72, heightPt: 72, imageable: [4.08, 4.32, 69.12, 64.8] },
  { key: "w162h90.1", sku: "30334", name: "30334 2-1/4 in x 1-1/4 in", widthPt: 162, heightPt: 90, imageable: [2.88, 4.32, 159.12, 85.68] },
  { key: "w72h154.1", sku: "30336", name: "30336 1 in x 2-1/8 in", widthPt: 72, heightPt: 154, imageable: [4.08, 4.32, 69.12, 146.64] },
  { key: "w154h198.1", sku: "30324", name: "30324 Large", widthPt: 154, heightPt: 198, imageable: [2.88, 4.32, 150.24, 182.16] },
  { key: "w167h288.2", sku: "30857", name: "30857 Badge Label", widthPt: 167, heightPt: 288, imageable: [4.08, 4.32, 163.68, 271.2] },
  { key: "w176h292", sku: "30856", name: "30856 Badge Card", widthPt: 176, heightPt: 292, imageable: [0, 4.32, 161.28, 264.72] },
  { key: "w71h144", sku: "30373", name: "30373 Price Tag", widthPt: 71, heightPt: 144, imageable: [0, 85.44, 67.44, 139.68] },
  { key: "w144h252", sku: "30374", name: "30374 Appointment Card", widthPt: 144, heightPt: 252, imageable: [8.64, 4.32, 141.12, 225.12] },
  { key: "w167h539", sku: "99019", name: "99019 Large Lever Arch", widthPt: 167, heightPt: 539, imageable: [4.08, 4.32, 163.68, 522.72] },
  { key: "w102h252.1", sku: "99012", name: "99012 Large Address", widthPt: 102, heightPt: 252, imageable: [4.32, 4.32, 98.4, 234.96] },
];

const PAGE_SIZE = /^\*PageSize\s+(\S+)\/([^:]+):\s*"<<\/PageSize\[([0-9.]+)\s+([0-9.]+)\]/;
const IMAGEABLE = /^\*ImageableArea\s+(\S+)\/[^:]+:\s*"([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)"/;

function normalizeImageable(values) {
  if (!Array.isArray(values) || values.length !== 4) return null;
  const nums = values.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return nums;
}

export function parsePpd(text) {
  const areas = new Map();
  for (const line of text.split(/\r?\n/)) {
    const area = IMAGEABLE.exec(line.trim());
    if (!area) continue;
    areas.set(area[1], [Number(area[2]), Number(area[3]), Number(area[4]), Number(area[5])]);
  }

  const media = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = PAGE_SIZE.exec(line.trim());
    if (!match) continue;
    const key = match[1];
    if (seen.has(key)) continue;
    seen.add(key);
    const name = match[2].trim();
    const sku = /^(\d{4,})/.exec(name)?.[1] ?? "";
    const fallback = FALLBACK_MEDIA.find((item) => item.key === key);
    const imageable = normalizeImageable(areas.get(key)) ?? normalizeImageable(fallback?.imageable);
    media.push({
      key,
      sku,
      name,
      widthPt: Number(match[3]),
      heightPt: Number(match[4]),
      ...(imageable ? { imageable } : {}),
    });
  }
  return media;
}

export function prefersTurn(media) {
  if (!media || media.widthPt <= 0) return false;
  return media.heightPt / media.widthPt >= 2 && media.widthPt <= 110;
}

export function mediaBySku(list, sku) {
  const clean = String(sku ?? "").replace(/\0/g, "").trim();
  if (!clean) return null;
  const exact = list.find((item) => item.sku && (clean === item.sku || clean.includes(item.sku)));
  if (exact) return exact;
  return list.find((item) => item.sku && item.name.startsWith(clean)) ?? null;
}

export function viewSize(media, turned) {
  if (!media) return { widthPt: 252, heightPt: 79 };
  if (turned) return { widthPt: media.heightPt, heightPt: media.widthPt };
  return { widthPt: media.widthPt, heightPt: media.heightPt };
}

/**
 * Printable rectangle in page coordinates (top-left origin, points).
 * Matches CUPS ImageableArea after converting from PostScript bottom-left.
 */
export function pageSafeRect(media) {
  const width = Number(media?.widthPt) || 0;
  const height = Number(media?.heightPt) || 0;
  const imageable = normalizeImageable(media?.imageable);
  if (imageable && width > 0 && height > 0) {
    const [llx, lly, urx, ury] = imageable;
    const x = Math.max(0, llx);
    const y = Math.max(0, height - ury);
    const w = Math.max(1, Math.min(width - x, urx - llx));
    const h = Math.max(1, Math.min(height - y, ury - lly));
    return { x, y, w, h };
  }
  const inset = DEFAULT_SAFE_PT;
  return {
    x: inset,
    y: inset,
    w: Math.max(1, width - inset * 2),
    h: Math.max(1, height - inset * 2),
  };
}

/**
 * Safe rectangle in editor / paint-source coordinates.
 * When the label is turned, matches the CW rotation used by paint().
 */
export function viewSafeRect(media, turned) {
  const page = pageSafeRect(media);
  if (!turned) return page;
  const pageW = Number(media?.widthPt) || 0;
  const corners = [
    [page.x, page.y],
    [page.x + page.w, page.y],
    [page.x, page.y + page.h],
    [page.x + page.w, page.y + page.h],
  ].map(([px, py]) => [py, pageW - px]);
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y) };
}

export function formatInches(media) {
  const w = media.widthPt / 72;
  const h = media.heightPt / 72;
  const n = (value) => (Math.round(value * 100) / 100).toFixed(2).replace(/0$/, "").replace(/\.0$/, "");
  return `${n(w)} × ${n(h)} in`;
}

export function safePageKey(key) {
  return typeof key === "string" && /^[A-Za-z0-9._-]+$/.test(key) ? key : null;
}
