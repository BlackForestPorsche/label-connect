/* global chrome, browser */
/**
 * Shop site ↔ Desk:
 * - Capture unlock JSON widgetToken when present
 * - Capture website Lock → site-lock → Tools DELETE :8788
 * - On shop page load: Tools→website unlock (Bearer :8788 → exchange → bf_shop_gate)
 *   and from-gate nudge when the jar already has a gate (Desk lot names)
 *
 * Live shop Lock (beta 0.1.36+) posts to `/_serverFn/<hash>` — the client bundle has
 * no `lockShop` string. Matching only lockShop|clearGateSession misses that path, so
 * Tools stayed logged in after website Lock. Detect the known lock hash, and also
 * treat “recent /_serverFn POST → navigate to /unlock” as Lock (survives hash churn).
 */
(function () {
  const runtime = typeof browser !== "undefined" ? browser : chrome;

  /** Live shop lockShop serverFn id (beta 0.1.36 bundle). Redeploys may change this. */
  const LIVE_LOCK_SERVERFN =
    "462df016712e9460dba3b3206037fe5482e55863b0e6af87f8c2b89dff89fc9a";

  /** Window after a /_serverFn POST during which /unlock navigation means Lock. */
  const SERVERFN_UNLOCK_NAV_MS = 5_000;

  let recentServerFnPostAt = 0;
  let lastReportedSiteLockAt = 0;

  function extractUnlock(raw) {
    if (typeof raw !== "string" || raw.indexOf("widgetToken") === -1) return null;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    const candidates = [data, data && data.data, data && data.payload, data && data.result].filter(
      Boolean,
    );
    for (const obj of candidates) {
      if (!obj || !obj.widgetToken || !obj.widgetExpiresAt) continue;
      return {
        token: String(obj.widgetToken),
        expiresAt: String(obj.widgetExpiresAt),
        person: obj.person ? String(obj.person) : "",
        source: "shop-site",
      };
    }
    return null;
  }

  function looksLikeLock(url, method, body) {
    if (String(method || "GET").toUpperCase() !== "POST") return false;
    const urlText = String(url || "");
    const hay = `${urlText}\n${body == null ? "" : String(body)}`;
    if (/unlockShop|widgetToken|widgetExpiresAt/i.test(hay)) return false;
    if (/widget\/logout/i.test(hay)) return true;
    if (/\/api\/widget\/session/i.test(hay)) return false;
    // Hashed TanStack lock (name not present in minified client).
    if (new RegExp(`/_serverFn/${LIVE_LOCK_SERVERFN}\\b`, "i").test(urlText)) {
      return true;
    }
    if (/\/_serverFn\/[^/?#]*lockShop/i.test(urlText)) return true;
    return /lockShop|clearGateSession/i.test(hay);
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
    return "";
  }

  function publish(session) {
    if (!session || !runtime?.runtime?.sendMessage) return;
    try {
      runtime.runtime.sendMessage({ type: "shop-site-session", payload: session });
    } catch {
      // ignore
    }
  }

  function reportSiteLock() {
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
      if (!/\/unlock\b/i.test(location.pathname || "")) return;
      if (Date.now() - recentServerFnPostAt > SERVERFN_UNLOCK_NAV_MS) return;
      reportSiteLock();
    } catch {
      // ignore
    }
  }

  function onShopLoadSync() {
    if (!runtime?.runtime?.sendMessage) return;
    try {
      // Tools unlock → Firefox jar (exchange). Force when already on /unlock so a
      // stale gate / post-lock quiet cannot leave the SPA stuck.
      const onUnlock = /\/unlock\b/i.test(location.pathname || "");
      runtime.runtime
        .sendMessage({ type: "tools-to-site-unlock", forceExchange: onUnlock })
        .then((response) => {
          if (!response) return;
          if (response.ok && response.shouldReload && onUnlock) {
            location.reload();
            return;
          }
          if (response.locked && response.shouldReload && !onUnlock) {
            location.reload();
          }
        })
        .catch(() => {});
    } catch {
      // ignore
    }
    try {
      runtime.runtime.sendMessage({ type: "site-session-import" });
    } catch {
      // ignore
    }
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const input = args[0];
    const init = args[1] || {};
    const url = requestUrl(input);
    const method = init.method || (input && input.method) || "GET";
    try {
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
            const session = extractUnlock(text);
            if (session) publish(session);
            // Bare {ok:true} on known lock URL (Tools preload parity).
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
        const session = extractUnlock(this.responseText);
        if (session) publish(session);
      } catch {
        // ignore
      }
    });
    return xhrSend.apply(this, args);
  };

  // Soft SPA Lock: await lockFn(); clear sessionStorage gate; router → /unlock.
  // content-script does not re-run DOMContentLoaded on client navigations.
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

  // sessionStorage bf_shop_gate cleared by Lock (client mirror of gate).
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
          if (Date.now() - recentServerFnPostAt < SERVERFN_UNLOCK_NAV_MS) {
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onShopLoadSync, { once: true });
  } else {
    onShopLoadSync();
  }
})();
