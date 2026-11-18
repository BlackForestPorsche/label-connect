import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const backgroundSrc = fs.readFileSync(path.join(root, "extension/shared/background.js"), "utf8");
const webhookMatch = backgroundSrc.match(/const DWIGHT_CREATE_RO_URL =\s*"([^"]+)"/);
const WEBHOOK = webhookMatch && webhookMatch[1];

function loadBackground({ token = "", webhookThrows = false, webhookStatus = 200 } = {}) {
  const fetches = [];
  const messageListeners = [];
  const store = {};
  if (token) store.dwightCreateRoToken = token;
  const noopEvent = { addListener() {} };
  const browser = {
    runtime: {
      getManifest: () => ({ version: "0.1.51" }),
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
    URL,
    Date,
    JSON,
    fetch: async (url, init) => {
      fetches.push({ url: String(url), init });
      if (String(url) === WEBHOOK) {
        if (webhookThrows) throw new Error("listener down");
        return {
          ok: webhookStatus >= 200 && webhookStatus < 300,
          status: webhookStatus,
          json: async () => ({ ok: true }),
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
        if (fn(message, {}, resolve) === true) return;
      }
      resolve(undefined);
    });
  return { fetches, send, store };
}

function webhookPosts(fetches) {
  return fetches.filter((call) => call.url === WEBHOOK);
}

test("the Create RO listener URL is shipped in the background script", () => {
  assert.equal(typeof WEBHOOK, "string");
  assert.match(WEBHOOK, /^https:\/\/api2\.cursor\.sh\/automations\/webhook\/[0-9a-f-]+$/);
});

test("Create RO listener POST includes the page fields and the bearer token", async () => {
  const { fetches, send } = loadBackground({ token: "desk-listener-test" });
  const result = await send({
    type: "dwight-nudge",
    event: "create_ro",
    fields: {
      ro: "J1001",
      customer: "Whatcott",
      car: "2018 Boxster",
      plate: "ABC123",
      vin: "WP0AB2A99KS123456",
      tech: "Logan",
      phone: "8015551212",
      email: "shop@example.com",
    },
  });
  assert.equal(result.ok, true);
  const posts = webhookPosts(fetches);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].init.method, "POST");
  assert.equal(posts[0].init.headers.Authorization, "Bearer desk-listener-test");
  assert.deepEqual(JSON.parse(posts[0].init.body), {
    event: "create_ro",
    ro: "J1001",
    customer: "Whatcott",
    car: "2018 Boxster",
    plate: "ABC123",
    vin: "WP0AB2A99KS123456",
    tech: "Logan",
  });
  assert.equal(posts[0].init.body.includes("desk-listener-test"), false);
  assert.equal(posts[0].init.body.includes("8015551212"), false);
  assert.equal(posts[0].init.body.includes("shop@example.com"), false);
});

test("missing RO still POSTs create_ro without phone or email", async () => {
  const { fetches, send } = loadBackground({ token: "desk-listener-test" });
  const result = await send({ type: "dwight-nudge", event: "create_ro", fields: { ro: "  " } });
  assert.equal(result.ok, true);
  const body = JSON.parse(webhookPosts(fetches)[0].init.body);
  assert.deepEqual(body, { event: "create_ro" });
  assert.equal(Object.hasOwn(body, "phone"), false);
  assert.equal(Object.hasOwn(body, "email"), false);
  assert.equal(Object.hasOwn(body, "lastName"), false);
});

test("Close, Cancel, and estimate actions POST the same fields", async () => {
  const { fetches, send } = loadBackground({ token: "desk-listener-test" });
  for (const event of ["close_ro", "cancel_ro", "estimate_saved", "estimate_emailed"]) {
    const result = await send({
      type: "dwight-nudge",
      event,
      fields: { ro: "J1001", customer: "Whatcott", email: "nope@example.com" },
    });
    assert.equal(result.ok, true, event);
  }
  const bodies = webhookPosts(fetches).map((post) => JSON.parse(post.init.body));
  assert.deepEqual(
    bodies.map((body) => body.event),
    ["close_ro", "cancel_ro", "estimate_saved", "estimate_emailed"],
  );
  for (const body of bodies) {
    assert.equal(body.ro, "J1001");
    assert.equal(body.customer, "Whatcott");
    assert.equal(Object.hasOwn(body, "email"), false);
  }
});

