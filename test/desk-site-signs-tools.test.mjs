import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GATE, makeWorld } from "./helpers/desk-world.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GATE_VALUE = "v2.1893456000000.logan.desk.proof";
const PROOF_TOKEN = "desk-proof-token";
const FROM_GATE = "https://shop.blackforestautomotive.com/api/widget/session/from-gate";

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

test("shop page asks the background to POST from-gate in the page", () => {
  const src = fs.readFileSync(path.join(root, "extension/shared/content-shop.js"), "utf8");
  const lot = fs.readFileSync(path.join(root, "extension/shared/lot-names.js"), "utf8");
  assert.equal(src.includes("pullPageGateInPage"), false);
  assert.equal(src.includes("event.source"), false);
  assert.equal(src.includes("event.origin"), false);
  assert.equal(src.includes('type: "pull-shop-gate"'), true);
  assert.equal(src.includes("function looksLikeShopUnlock"), true);
  assert.equal(src.includes("}, 4000);"), true);
  assert.match(lot, /world:\s*"MAIN"/);
  assert.match(lot, /credentials:\s*"include"/);
  assert.equal(lot.includes("headers.Cookie"), false);
  assert.equal(lot.includes("headers: { Cookie"), false);
  assert.equal(/Cookie\s*:/.test(lot.slice(lot.indexOf("function readShopGateInPage"), lot.indexOf("function pullShopGateFromTab"))), false);
});

test("an unlocked page sends bf_shop_gate on from-gate; a Desk Cookie header does not", async () => {
  const shopHits = [];
  const toolHits = [];
  const sent = [];
  const pageJar = new Map();
  const shop = await listen(async (req, res) => {
    const body = await readBody(req);
    const cookie = String(req.headers.cookie || "");
    const hadCookie = cookie.split(";").some((part) => {
      const trimmed = part.trim();
      return trimmed.startsWith(`${GATE}=`) && trimmed.length > `${GATE}=`.length;
    });
    shopHits.push({
      method: req.method,
      path: req.url,
      hadCookie,
      exact: hadCookie && cookie.includes(`${GATE}=${GATE_VALUE}`),
    });
    if (req.method === "POST" && req.url === "/api/widget/session/from-gate") {
      if (!hadCookie) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          token: PROOF_TOKEN,
          expiresAt: "2027-01-15T22:00:00.000Z",
          person: "logan",
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found", body }));
  });
  const tools = await listen(async (req, res) => {
    const body = await readBody(req);
    let parsed = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      parsed = null;
    }
    toolHits.push({ method: req.method, path: req.url, body: parsed });
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, hasSession: false, person: "", locked: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/widget-session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const shopPort = shop.address().port;
  const toolsPort = tools.address().port;

  async function liveFetch(url, init = {}) {
    const target = new URL(url);
    let port = 0;
    if (target.hostname === "shop.blackforestautomotive.com") port = shopPort;
    else if (target.port === "8788") port = toolsPort;
    else throw new Error(`unexpected url ${target.hostname}`);
    const headers = { ...(init.headers || {}) };
    const rawCookie = String(headers.Cookie || headers.cookie || "");
    const deskSetCookie = rawCookie.split(";").some((part) => part.trim().startsWith(`${GATE}=`));
    delete headers.Cookie;
    delete headers.cookie;
    const credentials = init.credentials || "";
    let attached = false;
    if (credentials === "include" && !deskSetCookie && pageJar.has(GATE)) {
      headers.Cookie = `${GATE}=${pageJar.get(GATE)}`;
      attached = true;
    }
    const body = init.body == null ? "" : String(init.body);
    if (body && !headers["Content-Length"] && !headers["content-length"]) {
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    sent.push({
      method: String(init.method || "GET").toUpperCase(),
      path: target.pathname,
      credentials,
      deskSetCookie,
      attached,
    });
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: `${target.pathname}${target.search}`,
          method: init.method || "GET",
          headers,
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode || 0;
            resolve({
              ok: status >= 200 && status < 300,
              status,
              json: async () => JSON.parse(text),
              text: async () => text,
            });
          });
        },
      );
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  try {
    const bare = await liveFetch(FROM_GATE, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(bare.status, 401);

    pageJar.set(GATE, GATE_VALUE);
    const headerOnly = await liveFetch(FROM_GATE, {
      method: "POST",
      credentials: "omit",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: `${GATE}=${GATE_VALUE}`,
      },
      body: "{}",
    });
    assert.equal(headerOnly.status, 401);
    assert.equal(sent.at(-1).deskSetCookie, true);
    assert.equal(sent.at(-1).attached, false);

    const headerAndInclude = await liveFetch(FROM_GATE, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: `${GATE}=${GATE_VALUE}`,
      },
      body: "{}",
    });
    assert.equal(headerAndInclude.status, 401);
    assert.equal(sent.at(-1).credentials, "include");
    assert.equal(sent.at(-1).deskSetCookie, true);
    assert.equal(sent.at(-1).attached, false);

    sent.length = 0;
    shopHits.length = 0;
    toolHits.length = 0;
    const w = makeWorld({ liveFetch });
    w.world.jar.set(GATE, GATE_VALUE);
    w.toolsLock();
    const result = await w.api.syncToolsSessionToSite({
      reloadUnlockTabs: false,
      pageSignedIn: true,
      pagePerson: "logan",
      shopLoad: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.reason, "site_signed_in");
    assert.equal(result.source, "site-gate");
    assert.equal(w.world.storage.shopWidgetToken, PROOF_TOKEN);
    assert.equal(w.world.storage.shopWidgetTokenSource, "site-gate");
    assert.equal(w.world.icons.at(-1), "green");
    assert.equal(w.world.jar.get(GATE), GATE_VALUE);
    assert.equal(w.world.pageExecutions.length, 1);
    assert.equal(w.world.pageExecutions[0].world, "MAIN");
    assert.equal(w.world.pageExecutions[0].tabId, 1);

    const posts = sent.filter((hit) => hit.path === "/api/widget/session/from-gate" && hit.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].credentials, "include");
    assert.equal(posts[0].deskSetCookie, false);
    assert.equal(posts[0].attached, true);
    const seen = shopHits.filter((hit) => hit.path === "/api/widget/session/from-gate" && hit.method === "POST");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].exact, true);

    const published = toolHits.filter((hit) => hit.method === "POST" && hit.path === "/v1/widget-session");
    assert.equal(published.length, 1);
    assert.equal(published[0].body && published[0].body.token, PROOF_TOKEN);
    assert.equal(published[0].body.person, "logan");

    pageJar.clear();
    sent.length = 0;
    shopHits.length = 0;
    toolHits.length = 0;
    const missed = makeWorld({ liveFetch });
    missed.toolsLock();
    const blocked = await missed.api.importSiteGateSession();
    assert.equal(blocked.reason, "no_gate_cookie");
    assert.equal(missed.world.storage.shopWidgetToken || "", "");
    assert.equal(missed.world.pageExecutions[0].world, "MAIN");
    const missedPosts = sent.filter((hit) => hit.path === "/api/widget/session/from-gate");
    assert.equal(missedPosts.length, 1);
    assert.equal(missedPosts[0].credentials, "include");
    assert.equal(missedPosts[0].deskSetCookie, false);
    assert.equal(missedPosts[0].attached, false);
    assert.equal(shopHits[0].hadCookie, false);
    assert.equal(toolHits.filter((hit) => hit.path === "/v1/widget-session").length, 0);
  } finally {
    await new Promise((resolve) => shop.close(resolve));
    await new Promise((resolve) => tools.close(resolve));
  }
});
