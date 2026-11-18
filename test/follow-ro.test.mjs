import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const backgroundSrc = fs.readFileSync(path.join(root, "extension/shared/background.js"), "utf8");

function loadBackground() {
  const fetches = [];
  const messageListeners = [];
  const store = {};
  const noopEvent = { addListener() {} };
  const browser = {
    runtime: {
      getManifest: () => ({ version: "0.1.56" }),
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      getBrowserInfo: async () => ({ name: "Firefox" }),
      onUpdateAvailable: noopEvent,
      onInstalled: noopEvent,
      onStartup: noopEvent,
      reload() {},
    },
    storage: {
      local: {
        get: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter((key) => key in store).map((key) => [key, store[key]]));
        },
        set: async (patch) => Object.assign(store, patch),
      },
      onChanged: noopEvent,
    },
    tabs: {
      create: async () => ({ id: 1 }),
      onUpdated: noopEvent,
      onRemoved: noopEvent,
      onActivated: noopEvent,
      query: async () => [],
    },
    alarms: { create() {}, onAlarm: noopEvent },
    downloads: { download: async () => 1 },
    cookies: { onChanged: noopEvent, get: async () => null, set: async () => null, remove: async () => null },
    idle: { onStateChanged: noopEvent, setDetectionInterval() {} },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
  };
  const sandbox = {
    browser,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    AbortController,
    URL,
    Date,
    JSON,
    fetch: async (url, init) => {
      fetches.push({ url: String(url), init });
      if (String(url).includes("/v1/follow")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, followed: true, reason: "open_job" }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(backgroundSrc, sandbox);
  const send = (message) =>
    new Promise((resolve) => {
      for (const fn of messageListeners) {
        const maybe = fn(message, {}, resolve);
        if (maybe !== true) resolve(undefined);
      }
    });
  return { fetches, send };
}

test("follow-ro posts scraped RO to Tools /v1/follow", async () => {
  const { fetches, send } = loadBackground();
  const result = await send({
    type: "follow-ro",
    event: "create_ro",
    fields: { ro: "1042", customer: "Whatcott", car: "Boxster" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.followed, true);
  const followFetches = fetches.filter((entry) => /\/v1\/follow$/.test(entry.url));
  assert.equal(followFetches.length, 1);
  const body = JSON.parse(followFetches[0].init.body);
  assert.equal(body.ro, "1042");
  assert.equal(body.event, "create");
  assert.equal(body.owner, "Whatcott");
  assert.equal(body.model, "Boxster");
  assert.equal(body.source, "alldata");
});

test("follow-ro skips empty RO without calling Tools", async () => {
  const { fetches, send } = loadBackground();
  const result = await send({ type: "follow-ro", event: "open", fields: {} });
  assert.equal(result.skipped, "missing_ro");
  assert.equal(fetches.length, 0);
});

test("follow-test-ping posts sample RO 1042 to /v1/follow", async () => {
  const { fetches, send } = loadBackground();
  const result = await send({ type: "follow-test-ping" });
  assert.equal(result.ok, true);
  assert.equal(result.followed, true);
  assert.equal(result.sampleRo, "1042");
  const followFetches = fetches.filter((entry) => /\/v1\/follow$/.test(entry.url));
  assert.equal(followFetches.length, 1);
  const body = JSON.parse(followFetches[0].init.body);
  assert.equal(body.ro, "1042");
  assert.equal(body.event, "open");
  assert.equal(body.owner, "Follow test");
  assert.equal(body.model, "Boxster");
  assert.equal(body.source, "alldata");
});

test("follow-ro still returns when Tools bridge is down", async () => {
  const fetches = [];
  const messageListeners = [];
  const store = {};
  const noopEvent = { addListener() {} };
  const browser = {
    runtime: {
      getManifest: () => ({ version: "0.1.56" }),
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      getBrowserInfo: async () => ({ name: "Firefox" }),
      onUpdateAvailable: noopEvent,
      onInstalled: noopEvent,
      onStartup: noopEvent,
      reload() {},
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async (patch) => Object.assign(store, patch),
      },
      onChanged: noopEvent,
    },
    tabs: { create: async () => ({ id: 1 }), onUpdated: noopEvent, onRemoved: noopEvent, onActivated: noopEvent, query: async () => [] },
    alarms: { create() {}, onAlarm: noopEvent },
    downloads: { download: async () => 1 },
    cookies: { onChanged: noopEvent, get: async () => null, set: async () => null, remove: async () => null },
    idle: { onStateChanged: noopEvent, setDetectionInterval() {} },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
  };
  const sandbox = {
    browser,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    AbortController,
    URL,
    Date,
    JSON,
    fetch: async (url, init) => {
      fetches.push({ url: String(url), init });
      throw new Error("bridge down");
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(backgroundSrc, sandbox);
  const send = (message) =>
    new Promise((resolve) => {
      for (const fn of messageListeners) {
        const maybe = fn(message, {}, resolve);
        if (maybe !== true) resolve(undefined);
      }
    });
  const result = await send({
    type: "follow-ro",
    event: "open",
    fields: { ro: "J006310" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, "bridge_unreachable");
  assert.equal(fetches.filter((entry) => /\/v1\/follow$/.test(entry.url)).length, 1);
});
