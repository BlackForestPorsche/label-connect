const BAY = {
  0: "Roll not read yet",
  1: "Cover open",
  2: "No roll",
  3: "Roll not seated",
  4: "Reading the roll",
  5: "Roll empty",
  6: "Roll almost out",
  7: "Roll low",
  8: "Roll in",
  9: "Label jam",
  10: "Not a genuine DYMO roll",
};

export function bayLabel(code) {
  return BAY[code] ?? "Roll status unknown";
}

/** 32-byte LabelWriter 550 status reply (ESC A). */
export function parseStatus(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 32) return null;
  const sku = buf.subarray(11, 23).toString("ascii").replace(/\0/g, "").trim();
  return {
    head: buf[0],
    sku,
    bay: buf[10],
    bayLabel: bayLabel(buf[10]),
    remaining: buf.readUInt16LE(27),
    errorId: buf.readUInt32LE(23),
    density: buf[9],
  };
}

/** ESC U NFC dump. Length fields are tenths of a millimetre. */
export function parseSkuDump(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 44) return null;
  const magic = buf.readUInt16LE(0);
  if (magic !== 0xcab6) return null;
  const sku = buf.subarray(8, 20).toString("ascii").replace(/\0/g, "").trim();
  const lengthMm = buf.readUInt16LE(40) / 10;
  const widthMm = buf.readUInt16LE(42) / 10;
  if (!Number.isFinite(lengthMm) || !Number.isFinite(widthMm) || widthMm <= 0 || lengthMm <= 0) return null;
  return { sku, widthMm, lengthMm };
}
