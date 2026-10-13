import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import {
  buildRoLabelDoc,
  extractLastName,
  normalizeRoPayload,
  planRoPrint,
  renderRoLabelPdf,
  roLabelLines,
} from "../shared/ro-label.mjs";

test("extractLastName takes the final token", () => {
  assert.equal(extractLastName("Ada Owner"), "Owner");
  assert.equal(extractLastName("Mary-Jane Watson"), "Watson");
  assert.equal(extractLastName("Single"), "Single");
});

test("normalize accepts create-ro with lastName + model", () => {
  const result = normalizeRoPayload({
    ro: "J001094",
    lastName: "Owner",
    model: "Macan",
    event: "create-ro",
  });
  assert.equal(result.ok, true);
  assert.equal(result.fields.roNumber, "J001094");
  assert.equal(result.fields.lastName, "Owner");
  assert.equal(result.fields.model, "Macan");
});

test("normalize derives lastName from customer full name", () => {
  const result = normalizeRoPayload({
    customer: "Ada Owner",
    model: "911",
    event: "create",
  });
  assert.equal(result.ok, true);
  assert.equal(result.fields.lastName, "Owner");
  assert.equal(result.fields.model, "911");
});

test("normalize rejects update-ro events", () => {
  const result = normalizeRoPayload({
    lastName: "Owner",
    model: "Macan",
    event: "update-ro",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Only Create/i);
});

test("normalize rejects schedule and assign events", () => {
  assert.equal(normalizeRoPayload({ lastName: "A", model: "Macan", event: "schedule-new-ro" }).ok, false);
  assert.equal(normalizeRoPayload({ lastName: "A", model: "Macan", event: "assign-ro" }).ok, false);
  assert.equal(normalizeRoPayload({ lastName: "A", model: "Macan", event: "new-ro" }).ok, false);
});

test("normalize rejects missing lastName or model", () => {
  assert.equal(normalizeRoPayload({ model: "Macan", event: "create-ro" }).ok, false);
  assert.equal(normalizeRoPayload({ lastName: "Owner", event: "create-ro" }).ok, false);
});

test("ro label lines are last name then model only", () => {
  const lines = roLabelLines({ lastName: "Owner", model: "Cayman" });
  assert.deepEqual(lines, ["Owner", "Cayman"]);
});

test("planRoPrint dry-run never marks printed", () => {
  const plan = planRoPrint({
    roNumber: "J001094",
    lastName: "Owner",
    model: "Macan",
    dryRun: true,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.printed, false);
  assert.equal(plan.doc.mediaKey, "w79h252");
  assert.equal(plan.doc.blocks.length, 2);
  assert.equal(plan.doc.blocks[0].text, "Owner");
  assert.equal(plan.doc.blocks[1].text, "Macan");
});

test("buildRoLabelDoc stays on 30252 address media", () => {
  const doc = buildRoLabelDoc({ lastName: "Test", model: "911", roNumber: "J9" });
  assert.equal(doc.mediaKey, "w79h252");
  assert.equal(doc.turned, true);
});

test("renderRoLabelPdf builds a one-page 30252 PDF", async () => {
  const { pdf, media } = await renderRoLabelPdf({ lastName: "Owner", model: "Macan" });
  assert.equal(media.key, "w79h252");
  assert.ok(pdf.length > 200);
  const doc = await PDFDocument.load(pdf);
  assert.equal(doc.getPageCount(), 1);
  const size = doc.getPage(0).getSize();
  assert.equal(size.width, 79);
  assert.equal(size.height, 252);
});
