/* global chrome, browser */
/**
 * Shop site ↔ Desk:
 * - Capture unlock JSON widgetToken when present
 * - Capture website Lock → site-lock → Tools DELETE + POST /v1/lock
 * - On shop page load: the page itself POSTs from-gate (SameSite=Lax is sent by the
 *   page, not by an extension fetch or a JSON document). A signed-in response
 *   turns the Desk widget on and is posted to Tools. A signed-out response opens
 *   the Tools handoff so the PIN page, including the home screen, leaves. A shop
 *   load must not delete bf_shop_gate. The page message is matched by origin,
 *   because Firefox does not treat event.source as the content-script window.
 *
 * Live shop Lock (beta 0.1.36+) posts to `/_serverFn/<hash>` — the client bundle has
 * no `lockShop` string. Matching only lockShop|clearGateSession misses that path, so
 * Tools stayed logged in after website Lock (#67 / website-lock-to-tools-fix.md).
 * Detect the known lock hash, and also treat “recent /_serverFn POST → navigate to
 * /unlock” (or sessionStorage bf_shop_gate clear) as Lock (survives hash churn).
 */
(function () {
  const runtime = typeof browser !== "undefined" ? browser : chrome;

  /** Live shop lockShop serverFn id (beta 0.1.36 bundle). Redeploys may change this. */
  const LIVE_LOCK_SERVERFN =
    "462df016712e9460dba3b3206037fe5482e55863b0e6af87f8c2b89dff89fc9a";

  /** Window after a /_serverFn POST during which /unlock navigation means Lock. */
  const SERVERFN_UNLOCK_NAV_MS = 5_000;

  let recentServerFnPostAt = 0;
  /** A website unlock response just landed: never read follow-up /unlock state writes as Lock. */
  let lastUnlockResponseAt = 0;
  const UNLOCK_RESPONSE_QUIET_MS = 15_000;
  let lastPathname = "";
  try {
    lastPathname = location.pathname || "";
  } catch {
    lastPathname = "";
  }
  let lastReportedSiteLockAt = 0;
  /** True once this document's own from-gate call saw a shop cookie. */
  let pageGateOk = false;
  let pagePullTimer = 0;
  let handoffLeaving = false;
  const FROM_GATE_PATH = "/api/widget/session/from-gate";

  function jsonStringField(raw, key) {
    const match = new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*)"`).exec(String(raw || ""));
    return match ? match[1] : "";
  }

  function widgetSessionFrom(value, depth) {
    if (!value || depth > 8) return null;
    if (typeof value === "string") {
      if (value.indexOf("widgetToken") === -1) return null;
      try {
        return widgetSessionFrom(JSON.parse(value), depth + 1);
      } catch {
        return null;
      }
    }
    if (typeof value !== "object") return null;
    if (typeof value.widgetToken === "string" && value.widgetToken && value.widgetExpiresAt) {
      return {
        token: String(value.widgetToken),
        expiresAt: String(value.widgetExpiresAt),
        person: value.person ? String(value.person) : "",
        source: "shop-site",
      };
    }
    const list = Array.isArray(value) ? value : Object.keys(value).map((key) => value[key]);
    for (const item of list) {
      const found = widgetSessionFrom(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function extractUnlock(raw) {
    if (typeof raw !== "string" || raw.indexOf("widgetToken") === -1) return null;
    try {
      const found = widgetSessionFrom(JSON.parse(raw), 0);
      if (found) return found;
    } catch {
      // TanStack framed / seroval bodies are not one JSON value.
    }
    const token = jsonStringField(raw, "widgetToken");
    const expiresAt = jsonStringField(raw, "widgetExpiresAt");
    if (!token || !expiresAt) return null;
    return {
      token,
      expiresAt,
      person: jsonStringField(raw, "person"),
      source: "shop-site",
    };
  }

  function isHandoffUrl(url) {
    try {
      const parsed = new URL(url, location.origin);
      return (
        parsed.origin === location.origin &&
        /^\/api\/widget\/session\/handoff\/[A-Za-z0-9_-]{20,}$/.test(parsed.pathname)
      );
    } catch {
      return false;
    }
  }

  function looksLikeLock(url, method, body) {
    if (String(method || "GET").toUpperCase() !== "POST") return false;
    const urlText = String(url || "");
    const hay = `${urlText}\n${body == null ? "" : String(body)}`;
    // Never treat unlock / session mint as lock.
    if (/unlockShop|widgetToken|widgetExpiresAt|from-gate|gateToken/i.test(hay)) return false;
    if (/widget\/logout/i.test(hay)) return true;
    if (/\/api\/widget\/session/i.test(hay)) return false;
    // Hashed TanStack lock (name not present in minified client) — #67.
    if (new RegExp(`/_serverFn/${LIVE_LOCK_SERVERFN}\\b`, "i").test(urlText)) {
      return true;
    }
    if (/\/_serverFn\/[^/?#]*lockShop/i.test(urlText)) return true;
    // Legacy / string-named server fns + RSC action names.
    return /lockShop|clearGateSession|clear_gate_session|lock_shop|gate\.ts.*lockShop|\/lockShop\b|_serverFn_[^"'\s]*lockShop|action[^"'\s]*lockShop/i.test(
      hay,
    );
  }

  function requestUrl(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    try {
      return String(input);
    } catch {
      return "";
    }
  }

  function bodyText(body) {
    if (body == null) return "";
    if (typeof body === "string") return body;
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      return body.toString();
    }
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      try {
        const parts = [];
        body.forEach((value, key) => {
          parts.push(`${key}=${typeof value === "string" ? value : ""}`);
        });
        return parts.join("&");
      } catch {
        return "FormData";
      }
    }
    if (typeof Blob !== "undefined" && body instanceof Blob) {
      return "";
    }
    try {
      return String(body);
    } catch {
      return "";
    }
  }

  /** lockShop often returns bare {ok:true} with empty body on the request. */
  function looksLikeLockResponse(url, method, text) {
    if (String(method || "GET").toUpperCase() !== "POST") return false;
    if (looksLikeLock(url, method, text || "")) return true;
    const bareOk =
      typeof text === "string" &&
      (/^\s*\{\s*"ok"\s*:\s*true\s*\}\s*$/.test(text) ||
        /^\s*\{\s*"ok"\s*:\s*true\s*,\s*"result"\s*:\s*\{\s*"ok"\s*:\s*true\s*\}\s*\}\s*$/.test(
          text,
        ));
    const urlHay = String(url || "");
    return Boolean(
      bareOk && /lockShop|clearGateSession|clear_gate_session|lock_shop/i.test(urlHay),
    );
  }

  function publish(session) {
    if (!session) return Promise.resolve(null);
    lastUnlockResponseAt = Date.now();
    recentServerFnPostAt = 0;
    pageGateOk = true;
    if (!runtime?.runtime?.sendMessage) return Promise.resolve(null);
    const send = () =>
      runtime.runtime.sendMessage({ type: "shop-site-session", payload: session });
    try {
      // Website unlock JSON → Desk → POST :8788 (site→Tools). Retry once on reject.
      return Promise.resolve(send())
        .catch(() => send())
        .catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  function reportSiteLock() {
    pageGateOk = false;
    const now = Date.now();
    // Soft-nav + fetch can both fire; debounce so Tools gets one DELETE.
    if (now - lastReportedSiteLockAt < 800) return;
    lastReportedSiteLockAt = now;
    if (!runtime?.runtime?.sendMessage) return;
    try {
      runtime.runtime.sendMessage({ type: "site-lock" }).catch(() => {});
    } catch {
      // ignore
    }
  }

  function noteServerFnPost(url, method) {
    if (String(method || "GET").toUpperCase() !== "POST") return;
    if (!/\/_serverFn\//i.test(String(url || ""))) return;
    recentServerFnPostAt = Date.now();
  }

  function maybeLockFromUnlockNavigation() {
    try {
      const path = location.pathname || "";
      const previous = lastPathname;
      lastPathname = path;
      if (/\/unlock\b/i.test(previous) && !/\/unlock\b/i.test(path)) {
        pageGateOk = false;
        schedulePagePull(true);
      }
      if (!/\/unlock\b/i.test(path)) return;
      // Only a move INTO /unlock is a Lock. Router state writes while already sitting on
      // /unlock (the unlock form itself) are not.
      if (/\/unlock\b/i.test(previous)) return;
      if (Date.now() - lastUnlockResponseAt < UNLOCK_RESPONSE_QUIET_MS) return;
      if (Date.now() - recentServerFnPostAt > SERVERFN_UNLOCK_NAV_MS) return;
      reportSiteLock();
    } catch {
      // ignore
    }
  }

  function isFromGateDocument() {
    try {
      return String(location.pathname || "").replace(/\/+$/, "") === FROM_GATE_PATH;
    } catch {
      return false;
    }
  }

  /**
   * Page-world POST. Firefox sends SameSite=Lax for the shop page.
   * A content-script fetch and a background fetch do not, and the JSON document
   * from a top-level POST never becomes a Desk session.
   */
  function pullPageGateInPage() {
    return new Promise((resolve) => {
      const requestId = `bf-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMessage);
        resolve(result);
      };
      const onMessage = (event) => {
        const data = event && event.data;
        if (!data || data.source !== "bf-desk-from-gate" || data.requestId !== requestId) return;
        let origin = "";
        try {
          origin = location.origin;
        } catch {
          return;
        }
        // The page posts this. Firefox content scripts do not see event.source
        // as their own window, so that check dropped a signed-in from-gate token.
        if (event.origin !== origin) return;
        finish({
          ok: Boolean(data.ok && data.token),
          token: data.token ? String(data.token) : "",
          expiresAt: data.expiresAt ? String(data.expiresAt) : "",
          person: data.person ? String(data.person) : "",
        });
      };
      window.addEventListener("message", onMessage);
      try {
        const script = document.createElement("script");
        script.textContent =
          "(function(){var id=" +
          JSON.stringify(requestId) +
          ";fetch(" +
          JSON.stringify(FROM_GATE_PATH) +
          ',{method:"POST",credentials:"include",headers:{"Accept":"application/json","Content-Type":"application/json"},body:"{}"}).then(function(r){return r.json().then(function(data){return {ok:r.ok,data:data};}).catch(function(){return {ok:false,data:null};});}).then(function(payload){var data=payload&&payload.data||{};window.postMessage({source:"bf-desk-from-gate",requestId:id,ok:Boolean(payload&&payload.ok&&data.token),token:data.token||"",expiresAt:data.expiresAt||data.widgetExpiresAt||"",person:data.person||""},location.origin);}).catch(function(){window.postMessage({source:"bf-desk-from-gate",requestId:id,ok:false,token:"",expiresAt:"",person:""},location.origin);});})();';
        (document.documentElement || document.head).appendChild(script);
        script.remove();
      } catch {
        finish({ ok: false, token: "", expiresAt: "", person: "" });
        return;
      }
      window.setTimeout(() => finish({ ok: false, token: "", expiresAt: "", person: "" }), 4000);
    });
  }

  async function askShopSession() {
    if (!runtime?.runtime?.sendMessage || handoffLeaving) return;
    if (isFromGateDocument()) {
      location.replace(`${location.origin}/`);
      return;
    }
    const onUnlock = /\/unlock\b/i.test(location.pathname || "");
    try {
      if (onUnlock) {
        runtime.runtime.sendMessage({ type: "site-unlock-page" }).catch(() => {});
      }
      const page = await pullPageGateInPage();
      if (handoffLeaving) return;
      if (page.ok && page.token) {
        pageGateOk = true;
        await publish({
          token: page.token,
          expiresAt: page.expiresAt,
          person: page.person,
          source: "shop-site",
        });
        await runtime.runtime.sendMessage({
          type: "tools-to-site-unlock",
          forceExchange: false,
          pageSignedIn: true,
          pagePerson: page.person || "",
          handoffNavigate: false,
          shopLoad: true,
        });
        return;
      }
      pageGateOk = false;
      const response = await runtime.runtime.sendMessage({
        type: "tools-to-site-unlock",
        forceExchange: false,
        pageSignedIn: false,
        pagePerson: "",
        handoffNavigate: false,
        shopLoad: true,
      });
      if (!response || handoffLeaving) return;
      if (response.handoffUrl && isHandoffUrl(response.handoffUrl)) {
        handoffLeaving = true;
        location.assign(response.handoffUrl);
      }
    } catch {
      // ignore
    }
  }

  async function onShopLoadSync() {
    await askShopSession();
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const input = args[0];
    const init = args[1] || {};
    const url = requestUrl(input);
    const method = init.method || (input && input.method) || "GET";
    try {
      // Fire site-lock BEFORE await — /unlock navigation must not beat Tools DELETE.
      if (looksLikeLock(url, method, bodyText(init.body))) {
        reportSiteLock();
      } else {
        noteServerFnPost(url, method);
      }
    } catch {
      // ignore
    }
    const response = await originalFetch(...args);
    try {
      const clone = response.clone();
      const contentType = clone.headers.get("content-type") || "";
      if (contentType.includes("json") || contentType.includes("text") || !contentType) {
        clone
          .text()
          .then((text) => {
            try {
              if (looksLikeLockResponse(url, method, text)) reportSiteLock();
            } catch {
              // ignore
            }
            const session = extractUnlock(text);
            if (session) publish(session);
            else if (looksLikeShopUnlock(url, text)) schedulePagePull(true);
            // Bare {ok:true} on known lock URL (Tools preload parity / #67).
            if (
              response.ok &&
              looksLikeLock(url, method, "") &&
              typeof text === "string" &&
              /^\s*\{\s*"ok"\s*:\s*true/.test(text)
            ) {
              reportSiteLock();
            }
          })
          .catch(() => {});
      }
    } catch {
      // ignore
    }
    return response;
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function openPatched(method, url, ...rest) {
    this.__bfMethod = method;
    this.__bfUrl = url;
    return xhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function sendPatched(...args) {
    try {
      if (looksLikeLock(this.__bfUrl, this.__bfMethod, args[0])) {
        reportSiteLock();
      } else {
        noteServerFnPost(this.__bfUrl, this.__bfMethod);
      }
    } catch {
      // ignore
    }
    this.addEventListener("load", function onLoad() {
      try {
        if (looksLikeLockResponse(this.__bfUrl, this.__bfMethod, this.responseText)) {
          reportSiteLock();
        }
        const session = extractUnlock(this.responseText);
        if (session) publish(session);
        else if (looksLikeShopUnlock(this.__bfUrl, this.responseText)) schedulePagePull(true);
      } catch {
        // ignore
      }
    });
    return xhrSend.apply(this, args);
  };

  // Soft SPA Lock: await lockFn(); clear sessionStorage gate; router → /unlock.
  // Only after a recent /_serverFn POST — bare /unlock must not lock Tools
  // (unlock bounce / Tools→site heal).
  try {
    const wrapHistory = (fn) =>
      function patchedHistory(...args) {
        const result = fn.apply(this, args);
        maybeLockFromUnlockNavigation();
        return result;
      };
    if (typeof history !== "undefined") {
      if (typeof history.pushState === "function") {
        history.pushState = wrapHistory(history.pushState.bind(history));
      }
      if (typeof history.replaceState === "function") {
        history.replaceState = wrapHistory(history.replaceState.bind(history));
      }
    }
    window.addEventListener("popstate", () => maybeLockFromUnlockNavigation());
  } catch {
    // ignore
  }

  // sessionStorage bf_shop_gate cleared by Lock (client mirror of gate) — #67.
  try {
    let hadGate = false;
    try {
      hadGate = Boolean(sessionStorage.getItem("bf_shop_gate"));
    } catch {
      hadGate = false;
    }
    const originalRemove = sessionStorage.removeItem.bind(sessionStorage);
    sessionStorage.removeItem = function removeItemPatched(key) {
      const result = originalRemove(key);
      try {
        if (key === "bf_shop_gate" && hadGate) {
          hadGate = false;
          if (
            Date.now() - recentServerFnPostAt < SERVERFN_UNLOCK_NAV_MS &&
            Date.now() - lastUnlockResponseAt >= UNLOCK_RESPONSE_QUIET_MS
          ) {
            reportSiteLock();
          }
        }
      } catch {
        // ignore
      }
      return result;
    };
    const originalSet = sessionStorage.setItem.bind(sessionStorage);
    sessionStorage.setItem = function setItemPatched(key, value) {
      const result = originalSet(key, value);
      if (key === "bf_shop_gate" && value) hadGate = true;
      return result;
    };
  } catch {
    // sessionStorage may be unavailable
  }

  const FUN_MODES = [
    "pirate",
    "west",
    "alien",
    "medieval",
    "odyssey",
    "tron",
    "casino",
    "arcade",
    "dota",
    "race",
    "surfer",
    "seasonal",
  ];

  function applyToolsPersonSettings(message) {
    const person = message && message.person ? String(message.person) : "";
    const settings =
      message && message.settings && typeof message.settings === "object" ? message.settings : null;
    if (!person || !settings) return { ok: false };
    try {
      const key = "bf-person-settings";
      let all = {};
      try {
        all = JSON.parse(localStorage.getItem(key) || "{}") || {};
      } catch {
        all = {};
      }
      if (!all || typeof all !== "object") all = {};
      const prev = all[person] && typeof all[person] === "object" ? all[person] : {};
      all[person] = { ...prev, ...settings };
      localStorage.setItem(key, JSON.stringify(all));
      localStorage.setItem("bf-last-person", person);
      const mode = settings.funMode || "off";
      for (const name of FUN_MODES) {
        document.documentElement.classList.toggle(name, name === mode);
      }
      if (mode === "off") {
        for (const name of FUN_MODES) document.documentElement.classList.remove(name);
      }
      const until = Date.now() + 20_000;
      const stamp = Number(message.updatedAt) || Date.now();
      localStorage.setItem("bf-tools-prefs-at", String(stamp));
      const hold = window.setInterval(() => {
        if (Date.now() > until) {
          window.clearInterval(hold);
          return;
        }
        try {
          const again = JSON.parse(localStorage.getItem(key) || "{}") || {};
          const cur = again[person] && typeof again[person] === "object" ? again[person] : {};
          if (cur.funMode !== mode) {
            again[person] = { ...cur, ...settings, funMode: mode };
            localStorage.setItem(key, JSON.stringify(again));
            for (const name of FUN_MODES) {
              document.documentElement.classList.toggle(name, name === mode);
            }
            if (mode === "off") {
              for (const name of FUN_MODES) document.documentElement.classList.remove(name);
            }
          }
        } catch {
          // ignore
        }
      }, 500);
      return { ok: true, funMode: mode };
    } catch {
      return { ok: false };
    }
  }

  if (runtime?.runtime?.onMessage?.addListener) {
    try {
      runtime.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message) return false;
        if (message.type === "pull-shop-gate") {
          pullPageGateInPage()
            .then((page) => sendResponse(page))
            .catch(() => sendResponse({ ok: false, token: "", expiresAt: "", person: "" }));
          return true;
        }
        if (message.type !== "apply-tools-person-settings") return false;
        sendResponse(applyToolsPersonSettings(message));
        return false;
      });
    } catch {
      // ignore
    }
  }

  // Immediate website → Tools fun on/off (last user action).
  let prefsPushTimer = 0;
  function pushLocalPrefsToTools() {
    try {
      const person = localStorage.getItem("bf-last-person") || "";
      const all = JSON.parse(localStorage.getItem("bf-person-settings") || "{}") || {};
      const settings = person && all[person] && typeof all[person] === "object" ? all[person] : null;
      if (!person || !settings || !runtime?.runtime?.sendMessage) return;
      const toolsAt = Number(localStorage.getItem("bf-tools-prefs-at") || 0);
      if (toolsAt && Date.now() - toolsAt < 600) return;
      runtime.runtime
        .sendMessage({
          type: "site-person-settings",
          person,
          settings,
        })
        .catch(() => {});
    } catch {
      // ignore
    }
  }
  window.addEventListener("storage", (event) => {
    if (event.key !== "bf-person-settings" && event.key !== "bf-last-person") return;
    window.clearTimeout(prefsPushTimer);
    prefsPushTimer = window.setTimeout(pushLocalPrefsToTools, 50);
  });
  let lastLocalPrefsFp = "";
  window.setInterval(() => {
    try {
      const person = localStorage.getItem("bf-last-person") || "";
      const raw = localStorage.getItem("bf-person-settings") || "";
      const fp = `${person}|${raw}`;
      if (fp === lastLocalPrefsFp) return;
      lastLocalPrefsFp = fp;
      pushLocalPrefsToTools();
    } catch {
      // ignore
    }
  }, 350);

  /**
   * Unlock JSON has no widget token. Ask the page again once the PIN form succeeds.
   */
  function schedulePagePull(force) {
    if (handoffLeaving || isFromGateDocument()) return;
    if (pageGateOk && !force) return;
    window.clearTimeout(pagePullTimer);
    pagePullTimer = window.setTimeout(() => {
      if (handoffLeaving || pageGateOk) return;
      askShopSession();
    }, force ? 200 : 400);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onShopLoadSync, { once: true });
  } else {
    onShopLoadSync();
  }
})();
