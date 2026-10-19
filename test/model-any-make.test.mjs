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

/** Scrape → payload → label lines, exactly as Create R/O does. */
function labelFor(html) {
  const scraped = scrapeHtml(html);
  const normalized = normalizeRoPayload({ event: "create-ro", lastName: scraped.lastName, model: scraped.model });
  assert.equal(normalized.ok, true);
  return roLabelLines(normalized.fields);
}

const PLATE_ROW = `<div class="row"><span>License Plate</span><span>7ABC123</span></div>`;

test("last name + non-Porsche model with a plate nearby: label has both", () => {
  const cases = [
    ["Camry", "Camry"],
    ["Q5", "Q5"],
    ["GLC300", "GLC300"],
    ["RX350", "RX350"],
    ["M340i", "M340i"],
    ["Silverado 1500", "Silverado 1500"],
    ["Model Y", "Model Y"],
    ["F-150 XLT", "F-150"],
    ["Ram 1500", "Ram 1500"],
    ["Defender", "Defender"],
  ];
  for (const [shown, printed] of cases) {
    const lines = labelFor(`
      <div class="row"><span>Customer</span><span>Ada Whatcott</span></div>
      ${PLATE_ROW}
      <div class="row"><span>Model</span><input value="${shown}" /></div>
    `);
    assert.deepEqual(lines, [`Whatcott - ${printed}`, "Out Mileage _____________"], shown);
  }
});

test("Year/Make/Model line for another make gives the model, not the plate", () => {
  const html = (ymm) => `
    <div class="row"><span>Customer</span><span>Ada Whatcott</span></div>
    <div class="row"><span>License Plate</span><span>LUVPRSH</span></div>
    <div class="row"><span>Year/Make/Model</span><span>${ymm}</span></div>
  `;
  assert.deepEqual(labelFor(html("2019 Toyota Camry")), ["Whatcott - Camry", "Out Mileage _____________"]);
  assert.deepEqual(labelFor(html("2020 Audi Q5")), ["Whatcott - Q5", "Out Mileage _____________"]);
  assert.deepEqual(labelFor(html("2021 Mercedes-Benz GLC300")), ["Whatcott - GLC300", "Out Mileage _____________"]);
  assert.deepEqual(labelFor(html("2018 Land Rover Defender")), ["Whatcott - Defender", "Out Mileage _____________"]);
  assert.deepEqual(labelFor(html("2022 Chevrolet Silverado 1500")), [
    "Whatcott - Silverado 1500",
    "Out Mileage _____________",
  ]);
  assert.deepEqual(labelFor(html("2023 Tesla Model 3")), ["Whatcott - Model 3", "Out Mileage _____________"]);
});

test("model only in free text (no Model label) for a non-Porsche make is still found", () => {
  const lines = labelFor(`
    <div class="row"><span>Customer</span><span>Ada Whatcott</span></div>
    <div class="row"><span>Plate</span><span>7ABC123</span></div>
    <p>Open vehicle: 2017 Honda Accord, in bay 3</p>
  `);
  assert.deepEqual(lines, ["Whatcott - Accord", "Out Mileage _____________"]);
});

test("a Porsche word does not hijack another make's model", () => {
  assert.equal(api.normalizeModelToken("2020 Ford Mustang Turbo"), "Mustang");
  assert.equal(cleanModel("Ford Mustang Turbo"), "Ford Mustang Turbo");
  assert.equal(api.normalizeModelToken("2019 Porsche 911 Turbo"), "911");
});

test("plate still never wins: a plate shaped like a model code is rejected when the page shows it as the plate", () => {
  const fields = scrapeHtml(`
    <div class="row"><span>Customer</span><span>Ada Whatcott</span></div>
    <div class="row"><span>License Plate</span><span>GLC300</span></div>
    <div class="row"><span>Model</span><span>GLC300</span></div>
    <div class="row"><span>Year/Make/Model</span><span>2021 Audi A4</span></div>
  `);
  assert.equal(fields.model, "A4");
});

test("plate, plate state, VIN and account are still never the model", () => {
  for (const junk of ["7ABC123", "ABC 123", "ABC1234", "CA", "WP0AB2A99KS123456", "12345", "VIN:"]) {
    assert.equal(cleanModel(junk), "", junk);
    assert.equal(api.normalizeModelToken(junk), "", junk);
  }
  const fields = scrapeHtml(`
    <div class="row"><span>Customer</span><span>Ada Whatcott</span></div>
    <div class="row"><span>Plate State</span><span>CA</span></div>
    <div class="row"><span>License Plate</span><span>7ABC123</span></div>
    <div class="row"><span>Account #</span><span>445566</span></div>
    <div class="row"><span>VIN</span><span>WP0AB2A99KS123456</span></div>
    <div class="row"><span>Model</span><span></span></div>
  `);
  assert.equal(fields.lastName, "Whatcott");
  assert.equal(fields.model, "");
});

test("model codes on the server backstop survive: GLC300, RX350, M340i, Silverado 1500, Model Y", () => {
  for (const model of ["GLC300", "RX350", "M340i", "Silverado 1500", "Model Y", "F-150 XLT", "Ram 1500", "Camry"]) {
    const r = normalizeRoPayload({ event: "create-ro", lastName: "Whatcott", model });
    assert.equal(r.ok, true);
    assert.equal(r.fields.model, model, model);
  }
});

test("Chromium and Firefox scrape.js match shared and read non-Porsche models", () => {
  for (const dir of ["extension/chromium", "extension/firefox"]) {
    assert.equal(
      readFileSync(join(root, dir, "scrape.js"), "utf8"),
      readFileSync(join(root, "extension/shared/scrape.js"), "utf8"),
      dir,
    );
    const built = loadApi(dir);
    const fields = scrapeHtml(
      `<div class="row"><span>Customer</span><span>Ada Whatcott</span></div>${PLATE_ROW}<div class="row"><span>Model</span><input value="GLC300" /></div>`,
      built,
    );
    assert.equal(fields.lastName, "Whatcott");
    assert.equal(fields.model, "GLC300");
  }
});

test("flat row 'Plate [..] Model [..]' reads the Model input, not the plate", () => {
  const lines = labelFor(`
    <div class="row"><span>Customer</span><span>Ada Whatcott</span></div>
    <div class="row"><span>Plate</span><input value="7ABC123" /><span>Model</span><input value="Camry" /></div>
  `);
  assert.deepEqual(lines, ["Whatcott - Camry", "Out Mileage _____________"]);
});
