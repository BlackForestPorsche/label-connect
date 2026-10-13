import assert from "node:assert/strict";
import test from "node:test";
import { buildRoLabelDoc, normalizeRoPayload, planRoPrint, roLabelLines } from "../shared/ro-label.mjs";

test("normalize accepts create-ro payload aliases", () => {
  const result = normalizeRoPayload({
    ro: "J001094",
    customer: "Ada Owner",
    year: "2018",
    make: "Porsche",
    model: "Macan",
    plate: "7NYB225",
    state: "ca",
    event: "create-ro",
  });
  assert.equal(result.ok, true);
  assert.equal(result.fields.roNumber, "J001094");
  assert.equal(result.fields.customerName, "Ada Owner");
  assert.equal(result.fields.licenseState, "CA");
  assert.equal(result.fields.licensePlate, "7NYB225");
});

test("normalize rejects update-ro events", () => {
  const result = normalizeRoPayload({
    roNumber: "J001094",
    event: "update-ro",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Update RO/i);
});

test("normalize rejects empty payload", () => {
  const result = normalizeRoPayload({});
  assert.equal(result.ok, false);
});

test("ro label lines put RO first", () => {
  const lines = roLabelLines({
    roNumber: "J001094",
    customerName: "Ada Owner",
    year: "2018",
    make: "Porsche",
    model: "Macan",
    licensePlate: "7NYB225",
    licenseState: "CA",
    keyTag: "",
    vinLast8: "",
  });
  assert.deepEqual(lines, ["RO J001094", "Ada Owner", "2018 Porsche Macan", "CA 7NYB225"]);
});

test("planRoPrint is always dry-run and never marks printed", () => {
  const plan = planRoPrint({
    roNumber: "J001094",
    customerName: "Ada Owner",
    confirmPrint: true,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.printed, false);
  assert.equal(plan.doc.dryRun, true);
  assert.equal(plan.doc.mediaKey, "w79h252");
  assert.ok(plan.doc.blocks.length >= 2);
});

test("buildRoLabelDoc stays on 30252 address media", () => {
  const doc = buildRoLabelDoc({
    roNumber: "J9",
    customerName: "Test",
    year: "",
    make: "",
    model: "",
    licensePlate: "",
    licenseState: "",
    keyTag: "",
    vinLast8: "",
  });
  assert.equal(doc.mediaKey, "w79h252");
  assert.equal(doc.turned, true);
});
