import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ADDON_ID = "black-forest-desk@blackforestautomotive.com";
const json = (body) => ({ ok: true, status: 200, json: async () => body });
const missing = { ok: false, status: 404, json: async () => ({}) };

function feedFetch(signedVersion, announcedVersion) {
  return async (url) => {
    if (url.includes("updates.json")) {
      return json({
        addons: {
          [ADDON_ID]: {
            updates: [{ version: signedVersion, update_link: `https://example.test/Black.Forest.Desk-${signedVersion}.xpi` }],
          },
        },
      });
    }
    if (url.includes("raw.githubusercontent.com")) return json({ version: announcedVersion, message: "note" });
    return missing;
  };
}

function loadBackground({ localVersion, fetchImpl }) {
  const calls = { tabs: [] };
  const store = {};
  const noopEvent = { addListener() {} };
  const listeners = [];
  const browser = {
    runtime: {
      getManifest: () => ({ version: localVersion }),
      getBrowserInfo: async () => ({ name: "Firefox" }),
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onUpdateAvailable: noopEvent,
      reload() {},
    },
    storage: {
      local: { get: async () => ({}), set: async (patch) => Object.assign(store, patch) },
      onChanged: noopEvent,
    },
    tabs: {
      create: async (opts) => {
        calls.tabs.push(opts);
        return { id: 1 };
      },
      onUpdated: noopEvent,
      query: async () => [],
    },
    alarms: { create() {}, onAlarm: noopEvent },
    cookies: { onChanged: noopEvent },
    idle: { onStateChanged: noopEvent },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
  };
  const sandbox = {
    browser,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    URL,
    Date,
    JSON,
    fetch: async (url, init) => fetchImpl(String(url), init),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "extension/shared/background.js"), "utf8"), sandbox);
  const send = (message) =>
    new Promise((resolve) => {
      for (const fn of listeners) {
        if (fn(message, {}, resolve) === true) return;
      }
      resolve(undefined);
    });
  return { calls, store, send };
}

test("check-update does not offer a version that is merged but not signed yet (0.1.33 -> 0.1.34 race)", async () => {
  const { calls, store, send } = loadBackground({ localVersion: "0.1.33", fetchImpl: feedFetch("0.1.33", "0.1.34") });
  const checked = await send({ type: "check-update", force: true });
  assert.equal(checked.available, null);
  assert.equal(store.deskUpdateAvailable, null);

  const result = await send({ type: "apply-update" });
  assert.equal(result.mode, "update_publishing");
  assert.equal(result.ok, false);
  assert.equal(result.version, "0.1.34");
  assert.match(result.message, /still being signed/);
  assert.equal(calls.tabs.length, 0);
});

test("check-update and apply-update agree once 0.1.34 is signed: badge, then signed XPI prompt", async () => {
  const { calls, send } = loadBackground({ localVersion: "0.1.33", fetchImpl: feedFetch("0.1.34", "0.1.34") });
  const checked = await send({ type: "check-update", force: true });
  assert.equal(checked.available.version, "0.1.34");
  assert.equal(checked.available.message, "note");

  const result = await send({ type: "apply-update" });
  assert.equal(result.mode, "firefox_xpi_prompt");
  assert.equal(result.version, "0.1.34");
  assert.deepEqual(calls.tabs.map((t) => t.url), ["https://example.test/Black.Forest.Desk-0.1.34.xpi"]);
});

test("apply-update still says up to date when nothing newer is announced or signed", async () => {
  const { calls, send } = loadBackground({ localVersion: "0.1.35", fetchImpl: feedFetch("0.1.35", "0.1.35") });
  const result = await send({ type: "apply-update" });
  assert.equal(result.mode, "up_to_date");
  assert.equal(result.ok, true);
  assert.equal(calls.tabs.length, 0);
});
