import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadExtensionApi() {
  const sandbox = { globalThis: null };
  sandbox.globalThis = sandbox;
  const ctx = createContext(sandbox);
  for (const file of ["extension/shared/config.js", "extension/shared/scrape.js"]) {
    runInContext(readFileSync(join(root, file), "utf8"), ctx, { filename: file });
  }
  return sandbox.AllDataRoLabels;
}

const api = loadExtensionApi();

function fakeCreateEl(overrides = {}) {
  return {
    nodeType: 1,
    isConnected: true,
    disabled: false,
    className: "",
    getAttribute: () => null,
    getAttributeNS: () => null,
    textContent: "Create R/O",
    innerText: "Create R/O",
    ...overrides,
  };
}

test("evaluateCreateSuccess: create gone + fields confirms", () => {
  const r = api.evaluateCreateSuccess({
    armedHadCreate: true,
    armedHadUpdate: false,
    armedBaselineRo: "",
    armedAt: Date.now() - 1000,
    armedCreateEl: null,
    scraped: { lastName: "Whatcott", model: "Boxster", roNumber: "J1" },
    createStillThere: false,
    updateThere: false,
    pageSuccess: false,
    now: Date.now(),
  });
  assert.equal(r.confirmed, true);
  assert.equal(r.reason, "create-gone");
});

test("evaluateCreateSuccess: open RO — Update already present does not alone confirm", () => {
  const r = api.evaluateCreateSuccess({
    armedHadCreate: true,
    armedHadUpdate: true,
    armedBaselineRo: "J100",
    armedAt: Date.now() - 1000,
    armedCreateEl: fakeCreateEl(),
    scraped: { lastName: "Whatcott", model: "Boxster", roNumber: "J100" },
    createStillThere: true,
    updateThere: true,
    pageSuccess: false,
    now: Date.now(),
  });
  assert.equal(r.confirmed, false);
});

test("evaluateCreateSuccess: open RO — armed Create disabled confirms", () => {
  const r = api.evaluateCreateSuccess({
    armedHadCreate: true,
    armedHadUpdate: true,
    armedBaselineRo: "J100",
    armedAt: Date.now() - 1000,
    armedCreateEl: fakeCreateEl({ disabled: true }),
    scraped: { lastName: "Whatcott", model: "Boxster", roNumber: "J100" },
    createStillThere: true,
    updateThere: true,
    pageSuccess: false,
    now: Date.now(),
  });
  assert.equal(r.confirmed, true);
  assert.equal(r.reason, "create-disabled");
});

test("evaluateCreateSuccess: open RO — armed Create disconnected confirms", () => {
  const r = api.evaluateCreateSuccess({
    armedHadCreate: true,
    armedHadUpdate: true,
    armedBaselineRo: "J100",
    armedAt: Date.now() - 1000,
    armedCreateEl: fakeCreateEl({ isConnected: false }),
    scraped: { lastName: "Whatcott", model: "Boxster", roNumber: "J100" },
    createStillThere: true,
    updateThere: true,
    pageSuccess: false,
    now: Date.now(),
  });
  assert.equal(r.confirmed, true);
  assert.equal(r.reason, "create-gone");
});

test("evaluateCreateSuccess: new RO# confirms even when Create stays", () => {
  const r = api.evaluateCreateSuccess({
    armedHadCreate: true,
    armedHadUpdate: true,
    armedBaselineRo: "J100",
    armedAt: Date.now() - 1000,
    armedCreateEl: fakeCreateEl(),
    scraped: { lastName: "Whatcott", model: "Boxster", roNumber: "J101" },
    createStillThere: true,
    updateThere: true,
    pageSuccess: false,
    now: Date.now(),
  });
  assert.equal(r.confirmed, true);
  assert.equal(r.reason, "ro-changed");
});

test("evaluateCreateSuccess: page success banner confirms", () => {
  const r = api.evaluateCreateSuccess({
    armedHadCreate: true,
    armedHadUpdate: true,
    armedBaselineRo: "J100",
    armedAt: Date.now() - 1000,
    armedCreateEl: fakeCreateEl(),
    scraped: { lastName: "Whatcott", model: "Boxster", roNumber: "J100" },
    createStillThere: true,
    updateThere: true,
    pageSuccess: false,
    pageSuccess: true,
    now: Date.now(),
  });
  assert.equal(r.confirmed, true);
  assert.equal(r.reason, "page-success");
});

test("evaluateCreateSuccess: update appeared (was absent) confirms", () => {
  const r = api.evaluateCreateSuccess({
    armedHadCreate: true,
    armedHadUpdate: false,
    armedBaselineRo: "",
    armedAt: Date.now() - 1000,
    armedCreateEl: fakeCreateEl(),
    scraped: { lastName: "Owner", model: "Macan", roNumber: "" },
    createStillThere: true,
    updateThere: true,
    pageSuccess: false,
    now: Date.now(),
  });
  assert.equal(r.confirmed, true);
  assert.equal(r.reason, "update-appeared");
});

test("evaluateCreateSuccess: UI confirm without fields → missingFields", () => {
  const r = api.evaluateCreateSuccess({
    armedHadCreate: true,
    armedHadUpdate: false,
    armedBaselineRo: "",
    armedAt: Date.now() - 1000,
    armedCreateEl: fakeCreateEl({ isConnected: false }),
    scraped: { lastName: "", model: "", roNumber: "" },
    createStillThere: false,
    updateThere: false,
    pageSuccess: false,
    now: Date.now(),
  });
  assert.equal(r.confirmed, true);
  assert.equal(r.missingFields, true);
});

test("evaluateCreateSuccess: no signal stays fail-closed", () => {
  const r = api.evaluateCreateSuccess({
    armedHadCreate: true,
    armedHadUpdate: false,
    armedBaselineRo: "",
    armedAt: Date.now() - 1000,
    armedCreateEl: fakeCreateEl(),
    scraped: { lastName: "Whatcott", model: "Boxster", roNumber: "" },
    createStillThere: true,
    updateThere: false,
    pageSuccess: false,
    now: Date.now(),
  });
  assert.equal(r.confirmed, false);
});

test("isCreateControl matches Create R/O label", () => {
  const el = {
    getAttribute: (name) => (name === "aria-label" ? "Create R/O" : null),
    textContent: "",
    innerText: "",
  };
  assert.equal(api.isCreateControl(el), true);
  const update = {
    getAttribute: (name) => (name === "aria-label" ? "Update R/O" : null),
    textContent: "",
    innerText: "",
  };
  assert.equal(api.isCreateControl(update), false);
  assert.equal(api.isForbiddenControl(update), true);
});

test("scrape rejects plate / account as lastName", () => {
  assert.equal(api.lastNameFromFull("ABC1234"), "");
  assert.equal(api.lastNameFromFull("A12345"), "");
  assert.equal(api.lastNameFromFull("Whatcott"), "Whatcott");
  assert.equal(api.isPlateOrAccountNoise("ABC1234"), true);
  assert.equal(api.isPlateOrAccountNoise("12345"), true);
  assert.equal(api.isPlateOrAccountNoise("License plate"), true);
  assert.equal(api.isPlateOrAccountNoise("Account #"), true);
  assert.equal(api.isPlateOrAccountNoise("Boxster"), false);
});
