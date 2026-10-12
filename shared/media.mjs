/** Page sizes from the DYMO LW5xx PPD (lw550.ppd). Key is the CUPS PageSize value. */

export const QUEUE = "LabelWriter550";

export const FALLBACK_MEDIA = [
  { key: "w79h252", sku: "30252", name: "30252 Address", widthPt: 79, heightPt: 252 },
  { key: "w79h252.1", sku: "30320", name: "30320 Address", widthPt: 79, heightPt: 252 },
  { key: "w54h144.1", sku: "30330", name: "30330 Return Address", widthPt: 54, heightPt: 144 },
  { key: "w102h252", sku: "30321", name: "30321 Large Address", widthPt: 102, heightPt: 251 },
  { key: "w154h286", sku: "30323", name: "30323 Shipping", widthPt: 154, heightPt: 286 },
  { key: "w167h288", sku: "30256", name: "30256 Large Shipping", widthPt: 167, heightPt: 288 },
  { key: "w57h248", sku: "30327", name: "30327 File Folder", widthPt: 57, heightPt: 248 },
  { key: "w72h72.1", sku: "30332", name: "30332 1 in x 1 in", widthPt: 72, heightPt: 72 },
  { key: "w162h90.1", sku: "30334", name: "30334 2-1/4 in x 1-1/4 in", widthPt: 162, heightPt: 90 },
  { key: "w72h154.1", sku: "30336", name: "30336 1 in x 2-1/8 in", widthPt: 72, heightPt: 154 },
  { key: "w154h198.1", sku: "30324", name: "30324 Large", widthPt: 154, heightPt: 198 },
  { key: "w167h288.2", sku: "30857", name: "30857 Badge Label", widthPt: 167, heightPt: 288 },
  { key: "w176h292", sku: "30856", name: "30856 Badge Card", widthPt: 176, heightPt: 292 },
  { key: "w71h144", sku: "30373", name: "30373 Price Tag", widthPt: 71, heightPt: 144 },
  { key: "w144h252", sku: "30374", name: "30374 Appointment Card", widthPt: 144, heightPt: 252 },
  { key: "w167h539", sku: "99019", name: "99019 Large Lever Arch", widthPt: 167, heightPt: 539 },
  { key: "w102h252.1", sku: "99012", name: "99012 Large Address", widthPt: 102, heightPt: 252 },
];

const PAGE_SIZE = /^\*PageSize\s+(\S+)\/([^:]+):\s*"<<\/PageSize\[([0-9.]+)\s+([0-9.]+)\]/;

export function parsePpd(text) {
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
    media.push({
      key,
      sku,
      name,
      widthPt: Number(match[3]),
      heightPt: Number(match[4]),
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

export function formatInches(media) {
  const w = media.widthPt / 72;
  const h = media.heightPt / 72;
  const n = (value) => (Math.round(value * 100) / 100).toFixed(2).replace(/0$/, "").replace(/\.0$/, "");
  return `${n(w)} × ${n(h)} in`;
}

export function safePageKey(key) {
  return typeof key === "string" && /^[A-Za-z0-9._-]+$/.test(key) ? key : null;
}
