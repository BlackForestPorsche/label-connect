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
    const hay = `${url || ""}\n${body == null ? "" : String(body)}`;
    if (/unlockShop|widgetToken|widgetExpiresAt/i.test(hay)) return false;
    if (/widget\/logout/i.test(hay)) return true;
    if (/\/api\/widget\/session/i.test(hay)) return false;
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
    if (!runtime?.runtime?.sendMessage) return;
    try {
      runtime.runtime.sendMessage({ type: "site-lock" }).catch(() => {});
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
        const session = extractUnlock(this.responseText);
        if (session) publish(session);
      } catch {
        // ignore
      }
    });
    return xhrSend.apply(this, args);
  };

  function publishPersonSettings(settings) {
    if (!settings || !runtime?.runtime?.sendMessage) return;
    try {
      runtime.runtime.sendMessage({ type: "site-person-settings", payload: settings });
    } catch {
      // ignore
    }
  }

  function readLocalPersonSettings() {
    try {
      const raw = localStorage.getItem("bf-person-settings");
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // Firefox funMode / prefs → Tools :8788 (push on change).
  let lastSettingsJson = "";
  try {
    const initial = readLocalPersonSettings();
    if (initial) {
      lastSettingsJson = JSON.stringify(initial);
      publishPersonSettings(initial);
    }
    window.addEventListener("storage", (event) => {
      if (event.key !== "bf-person-settings") return;
      try {
        const next = event.newValue ? JSON.parse(event.newValue) : null;
        const json = next ? JSON.stringify(next) : "";
        if (!next || json === lastSettingsJson) return;
        lastSettingsJson = json;
        publishPersonSettings(next);
      } catch {
        // ignore
      }
    });
    // Same-tab writes do not fire `storage` — poll localStorage briefly.
    setInterval(() => {
      const next = readLocalPersonSettings();
      if (!next) return;
      const json = JSON.stringify(next);
      if (json === lastSettingsJson) return;
      lastSettingsJson = json;
      publishPersonSettings(next);
    }, 1000);
  } catch {
    // ignore
  }

  if (runtime?.runtime?.onMessage?.addListener) {
    try {
      runtime.runtime.onMessage.addListener((message) => {
        if (!message || message.type !== "apply-person-settings") return;
        try {
          const payload = message.payload;
          if (!payload || typeof payload !== "object") return;
          const json = JSON.stringify(payload);
          if (json === lastSettingsJson) return;
          lastSettingsJson = json;
          localStorage.setItem("bf-person-settings", json);
          window.dispatchEvent(new Event("bf-person-settings-updated"));
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onShopLoadSync, { once: true });
  } else {
    onShopLoadSync();
  }
})();
