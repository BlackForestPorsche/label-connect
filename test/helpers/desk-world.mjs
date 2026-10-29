import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const GATE = "bf_shop_gate";

export function makeWorld(options = {}) {
  let now = 1_800_000_000_000;
  let timerId = 0;
  const timers = new Map();
  const world = {
    tools: { hasSession: false, person: "logan", token: "", sessionId: "", revoked: new Set(), n: 0 },
    mint: 0,
    exchangeGate: null,
    jar: new Map(),
    jarExp: new Map(),
    exchanges: 0,
    handoffs: 0,
    cookieError: false,
    reloads: [],
    tabUpdates: [],
    tabs: [{ id: 1, url: "https://shop.blackforestautomotive.com/" }],
    storage: {},
    bridgeDown: false,
    icons: [],
    fromGateCalls: [],
    pageExecutions: [],
    tabMessages: [],
    fetchPrincipal: "extension",
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
    const principal = world.fetchPrincipal || "extension";
    if (typeof options.liveFetch === "function") {
      return options.liveFetch(url, { ...init, __principal: principal });
    }
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
          locked: world.tools.expired ? false : !world.tools.hasSession,
          sessionExpired: Boolean(world.tools.expired),
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
        world.exchanges += 1;
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
      if (u.pathname === "/api/widget/session/handoff" && method === "POST") {
        world.handoffs += 1;
        const auth = String((init.headers && (init.headers.Authorization || init.headers.authorization)) || "");
        if (!auth.includes("Bearer ")) return json(401, { error: "unauthorized" });
        return json(200, {
          url: "https://shop.blackforestautomotive.com/api/widget/session/handoff/ticket-ticket-ticket-ticket-ticket",
        });
      }
      if (u.pathname === "/api/widget/session/from-gate") {
        const headers = init.headers || {};
        const cookieHeader = String(headers.Cookie || headers.cookie || "");
        const deskSetCookie = cookieHeader.split(";").some((part) => part.trim().startsWith(`${GATE}=`));
        const credentials = String(init.credentials || "");
        const principal = world.fetchPrincipal || "extension";
        world.fromGateCalls.push({ credentials, deskSetCookie, principal });
        // 0.1.42: credentials include sends the jar cookie. A Cookie header is not used.
        if (credentials === "include" && !deskSetCookie && world.jar.has(GATE)) {
          return json(200, {
            ok: true,
            token: `bearer-site-${++world.mint}`,
            expiresAt: new Date(now + 3_600_000).toISOString(),
            person: "logan",
          });
        }
        return json(401, { error: "unauthorized" });
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
      get: async ({ name, partitionKey }) => {
        if (world.cookieError) throw new Error("cookie store unavailable");
        world.cookieGets = world.cookieGets || [];
        world.cookieGets.push(partitionKey && partitionKey.topLevelSite ? partitionKey.topLevelSite : "");
        if (world.partitionOnly) {
          const site = partitionKey && partitionKey.topLevelSite;
          if (site !== "https://shop.blackforestautomotive.com") return null;
        }
        if (!world.jar.has(name)) return null;
        const cookie = { name, value: world.jar.get(name) };
        if (world.jarExp.has(name)) cookie.expirationDate = world.jarExp.get(name);
        return cookie;
      },
      getAll: async (details = {}) => {
        const one = await runtime.cookies.get(details);
        return one ? [one] : [];
      },
      set: async ({ name, value, expirationDate }) => {
        world.jar.set(name, value);
        if (expirationDate) world.jarExp.set(name, expirationDate);
        else world.jarExp.delete(name);
      },
      remove: async ({ name }) => {
        world.jar.delete(name);
        world.jarExp.delete(name);
      },
    },
    scripting: {
      executeScript: async ({ target, world: scriptWorld, func }) => {
        const tabId = target && target.tabId != null ? target.tabId : null;
        world.pageExecutions.push({ world: scriptWorld || "", tabId });
        const previous = world.fetchPrincipal;
        world.fetchPrincipal = "extension";
        try {
          if (scriptWorld !== "MAIN" || typeof func !== "function") return [{ result: { ok: false } }];
          const result = await func();
          return [{ result }];
        } finally {
          world.fetchPrincipal = previous || "extension";
        }
      },
    },
    tabs: {
      query: async () => world.tabs.slice(),
      sendMessage: async (tabId, message) => {
        world.tabMessages.push({ tabId, type: message && message.type });
        if (!message || message.type !== "page-post-from-gate") return null;
        const tab = world.tabs.find((item) => item.id === tabId);
        if (!tab || !String(tab.url || "").startsWith("https://shop.blackforestautomotive.com/")) return null;
        const previous = world.fetchPrincipal;
        world.fetchPrincipal = "page";
        try {
          const response = await fakeFetch("https://shop.blackforestautomotive.com/api/widget/session/from-gate", {
            method: "POST",
            credentials: "include",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: "{}",
          });
          let data = null;
          try {
            data = await response.json();
          } catch {
            data = null;
          }
          if (!response.ok || !data || !data.token) {
            return { ok: false, token: "", expiresAt: "", person: "" };
          }
          return {
            ok: true,
            token: String(data.token),
            expiresAt: String(data.expiresAt || ""),
            person: String(data.person || ""),
          };
        } finally {
          world.fetchPrincipal = previous || "extension";
        }
      },
      reload: async (id) => {
        world.reloads.push(id);
      },
      update: async (id, props) => {
        world.tabUpdates.push({ id, url: props && props.url });
        const tab = world.tabs.find((item) => item.id === id);
        if (tab && props && props.url) tab.url = props.url;
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
      await api.handleGateCookieRemoved({ cause: "explicit" });
    },
  };
}
