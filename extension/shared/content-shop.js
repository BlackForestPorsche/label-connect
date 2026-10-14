/* global chrome, browser */
/**
 * Shop site ↔ Desk:
 * - Capture unlock JSON widgetToken when present
 * - Capture lockShop / clearGateSession → lock Tools via :8788 DELETE
 * - On shop page load: Tools→website unlock (Bearer :8788 → exchange → bf_shop_gate)
 *   and from-gate nudge when the jar already has a gate (Desk lot names)
 */
(function () {
  const runtime = typeof browser !== "undefined" ? browser : chrome;

  function extractUnlock(raw) {
    if (typeof raw !== "string" || raw.indexOf("widgetToken") === -1) return null;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    // TanStack server-fn wraps: result / data / payload / nested ok envelopes.
    const candidates = [
      data,
      data && data.data,
      data && data.payload,
      data && data.result,
      data && data.result && data.result.data,
      data && data.result && data.result.result,
    ].filter(Boolean);
    for (const obj of candidates) {
      if (!obj || typeof obj !== "object") continue;
      if (!obj.widgetToken || !obj.widgetExpiresAt) continue;
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
    const hay = `${url || ""}\n${body == null ? "" : String(body)}`;
    if (/unlockShop|widgetToken|widgetExpiresAt/i.test(hay)) return false;
    if (/widget\/logout/i.test(hay)) return true;
    if (/\/api\/widget\/session/i.test(hay)) return false;
    // TanStack server fn id / path / serialized createServerFn payload.
    return /lockShop|clearGateSession|gate\.ts.*lockShop|\/lockShop\b/i.test(hay);
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
    if (looksLikeLock(url, method, "")) return true;
    const bareOk =
      typeof text === "string" &&
      (/^\s*\{\s*"ok"\s*:\s*true\s*\}\s*$/.test(text) ||
        /^\s*\{\s*"ok"\s*:\s*true\s*,\s*"result"\s*:\s*\{\s*"ok"\s*:\s*true\s*\}\s*\}\s*$/.test(text));
    return Boolean(bareOk && /lockShop|clearGateSession/i.test(String(url || "")));
  }

  function publish(session) {
    if (!session || !runtime?.runtime?.sendMessage) return;
    const send = () => {
      try {
        return runtime.runtime.sendMessage({ type: "shop-site-session", payload: session });
      } catch {
        return Promise.resolve(null);
      }
    };
    // One retry — unlock JSON can race Tools localLock clear.
    send()
      .then((res) => {
        if (res && res.ok === false && res.toolsPublished === false) return send();
        return res;
      })
      .catch(() => send().catch(() => {}));
  }

  function reportSiteLock() {
    if (!runtime?.runtime?.sendMessage) return;
    try {
      runtime.runtime.sendMessage({ type: "site-lock" }).catch(() => {});
    } catch {
      // ignore
    }
  }

  function onShopLoadSync() {
    if (!runtime?.runtime?.sendMessage) return;
    const onUnlock = /\/unlock\b/i.test(location.pathname || "");
    try {
      // /unlock: Tools→site only (remint guard). Unlocked pages: site→Tools
      // publish FIRST, then Tools→site — otherwise a brief hasSession:false
      // clears bf_shop_gate (unlock flash / website→Tools miss).
      if (onUnlock) {
        runtime.runtime
          .sendMessage({
            type: "tools-to-site-unlock",
            forceExchange: false,
            skipSitePublish: true,
          })
          .then((response) => {
            if (response?.ok && response.shouldReload) location.reload();
          })
          .catch(() => {});
        return;
      }
      runtime.runtime
        .sendMessage({ type: "site-session-import" })
        .catch(() => {})
        .then(() =>
          runtime.runtime.sendMessage({
            type: "tools-to-site-unlock",
            forceExchange: false,
          }),
        )
        .then((response) => {
          if (!response) return;
          if (response.locked && response.shouldReload) location.reload();
        })
        .catch(() => {});
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
      // Fire site-lock BEFORE await — /unlock navigation must not beat Tools DELETE.
      if (looksLikeLock(url, method, bodyText(init.body))) {
        reportSiteLock();
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
      } catch {
        // ignore
      }
    });
    return xhrSend.apply(this, args);
  };

  // Do NOT reportSiteLock on bare /unlock navigation — that fires during unlock
  // bounce and intentional Tools→site heal, and wrongly locks Tools (~30s later).

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
    const settings = message && message.settings && typeof message.settings === "object" ? message.settings : null;
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
      // Hold Tools prefs against the site's 4s poll + keep-local-fun-on bias for a short window.
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
        if (!message || message.type !== "apply-tools-person-settings") return false;
        sendResponse(applyToolsPersonSettings(message));
        return false;
      });
    } catch {
      // ignore
    }
  }

  // Immediate website → Tools fun on/off (last user action), not only the 4s site poll.
  let prefsPushTimer = 0;
  function pushLocalPrefsToTools() {
    try {
      const person = localStorage.getItem("bf-last-person") || "";
      const all = JSON.parse(localStorage.getItem("bf-person-settings") || "{}") || {};
      const settings = person && all[person] && typeof all[person] === "object" ? all[person] : null;
      if (!person || !settings || !runtime?.runtime?.sendMessage) return;
      // Skip echo of a Tools→site apply we just wrote (short; :8788 should feel instant).
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
  // Same-tab toggles do not fire `storage` — sub-second poll for instant Tools push.
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onShopLoadSync, { once: true });
  } else {
    onShopLoadSync();
  }
})();
