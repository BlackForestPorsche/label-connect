import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseHTML } from "linkedom";

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

function scrapeHtml(html) {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  return api.scrapeWorkScreen(document);
}

test("Y/M/M line splits model and submodel for Porsche", () => {
  const fields = scrapeHtml(`
    <div class="row"><span>Customer</span><span>Ada Whatcott</span></div>
    <div class="row"><span>Year/Make/Model</span><span>2019 Porsche 911 Targa</span></div>
  `);
  assert.equal(fields.model, "911");
  assert.equal(fields.submodel, "Targa");
});

test("explicit Submodel field wins", () => {
  const fields = scrapeHtml(`
    <div class="row"><span>Model</span><input value="911" /></div>
    <div class="row"><span>Submodel</span><input value="Turbo S" /></div>
  `);
  assert.equal(fields.model, "911");
  assert.equal(fields.submodel, "Turbo S");
});

test("single-model Y/M/M leaves submodel empty", () => {
  const fields = scrapeHtml(`
    <div class="row"><span>Year/Make/Model</span><span>2019 Toyota Camry</span></div>
  `);
  assert.equal(fields.model, "Camry");
  assert.equal(fields.submodel, "");
});

test("submodelFromVehicleText helper", () => {
  assert.equal(api.submodelFromVehicleText("2019 Porsche 911 Targa", "911"), "Targa");
  assert.equal(api.submodelFromVehicleText("F-150 XLT", "F-150"), "XLT");
  assert.equal(api.submodelFromVehicleText("911", "911"), "");
});