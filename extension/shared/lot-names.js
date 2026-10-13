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
  const PERSON_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
  const PIN_RE = /^\d{4,12}$/;
  /** Desk unlock roster (plasmoid fallback). */
  const DESK_PEOPLE = Object.freeze(["logan", "stephen", "steve", "carla", "john"]);

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

  function normalizePerson(person) {
    return String(person || "")
      .trim()
      .toLowerCase();
  }

  function friendlyWidgetError(code, status) {
    const key = String(code || "").trim().toLowerCase();
    if (key === "unauthorized" || status === 401) {
      return "Desk PIN rejected (or person not found). Pick a person from the list and use the desk/shop widget PIN — not another password.";
    }
    if (key === "locked" || status === 429) {
      return "Too many PIN tries — wait a bit, then unlock again with your desk PIN.";
    }
    if (key === "pin_change_required") {
      return "This person must set a PIN on the shop site first, then unlock here.";
    }
    if (key === "https_required") {
      return "Shop widget login needs HTTPS. Check shop.blackforestautomotive.com.";
    }
    if (key === "bad_request") {
      return "Enter a valid shop person (lowercase letters) and a 4–12 digit desk PIN.";
    }
    if (key === "rate_limited") {
      return "Shop rate-limited this request. Wait a minute, then try again.";
    }
    if (key && !/^[a-z_]+$/.test(key)) {
      return String(code);
    }
    if (status) return `Shop unlock failed (${status}). Enter your desk PIN in the popup.`;
    return "Could not unlock. Enter your desk PIN in the Black Forest Desk popup.";
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
    } catch {}
  }

  async function setPinBadge(needsPin) {
    if (!runtime?.action?.setBadgeText) return;
    try {
      if (needsPin) {
        await runtime.action.setBadgeText({ text: "PIN" });
        await runtime.action.setBadgeBackgroundColor?.({ color: "#7a1f1f" });
        await runtime.action.setTitle?.({
          title: "Black Forest Desk — enter desk PIN to unlock lot names",
        });
      } else {
        const stored = await storageGet(["deskUpdateAvailable"]);
        if (stored.deskUpdateAvailable?.version) {
          await runtime.action.setBadgeText({ text: "↑" });
          await runtime.action.setBadgeBackgroundColor?.({ color: "#1f4d2a" });
        } else {
          await runtime.action.setBadgeText({ text: "" });
          await runtime.action.setTitle?.({ title: "Black Forest Desk" });
        }
      }
    } catch {}
  }

  async function shopBaseUrl() {
    const stored = await storageGet(["shopBaseUrl"]);
    const value = stored.shopBaseUrl;
    if (typeof value === "string" && /^https:\/\/shop\.blackforestautomotive\.com\/?$/i.test(value.trim())) {
      return value.trim().replace(/\/$/, "");
    }
    return api.DEFAULT_SHOP_BASE || DEFAULT_SHOP;
  }

  async function createWidgetSession({ person, pin }) {
    const normalized = normalizePerson(person);
    const pinText = String(pin || "");
    if (!PERSON_ID_RE.test(normalized)) {
      return {
        error: "Enter a valid shop person (lowercase, same as unlock — e.g. logan).",
      };
    }
    if (!PIN_RE.test(pinText)) {
      return { error: "Desk PIN must be 4–12 digits (same PIN as the shop / Plasma widget)." };
    }

    const base = await shopBaseUrl();
    let response;
    try {
      response = await fetch(`${base}/api/widget/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ person: normalized, pin: pinText }),
      });
    } catch {
      return {
        error:
          "Could not reach the shop widget API. Check the network, then enter your desk PIN again.",
      };
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      return { error: friendlyWidgetError(data && data.error, response.status) };
    }
    const token = data?.token || data?.accessToken || data?.bearer;
    if (!token) return { error: "Shop unlock worked but returned no token. Try again." };
    const parsedExpiry = data?.expiresAt ? Date.parse(data.expiresAt) : NaN;
    const ttlMs = Number.isFinite(parsedExpiry) ? Math.max(parsedExpiry - Date.now(), 60_000) : 8 * 60 * 60 * 1000;
    await storageSet({
      shopWidgetToken: token,
      shopWidgetTokenExpiresAt: Date.now() + ttlMs,
      shopPerson: normalized,
    });
    await setPinBadge(false);
    return { ok: true, person: normalized };
  }

  async function ensureWidgetToken() {
    const stored = await storageGet(["shopWidgetToken", "shopWidgetTokenExpiresAt"]);
    const token = stored.shopWidgetToken;
    const expiresAt = Number(stored.shopWidgetTokenExpiresAt || 0);
    if (token && expiresAt > Date.now() + 60_000) return { token };
    return { needsAuth: true };
  }

  async function resolveLotLastNames() {
    const cached = await storageGet(["lotLastNames", "lotLastNamesAt"]);
    const cachedNames = Array.isArray(cached.lotLastNames) ? cached.lotLastNames : [];
    const auth = await ensureWidgetToken();
    if (auth.needsAuth) {
      await setPinBadge(true);
      return {
        needsAuth: true,
        names: cachedNames,
        source: cachedNames.length ? "cache" : "auth",
        message:
          "Enter your desk PIN in the Black Forest Desk popup (toolbar icon), then Refresh. Same person + PIN as the shop / Plasma widget.",
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
        error: "Lot view unreachable. Is the shop online?",
        names: cachedNames,
        source: cachedNames.length ? "cache" : "error",
      };
    }

    if (response.status === 401 || response.status === 403) {
      await storageSet({ shopWidgetToken: "", shopWidgetTokenExpiresAt: 0 });
      await setPinBadge(true);
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      const code = data && data.error;
      return {
        needsAuth: true,
        names: [],
        source: "auth",
        message:
          code === "pin_change_required"
            ? friendlyWidgetError(code, response.status)
            : "Desk PIN session expired — open the Black Forest Desk popup and enter your desk PIN again.",
      };
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      return {
        error: friendlyWidgetError(data && data.error, response.status),
        names: cachedNames,
        source: cachedNames.length ? "cache" : "error",
      };
    }

    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
    const names = lotLabelsToLastNames(items);
    await storageSet({ lotLastNames: names, lotLastNamesAt: Date.now() });
    await setPinBadge(false);
    return { names, source: "lot" };
  }

  async function loadLotLastNames() {
    if (runtime?.runtime?.sendMessage) {
      try {
        const response = await runtime.runtime.sendMessage({ type: "lot-last-names" });
        if (response && Array.isArray(response.names)) return response.names;
      } catch {}
    }
    const cached = await storageGet(["lotLastNames", "lotLastNamesAt"]);
    const names = Array.isArray(cached.lotLastNames) ? cached.lotLastNames : [];
    const at = Number(cached.lotLastNamesAt || 0);
    if (names.length && Date.now() - at < CACHE_MAX_AGE_MS * 12) return names;
    return [];
  }

  api.lastNameFromLotLabel = lastNameFromLotLabel;
  api.lotLabelsToLastNames = lotLabelsToLastNames;
  api.DESK_PEOPLE = DESK_PEOPLE;
  api.normalizePerson = normalizePerson;
  api.friendlyWidgetError = friendlyWidgetError;
  api.createWidgetSession = createWidgetSession;
  api.resolveLotLastNames = resolveLotLastNames;
  api.loadLotLastNames = loadLotLastNames;
})(globalThis);
