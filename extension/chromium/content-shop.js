/* global chrome, browser */
/**
 * Shop site → Desk: capture unlock JSON widgetToken when present; nudge
 * background to try from-gate when the shop page loads (same Firefox profile).
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

  function publish(session) {
    if (!session || !runtime?.runtime?.sendMessage) return;
    try {
      runtime.runtime.sendMessage({ type: "shop-site-session", payload: session });
    } catch {
      // ignore
    }
  }

  function trySiteImportQuiet() {
    if (!runtime?.runtime?.sendMessage) return;
    try {
      runtime.runtime.sendMessage({ type: "site-session-import" });
    } catch {
      // ignore
    }
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
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

  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function sendPatched(...args) {
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", trySiteImportQuiet, { once: true });
  } else {
    trySiteImportQuiet();
  }
})();
