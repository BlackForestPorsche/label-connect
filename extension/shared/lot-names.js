/* global globalThis, chrome, browser */
/**
 * On the Lot last-name helpers for SSF checkout.
 * Never reads book-today — only lot labels (cars.owner).
 *
 * Loaded in the background (fetch + storage) and content scripts (parse helpers).
 */
(function (root) {
  const api = root.AllDataRoLabels || (root.AllDataRoLabels = {});
  const runtime = typeof browser !== "undefined" ? browser : typeof chrome !== "undefined" ? chrome : null;
  const DEFAULT_SHOP = "https://shop.blackforestautomotive.com";
  const CACHE_MAX_AGE_MS = 5 * 60 * 1000;

  function lastNameFromLotLabel(label) {
    const text = String(label || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || /^no\s*name$/i.test(text)) return "";
    // "LAST, FIRST" → LAST
    if (text.includes(",")) {
      const head = text.split(",")[0].trim();
      if (head) return head;
    }
    const parts = text.split(" ").filter(Boolean);
    return parts[parts.length - 1] || "";
  }

  function lotLabelsToLastNames(items) {
    const seen = new Set();
    const names = [];
    for (const item of items || []) {
      const label = item && typeof item === "object" ? item.label : item;
      const last = lastNameFromLotLabel(label);
      if (!last) continue;
      const key = last.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(last);
    }
    names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    return names;
  }

  async function storageGet(keys) {
    if (!runtime?.storage?.local) return {};
    try {
      return (await runtime.storage.local.get(keys)) || {};
    } catch {
      return {};
    }
  }

  async function storageSet(obj) {
    if (!runtime?.storage?.local) return;
    try {
      await runtime.storage.local.set(obj);
    } catch {
      // ignore
    }
  }

  async function shopBaseUrl() {
    const stored = await storageGet(["shopBaseUrl"]);
    const value = stored.shopBaseUrl;
    if (typeof value === "string" && /^https:\/\/shop\.blackforestautomotive\.com\/?$/i.test(value.trim())) {
      return value.trim().replace(/\/$/, "");
    }
    return api.DEFAULT_SHOP_BASE || DEFAULT_SHOP;
  }

  /**
   * Background-only: Bearer session for widget API.
   * Never logs PIN/token.
   */
  async function createWidgetSession({ person, pin }) {
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
      shopPerson: String(person || "").trim(),
    });
    return { ok: true };
  }

  async function ensureWidgetToken() {
    const stored = await storageGet(["shopWidgetToken", "shopWidgetTokenExpiresAt"]);
    const token = stored.shopWidgetToken;
    const expiresAt = Number(stored.shopWidgetTokenExpiresAt || 0);
    if (token && expiresAt > Date.now() + 60_000) return { token };
    return { needsAuth: true };
  }

  /**
   * Background-only lot fetch. Never calls book-today.
   */
  async function resolveLotLastNames() {
    const cached = await storageGet(["lotLastNames", "lotLastNamesAt"]);
    const cachedNames = Array.isArray(cached.lotLastNames) ? cached.lotLastNames : [];
    const cachedAt = Number(cached.lotLastNamesAt || 0);
    const auth = await ensureWidgetToken();
    if (auth.needsAuth) {
      return {
        needsAuth: true,
        names: cachedNames,
        source: cachedNames.length ? "cache" : "auth",
        message: "Unlock desk extension (person + PIN) in the popup.",
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
      return {
        error: "Lot view unreachable.",
        names: cachedNames,
        source: cachedNames.length ? "cache" : "error",
      };
    }

    if (response.status === 401 || response.status === 403) {
      await storageSet({ shopWidgetToken: "", shopWidgetTokenExpiresAt: 0 });
      return { needsAuth: true, names: [], source: "auth", message: "PIN session expired — unlock again." };
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      return {
        error: (data && data.error) || `Lot view failed (${response.status}).`,
        names: cachedNames,
        source: cachedNames.length ? "cache" : "error",
      };
    }

    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
    const names = lotLabelsToLastNames(items);
    await storageSet({ lotLastNames: names, lotLastNamesAt: Date.now() });
    return { names, source: "lot" };
  }

  /**
   * Content-script friendly: ask the background, fall back to short cache.
   */
  async function loadLotLastNames() {
    if (runtime?.runtime?.sendMessage) {
      try {
        const response = await runtime.runtime.sendMessage({ type: "lot-last-names" });
        if (response && Array.isArray(response.names)) return response.names;
      } catch {
        // fall through to local cache
      }
    }
    const cached = await storageGet(["lotLastNames", "lotLastNamesAt"]);
    const names = Array.isArray(cached.lotLastNames) ? cached.lotLastNames : [];
    const at = Number(cached.lotLastNamesAt || 0);
    if (names.length && Date.now() - at < CACHE_MAX_AGE_MS * 12) return names;
    return [];
  }

  api.lastNameFromLotLabel = lastNameFromLotLabel;
  api.lotLabelsToLastNames = lotLabelsToLastNames;
  api.createWidgetSession = createWidgetSession;
  api.resolveLotLastNames = resolveLotLastNames;
  api.loadLotLastNames = loadLotLastNames;
})(globalThis);
