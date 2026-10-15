import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

/**
 * Runs the real extension/shared/lot-names.js against a fake Tools bridge, fake
 * shop and fake clock, then walks lock/unlock in both directions with 10s gaps.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GATE = "bf_shop_gate";

function makeWorld() {
  let now = 1_800_000_000_000;
  let timerId = 0;
  const timers = new Map();
  const world = {
    tools: { hasSession: false, person: "logan", token: "", sessionId: "", revoked: new Set(), n: 0 },
    mint: 0,
    exchangeGate: null,
    jar: new Map(),
    reloads: [],
    storage: {},
    bridgeDown: false,
    icons: [],
  };

  const fakeSetTimeout = (fn, ms = 0) => {
    const id = ++timerId;
    timers.set(id, { at: now + ms, fn });
    return id;
  };
  const fakeClearTimeout = (id) => timers.delete(id);

  const json = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  async function fakeFetch(url, init = {}) {
    const method = String(init.method || "GET").toUpperCase();
    const u = new URL(url);
    if (u.hostname === "127.0.0.1") {
      if (world.bridgeDown) throw new TypeError("down");
      if (u.pathname === "/health") {
        return json(200, {
          ok: true,
          hasSession: world.tools.hasSession,
          person: world.tools.hasSession ? world.tools.person : "",
          sessionId: world.tools.hasSession ? world.tools.sessionId : "",
          locked: !world.tools.hasSession,
        });
      }
      if (u.pathname === "/v1/widget-session" && method === "GET") {
        return world.tools.hasSession
          ? json(200, { token: world.tools.token, expiresAt: new Date(now + 3_600_000).toISOString(), person: world.tools.person })
          : json(404, { ok: false, error: "no_session" });
      }
      if (u.pathname === "/v1/widget-session" && method === "POST") {
        const body = JSON.parse(init.body || "{}");
        const id = `id-${body.token}`;
        if (world.tools.revoked.has(id)) return json(409, { ok: false, error: "locked" });
        if (!world.dropPublish) {
          world.tools.hasSession = true;
          world.tools.token = body.token;
          world.tools.sessionId = id;
        }
        return json(200, { ok: true });
      }
      if ((u.pathname === "/v1/widget-session" && method === "DELETE") || u.pathname === "/v1/lock") {
        if (world.tools.sessionId) world.tools.revoked.add(world.tools.sessionId);
        world.tools.hasSession = false;
        return json(200, { ok: true, locked: true });
      }
    }
    if (u.hostname === "shop.blackforestautomotive.com") {
      if (u.pathname === "/api/widget/session/exchange") {
        if (world.exchangeGate) await world.exchangeGate;
        if (world.exchangeFails > 0) {
          world.exchangeFails -= 1;
          return json(500, { ok: false });
        }
        return json(200, {
          ok: true,
          person: "logan",
          gateToken: "v2.gate",
          expiresAt: new Date(now + 3_600_000).toISOString(),
        });
      }
      if (u.pathname === "/api/widget/session/from-gate") {
        if (!world.jar.has(GATE)) return json(401, { error: "unauthorized" });
        return json(200, {
          token: `bearer-site-${++world.mint}`,
          expiresAt: new Date(now + 3_600_000).toISOString(),
          person: "logan",
        });
      }
    }
    return json(404, {});
  }

  const runtime = {
    storage: {
      local: {
        get: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter((k) => k in world.storage).map((k) => [k, world.storage[k]]));
        },
        set: async (obj) => {
          Object.assign(world.storage, obj);
        },
      },
    },
    cookies: {
      get: async ({ name }) => (world.jar.has(name) ? { name, value: world.jar.get(name) } : null),
      set: async ({ name, value }) => {
        world.jar.set(name, value);
      },
      remove: async ({ name }) => {
        world.jar.delete(name);
      },
    },
    tabs: {
      query: async () => [{ id: 1, url: "https://shop.blackforestautomotive.com/" }],
      reload: async (id) => {
        world.reloads.push(id);
      },
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setIcon: async ({ imageData }) => {
        world.icons.push(imageData[16].tag);
      },
    },
    browserAction: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    runtime: { getManifest: () => ({ version: "0.1.26" }) },
  };

  const FakeDate = class extends Date {
    static now() {
      return now;
    }
  };

  let api = null;
  const boot = () => {
  const context = vm.createContext({
    console,
    URL,
    Date: FakeDate,
    JSON,
    Promise,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: fakeFetch,
    OffscreenCanvas: class {
      getContext() {
        const ctx = {
          fillStyle: "",
          fill() {
            ctx.painted = ctx.fillStyle;
          },
          getImageData: () => ({ tag: ctx.painted === "#2e7d32" ? "green" : "red" }),
        };
        for (const fn of ["clearRect", "beginPath", "arc", "stroke", "moveTo", "lineTo"]) ctx[fn] = () => {};
        return ctx;
      }
    },
    browser: runtime,
    chrome: runtime,
  });
  context.globalThis = context;
  for (const file of ["config.js", "lot-names.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "extension/shared", file), "utf8"), context, { filename: file });
  }
  api = context.AllDataRoLabels;
  };
  boot();

  async function settle() {
    for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r));
  }

  async function advance(ms) {
    const target = now + ms;
    while (true) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next.t.at)) next = { id, t };
      if (!next) break;
      timers.delete(next.id);
      now = Math.max(now, next.t.at);
      next.t.fn();
      await settle();
    }
    now = target;
    await settle();
  }

  /** Poll like the 400ms background tick for `ms` of fake time. */
  async function run(ms) {
    for (let t = 0; t < ms; t += 400) {
      await api.tickBridgeSyncPoll();
      await advance(400);
    }
  }

  const gate = () => world.jar.has(GATE);

  return {
    world,
    get api() {
      return api;
    },
    boot,
    settle,
    run,
    advance,
    gate,
    toolsUnlock: () => {
      world.tools.n += 1;
      world.tools.token = `tools-${world.tools.n}`;
      world.tools.sessionId = `id-${world.tools.token}`;
      world.tools.hasSession = true;
    },
    toolsLock: () => {
      if (world.tools.sessionId) world.tools.revoked.add(world.tools.sessionId);
      world.tools.hasSession = false;
    },
    siteUnlockPageLoad: async () => {
      world.jar.set(GATE, "v2.site");
      await api.importSiteGateSession();
    },
    siteLock: async () => {
      world.jar.delete(GATE);
      await advance(700);
      await api.handleGateCookieRemoved();
    },
  };
}

