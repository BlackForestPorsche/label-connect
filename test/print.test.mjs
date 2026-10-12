import assert from "node:assert/strict";
import test from "node:test";
import { parsePpd, mediaBySku, safePageKey, prefersTurn, FALLBACK_MEDIA } from "../shared/media.mjs";
import { parseStatus, parseSkuDump } from "../shared/status.mjs";
import { PDFDocument } from "pdf-lib";
import { printArgs, pngToPdf } from "../shared/print.mjs";
import { code128 } from "../shared/code128.mjs";

test("ppd page size becomes a CUPS key", () => {
  const text = '*PageSize w79h252/30252 Address: "<</PageSize[79 252]/ImagingBBox null>>setpagedevice"';
  const media = parsePpd(text);
  assert.equal(media[0].key, "w79h252");
  assert.equal(media[0].sku, "30252");
  assert.equal(media[0].widthPt, 79);
  assert.equal(media[0].heightPt, 252);
});

test("sku from the printer picks the address roll", () => {
  const found = mediaBySku(FALLBACK_MEDIA, "30252");
  assert.equal(found.key, "w79h252");
  assert.equal(prefersTurn(found), true);
  assert.equal(prefersTurn(mediaBySku(FALLBACK_MEDIA, "30323")), false);
});

test("status reply carries the sku and the count", () => {
  const buf = Buffer.alloc(32, 0);
  buf[0] = 0;
  buf[10] = 8;
  buf.write("30252", 11, "ascii");
  buf.writeUInt16LE(41, 27);
  const status = parseStatus(buf);
  assert.equal(status.sku, "30252");
  assert.equal(status.remaining, 41);
  assert.equal(status.bayLabel, "Roll in");
});

test("nfc dump lengths are tenths of a millimetre", () => {
  const buf = Buffer.alloc(64, 0);
  buf.writeUInt16LE(0xcab6, 0);
  buf.write("30252", 8, "ascii");
  buf.writeUInt16LE(889, 40);
  buf.writeUInt16LE(286, 42);
  const dump = parseSkuDump(buf);
  assert.equal(dump.sku, "30252");
  assert.equal(dump.lengthMm, 88.9);
  assert.equal(dump.widthMm, 28.6);
});

test("print goes to LabelWriter550 and nowhere else", () => {
  const args = printArgs("w79h252", "/tmp/label.pdf");
  assert.deepEqual(args.slice(0, 4), ["-d", "LabelWriter550", "-o", "PageSize=w79h252"]);
  assert.equal(args.includes("-n"), true);
  assert.equal(args.at(-1), "/tmp/label.pdf");
  assert.equal(safePageKey("w79h252;rm"), null);
  assert.throws(() => printArgs("30252 Address", "/tmp/x.pdf"));
});

test("code 128 has a quiet zone and a stop", () => {
  const bits = code128("BF-1042");
  assert.ok(bits.length > 40);
  assert.equal(bits.slice(0, 10).some(Boolean), false);
  assert.equal(bits.at(-1), false);
});

test("pdf is one page per copy at the label size", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const pdf = await pngToPdf(png, 79, 252, 3);
  const doc = await PDFDocument.load(pdf);
  assert.equal(doc.getPageCount(), 3);
  const size = doc.getPage(0).getSize();
  assert.equal(size.width, 79);
  assert.equal(size.height, 252);
});
