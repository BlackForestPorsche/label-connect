/* global chrome, browser */
/**
 * Black Forest Desk background:
 * - POST Create RO payloads to local Labels (/api/print-ro)
 * - Fetch On the Lot last names from shop widget API (never book-today)
 */
(function () {
  const runtime = typeof browser !== "undefined" ? browser : chrome;
  const DEFAULT_LABELS = "http://127.0.0.1:8080";
  const DEFAULT_SHOP = "https://shop.blackforestautomotive.com";

  async function storageGet(keys) {
    try {
      return (await runtime.storage.local.get(keys)) || {};
    } catch {
      return {};
    }
  }

  async function storageSet(obj) {
    try {
      await runtime.storage.local.set(obj);
    } catch {
      // ignore
    }
  }

  async function labelsBaseUrl() {
    const stored = await storageGet(["labelsBaseUrl"]);
    const value = stored.labelsBaseUrl;
    if (typeof value === "string" && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(value.trim())) {
      return value.trim().replace(/\/$/, "");
    }
    return DEFAULT_LABELS;
  }

  async function shopBaseUrl() {
    const stored = await storageGet(["shopBaseUrl"]);
    const value = stored.shopBaseUrl;
    if (typeof value === "string" && /^https:\/\/shop\.blackforestautomotive\.com\/?$/i.test(value.trim())) {
      return value.trim().replace(/\/$/, "");
    }
    return DEFAULT_SHOP;
  }

  function lastNameFromLotLabel(label) {
    const text = String(label || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || /^no\s*name$/i.test(text)) return "";
    if (text.includes(",")) {
      const head = text.split(",")[0].trim();
      if (head) return head;
    }
    const parts = text.split(" ").filter(Boolean);
    return parts[parts.length - 1] || "";
  }

  function lotItemsToLastNames(items) {
    const seen = new Set();
    const names = [];
    for (const item of items || []) {
      const last = lastNameFromLotLabel(item && item.label);
      if (!last) continue;
      const key = last.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(last);
    }
    names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    return names;
  }

  async function printRo(payload) {
    if (!payload || typeof payload !== "object") {
      return { error: "Missing payload." };
    }
    if (payload.event && /update|schedule|assign|new[\s_-]*r\/?o/i.test(String(payload.event))) {
      return { error: "Blocked — only Create R/O may print." };
    }
    const body = {
      ...payload,
      event: "create-ro",
      source: payload.source || "alldata-extension",
    };
    const base = await labelsBaseUrl();
    let response;
    try {
      response = await fetch(`${base}/api/print-ro`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      return { error: `Labels is not reachable at ${base}. Is it running?` };
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      return { error: (data && data.error) || `Labels returned ${response.status}.` };
    }
    return data || { ok: true };
  }

  async function ensureWidgetToken() {
    const stored = await storageGet(["shopWidgetToken", "shopWidgetTokenExpiresAt"]);
    const token = stored.shopWidgetToken;
    const expiresAt = Number(stored.shopWidgetTokenExpiresAt || 0);
    if (token && expiresAt > Date.now() + 60_000) {
      return { token };
    }
    return { needsAuth: true };
  }

  async function widgetSession({ person, pin }) {
    const base = await shopBaseUrl();
    let response;
    try {
      response = await fetch(`${base}/api/widget/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ person, pin }),
      });
    } catch {
      return { error: "Shop widget session unreachable." };
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      return { error: (data && data.error) || `Session failed (${response.status}).` };
    }
    const token = data?.token || data?.accessToken || data?.bearer;
    if (!token) return { error: "Session response missing token." };
    const ttlMs = 8 * 60 * 60 * 1000;
    await storageSet({
      shopWidgetToken: token,
      shopWidgetTokenExpiresAt: Date.now() + ttlMs,
    });
    return { ok: true };
  }

  async function fetchLotLastNames() {
    const auth = await ensureWidgetToken();
    if (auth.needsAuth) {
      const cached = await storageGet(["lotLastNames"]);
      return {
        needsAuth: true,
        names: Array.isArray(cached.lotLastNames) ? cached.lotLastNames : [],
      };
    }
    const base = await shopBaseUrl();
    let response;
    try {
      response = await fetch(`${base}/api/widget/views/lot`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: "application/json",
        },
      });
    } catch {
      const cached = await storageGet(["lotLastNames"]);
      return {
        error: "Lot view unreachable.",
        names: Array.isArray(cached.lotLastNames) ? cached.lotLastNames : [],
      };
    }
    if (response.status === 401 || response.status === 403) {
      await storageSet({ shopWidgetToken: "", shopWidgetTokenExpiresAt: 0 });
      return { needsAuth: true, names: [] };
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      const cached = await storageGet(["lotLastNames"]);
      return {
        error: (data && data.error) || `Lot view failed (${response.status}).`,
        names: Array.isArray(cached.lotLastNames) ? cached.lotLastNames : [],
      };
    }
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
    const names = lotItemsToLastNames(items);
    await storageSet({ lotLastNames: names, lotLastNamesAt: Date.now() });
    return { names };
  }

  runtime.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;
    if (message.type === "print-ro") {
      printRo(message.payload).then(sendResponse);
      return true;
    }
    if (message.type === "lot-last-names") {
      fetchLotLastNames().then(sendResponse);
      return true;
    }
    if (message.type === "widget-session") {
      widgetSession(message.payload || {}).then(sendResponse);
      return true;
    }
    return false;
  });
})();
