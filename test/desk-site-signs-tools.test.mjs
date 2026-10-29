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

test("shop page source accepts the page from-gate message without event.source", () => {
  const src = fs.readFileSync(path.join(root, "extension/shared/content-shop.js"), "utf8");
  assert.equal(src.includes("event.source !== window"), false);
  assert.equal(src.includes("event.origin !== origin"), true);
  assert.equal(src.includes("pull-shop-gate"), true);
});

test("cookie present on the partitioned jar signs Tools in and turns the extension green", async () => {
  const shopHits = [];
  const toolHits = [];
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
    const body = init.body == null ? "" : String(init.body);
    if (body && !headers["Content-Length"] && !headers["content-length"]) {
      headers["Content-Length"] = Buffer.byteLength(body);
    }
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
    const bare = await liveFetch("https://shop.blackforestautomotive.com/api/widget/session/from-gate", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(bare.status, 401);
    const bareBody = await bare.json();
    assert.equal(bareBody.error, "unauthorized");

    const w = makeWorld({ liveFetch });
    w.world.partitionOnly = true;
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

    const gets = w.world.cookieGets || [];
    assert.equal(gets.includes(""), true);
    assert.equal(gets.includes("https://shop.blackforestautomotive.com"), true);

    const exchanges = shopHits.filter((hit) => hit.path === "/api/widget/session/from-gate" && hit.method === "POST");
    const withCookie = exchanges.filter((hit) => hit.hadCookie && hit.exact);
    assert.equal(withCookie.length, 1);
    assert.equal(exchanges.some((hit) => !hit.hadCookie && hit !== shopHits[0]), false);

    const published = toolHits.filter((hit) => hit.method === "POST" && hit.path === "/v1/widget-session");
    assert.equal(published.length, 1);
    assert.equal(published[0].body && published[0].body.token, PROOF_TOKEN);
    assert.equal(published[0].body.person, "logan");

    shopHits.length = 0;
    toolHits.length = 0;
    const missed = makeWorld({ liveFetch });
    missed.world.partitionOnly = true;
    missed.toolsLock();
    const blocked = await missed.api.importSiteGateSession();
    assert.equal(blocked.reason, "no_gate_cookie");
    assert.equal(missed.world.storage.shopWidgetToken || "", "");
    assert.equal(
      shopHits.filter((hit) => hit.path === "/api/widget/session/from-gate").length,
      0,
    );
    assert.equal(toolHits.filter((hit) => hit.path === "/v1/widget-session").length, 0);
  } finally {
    await new Promise((resolve) => shop.close(resolve));
    await new Promise((resolve) => tools.close(resolve));
  }
});
