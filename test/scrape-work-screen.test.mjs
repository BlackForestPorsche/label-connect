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

test("scrape: listener fields keep plate, vin, and tech, and drop phone and email", () => {
  const fields = scrapeHtml(`
    <div class="row"><label for="cu">Customer</label><input id="cu" value="Ada Whatcott"></div>
    <div class="row"><label for="yr">Year</label><input id="yr" value="2018"></div>
    <div class="row"><label for="mk">Make</label><input id="mk" value="Porsche"></div>
    <div class="row"><label for="md">Model</label><input id="md" value="Boxster"></div>
    <div class="row"><label for="pl">License plate</label><input id="pl" value="ABC1234"></div>
    <div class="row"><label for="vn">VIN</label><input id="vn" value="WP0AB2A99KS123456"></div>
    <div class="row"><label for="tc">Technician</label><input id="tc" value="Logan"></div>
    <div class="row"><label for="ph">Phone</label><input id="ph" value="8015551212"></div>
    <div class="row"><label for="em">Email</label><input id="em" value="ada@example.com"></div>
    <div class="row"><label for="ro">RO #</label><input id="ro" value="J1001"></div>
  `);
  assert.equal(fields.customer, "Ada Whatcott");
  assert.equal(fields.car, "2018 Porsche Boxster");
  assert.equal(fields.plate, "ABC1234");
  assert.equal(fields.vin, "WP0AB2A99KS123456");
  assert.equal(fields.tech, "Logan");
  assert.equal(fields.ro, "J1001");
  assert.equal(fields.lastName, "Whatcott");
  assert.equal(fields.model, "Boxster");
  assert.equal(Object.hasOwn(fields, "phone"), false);
  assert.equal(Object.hasOwn(fields, "email"), false);
  assert.equal(api.isCloseControl({ textContent: "Close R/O", nodeType: 1, getAttribute() { return ""; } }), true);
  assert.equal(api.isCancelControl({ textContent: "Cancel R/O", nodeType: 1, getAttribute() { return ""; } }), true);
});
