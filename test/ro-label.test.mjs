import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import {
  OUT_MILEAGE_LINE,
  RO_LABEL_SAFE_INSET_PT,
  buildRoLabelDoc,
  cleanModel,
  extractLastName,
  isPlateOrAccountNoise,
  isVinNoise,
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

test("extractLastName strips first initial forms", () => {
  assert.equal(extractLastName("J. Owner"), "Owner");
  assert.equal(extractLastName("J Owner"), "Owner");
  assert.equal(extractLastName("J.Owner"), "Owner");
  assert.equal(extractLastName("Owner, J"), "Owner");
  assert.equal(extractLastName("Owner, J."), "Owner");
  assert.equal(extractLastName("Owner, Ada"), "Owner");
  assert.equal(extractLastName("Abernathy"), "Abernathy");
});

test("extractLastName strips glued shop code LWhatcott", () => {
  assert.equal(extractLastName("LWhatcott"), "Whatcott");
  assert.equal(extractLastName("JSmith"), "Smith");
  // McDonald: second char is lowercase — keep intact
  assert.equal(extractLastName("McDonald"), "McDonald");
});

test("extractLastName rejects VIN noise", () => {
  assert.equal(extractLastName("VIN:"), "");
  assert.equal(extractLastName("VIN"), "");
  assert.equal(extractLastName("WP0AB2A99KS123456"), "");
});

test("extractLastName rejects license plate and account #", () => {
  assert.equal(extractLastName("ABC1234"), "");
  assert.equal(extractLastName("A12345"), "");
  assert.equal(extractLastName("123456"), "");
  assert.equal(extractLastName("License plate"), "");
  assert.equal(extractLastName("Account #"), "");
  assert.equal(isPlateOrAccountNoise("ABC1234"), true);
  assert.equal(isPlateOrAccountNoise("12345"), true);
  assert.equal(isPlateOrAccountNoise("Whatcott"), false);
  assert.equal(isPlateOrAccountNoise("Boxster"), false);
  assert.equal(isPlateOrAccountNoise("911"), false);
});

test("normalize strips first initial from lastName field", () => {
  const result = normalizeRoPayload({
    lastName: "J. Owner",
    model: "Macan",
    event: "create-ro",
  });
  assert.equal(result.ok, true);
  assert.equal(result.fields.lastName, "Owner");
});

test("normalize strips LWhatcott glued initial", () => {
  const result = normalizeRoPayload({
    lastName: "LWhatcott",
    model: "Boxster",
    event: "create-ro",
  });
  assert.equal(result.ok, true);
  assert.equal(result.fields.lastName, "Whatcott");
  assert.equal(result.fields.model, "Boxster");
});

test("normalize rejects VIN as lastName or model", () => {
  assert.equal(normalizeRoPayload({ lastName: "VIN:", model: "Boxster", event: "create-ro" }).ok, false);
  assert.equal(normalizeRoPayload({ lastName: "Whatcott", model: "VIN:", event: "create-ro" }).ok, false);
  assert.equal(
    normalizeRoPayload({ lastName: "Whatcott", model: "WP0AB2A99KS123456", event: "create-ro" }).ok,
    false,
  );
});

test("normalize rejects license plate / account as lastName or model", () => {
  assert.equal(normalizeRoPayload({ lastName: "ABC1234", model: "Boxster", event: "create-ro" }).ok, false);
  assert.equal(normalizeRoPayload({ lastName: "Whatcott", model: "12345", event: "create-ro" }).ok, false);
  assert.equal(normalizeRoPayload({ lastName: "A98765", model: "XYZ99", event: "create-ro" }).ok, false);
  assert.equal(cleanModel("12345"), "");
  assert.equal(cleanModel("ABC1234"), "");
  assert.equal(cleanModel("Boxster"), "Boxster");
});

test("ro label lines are LastName - Model plus Out Mileage blank", () => {
  const lines = roLabelLines({ lastName: "Whatcott", model: "Boxster", roNumber: "J001094" });
  assert.deepEqual(lines, ["Whatcott - Boxster", OUT_MILEAGE_LINE]);
  assert.ok(!lines.some((line) => /J001094|VIN/i.test(line)));
  assert.match(lines[1], /Out Mileage _{3,}/);
});

test("ro label lines never include roNumber or VIN", () => {
  const lines = roLabelLines({ lastName: "Owner", model: "Macan", roNumber: "J001094" });
  assert.deepEqual(lines, ["Owner - Macan", OUT_MILEAGE_LINE]);
  assert.ok(!lines.some((line) => /J001094|RO|VIN/i.test(line)));
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

test("cleanModel drops VIN junk", () => {
  assert.equal(cleanModel("VIN:"), "");
  assert.equal(cleanModel("Boxster"), "Boxster");
  assert.equal(isVinNoise("VIN:"), true);
  assert.equal(isVinNoise("Boxster"), false);
});

test("planRoPrint dry-run never marks printed", () => {
  const plan = planRoPrint({
    roNumber: "J001094",
    lastName: "Whatcott",
    model: "Boxster",
    dryRun: true,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.printed, false);
  assert.equal(plan.doc.mediaKey, "w79h252");
  assert.equal(plan.doc.blocks.length, 2);
  assert.equal(plan.doc.blocks[0].text, "Whatcott - Boxster");
  assert.equal(plan.doc.blocks[1].text, OUT_MILEAGE_LINE);
  assert.deepEqual(plan.lines, ["Whatcott - Boxster", OUT_MILEAGE_LINE]);
});

test("buildRoLabelDoc stays on 30252 address media", () => {
  const doc = buildRoLabelDoc({ lastName: "Test", model: "911", roNumber: "J9" });
  assert.equal(doc.mediaKey, "w79h252");
  assert.equal(doc.turned, true);
});

test("buildRoLabelDoc pads past ImageableArea so top line is not clipped", () => {
  assert.ok(RO_LABEL_SAFE_INSET_PT >= 6);
  const doc = buildRoLabelDoc({ lastName: "Whatcott", model: "Boxster" });
  assert.ok(doc.blocks[0].y >= RO_LABEL_SAFE_INSET_PT);
  assert.ok(doc.blocks[0].x >= RO_LABEL_SAFE_INSET_PT);
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
