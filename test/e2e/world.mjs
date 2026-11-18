/**
 * Mock shop world for the real-browser Desk e2e suites (Chromium and Firefox).
 *
 * One process stands in for everything Desk talks to:
 *   - Black Forest Tools desk bridge   http://127.0.0.1:8788
 *   - Labels print server              http://127.0.0.1:8080
 *   - shop site, AllData, SSF, the GitHub update feed and the Create RO listener,
 *     all on one self-signed TLS server routed by Host header.
 *
 * Chromium reaches the TLS server with --host-resolver-rules; Firefox goes through the
 * CONNECT proxy below. Nothing here touches the real shop, AllData or GitHub.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const SHOP_PORT = 18443;
export const PROXY_PORT = 18444;
export const TOOLS_PORT = 8788;
export const LABELS_PORT = 8080;
export const SHOP_ORIGIN = "https://shop.blackforestautomotive.com";
export const MOCK_HOSTS = [
  "shop.blackforestautomotive.com",
  "manageonline.alldata.com",
  "www.ssfautoparts.com",
  "ssfautoparts.com",
  "github.com",
  "raw.githubusercontent.com",
  "api.github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "api2.cursor.sh",
];
/** Same id the live shop bundle uses for Lock (content-shop.js LIVE_LOCK_SERVERFN). */
export const LOCK_SERVERFN = "462df016712e9460dba3b3206037fe5482e55863b0e6af87f8c2b89dff89fc9a";
/** Test-only PIN for the mock shop. Not a real PIN. */
export const MOCK_PIN = "000000";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, { timeout = 8000, step = 100, what = "condition" } = {}) {
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

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function html(res, body, headers = {}) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function gateFromCookie(header) {
  for (const part of String(header || "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "bf_shop_gate" && rest.join("=")) return rest.join("=");
  }
  return "";
}

const ALLDATA_HTML = `<!doctype html><html><head><title>Manage Online</title></head><body>
<h1>Manage Online</h1>
<div class="form-row"><span>Customer</span><span>J. Whatcott</span></div>
<div class="form-row"><span>Year</span><span>2018</span></div>
<div class="form-row"><span>Make</span><span>Porsche</span></div>
<div class="form-row"><span>Model</span><span>Boxster</span></div>
<button class="go" type="button">Create R/O</button>
<button class="close-ro" type="button">Close R/O</button>
<button class="cancel-ro" type="button">Cancel R/O</button>
<button class="save-est" type="button">Save Estimate</button>
<button class="email-est" type="button">Email Estimate</button>
<div id="ok" hidden>Repair order created</div>
<script>
document.querySelector('.go').addEventListener('click', () => {
  setTimeout(() => {
    document.querySelector('.go').remove();
    document.getElementById('ok').hidden = false;
  }, 150);
});
</script></body></html>`;

const SSF_HTML = `<!doctype html><html><head><title>SSF checkout</title>
<style>body{font:14px system-ui,sans-serif;margin:32px;max-width:520px}label{display:block;font-weight:600;margin-bottom:4px}input{width:100%;padding:8px;box-sizing:border-box}</style>
</head><body>
<h1>Checkout</h1>
<div class="form-group">
<label for="po">Order reference</label>
<input id="po" name="orderReference" placeholder="PO # / RO #">
</div>
</body></html>`;

function shopPage(pathname, signedInPerson) {
  const signedIn = Boolean(signedInPerson);
  return `<!doctype html><html><head><title>Black Forest shop</title>
<style>body{font:14px system-ui,sans-serif;margin:32px}button{padding:8px 14px}</style></head>
<body data-signed-in="${signedIn}" data-person="${signedInPerson || ""}">
<h1 id="state">${signedIn ? `Shop home (${signedInPerson})` : "Enter PIN"}</h1>
<p id="path">${pathname}</p>
<button id="lock" type="button">Lock</button>
<button id="unlock" type="button">Unlock</button>
<script>
const state = document.getElementById("state");
document.getElementById("unlock").addEventListener("click", async () => {
  const response = await fetch("/_serverFn/mock-unlock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ person: "logan", pin: "${MOCK_PIN}" }),
  });
  const data = await response.json();
  if (data && data.ok) {
    document.body.dataset.signedIn = "true";
    document.body.dataset.person = data.person;
    state.textContent = "Shop home (" + data.person + ")";
    history.pushState({}, "", "/");
  }
});
document.getElementById("lock").addEventListener("click", async () => {
  await fetch("/_serverFn/${LOCK_SERVERFN}", { method: "POST" });
  document.body.dataset.signedIn = "false";
  state.textContent = "Enter PIN";
  history.pushState({}, "", "/unlock");
});
</script></body></html>`;
}

export async function createWorld() {
  const tools = { session: null, hits: [], nextId: 1, down: false };
  const shop = {
    exchanges: 0,
    handoffs: 0,
    fromGate: [],
    requests: [],
    gateSerial: 0,
    lot: {
      status: 200,
      items: [{ label: "Whatcott" }, { label: "Anna Baker" }, { label: "No name" }, { label: "Chen, Li" }],
    },
    tickets: new Map(),
  };
  const labels = { prints: [], status: 200, response: { ok: true, printed: true }, down: false };
  const listener = { pings: [] };
  /** version: what updates.json / version.json announce; null = feed unreachable (HTTP 503). */
  const feed = { version: "0.0.1", message: "", status: 200 };
  const servers = [];

  function mintGate(person = "logan") {
    shop.gateSerial += 1;
    const until = Math.floor(Date.now() / 1000) + 8 * 3600;
    return `v2.${until}.${person}.pin.mock${shop.gateSerial}`;
  }

  function gateSetCookie(value) {
    return `bf_shop_gate=${value}; Path=/; Max-Age=28800; Secure; HttpOnly; SameSite=Lax`;
  }

  const GATE_CLEAR = "bf_shop_gate=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax";

  function personFromGate(value) {
    const parts = String(value || "").split(".");
    return parts[0] === "v2" && parts.length === 5 ? parts[2] : "";
  }

  function toolsUnlock(person = "logan") {
    tools.session = {
      token: `tok-${tools.nextId}`,
      expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
      person,
      sessionId: `sess-${tools.nextId++}`,
    };
    return { ...tools.session };
  }

  function toolsLock() {
    tools.session = null;
  }

  const toolsServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    // Tools not running on this PC.
    if (tools.down) return req.socket.destroy();
    tools.hits.push(`${req.method} ${url.pathname}`);
    if (tools.hits.length > 5000) tools.hits.splice(0, 2500);
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

  const labelsServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname === "/api/print-ro") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (labels.down) return req.socket.destroy();
      labels.prints.push(body);
      return json(res, labels.status, labels.response);
    }
    return json(res, 404, { error: "not_found" });
  });

  async function shopHandler(req, res, url) {
    const cookieGate = gateFromCookie(req.headers.cookie);
    const person = personFromGate(cookieGate);
    const auth = String(req.headers.authorization || "");
    if (url.pathname === "/api/widget/session/exchange" && req.method === "POST") {
      if (!auth.startsWith("Bearer tok-") && !auth.startsWith("Bearer lot-")) {
        return json(res, 401, { error: "unauthorized" });
      }
      shop.exchanges += 1;
      return json(res, 200, {
        ok: true,
        gateToken: mintGate(tools.session?.person || "logan"),
        person: tools.session?.person || "logan",
        expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
      });
    }
    if (url.pathname === "/api/widget/session/from-gate" && req.method === "POST") {
      shop.fromGate.push({ cookie: Boolean(cookieGate), person });
      if (!person) return json(res, 401, { error: "unauthorized" });
      return json(res, 200, {
        token: `lot-from-gate-${shop.fromGate.length}`,
        expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
        person,
      });
    }
    if (url.pathname === "/api/widget/session/handoff" && req.method === "POST") {
      if (!auth.startsWith("Bearer tok-") && !auth.startsWith("Bearer lot-")) {
        return json(res, 401, { error: "unauthorized" });
      }
      shop.handoffs += 1;
      const ticket = `ticket${String(shop.handoffs).padStart(4, "0")}-abcdefghijklmnopqrstuvwxyz`;
      shop.tickets.set(ticket, tools.session?.person || "logan");
      return json(res, 200, { url: `${SHOP_ORIGIN}/api/widget/session/handoff/${ticket}` });
    }
    const ticketMatch = /^\/api\/widget\/session\/handoff\/([A-Za-z0-9_-]{20,})$/.exec(url.pathname);
    if (ticketMatch && req.method === "GET") {
      const who = shop.tickets.get(ticketMatch[1]);
      shop.tickets.delete(ticketMatch[1]);
      if (!who) {
        res.writeHead(302, { location: "/unlock" });
        return res.end();
      }
      res.writeHead(302, { location: "/", "set-cookie": gateSetCookie(mintGate(who)) });
      return res.end();
    }
    if (url.pathname === "/api/widget/session" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.pin !== MOCK_PIN) return json(res, 401, { error: "unauthorized" });
      return json(res, 200, {
        token: `lot-pin-${body.person}`,
        expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
        person: body.person,
      });
    }
    if (url.pathname === "/api/widget/views/lot") {
      if (!auth.startsWith("Bearer ")) return json(res, 401, { error: "unauthorized" });
      if (shop.lot.status !== 200) return json(res, shop.lot.status, { error: "server_error" });
      return json(res, 200, { items: shop.lot.items });
    }
    if (url.pathname === "/_serverFn/mock-unlock" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.pin !== MOCK_PIN) return json(res, 200, { ok: false, error: "bad_pin" });
      const who = String(body.person || "logan");
      return json(
        res,
        200,
        { ok: true, person: who, mustChange: false, view: "home" },
        { "set-cookie": gateSetCookie(mintGate(who)) },
      );
    }
    if (
      (url.pathname === `/_serverFn/${LOCK_SERVERFN}` || url.pathname === "/_serverFn/lock") &&
      req.method === "POST"
    ) {
      return json(res, 200, { ok: true }, { "set-cookie": GATE_CLEAR });
    }
    // /unlock always shows the PIN screen; every other page follows the cookie.
    const onUnlock = url.pathname.replace(/\/+$/, "") === "/unlock";
    return html(res, shopPage(url.pathname, onUnlock ? "" : person));
  }

  function feedHandler(req, res, host, url) {
    if (host === "api2.cursor.sh") {
      return readBody(req).then((raw) => {
        let body = null;
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          body = null;
        }
        // Record only whether a key came along, never the key.
        listener.pings.push({ path: url.pathname, body, authorized: Boolean(req.headers.authorization) });
        return json(res, 200, { ok: true });
      });
    }
    const cors = { "access-control-allow-origin": "*" };
    if (feed.status !== 200 || !feed.version) return json(res, feed.status === 200 ? 503 : feed.status, {}, cors);
    if (host === "github.com" && url.pathname.endsWith("/updates.json")) {
      return json(
        res,
        200,
        {
          addons: {
            "black-forest-desk@blackforestautomotive.com": {
              updates: [
                {
                  version: feed.version,
                  update_link: `https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/Black.Forest.Desk-${feed.version}.xpi`,
                },
              ],
            },
          },
        },
        cors,
      );
    }
    if (host === "raw.githubusercontent.com" && url.pathname.endsWith("/extension/version.json")) {
      return json(res, 200, { version: feed.version, message: feed.message }, cors);
    }
    if (host === "api.github.com") return json(res, 200, { assets: [] }, cors);
    if (/\.(xpi|zip)$/.test(url.pathname)) {
      res.writeHead(200, { "content-type": "application/octet-stream", ...cors });
      return res.end("mock");
    }
    return json(res, 404, {}, cors);
  }

  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-e2e-cert-"));
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", path.join(certDir, "key.pem"), "-out", path.join(certDir, "cert.pem"),
      "-days", "2", "-subj", "/CN=desk-e2e",
    ],
    { stdio: "ignore" },
  );
  const tlsServer = https.createServer(
    {
      key: fs.readFileSync(path.join(certDir, "key.pem")),
      cert: fs.readFileSync(path.join(certDir, "cert.pem")),
    },
    async (req, res) => {
      try {
        const url = new URL(req.url, "https://x");
        const host = String(req.headers.host || "").replace(/:\d+$/, "");
        shop.requests.push(`${req.method} ${host}${url.pathname}`);
        if (shop.requests.length > 5000) shop.requests.splice(0, 2500);
        if (host === "manageonline.alldata.com") return html(res, ALLDATA_HTML);
        if (host === "www.ssfautoparts.com" || host === "ssfautoparts.com") return html(res, SSF_HTML);
        if (host === "shop.blackforestautomotive.com") return await shopHandler(req, res, url);
        return await feedHandler(req, res, host, url);
      } catch {
        try {
          json(res, 500, { error: "mock_failed" });
        } catch {
          // response already started
        }
      }
    },
  );

  /** Firefox has no host-resolver-rules: a CONNECT proxy sends the mocked hosts to the TLS server. */
  const proxyServer = http.createServer((_req, res) => {
    res.writeHead(502);
    res.end();
  });
  proxyServer.on("connect", (req, clientSocket, head) => {
    const host = String(req.url || "").replace(/:\d+$/, "");
    if (!MOCK_HOSTS.includes(host)) {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    const upstream = net.connect(SHOP_PORT, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  async function listen(server, port) {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    servers.push(server);
  }

  await listen(toolsServer, TOOLS_PORT);
  await listen(labelsServer, LABELS_PORT);
  await listen(tlsServer, SHOP_PORT);
  await listen(proxyServer, PROXY_PORT);

  return {
    tools,
    shop,
    labels,
    listener,
    feed,
    toolsUnlock,
    toolsLock,
    /** Chromium flag that sends every mocked host to the TLS server. */
    hostResolverRules: MOCK_HOSTS.map((host) => `MAP ${host} 127.0.0.1:${SHOP_PORT}`).join(","),
    async close() {
      for (const server of servers) {
        server.closeAllConnections?.();
        server.close();
      }
      fs.rmSync(certDir, { recursive: true, force: true });
    },
  };
}
