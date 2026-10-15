/**
 * Real-Chromium smoke for the Desk MV3 package (extension/chromium).
 *
 *   npm run test:chromium
 *
 * Loads the unpacked extension into Chrome/Edge/Chromium with mock Tools (:8788),
 * Labels (:8080) and shop (https, mapped via --host-resolver-rules) servers and drives the
 * real service worker: toolbar state, Tools → website unlock, sticky site lock, SW restart,
 * Create RO print, SSF lot dropdown and the Chromium Update UX.
 *
 * Needs playwright-core (devDependency) and a Chromium-family browser:
 *   DESK_CHROME=/path/to/chrome   (default: google-chrome / chromium on PATH)
 * Headed Chrome needs a display (xvfb-run on CI).
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXT = path.join(root, "extension/chromium");
const require = createRequire(import.meta.url);

let chromium;
try {
  ({ chromium } = require("playwright-core"));
} catch {
  console.log("playwright-core not installed — skipping Chromium e2e (npm install)");
  process.exit(0);
}

function findChrome() {
  if (process.env.DESK_CHROME) return process.env.DESK_CHROME;
  for (const name of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "microsoft-edge"]) {
    try {
      return execFileSync("which", [name], { encoding: "utf8" }).trim();
    } catch {
      // keep looking
    }
  }
  return "";
}

const chromePath = findChrome();
if (!chromePath) {
  console.log("No Chrome/Chromium found — skipping Chromium e2e (set DESK_CHROME)");
  process.exit(0);
}

const SHOP_PORT = 18443;
const TOOLS_PORT = 8788;
const LABELS_PORT = 8080;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 8000, step = 100, what = "condition" } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(step);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
}

const tools = { session: null, hits: [], nextId: 1 };
const shop = { exchanges: 0, gate: "gate-abc", requests: [] };
const labels = { prints: [] };

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function toolsUnlock(person = "logan") {
  tools.session = {
    token: `tok-${tools.nextId}`,
    expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
    person,
    sessionId: `sess-${tools.nextId++}`,
  };
}

function startTools() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    tools.hits.push(`${req.method} ${url.pathname}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        hasSession: Boolean(tools.session),
        sessionId: tools.session ? tools.session.sessionId : "",
        person: tools.session ? tools.session.person : "",
        locked: !tools.session,
      });
    }
    if (url.pathname === "/v1/widget-session") {
      if (req.method === "GET") {
        if (!tools.session) return json(res, 404, { error: "no_session" });
        return json(res, 200, tools.session);
      }
      if (req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        tools.session = {
          token: body.token,
          expiresAt: body.expiresAt,
          person: body.person || "logan",
          sessionId: `sess-${tools.nextId++}`,
        };
        return json(res, 200, { ok: true });
      }
      if (req.method === "DELETE") {
        tools.session = null;
        return json(res, 200, { ok: true });
      }
    }
    if (req.method === "POST" && url.pathname === "/v1/lock") {
      tools.session = null;
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "not_found" });
  });
}

function startLabels() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname === "/api/print-ro") {
      const body = JSON.parse((await readBody(req)) || "{}");
      labels.prints.push(body);
      return json(res, 200, { ok: true, printed: true });
    }
    return json(res, 404, { error: "not_found" });
  });
}

const ALLDATA_HTML = `<!doctype html><html><body>
<h1>Manage Online</h1>
<div class="form-row"><span>Customer</span><span>J. Whatcott</span></div>
<div class="form-row"><span>Model</span><span>Boxster</span></div>
<button class="go" type="button">Create R/O</button>
<div id="ok" hidden>Repair order created</div>
<script>
document.querySelector('.go').addEventListener('click', () => {
  setTimeout(() => {
    document.querySelector('.go').remove();
    document.getElementById('ok').hidden = false;
  }, 150);
});
</script></body></html>`;

const SSF_HTML = `<!doctype html><html><body>
<h1>Checkout</h1>
<label for="po">Order reference</label>
<input id="po" name="orderReference" placeholder="PO # / RO #">
</body></html>`;

function startShop(cert) {
  return https.createServer(cert, async (req, res) => {
    const url = new URL(req.url, "https://x");
    const host = String(req.headers.host || "");
    shop.requests.push(`${req.method} ${host}${url.pathname}`);
    const cookie = String(req.headers.cookie || "");
    if (host.startsWith("manageonline.alldata.com")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(ALLDATA_HTML);
    }
    if (host.startsWith("www.ssfautoparts.com")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(SSF_HTML);
    }
    if (url.pathname === "/api/widget/session/exchange" && req.method === "POST") {
      const auth = String(req.headers.authorization || "");
      if (!auth.startsWith("Bearer tok-") && !auth.startsWith("Bearer lot-")) {
        return json(res, 401, { error: "unauthorized" });
      }
      shop.exchanges += 1;
      return json(res, 200, {
        ok: true,
        gateToken: shop.gate,
        person: tools.session?.person || "logan",
        expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
      });
    }
    if (url.pathname === "/api/widget/session/from-gate" && req.method === "POST") {
      if (!cookie.includes("bf_shop_gate=")) return json(res, 401, { error: "unauthorized" });
      return json(res, 200, {
        token: "lot-from-gate",
        expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
        person: "logan",
      });
    }
    if (url.pathname === "/api/widget/views/lot") {
      const auth = String(req.headers.authorization || "");
      if (!auth.startsWith("Bearer ")) return json(res, 401, { error: "unauthorized" });
      return json(res, 200, {
        items: [{ label: "Whatcott" }, { label: "Anna Baker" }, { label: "No name" }, { label: "Chen, Li" }],
      });
    }
    if (url.pathname === "/_serverFn/lock" && req.method === "POST") {
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "bf_shop_gate=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None",
      });
      return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>shop ${url.pathname}</title><body>shop ${url.pathname}</body>`);
  });
}

let ctx;
let userDataDir;
let sw;
let extId;
const servers = [];

async function listen(server, port, host = "127.0.0.1") {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  servers.push(server);
}

async function worker() {
  const found = ctx.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${extId}/`));
  if (found) return found;
  return ctx.waitForEvent("serviceworker", { timeout: 10_000 });
}

function swEval(fn, arg) {
  return sw.evaluate(fn, arg);
}

async function getCookie() {
  const cookies = await ctx.cookies("https://shop.blackforestautomotive.com/");
  return cookies.find((c) => c.name === "bf_shop_gate") || null;
}

async function storage(keys) {
  return swEval((k) => chrome.storage.local.get(k), keys);
}

before(async () => {
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-e2e-cert-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", path.join(certDir, "key.pem"), "-out", path.join(certDir, "cert.pem"),
    "-days", "2", "-subj", "/CN=desk-e2e",
  ], { stdio: "ignore" });
  const cert = {
    key: fs.readFileSync(path.join(certDir, "key.pem")),
    cert: fs.readFileSync(path.join(certDir, "cert.pem")),
  };
  await listen(startTools(), TOOLS_PORT);
  await listen(startLabels(), LABELS_PORT);
  await listen(startShop(cert), SHOP_PORT);

  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-e2e-profile-"));
  ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromePath,
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      "--enable-unsafe-extension-debugging",
      "--no-sandbox",
      "--ignore-certificate-errors",
      `--host-resolver-rules=MAP shop.blackforestautomotive.com 127.0.0.1:${SHOP_PORT},MAP manageonline.alldata.com 127.0.0.1:${SHOP_PORT},MAP www.ssfautoparts.com 127.0.0.1:${SHOP_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  // Branded Chrome 137+ ignores --load-extension; CDP loadUnpacked is the supported path.
  const cdp = await ctx.browser().newBrowserCDPSession();
  ({ id: extId } = await cdp.send("Extensions.loadUnpacked", { path: EXT }));
  sw = await worker();
});

after(async () => {
  try {
    await ctx?.close();
  } catch {
    // ignore
  }
  for (const s of servers) s.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

test("service worker boots with shared helpers and reports logged out", async () => {
  await until(() => swEval(() => typeof globalThis.AllDataRoLabels?.tryAutoUnlock === "function"), {
    what: "lot-names loaded in the service worker",
  });
  const manifest = await swEval(() => chrome.runtime.getManifest());
  assert.equal(manifest.background.service_worker, "background.js");
  await until(
    async () => (await swEval(() => chrome.action.getTitle({}))).includes("logged out"),
    { what: "logged-out toolbar title" },
  );
});

test("Tools unlock → website bf_shop_gate lands in the Chromium jar and toolbar turns logged in", async () => {
  toolsUnlock("logan");
  await until(async () => (await getCookie())?.value === shop.gate, { timeout: 10_000, what: "gate cookie" });
  const cookie = await getCookie();
  assert.equal(cookie.secure, true);
  assert.equal(cookie.httpOnly, true);
  await until(
    async () => (await swEval(() => chrome.action.getTitle({}))).includes("logged in"),
    { what: "logged-in toolbar title" },
  );
  const stored = await storage(["shopWidgetToken", "deskSessionPerson"]);
  assert.ok(stored.shopWidgetToken);
  assert.equal(stored.deskSessionPerson, "logan");
});

test("popup shows Logged in as Name and hides login boxes", async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`);
  await page.waitForSelector("#loggedIn:not([hidden])", { timeout: 8000 });
  assert.match(await page.textContent("#loggedIn"), /Logged in as Logan/);
  assert.equal(await page.isHidden("#loginBox"), true);
  assert.match(await page.textContent("#version"), /\d+\.\d+\.\d+/);
  await page.close();
});

test("Tools lock → website gate cleared and toolbar turns logged out", async () => {
  await until(() => swEval(() => !globalThis.AllDataRoLabels.unlockHoldActive()), {
    timeout: 40_000,
    what: "unlock hold to lapse after the exchange",
  });
  tools.session = null;
  await until(async () => (await getCookie()) === null, { timeout: 10_000, what: "gate cleared" });
  await until(
    async () => (await swEval(() => chrome.action.getTitle({}))).includes("logged out"),
    { what: "logged-out title" },
  );
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`);
  await page.waitForSelector("#loginBox:not([hidden])", { timeout: 8000 });
  assert.equal(await page.isHidden("#loggedIn"), true);
  await page.close();
});

test("website lock latches: Tools is locked and the same session never re-exchanges", async () => {
  toolsUnlock("logan");
  await until(async () => (await getCookie())?.value === shop.gate, { timeout: 10_000, what: "gate cookie" });
  const page = await ctx.newPage();
  await page.goto("https://shop.blackforestautomotive.com/");
  await sleep(1500);
  const sameSession = { ...tools.session };
  const exchangesBefore = shop.exchanges;
  await page.evaluate(() => fetch("/_serverFn/lock", { method: "POST" }));
  await until(async () => (await getCookie()) === null, { timeout: 10_000, what: "gate removed by site lock" });
  await until(() => tools.session === null, { timeout: 10_000, what: "Tools locked by site lock" });

  const latch = await swEval(() => chrome.storage.local.get("deskSiteLatch"));
  assert.ok(latch.deskSiteLatch, "latch persisted in storage");

  // Tools comes back with the very session that was locked: must stay locked.
  tools.session = sameSession;
  await sleep(3500);
  assert.equal(tools.session, null, "latched session is re-locked, never revived");
  assert.equal(await getCookie(), null);
  assert.equal(shop.exchanges, exchangesBefore);
  await page.close();
});

test("latch survives a service-worker kill, then a new Tools unlock releases it", async () => {
  const cdp = await ctx.browser().newBrowserCDPSession();
  await cdp.send("ServiceWorker.enable").catch(() => {});
  const targets = await cdp.send("Target.getTargets");
  const swTarget = targets.targetInfos.find((t) => t.type === "service_worker" && t.url.includes(extId));
  assert.ok(swTarget, "found extension service worker target");
  await cdp.send("Target.closeTarget", { targetId: swTarget.targetId }).catch(() => {});
  await sleep(500);

  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`);
  sw = await until(
    async () => ctx.serviceWorkers().find((w) => w.url().includes(extId)),
    { what: "service worker restarted", timeout: 15_000 },
  );
  await until(() => swEval(() => typeof globalThis.AllDataRoLabels?.siteLatchState === "function"), {
    what: "helpers reloaded",
  });
  await swEval(() => globalThis.AllDataRoLabels.latchReady);
  const latch = await swEval(() => globalThis.AllDataRoLabels.siteLatchState());
  assert.ok(latch, "latch reloaded from storage after SW restart");

  toolsUnlock("stephen");
  await until(async () => (await getCookie())?.value === shop.gate, {
    timeout: 12_000,
    what: "new Tools session releases latch and exchanges",
  });
  await page.close();
});

test("alarms keep the worker honest (bridge wake + update + icon)", async () => {
  const names = await swEval(async () => (await chrome.alarms.getAll()).map((a) => a.name));
  for (const name of ["desk-update-check", "desk-icon-refresh", "desk-auto-unlock", "desk-bridge-wake"]) {
    assert.ok(names.includes(name), `alarm ${name} registered (have ${names.join(",")})`);
  }
});

test("Create RO on AllData prints once through Labels", async () => {
  labels.prints.length = 0;
  const page = await ctx.newPage();
  await page.goto("https://manageonline.alldata.com/");
  await page.click(".go");
  await until(() => labels.prints.length >= 1, { timeout: 15_000, what: "Labels print-ro" });
  assert.equal(labels.prints[0].event, "create-ro");
  assert.equal(labels.prints[0].lastName, "Whatcott");
  assert.equal(labels.prints[0].model, "Boxster");
  await sleep(1500);
  assert.equal(labels.prints.length, 1, "exactly one label per Create");
  await page.close();
});

test("SSF checkout offers the On the Lot dropdown and fills Order reference", async () => {
  const page = await ctx.newPage();
  await page.goto("https://www.ssfautoparts.com/checkout");
  await page.waitForSelector("#bf-ssf-lot-names", { timeout: 15_000 });
  const select = page.locator("#bf-ssf-lot-names select");
  await until(async () => (await select.locator("option").count()) > 1, { what: "lot options" });
  const options = await select.locator("option").allTextContents();
  assert.ok(options.includes("Whatcott"), options.join(","));
  assert.ok(options.includes("Baker"));
  assert.ok(options.includes("Chen"));
  assert.ok(!options.some((o) => /no name/i.test(o)));
  await select.selectOption({ label: "Baker" });
  assert.equal(await page.inputValue("#po"), "Baker");
  await page.close();
});

test("Update on Chromium offers the zip, never Firefox install prompts", async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`);
  const result = await page.evaluate(() => chrome.runtime.sendMessage({ type: "apply-update" }));
  await page.close();
  assert.ok(result, "apply-update responded");
  assert.ok(!/about:addons|Allow, then Add|Install Add-on From File/.test(result.message || ""));
  assert.ok(["up_to_date", "chromium_manual", "feed_unreachable", "chromium_zip"].includes(result.mode), result.mode);
});
