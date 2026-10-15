import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isLocalClient,
  isNewerVersion,
  readDeskVersion,
  resolveLabelConnectRoot,
  stageHubUploadZip,
  fetchDeskUpdateFeed,
  stageSignedXpiFromFeed,
} from "../shared/desk-update.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fakeReq({ remoteAddress, host }) {
  return {
    socket: { remoteAddress },
    headers: host ? { host } : {},
  };
}

test("isLocalClient accepts loopback IPv4/IPv6", () => {
  assert.equal(isLocalClient(fakeReq({ remoteAddress: "127.0.0.1", host: "127.0.0.1:8080" })), true);
  assert.equal(isLocalClient(fakeReq({ remoteAddress: "::1", host: "localhost:8080" })), true);
  assert.equal(isLocalClient(fakeReq({ remoteAddress: "::ffff:127.0.0.1", host: "127.0.0.1" })), true);
});

test("isLocalClient rejects LAN clients", () => {
  assert.equal(isLocalClient(fakeReq({ remoteAddress: "192.168.1.50", host: "192.168.1.50:8080" })), false);
  assert.equal(isLocalClient(fakeReq({ remoteAddress: "10.0.0.8", host: "labels.local" })), false);
});

test("resolveLabelConnectRoot finds this checkout", async () => {
  const found = await resolveLabelConnectRoot(root);
  assert.equal(found, root);
  const version = await readDeskVersion(found);
  assert.match(String(version), /^\d+\.\d+\.\d+/);
});

test("popup Update never stages a Desktop XPI or tells Logan to Install from File", async () => {
  const { readFile } = await import("node:fs/promises");
  const popup = await readFile(path.join(root, "extension/shared/popup.js"), "utf8");
  const background = await readFile(path.join(root, "extension/shared/background.js"), "utf8");
  assert.equal(/update-desk-extension\.sh/.test(popup), false);
  assert.equal(/apply-update/.test(background), true);
  assert.equal(/\/api\/update-desk-extension/.test(background), false);
  assert.equal(/signed_staged/.test(background), false);
  assert.equal(/signed_staged/.test(popup), false);
  assert.equal(/NOT applied/.test(background), false);
  assert.equal(/NOT applied/.test(popup), false);
  assert.equal(/Install Add-on From File/.test(background), false);
  assert.equal(/onUpdateAvailable/.test(background), true);
  assert.equal(/requestUpdateCheck\(/.test(background), false);
  assert.equal(/firefox_xpi_prompt/.test(background), true);
  assert.equal(/updates\.json/.test(background), true);
  assert.equal(/startToolsBridgeWatch/.test(await readFile(path.join(root, "extension/shared/lot-names.js"), "utf8")), true);
});

function loadBackground({ feedVersion, localVersion = "0.1.28" }) {
  const calls = { tabs: [], fetches: [], reloads: 0 };
  const noopEvent = { addListener() {} };
  const messageListeners = [];
  const feed = {
    addons: {
      "black-forest-desk@blackforestautomotive.com": {
        updates: [
          {
            version: feedVersion,
            update_link: `https://example.test/Black.Forest.Desk-${feedVersion}.xpi`,
          },
        ],
      },
    },
  };
  const store = {};
  const runtimeApi = {
    getManifest: () => ({ version: localVersion }),
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    getBrowserInfo: async () => ({ name: "Firefox" }),
    onUpdateAvailable: noopEvent,
    onInstalled: noopEvent,
    onStartup: noopEvent,
    reload: () => {
      calls.reloads += 1;
    },
  };
  const browser = {
    runtime: runtimeApi,
    storage: {
      local: {
        get: async () => ({}),
        set: async (patch) => Object.assign(store, patch),
      },
      onChanged: noopEvent,
    },
    tabs: {
      create: async (opts) => {
        calls.tabs.push(opts);
        return { id: 1 };
      },
      onUpdated: noopEvent,
      onRemoved: noopEvent,
      onActivated: noopEvent,
      query: async () => [],
    },
    alarms: { create() {}, onAlarm: noopEvent },
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
    fetch: async (url) => {
      calls.fetches.push(String(url));
      if (String(url).includes("updates.json")) return { ok: true, status: 200, json: async () => feed };
      return { ok: false, status: 404, json: async () => ({}) };
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "extension/shared/background.js"), "utf8"), sandbox);
  const send = (message) =>
    new Promise((resolve) => {
      for (const fn of messageListeners) {
        if (fn(message, {}, resolve) === true) return;
      }
      resolve(undefined);
    });
  return { calls, send };
}

