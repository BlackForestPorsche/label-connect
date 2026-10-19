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

test("scrape: state code CA in the Model slot never wins; vehicle model does", () => {
  const fields = scrapeHtml(`
    <div class="row"><span>Customer</span><span>Ada Whatcott</span></div>
    <div class="row"><span>State</span><span>CA</span></div>
    <div class="row"><span>Model</span><span>CA</span></div>
    <div class="row"><span>Vehicle</span><span>2019 Porsche Cayenne S</span></div>
  `);
  assert.equal(fields.lastName, "Whatcott");
  assert.equal(fields.model, "Cayenne");
});

test("scrape: Model slot holding a state is skipped for the next Model value", () => {
  const fields = scrapeHtml(`
    <div class="row"><span>Customer</span><span>Ada Whatcott</span></div>
    <div class="row"><span>Model</span><span>CA</span></div>
    <div class="row"><span>Model</span><span>M3</span></div>
  `);
  assert.equal(fields.model, "M3");
});

test("scrape: Model input holding CA is ignored for a later Year/Make/Model", () => {
  const fields = scrapeHtml(`
    <label for="ln">Last Name *</label><input id="ln" value="Whatcott" />
    <label for="md">Model</label><input id="md" value="CA" />
    <div class="row"><span>Year/Make/Model</span><span>2020 Porsche Macan</span></div>
  `);
  assert.equal(fields.lastName, "Whatcott");
  assert.equal(fields.model, "Macan");
});

test("scrape: trailing state code is dropped from a year/make/model blob", () => {
  assert.equal(api.normalizeModelToken("2019 BMW M3 CA"), "M3");
  assert.equal(api.normalizeModelToken("2018 Toyota Camry CA"), "Camry");
  assert.equal(api.normalizeModelToken("2021 Porsche 911 Carrera CA"), "911");
  assert.equal(api.normalizeModelToken("CA"), "");
  assert.equal(api.normalizeModelToken("ca"), "");
  assert.equal(api.normalizeModelToken("TX"), "");
  assert.equal(api.normalizeModelToken("Anytown, CA 92101"), "");
  assert.equal(api.normalizeModelToken("Cayenne"), "Cayenne");
  assert.equal(api.normalizeModelToken("X5"), "X5");
  assert.equal(api.normalizeModelToken("ABC1234"), "");
  assert.equal(api.isStateOrRegionNoise("CA"), true);
  assert.equal(api.isStateOrRegionNoise("911"), false);
});

test("scrape: last name stays last name when Model is a state", () => {
  const fields = scrapeHtml(`
    <div class="row"><span>Customer</span><span>J. Whatcott</span></div>
    <div class="row"><span>Model</span><span>CA</span></div>
    <div class="row"><span>Vehicle</span><span>2015 Porsche 911</span></div>
  `);
  assert.equal(fields.lastName, "Whatcott");
  assert.equal(fields.model, "911");
});

test("Chromium and Firefox scrape.js match shared (state-code guard shipped)", () => {
  for (const dir of ["extension/chromium", "extension/firefox"]) {
    assert.equal(
      readFileSync(join(root, dir, "scrape.js"), "utf8"),
      readFileSync(join(root, "extension/shared/scrape.js"), "utf8"),
      dir,
    );
    const built = loadApi(dir);
    assert.equal(built.normalizeModelToken("CA"), "");
    assert.equal(
      scrapeHtml(`<div class="row"><span>Customer</span><span>Ada Whatcott</span></div><div class="row"><span>Model</span><span>CA</span></div><div class="row"><span>Vehicle</span><span>2019 Porsche Cayenne</span></div>`, built).model,
      "Cayenne",
    );
  }
});

test("Labels: a state code (CA) is never printed as the model", () => {
  assert.equal(normalizeRoPayload({ lastName: "Whatcott", model: "CA", event: "create-ro" }).ok, false);
  assert.equal(normalizeRoPayload({ lastName: "Whatcott", model: "tx", event: "create-ro" }).ok, false);
  assert.equal(cleanModel("CA"), "");
  assert.equal(cleanModel("Camry CA"), "Camry");
  assert.equal(cleanModel("M3"), "M3");
  assert.equal(cleanModel("911"), "911");
  assert.equal(cleanModel("Cayenne"), "Cayenne");
  assert.deepEqual(roLabelLines({ lastName: "Whatcott", model: "Cayenne" }), [
    "Whatcott - Cayenne",
    "Out Mileage _____________",
  ]);
});