const GAP = 10_000;

test("10s gaps: Tools unlock → Tools lock → site unlock → site lock → Tools unlock → site lock", async () => {
  const w = makeWorld();
  await w.run(1_000);
  assert.equal(w.gate(), false);

  w.toolsUnlock();
  await w.run(GAP);
  assert.equal(w.gate(), true, "Tools unlock → site gets gate");

  w.toolsLock();
  await w.run(GAP);
  assert.equal(w.gate(), false, "Tools lock → site gate cleared (10s after unlock)");

  await w.siteUnlockPageLoad();
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, true, "site unlock → Tools unlocked");
  assert.equal(w.gate(), true, "site unlock must not be cleared by Desk");

  await w.siteLock();
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, false, "site lock → Tools locked (10s after unlock)");
  assert.equal(w.gate(), false);

  w.toolsUnlock();
  await w.run(GAP);
  assert.equal(w.gate(), true, "Tools unlock after site lock → site gets gate");

  await w.siteLock();
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, false, "site lock again → Tools locked");
});

test("Tools lock 10s after a site unlock clears the site gate", async () => {
  const w = makeWorld();
  await w.run(800);
  await w.siteUnlockPageLoad();
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, true);
  w.toolsLock();
  await w.run(GAP);
  assert.equal(w.gate(), false);
});

test("site lock 10s after a Tools unlock locks Tools", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  assert.equal(w.gate(), true);
  await w.siteLock();
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, false);
});

test("site unlock 10s after a Tools lock unlocks Tools and keeps the gate", async () => {
  const w = makeWorld();
  w.toolsUnlock();
  await w.run(2_000);
  w.toolsLock();
  await w.run(GAP);
  assert.equal(w.gate(), false);
  await w.siteUnlockPageLoad();
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, true);
  assert.equal(w.gate(), true);
});

test("a fresh site unlock is not cleared while Tools is still catching up", async () => {
  const w = makeWorld();
  await w.run(800);
  w.world.dropPublish = true;
  await w.siteUnlockPageLoad();
  await w.run(5_000);
  assert.equal(w.gate(), true, "hold protects the unlock until Tools reflects it");
  w.world.dropPublish = false;
  await w.api.publishSessionToToolsBridge({ token: "t-fresh", expiresAt: new Date().toISOString(), person: "logan" });
  await w.run(1_000);
  assert.equal(w.world.tools.hasSession, true);
  assert.equal(w.gate(), true);
});

test("Tools lock replays after a lock edge landed inside the hold", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(1_200);
  w.api.armUnlockHold();
  w.world.tools.hasSession = false;
  await w.api.tickBridgeSyncPoll();
  assert.equal(w.gate(), true, "still held");
  await w.advance(40_000);
  await w.run(1_200);
  assert.equal(w.gate(), false, "edge replayed after hold ended");
});

