import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { normalizeCopies } from "../shared/copies.mjs";
import { pngToPdf } from "../shared/print.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("copies field: whole number 1..20, junk means 1", () => {
  assert.equal(normalizeCopies("2"), 2);
  assert.equal(normalizeCopies(2), 2);
  assert.equal(normalizeCopies("2.4"), 2);
  assert.equal(normalizeCopies(""), 1);
  assert.equal(normalizeCopies("0"), 1);
  assert.equal(normalizeCopies("-3"), 1);
  assert.equal(normalizeCopies("abc"), 1);
  assert.equal(normalizeCopies(undefined), 1);
  assert.equal(normalizeCopies("99"), 20);
});

test("each copy is its own page in the PDF sent to the 550 (lp -n 1)", async () => {
  for (const copies of [1, 2, 5]) {
    const pdf = await PDFDocument.load(await pngToPdf(PNG, 167, 288, copies));
    assert.equal(pdf.getPageCount(), copies);
  }
});
