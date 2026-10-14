import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseHTML } from "linkedom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadApi() {
  const sandbox = { globalThis: null };
  sandbox.globalThis = sandbox;
  const ctx = createContext(sandbox);
  for (const file of ["extension/shared/config.js", "extension/shared/scrape.js"]) {
    runInContext(readFileSync(join(root, file), "utf8"), ctx, { filename: file });
  }
  return sandbox.AllDataRoLabels;
}

const api = loadApi();

function scrapeHtml(html) {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  return api.scrapeWorkScreen(document);
}

test("scrape: Customer + Model in class=row (AllData-like)", () => {
  const fields = scrapeHtml(`
    <div class="form-row">
      <span>Customer</span>
      <span>J. Whatcott</span>
    </div>
    <div class="form-row">
      <span>License plate</span>
      <span>ABC1234</span>
    </div>
    <div class="form-row">
      <span>Account #</span>
      <span>A99887</span>
    </div>
    <div class="form-row">
      <span>Model</span>
      <span>Boxster</span>
    </div>
  `);
  assert.equal(fields.lastName, "Whatcott");
  assert.equal(fields.model, "Boxster");
});

test("scrape: Last Name * + input for= association", () => {
  const fields = scrapeHtml(`
    <label for="ln">Last Name *</label>
    <input id="ln" value="LWhatcott" />
    <label for="md">Model</label>
    <input id="md" value="Macan" />
    <label for="pl">License plate</label>
    <input id="pl" value="XYZ9876" />
  `);
  assert.equal(fields.lastName, "Whatcott");
  assert.equal(fields.model, "Macan");
});

test("scrape: inline Customer: Name does not take plate", () => {
  const fields = scrapeHtml(`
    <div>Customer: Ada Owner</div>
    <div>License plate: ABC1234</div>
    <div>Model: Cayman</div>
  `);
  assert.equal(fields.lastName, "Owner");
  assert.equal(fields.model, "Cayman");
});

test("scrape: plate/account never become lastName or model", () => {
  const fields = scrapeHtml(`
    <div class="row">
      <span>Customer</span>
      <span>ABC1234</span>
    </div>
    <div class="row">
      <span>Model</span>
      <span>A99887</span>
    </div>
    <div>Boxster</div>
  `);
  // Plate rejected as customer; model falls back to Porsche token on page.
  assert.equal(fields.lastName, "");
  assert.equal(fields.model, "Boxster");
  assert.equal(api.isPlateOrAccountNoise("ABC1234"), true);
  assert.equal(api.isPlateOrAccountNoise("A99887"), true);
});

test("scrape: table th/td Customer + Model", () => {
  const fields = scrapeHtml(`
    <table>
      <tr><th>Customer Name</th><td>Mary Whatcott</td></tr>
      <tr><th>License plate</th><td>QWE1234</td></tr>
      <tr><th>Model</th><td>911</td></tr>
    </table>
  `);
  assert.equal(fields.lastName, "Whatcott");
  assert.equal(fields.model, "911");
});
