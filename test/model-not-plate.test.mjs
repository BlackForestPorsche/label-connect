import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseHTML } from "linkedom";
import { cleanModel, normalizeRoPayload, roLabelLines } from "../shared/ro-label.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadApi(dir) {
  const sandbox = { globalThis: null };
  sandbox.globalThis = sandbox;
  const ctx = createContext(sandbox);
  for (const file of ["config.js", "scrape.js"]) {
    const rel = `${dir}/${file}`;
    runInContext(readFileSync(join(root, rel), "utf8"), ctx, { filename: rel });
  }
  return sandbox.AllDataRoLabels;
}

const api = loadApi("extension/shared");

function scrapeHtml(html, a = api) {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  return a.scrapeWorkScreen(document);
}

test("scrape: a plate input sharing the Model row never wins over the vehicle model", () => {
  const fields = scrapeHtml(`
    <div class="row"><span>Customer</span><span>Ada Whatcott</span></div>
    <div class="form-group">
      <div><span>Plate</span><input id="f1" value="LUVPRSH" /></div>
      <div><span>Model</span><input id="f2" value="Cayenne" /></div>
    </div>
  `);
  assert.equal(fields.lastName, "Whatcott");
  assert.equal(fields.model, "Cayenne");
});

test("scrape: plate field before an empty Model falls through to Vehicle, not the plate", () => {
  const fields = scrapeHtml(`
    <div class="row"><span>Customer</span><span>Ada Whatcott</span></div>
    <div class="row">
      <div><label>License Plate</label><input value="LUVPRSH" /></div>
      <div><label>Model</label><input value="" /></div>
    </div>
    <div class="row"><span>Vehicle</span><span>2019 Porsche Cayenne</span></div>
  `);
  assert.equal(fields.model, "Cayenne");
});

test("scrape: letters-only plate sitting under Model is rejected when the page shows it as the plate", () => {
  const fields = scrapeHtml(`
    <div class="row"><span>Customer</span><span>Ada Whatcott</span></div>
    <div class="row"><span>License Plate</span><span>LUVPRSH</span></div>
    <div class="row"><span>Model</span><span>LUVPRSH</span></div>
    <div class="row"><span>Year/Make/Model</span><span>2021 BMW M3</span></div>
  `);
  assert.equal(fields.model, "M3");
});

test("scrape: plate split into fragments (ABC 123) next to Model never becomes the model", () => {
  const fields = scrapeHtml(`
    <div class="row"><span>Customer</span><span>Ada Whatcott</span></div>
    <div class="row"><span>Model</span><span>ABC 123</span></div>
    <div class="row"><span>Vehicle</span><span>2015 Porsche 911</span></div>
  `);
  assert.equal(fields.lastName, "Whatcott");
  assert.equal(fields.model, "911");
});

test("scrape: empty Model beside a plate value does not borrow the plate", () => {
  const fields = scrapeHtml(`
    <div class="row"><span>Customer</span><span>Ada Whatcott</span></div>
    <div class="row"><span>Model</span><div><input value="" /></div></div>
    <div class="row"><span>Plate</span><span>ABC 123</span></div>
  `);
  assert.equal(fields.model, "");
});

test("scrape: plate and plate state in one Model row, vehicle model still wins", () => {
  const fields = scrapeHtml(`
    <div class="row"><span>Customer</span><span>Ada Whatcott</span></div>
    <div class="row">
      <div><span>Plate State</span><input value="CA" /></div>
      <div><span>License Plate</span><input value="7ABC123" /></div>
      <div><span>Model</span><input value="Macan" /></div>
    </div>
  `);
  assert.equal(fields.model, "Macan");
});

test("scrape: plate fragments inside a model blob are dropped", () => {
  assert.equal(api.normalizeModelToken("ABC 123"), "");
  assert.equal(api.normalizeModelToken("ABC 123 CA"), "");
  assert.equal(api.normalizeModelToken("7ABC123"), "");
  assert.equal(api.normalizeModelToken("7ABC 123"), "");
  assert.equal(api.normalizeModelToken("123"), "");
  assert.equal(api.normalizeModelToken("2019 BMW 7ABC123 M3"), "M3");
  assert.equal(api.normalizeModelToken("Cayenne 7ABC123"), "Cayenne");
  assert.equal(api.normalizeModelToken("Grand Cherokee 7ABC123 CA"), "Cherokee");
  assert.equal(api.normalizeModelToken("M3"), "M3");
  assert.equal(api.normalizeModelToken("X5"), "X5");
  assert.equal(api.normalizeModelToken("328i"), "328i");
  assert.equal(api.normalizeModelToken("944"), "944");
  assert.equal(api.normalizeModelToken("911"), "911");
  assert.equal(api.normalizeModelToken("Camry LE"), "Camry");
});

test("scrape: last name stays last name with a plate on the page", () => {
  const fields = scrapeHtml(`
    <div class="row"><span>Customer</span><span>J. Whatcott</span></div>
    <div class="row"><span>License Plate</span><span>7ABC123</span></div>
    <div class="row"><span>Model</span><span>Cayenne</span></div>
  `);
  assert.equal(fields.lastName, "Whatcott");
  assert.equal(fields.model, "Cayenne");
});

test("scrape: a vanity plate that is also a model word only wins through the Model field", () => {
  const fields = scrapeHtml(`
    <div class="row"><span>Customer</span><span>Ada Whatcott</span></div>
    <div class="row"><span>License Plate</span><span>CARRERA</span></div>
    <div class="row"><span>Vehicle</span><span>2019 BMW M3</span></div>
  `);
  assert.equal(fields.model, "M3");
});

test("Labels: plate-shaped model strings never print", () => {
  assert.equal(cleanModel("7ABC123"), "");
  assert.equal(cleanModel("ABC 123"), "");
  assert.equal(cleanModel("7ABC 123 CA"), "");
  assert.equal(cleanModel("123"), "");
  assert.equal(cleanModel("M3"), "M3");
  assert.equal(cleanModel("328i"), "328i");
  assert.equal(cleanModel("Camry CA"), "Camry");
  assert.equal(cleanModel("Cayenne"), "Cayenne");
  assert.equal(
    normalizeRoPayload({ lastName: "Whatcott", model: "7ABC123", event: "create-ro" }).ok,
    false,
  );
  assert.deepEqual(roLabelLines({ lastName: "Whatcott", model: "Cayenne" }), [
    "Whatcott - Cayenne",
    "Out Mileage _____________",
  ]);
});

test("Chromium and Firefox scrape.js match shared (plate guard shipped)", () => {
  for (const dir of ["extension/chromium", "extension/firefox"]) {
    assert.equal(
      readFileSync(join(root, dir, "scrape.js"), "utf8"),
      readFileSync(join(root, "extension/shared/scrape.js"), "utf8"),
      dir,
    );
    const built = loadApi(dir);
    assert.equal(built.normalizeModelToken("ABC 123"), "");
    assert.equal(
      scrapeHtml(
        `<div class="row"><span>Customer</span><span>Ada Whatcott</span></div><div class="form-group"><div><span>Plate</span><input value="LUVPRSH" /></div><div><span>Model</span><input value="Cayenne" /></div></div>`,
        built,
      ).model,
      "Cayenne",
    );
  }
});