test("each click POSTs again with no local delay", async () => {
  const { fetches, send } = loadBackground({ token: "desk-listener-test" });
  await send({ type: "dwight-nudge", event: "create_ro", fields: { ro: "J1001" } });
  await send({ type: "dwight-nudge", event: "create_ro", fields: { ro: "J1002" } });
  const posts = webhookPosts(fetches);
  assert.equal(posts.length, 2);
  assert.deepEqual(
    posts.map((post) => JSON.parse(post.init.body).ro),
    ["J1001", "J1002"],
  );
});

test("missing sender key skips the POST", async () => {
  const { fetches, send } = loadBackground({ token: "" });
  const result = await send({ type: "dwight-nudge", event: "create_ro", fields: { ro: "J1001" } });
  assert.equal(result.skipped, "no-token");
  assert.equal(webhookPosts(fetches).length, 0);
});

test("listener failure does not reject, and label print does not call the listener", async () => {
  const { fetches, send } = loadBackground({ token: "desk-listener-test", webhookThrows: true });
  const nudge = await send({ type: "dwight-nudge", event: "create_ro", fields: { ro: "J1001" } });
  assert.equal(nudge.ok, false);
  const printed = await send({
    type: "print-ro",
    payload: { event: "create-ro", lastName: "Whatcott", model: "Camry", roNumber: "J1001" },
  });
  assert.equal(printed.error.includes("Labels"), true);
  assert.equal(webhookPosts(fetches).length, 1);
});

test("committed extension files do not contain a sender key", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(root);
  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    if (/crsr_[0-9a-f]{8,}/i.test(text)) hits.push(path.relative(root, file));
  }
  assert.deepEqual(hits, []);
});

test("both Desk manifests allow the Create RO listener host", () => {
  const released = JSON.parse(fs.readFileSync(path.join(root, "extension/version.json"), "utf8"));
  for (const rel of ["extension/firefox/manifest.json", "extension/chromium/manifest.json"]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
    assert.ok(manifest.host_permissions.includes("https://api2.cursor.sh/*"), rel);
    assert.equal(manifest.version, released.version);
  }
});

test("the popup can tell whether the last RO event reached the listener, without the key", async () => {
  const sentOk = loadBackground({ token: "desk-listener-test" });
  assert.equal((await sentOk.send({ type: "dwight-nudge", event: "close_ro", fields: { ro: "J1001" } })).ok, true);
  assert.equal(sentOk.store.deskListenerLast.event, "close_ro");
  assert.equal(sentOk.store.deskListenerLast.ok, true);
  assert.equal(sentOk.store.deskListenerLast.status, 200);
  assert.ok(sentOk.store.deskListenerLast.at > 0);

  const refused = loadBackground({ token: "desk-listener-test", webhookStatus: 401 });
  assert.equal((await refused.send({ type: "dwight-nudge", event: "create_ro", fields: {} })).ok, false);
  assert.deepEqual(
    [refused.store.deskListenerLast.ok, refused.store.deskListenerLast.status],
    [false, 401],
  );

  const down = loadBackground({ token: "desk-listener-test", webhookThrows: true });
  assert.equal((await down.send({ type: "dwight-nudge", event: "create_ro", fields: {} })).ok, false);
  assert.deepEqual([down.store.deskListenerLast.ok, down.store.deskListenerLast.status], [false, 0]);

  const noKey = loadBackground({});
  await noKey.send({ type: "dwight-nudge", event: "create_ro", fields: {} });
  assert.equal("deskListenerLast" in noKey.store, false, "nothing is recorded when nothing is sent");

  for (const world of [sentOk, refused, down]) {
    assert.equal(JSON.stringify(world.store.deskListenerLast).includes("desk-listener-test"), false);
  }
});

test("desk-status answers with nothing to show when the shared helpers are not loaded", async () => {
  const { send } = loadBackground({});
  assert.deepEqual({ ...(await send({ type: "desk-status" })) }, { ok: false });
});