test("site lock stays locked for 10 minutes through every Desk trigger", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  assert.equal(w.gate(), true);

  await w.siteLock();
  await w.run(2_000);
  assert.equal(w.world.tools.hasSession, false);
  assert.equal(w.gate(), false);

  for (let minute = 0; minute < 10; minute++) {
    await w.run(30_000);
    await w.api.tryAutoUnlock({ force: false, reason: "shop-tab-complete" });
    await w.api.tryAutoUnlock({ force: false, reason: "idle-active" });
    if (minute % 5 === 4) await w.api.tryAutoUnlock({ force: false, reason: "alarm" });
    await w.run(30_000);
    assert.equal(w.gate(), false, `gate stays absent at minute ${minute + 1}`);
    assert.equal(w.world.tools.hasSession, false, `Tools stays locked at minute ${minute + 1}`);
  }
});

test("lock survives a suspended and restarted background page", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  await w.siteLock();
  await w.run(1_000);
  assert.equal(w.world.tools.hasSession, false);

  w.boot();
  await w.api.tryAutoUnlock({ force: true, reason: "startup" });
  await w.run(3_000);
  assert.equal(w.gate(), false, "startup exchange must not remint");
  assert.equal(w.world.tools.hasSession, false);
  await w.advance(150_000);
  await w.api.tryAutoUnlock({ force: false, reason: "shop-tab-complete" });
  await w.run(2_000);
  assert.equal(w.gate(), false, "still locked 2.5 minutes later");
});

test("a site lock the cookie listener only sees after wake still sticks", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  w.world.jar.delete(GATE);
  w.boot();
  await w.api.tryAutoUnlock({ force: false, reason: "shop-tab-complete" });
  await w.api.handleGateCookieRemoved();
  await w.run(5_000);
  assert.equal(w.world.tools.hasSession, false, "Tools locked");
  assert.equal(w.gate(), false);
});

test("an exchange already in flight when the site locks is discarded", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  w.world.jar.delete(GATE);
  let release;
  w.world.exchangeGate = new Promise((r) => {
    release = r;
  });
  const pending = w.api.exchangeWidgetSessionToGate(w.world.tools.token);
  await w.settle();
  await w.api.syncSiteLockToTools({ reloadShopTabs: false });
  release();
  const result = await pending;
  w.world.exchangeGate = null;
  assert.equal(result.ok, undefined);
  assert.equal(w.gate(), false, "stale exchange must not set the gate");
  assert.equal(w.world.tools.hasSession, false);
});

test("a revoked Tools session coming back is relocked, not exchanged", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  const staleId = w.world.tools.sessionId;
  const staleToken = w.world.tools.token;
  await w.siteLock();
  await w.run(1_000);
  w.world.tools.hasSession = true;
  w.world.tools.sessionId = staleId;
  w.world.tools.token = staleToken;
  await w.run(3_000);
  assert.equal(w.world.tools.hasSession, false, "relocked");
  assert.equal(w.gate(), false);
});

test("Tools unlock any time after a site lock opens the site again", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  await w.siteLock();
  await w.run(1_000);
  await w.advance(600_000);
  w.toolsUnlock();
  await w.run(3_000);
  assert.equal(w.gate(), true, "intentional Tools unlock mirrors to the site");
});

test("site PIN unlock after a site lock releases the latch", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  await w.siteLock();
  await w.run(1_000);
  await w.siteUnlockPageLoad();
  await w.run(3_000);
  assert.equal(w.world.tools.hasSession, true, "Tools follows the site unlock");
  assert.equal(w.gate(), true);
  assert.equal(w.api.siteLatchState(), null);
});

test("a failed exchange after Tools unlock is retried", async () => {
  const w = makeWorld();
  await w.run(800);
  w.world.exchangeFails = 2;
  w.toolsUnlock();
  await w.run(12_000);
  assert.equal(w.gate(), true, "site follows Tools after retries");
});

test("toolbar icon is green while logged in and red when logged out", async () => {
  const w = makeWorld();
  await w.api.refreshUnlockBadge();
  assert.equal(w.world.icons.at(-1), "red");
  w.toolsUnlock();
  await w.run(GAP);
  assert.equal(w.world.icons.at(-1), "green");
  assert.equal(w.world.storage.deskSessionPerson, "logan");
  await w.siteLock();
  await w.run(GAP);
  assert.equal(w.world.icons.at(-1), "red");
  w.toolsUnlock();
  await w.run(GAP);
  assert.equal(w.world.icons.at(-1), "green");
});