test("apply-update on Firefox without requestUpdateCheck opens the signed XPI prompt, no staging", async () => {
  const { calls, send } = loadBackground({ feedVersion: "0.1.29" });
  const result = await send({ type: "apply-update" });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "firefox_xpi_prompt");
  assert.equal(result.applied, false);
  assert.deepEqual(
    calls.tabs.map((t) => t.url),
    ["https://example.test/Black.Forest.Desk-0.1.29.xpi"],
  );
  assert.equal(calls.fetches.some((u) => u.includes("/api/update-desk-extension")), false);
  assert.equal(/NOT applied|Install Add-on From File|Desktop/.test(result.message), false);
});

test("apply-update says up to date when the feed is not newer", async () => {
  const { calls, send } = loadBackground({ feedVersion: "0.1.28" });
  const result = await send({ type: "apply-update" });
  assert.equal(result.mode, "up_to_date");
  assert.equal(calls.tabs.length, 0);
});

test("isNewerVersion compares semver-ish strings", () => {
  assert.equal(isNewerVersion("0.1.18", "0.1.17"), true);
  assert.equal(isNewerVersion("0.1.17", "0.1.17"), false);
  assert.equal(isNewerVersion("0.1.16", "0.1.17"), false);
});

test("fetchDeskUpdateFeed + stageSignedXpiFromFeed write Desktop XPI", async () => {
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const fakeHome = await mkdtemp(path.join(tmpdir(), "desk-feed-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  const payload = Buffer.from("PK\x03\x04fakeMETA-INF/mozilla.rsa\x00signed-bytes");
  const hash = (await import("node:crypto")).createHash("sha256").update(payload).digest("hex");
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("updates.json")) {
      return {
        ok: true,
        async json() {
          return {
            addons: {
              "black-forest-desk@blackforestautomotive.com": {
                updates: [
                  {
                    version: "9.9.8",
                    update_link: "https://example.test/Black.Forest.Desk-9.9.8.xpi",
                    update_hash: `sha256:${hash}`,
                  },
                ],
              },
            },
          };
        },
      };
    }
    return {
      ok: true,
      async arrayBuffer() {
        return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
      },
    };
  };
  try {
    const feed = await fetchDeskUpdateFeed(fetchImpl);
    assert.equal(feed.version, "9.9.8");
    const staged = await stageSignedXpiFromFeed(feed, { fetchImpl });
    assert.equal(staged.signed, true);
    assert.equal(staged.path, path.join(fakeHome, "Desktop", "Black.Forest.Desk-9.9.8.xpi"));
    const copied = await readFile(staged.path);
    assert.equal(Buffer.compare(copied, payload), 0);
  } finally {
    process.env.HOME = prevHome;
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("stageHubUploadZip copies self-dist pack to Desktop", async () => {
  const { mkdtemp, rm, mkdir, writeFile, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { homedir } = await import("node:os");
  const fakeRoot = await mkdtemp(path.join(tmpdir(), "desk-hub-"));
  const dist = path.join(fakeRoot, "extension", "dist");
  await mkdir(dist, { recursive: true });
  const payload = Buffer.from("fake-xpi-bytes");
  await writeFile(path.join(dist, "Black.Forest.Desk-9.9.9.xpi"), payload);
  const prevHome = process.env.HOME;
  const fakeHome = await mkdtemp(path.join(tmpdir(), "desk-home-"));
  process.env.HOME = fakeHome;
  try {
    const dest = await stageHubUploadZip(fakeRoot, "9.9.9");
    assert.equal(dest, path.join(fakeHome, "Desktop", "Black.Forest.Desk-9.9.9-hub-upload.zip"));
    const copied = await readFile(dest);
    assert.equal(Buffer.compare(copied, payload), 0);
  } finally {
    process.env.HOME = prevHome;
    await rm(fakeRoot, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
  // silence unused import warning if bundlers care
  assert.equal(typeof homedir, "function");
});
