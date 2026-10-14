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
  const DEFAULT_TOOLS_BRIDGE = "http://127.0.0.1:8788";
  const GATE_COOKIE = "bf_shop_gate";
  const CACHE_MAX_AGE_MS = 5 * 60 * 1000;
  const PERSON_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
  const PIN_RE = /^\d{4,12}$/;
  /** After Firefox website lock, do not re-exchange Tools Bearer into the site jar. */
  const SITE_LOCK_QUIET_MS = 90_000;
  /** Desk unlock roster (plasmoid fallback). */
  const DESK_PEOPLE = Object.freeze(["logan", "stephen", "steve", "carla", "john"]);
  let siteLockQuietUntil = 0;
  /** While exchanging / applying gateToken, ignore cookie-removal → site-lock. */
  let unlockHoldUntil = 0;

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
          await runtime.action.setTitle?.({
            title: `Black Forest Desk — update ${stored.deskUpdateAvailable.version} ready`,
          });
        } else {
          // Unlocked: empty badge (no PIN). Title signals session is live.
          await runtime.action.setBadgeText({ text: "" });
          await runtime.action.setBadgeBackgroundColor?.({ color: "#1f4d2a" });
          await runtime.action.setTitle?.({
            title: "Black Forest Desk — lot names unlocked",
          });
        }
      }
    } catch {}
  }

  async function hasFreshWidgetToken(minTtlMs = 60_000) {
    const stored = await storageGet(["shopWidgetToken", "shopWidgetTokenExpiresAt"]);
    const token = stored.shopWidgetToken;
    const expiresAt = Number(stored.shopWidgetTokenExpiresAt || 0);
    return Boolean(token && expiresAt > Date.now() + minTtlMs);
  }

  /** Refresh toolbar badge from stored token (does not hit the network). */
  async function refreshUnlockBadge() {
    const fresh = await hasFreshWidgetToken(0);
    await setPinBadge(!fresh);
    return { unlocked: fresh };
  }

  async function shopBaseUrl() {
    const stored = await storageGet(["shopBaseUrl"]);
    const value = stored.shopBaseUrl;
    if (typeof value === "string" && /^https:\/\/shop\.blackforestautomotive\.com\/?$/i.test(value.trim())) {
      return value.trim().replace(/\/$/, "");
    }
    return api.DEFAULT_SHOP_BASE || DEFAULT_SHOP;
  }

  async function toolsBridgeBaseUrl() {
    const stored = await storageGet(["toolsBridgeBaseUrl"]);
    const value = stored.toolsBridgeBaseUrl;
    if (
      typeof value === "string" &&
      /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(value.trim())
    ) {
      return value.trim().replace(/\/$/, "");
    }
    return api.DEFAULT_TOOLS_BRIDGE_BASE || DEFAULT_TOOLS_BRIDGE;
  }

  async function storeWidgetToken({
    token,
    expiresAt,
    person,
    source,
    publishToTools = true,
  } = {}) {
    const parsedExpiry = expiresAt ? Date.parse(expiresAt) : NaN;
    const ttlMs = Number.isFinite(parsedExpiry)
      ? Math.max(parsedExpiry - Date.now(), 60_000)
      : 8 * 60 * 60 * 1000;
    const normalized = normalizePerson(person);
    const src = source || "pin";
    // During site-lock quiet, never publish a leftover Firefox gate into Tools
    // (locked /unlock refresh remint). PIN / explicit shop unlock still win.
    const allowPublish =
      publishToTools && !(siteLockQuietActive() && (src === "site-gate" || src === "shop-site"));
    // Website → Tools unlock: clear quiet + hold so cookie churn cannot re-lock Tools.
    if (allowPublish && (src === "shop-site" || src === "site-gate" || src === "pin")) {
      siteLockQuietUntil = 0;
      armUnlockHold();
    }
    await storageSet({
      shopWidgetToken: token,
      shopWidgetTokenExpiresAt: Date.now() + ttlMs,
      shopPerson: normalized || undefined,
      shopWidgetTokenSource: src,
    });
    await setPinBadge(false);
    // Website → Tools unlock: POST :8788/v1/widget-session (Tools onPublished → leave /unlock).
    if (
      allowPublish &&
      token &&
      (src === "shop-site" || src === "site-gate" || src === "pin")
    ) {
      const expiresIso = Number.isFinite(parsedExpiry)
        ? new Date(parsedExpiry).toISOString()
        : new Date(Date.now() + ttlMs).toISOString();
      const published = await publishSessionToToolsBridge({
        token,
        expiresAt: expiresIso,
        person: normalized,
      });
      if (published.ok) armUnlockHold();
      return { ok: true, person: normalized, source: src, toolsPublished: Boolean(published.ok) };
    }
    return { ok: true, person: normalized, source: src };
  }

  /**
   * Publish Desk/site Bearer into Tools shared file (POST :8788/v1/widget-session).
   * Tools onPublished → exchange → Electron bf_shop_gate (website unlock → Tools unlock).
   */
  async function publishSessionToToolsBridge({ token, expiresAt, person } = {}) {
    if (!token || !expiresAt) {
      return { ok: false, reason: "bad_payload" };
    }
    const base = await toolsBridgeBaseUrl();
    const body = JSON.stringify({
      token: String(token),
      expiresAt: String(expiresAt),
      person: person ? String(person) : "",
    });
    // Website unlock → Tools: retry — bridge may still be mid localLock clear.
    let last = { ok: false, reason: "bridge_unreachable" };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response;
      try {
        response = await fetch(`${base}/v1/widget-session`, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body,
          cache: "no-store",
        });
      } catch {
        last = { ok: false, reason: "bridge_unreachable" };
        continue;
      }
      if (!response.ok) {
        last = { ok: false, reason: "publish_failed", status: response.status };
        continue;
      }
      return { ok: true, reason: "published" };
    }
    return last;
  }

  /**
   * Website lock → Tools lock. Prefer POST /v1/lock (SPA → /unlock + jar clear),
   * then DELETE session as belt-and-suspenders. Always try both when reachable.
   */
  async function lockToolsViaBridge() {
    const base = await toolsBridgeBaseUrl();
    const tryOnce = async (method, path) => {
      try {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (response.status === 404 || response.status === 405) {
          return { ok: false, reason: "lock_unsupported", status: response.status };
        }
        if (!response.ok) {
          return { ok: false, reason: "lock_failed", status: response.status };
        }
        let data = null;
        try {
          data = await response.json();
        } catch {
          data = null;
        }
        return { ok: true, reason: "locked", data };
      } catch {
        return { ok: false, reason: "bridge_unreachable" };
      }
    };
    // POST /v1/lock first — navigates Tools SPA to /unlock via onLock.
    let result = await tryOnce("POST", "/v1/lock");
    const del = await tryOnce("DELETE", "/v1/widget-session");
    if (!result.ok && del.ok) result = del;
    else if (!result.ok && del.reason === "lock_unsupported") {
      result = await tryOnce("POST", "/v1/lock");
    }
    return result;
  }

  /** Arm quiet immediately so /unlock tab-load cannot exchange before Tools DELETE finishes. */
  function armSiteLockQuiet(nowMs = Date.now()) {
    siteLockQuietUntil = nowMs + SITE_LOCK_QUIET_MS;
  }

  const UNLOCK_HOLD_MS = 8_000;
  function armUnlockHold(nowMs = Date.now()) {
    unlockHoldUntil = nowMs + UNLOCK_HOLD_MS;
  }
  function unlockHoldActive(nowMs = Date.now()) {
    return nowMs < unlockHoldUntil;
  }

  /**
   * Firefox website lock: clear gate + Desk token, lock Tools bridge, block re-exchange.
   */
  async function syncSiteLockToTools({ reloadShopTabs = true } = {}) {
    // Intentional website/Tools unlock in flight — do not publish lock (bounce fight).
    if (unlockHoldActive()) {
      return { ok: false, skipped: "unlock_hold", reason: "unlock_hold" };
    }
    armSiteLockQuiet();
    const hadGate = (await readShopGateCookie()).present;
    await clearShopGateCookie();
    await storageSet({
      shopWidgetToken: "",
      shopWidgetTokenExpiresAt: 0,
      shopGateFromToolsAt: 0,
    });
    await setPinBadge(true);
    // POST /v1/lock clears Electron jar + SPA; DELETE clears shared file (probe: both needed).
    let locked = await lockToolsViaBridge();
    // Retry while Tools still shows a session (Firefox gate republish remint ~24s).
    for (let i = 0; i < 4; i += 1) {
      if (unlockHoldActive()) {
        return { ok: false, skipped: "unlock_hold", reason: "unlock_hold" };
      }
      const health = await probeToolsBridgeHealth();
      if (!health.reachable || health.hasSession === false) break;
      locked = await lockToolsViaBridge();
    }
    if (hadGate && reloadShopTabs && runtime?.tabs?.query && runtime?.tabs?.reload) {
      try {
        const tabs = await runtime.tabs.query({
          url: ["https://shop.blackforestautomotive.com/*"],
        });
        for (const tab of tabs || []) {
          if (tab?.id == null) continue;
          const url = String(tab.url || "");
          if (url.includes("/unlock")) continue;
          try {
            await runtime.tabs.reload(tab.id);
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }
    return {
      ok: true,
      locked: true,
      toolsLocked: Boolean(locked.ok),
      reason: locked.ok ? "site_lock" : locked.reason || "site_lock_tools_pending",
      shouldReload: hadGate,
    };
  }

  function siteLockQuietActive(nowMs = Date.now()) {
    return nowMs < siteLockQuietUntil;
  }

  /** Read bf_shop_gate from the default browser profile. Never logs the value. */
  async function readShopGateCookie() {
    const base = await shopBaseUrl();
    const name = api.SHOP_GATE_COOKIE || GATE_COOKIE;
    if (!runtime?.cookies?.get) {
      return { present: false, reason: "no_cookies_api" };
    }
    try {
      const cookie = await runtime.cookies.get({ url: `${base}/`, name });
      if (cookie && cookie.value) return { present: true };
      return { present: false, reason: "missing" };
    } catch {
      return { present: false, reason: "cookie_error" };
    }
  }

  /**
   * Probe Tools desk bridge health (no token). Distinguishes bridge-down vs locked.
   * Bridge up + hasSession:false → Tools intentionally locked (clear Firefox gate).
   * Bridge unreachable → do not clear Firefox gate (Tools may be quitting).
   */
  async function probeToolsBridgeHealth() {
    const base = await toolsBridgeBaseUrl();
    let response;
    try {
      response = await fetch(`${base}/health`, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
    } catch {
      return { reachable: false, reason: "bridge_unreachable" };
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      return { reachable: true, hasSession: false, reason: "health_error", status: response.status };
    }
    const hasSession = Boolean(data && data.hasSession);
    const hasGate = Boolean(data && data.hasGate);
    return {
      reachable: true,
      hasSession,
      hasGate,
      person: data && data.person ? String(data.person) : "",
      reason: hasSession ? "has_session" : hasGate ? "gate_only" : "no_session",
    };
  }

  async function clearShopGateCookie() {
    const base = await shopBaseUrl();
    const name = api.SHOP_GATE_COOKIE || GATE_COOKIE;
    if (!runtime?.cookies?.remove) return { ok: false, reason: "no_cookies_api" };
    try {
      await runtime.cookies.remove({ url: `${base}/`, name });
      return { ok: true };
    } catch {
      return { ok: false, reason: "remove_failed" };
    }
  }

  /**
   * Write bf_shop_gate into this browser's jar (Firefox/Chromium ≠ Electron persist:shop).
   * Prefer explicit gateToken from exchange JSON; never log the value.
   */
  async function applyGateCookie(value, expiresAt) {
    if (!value || !runtime?.cookies?.set) {
      return { ok: false, reason: "no_cookies_api" };
    }
    const base = await shopBaseUrl();
    const name = api.SHOP_GATE_COOKIE || GATE_COOKIE;
    const details = {
      url: `${base}/`,
      name,
      value: String(value),
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "no_restriction",
    };
    const parsed = expiresAt ? Date.parse(expiresAt) : NaN;
    if (Number.isFinite(parsed)) {
      details.expirationDate = Math.floor(parsed / 1000);
    }
    try {
      await runtime.cookies.set(details);
      return { ok: true };
    } catch {
      try {
        delete details.sameSite;
        await runtime.cookies.set(details);
        return { ok: true };
      } catch {
        return { ok: false, reason: "set_failed" };
      }
    }
  }

  /**
   * Tools/Desk Bearer → website bf_shop_gate via POST /api/widget/session/exchange.
   * This is the missing half of App↔website sync (Desk already imported :8788 for itself).
   */
  /**
   * Copy bf_shop_gate from Tools Electron jar (GET :8788/v1/shop-gate).
   * Works when exchange Set-Cookie / gateToken JSON is missing on the site.
   */
  async function importShopGateFromToolsBridge() {
    const base = await toolsBridgeBaseUrl();
    let response;
    try {
      response = await fetch(`${base}/v1/shop-gate`, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
    } catch {
      return { ok: false, reason: "bridge_unreachable" };
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (response.status === 404) {
      return { ok: false, reason: "no_gate", error: "Tools has no shop gate cookie yet." };
    }
    if (!response.ok || !data || !data.gateToken) {
      return { ok: false, reason: "gate_copy_failed", status: response.status };
    }
    await applyGateCookie(data.gateToken, data.expiresAt);
    const gate = await readShopGateCookie();
    if (!gate.present) {
      return { ok: false, reason: "cookie_set_failed" };
    }
    await storageSet({ shopGateFromToolsAt: Date.now() });
    return {
      ok: true,
      person: data.person ? String(data.person) : "",
      expiresAt: data.expiresAt || "",
      source: "tools-jar-gate",
    };
  }

  let lastToolsPrefsFingerprint = "";

  /** Pull Tools SPA person settings and push into open shop tabs (fun on/off last-wins). */
  async function applyToolsPersonSettingsToSite() {
    const base = await toolsBridgeBaseUrl();
    let response;
    try {
      response = await fetch(`${base}/v1/person-settings`, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
    } catch {
      return { ok: false, reason: "bridge_unreachable" };
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok || !data || !data.ok || !data.person || !data.settings) {
      return { ok: false, reason: "no_settings", status: response.status };
    }
    const fp = `${data.person}|${data.settings.funMode}|${data.updatedAt || ""}`;
    if (fp === lastToolsPrefsFingerprint) {
      return { ok: true, person: data.person, funMode: data.settings.funMode, applied: 0, skipped: "same" };
    }
    lastToolsPrefsFingerprint = fp;
    if (!runtime?.tabs?.query || !runtime?.tabs?.sendMessage) {
      return { ok: false, reason: "no_tabs_api" };
    }
    let applied = 0;
    try {
      const tabs = await runtime.tabs.query({
        url: ["https://shop.blackforestautomotive.com/*"],
      });
      for (const tab of tabs || []) {
        if (tab?.id == null) continue;
        try {
          await runtime.tabs.sendMessage(tab.id, {
            type: "apply-tools-person-settings",
            person: data.person,
            settings: data.settings,
            updatedAt: data.updatedAt || Date.now(),
          });
          applied += 1;
        } catch {
          // tab may not have content-shop yet
        }
      }
    } catch {
      return { ok: false, reason: "tabs_failed" };
    }
    return {
      ok: true,
      person: data.person,
      funMode: data.settings.funMode,
      applied,
      source: "tools-spa",
    };
  }

  /** Website → Tools: push Firefox funMode/prefs into Electron (immediate, last write). */
  async function publishPersonSettingsToToolsBridge({ person, settings } = {}) {
    if (!person || !settings) return { ok: false, reason: "bad_payload" };
    const base = await toolsBridgeBaseUrl();
    let response;
    try {
      response = await fetch(`${base}/v1/person-settings`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ person: String(person), settings }),
        cache: "no-store",
      });
    } catch {
      return { ok: false, reason: "bridge_unreachable" };
    }
    if (!response.ok) {
      return { ok: false, reason: "publish_failed", status: response.status };
    }
    lastToolsPrefsFingerprint = `${person}|${settings.funMode}|${Date.now()}`;
    return { ok: true, person, funMode: settings.funMode, source: "site-push" };
  }

  let bridgeSyncPollTimer = null;
  let lastBridgeSessionFp = "";

  /**
   * Local :8788 must feel instant — poll Tools health + prefs well under 1s.
   * Session fingerprint flip → syncToolsSessionToSite (lock/unlock) without waiting
   * on tab load or the 2-minute alarm.
   */
  function startBridgeSyncPoll() {
    if (bridgeSyncPollTimer) return;
    const TICK_MS = 400;
    bridgeSyncPollTimer = setInterval(() => {
      void (async () => {
        try {
          const health = await probeToolsBridgeHealth();
          const fp = health.reachable
            ? `up|${health.hasSession ? "1" : "0"}|${health.hasGate ? "g" : "-"}|${health.person || ""}`
            : "down";
          if (fp !== lastBridgeSessionFp) {
            const prev = lastBridgeSessionFp;
            lastBridgeSessionFp = fp;
            // First tick only seeds fingerprint — avoid reload storms on load.
            if (prev) {
              await syncToolsSessionToSite({ reloadUnlockTabs: true });
            }
          }
          await applyToolsPersonSettingsToSite();
        } catch {
          // ignore
        }
      })();
    }, TICK_MS);
  }

  startBridgeSyncPoll();

  async function exchangeWidgetSessionToGate(token) {
    if (!token) return { error: "No Tools session token.", reason: "no_token" };
    const base = await shopBaseUrl();
    let response;
    try {
      response = await fetch(`${base}/api/widget/session/exchange`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        credentials: "include",
        cache: "no-store",
      });
    } catch {
      return { error: "Could not reach the shop exchange API.", reason: "network" };
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (response.status === 401 || response.status === 403) {
      return { error: "Tools session was rejected. Unlock Tools again.", reason: "unauthorized" };
    }
    if (response.status === 429) {
      return { error: friendlyWidgetError("rate_limited", 429), reason: "rate_limited" };
    }
    if (response.status === 404 || response.status === 406) {
      return {
        error: "Shop exchange is not on the site yet (needs beta with /api/widget/session/exchange).",
        reason: "exchange_missing",
      };
    }
    if (!response.ok || !data || data.ok !== true) {
      return {
        error: friendlyWidgetError(data && data.error, response.status),
        reason: "exchange_failed",
      };
    }
    // Hold site-lock: cookies.set may remove+set; must not publish lock to Tools.
    armUnlockHold();
    siteLockQuietUntil = 0;
    // Site beta 0.1.36+ returns gateToken for extension cookies.set (Set-Cookie often invisible).
    const gateToken = data.gateToken || data.gate || data.cookieValue || "";
    if (gateToken) {
      const applied = await applyGateCookie(gateToken, data.expiresAt);
      if (!applied.ok) {
        return {
          error: "Could not write bf_shop_gate into Firefox (cookies.set failed).",
          reason: "cookie_set_failed",
          person: data.person ? String(data.person) : "",
        };
      }
    }
    let gate = await readShopGateCookie();
    // Fallback: copy Electron bf_shop_gate when JSON/Set-Cookie still did not land.
    if (!gate.present) {
      const copied = await importShopGateFromToolsBridge();
      if (copied.ok) {
        armUnlockHold();
        await storageSet({ shopGateFromToolsAt: Date.now() });
        return {
          ok: true,
          person: copied.person || (data.person ? String(data.person) : ""),
          expiresAt: copied.expiresAt || data.expiresAt || "",
          source: "tools-jar-gate",
        };
      }
      return {
        error:
          "Exchange succeeded but bf_shop_gate is missing in this browser. Need site gateToken (beta 0.1.36+) or Tools 1.5.13+ jar-gate copy.",
        reason: "cookie_missing",
        person: data.person ? String(data.person) : "",
      };
    }
    armUnlockHold();
    await storageSet({ shopGateFromToolsAt: Date.now() });
    return {
      ok: true,
      person: data.person ? String(data.person) : "",
      expiresAt: data.expiresAt || "",
      source: "tools-exchange",
    };
  }

  async function reloadShopUnlockTabs() {
    if (!runtime?.tabs?.query || !runtime?.tabs?.reload) return { reloaded: 0 };
    let tabs = [];
    try {
      tabs = await runtime.tabs.query({ url: ["https://shop.blackforestautomotive.com/*"] });
    } catch {
      return { reloaded: 0 };
    }
    let reloaded = 0;
    for (const tab of tabs || []) {
      if (tab?.id == null || typeof tab.url !== "string") continue;
      if (!tab.url.includes("/unlock")) continue;
      try {
        await runtime.tabs.reload(tab.id);
        reloaded += 1;
      } catch {
        // ignore
      }
    }
    return { reloaded };
  }

  /**
   * End-to-end: Tools :8788 Bearer → Firefox/Chromium bf_shop_gate.
   * Lock Tools (bridge up, no session) → clear stale site gate so refresh stays locked.
   * forceExchange=true on explicit Sync Tools (heal stale gate); auto path skips when gate present.
   */
  async function syncToolsSessionToSite({ reloadUnlockTabs = true, forceExchange = false } = {}) {
    const health = await probeToolsBridgeHealth();

    // Website lock quiet: NEVER exchange. A live Tools session during quiet is
    // almost always the pre-lock Bearer still present (Logan: lock website →
    // /unlock tab load used to clear quiet and remint Tools). Force-lock Tools
    // instead. Intentional Tools unlock clears quiet via storeWidgetToken /
    // Sync Tools (forceExchange) / quiet expiry.
    if (siteLockQuietActive() && !forceExchange) {
      if (health.reachable && health.hasSession) {
        await lockToolsViaBridge();
        const hadGate = (await readShopGateCookie()).present;
        await clearShopGateCookie();
        return {
          ok: false,
          locked: true,
          shouldReload: hadGate && reloadUnlockTabs,
          reason: "site_lock_force_tools",
          error: "Website locked — forcing Tools lock.",
        };
      }
      if (health.reachable && health.hasSession === false) {
        const hadGate = (await readShopGateCookie()).present;
        await clearShopGateCookie();
        return {
          ok: false,
          locked: true,
          shouldReload: hadGate && reloadUnlockTabs,
          reason: "site_lock",
          error: "Website locked — Tools session cleared.",
        };
      }
      return {
        ok: false,
        locked: true,
        shouldReload: false,
        reason: "site_lock_pending",
        error: "Website locked — waiting for Tools to clear session.",
      };
    }

    if (health.reachable && health.hasSession === false) {
      // Website→Tools unlock in flight: Tools may report no session for a few
      // hundred ms after publish — never clear Firefox gate (unlock flash).
      if (unlockHoldActive()) {
        return { ok: true, skipped: "unlock_hold", reason: "unlock_hold" };
      }
      // Mismatch: Tools SPA unlocked (jar gate) but Bearer empty — heal Firefox.
      // Never do this during site-lock quiet (last lock wins: refresh /unlock
      // must not copy a leftover Electron gate and must not remint Tools).
      if (!siteLockQuietActive()) {
        const jarGate = await importShopGateFromToolsBridge();
        if (jarGate.ok) {
          siteLockQuietUntil = 0;
          const prefs = await applyToolsPersonSettingsToSite();
          if (reloadUnlockTabs) {
            await reloadShopUnlockTabs();
          }
          await setPinBadge(false);
          return {
            ok: true,
            person: jarGate.person || "",
            source: "tools-jar-gate",
            siteGate: true,
            shouldReload: true,
            reason: "tools_gate_without_bearer",
            prefsApplied: Boolean(prefs.ok),
            funMode: prefs.funMode,
          };
        }
      }
      const hadGate = (await readShopGateCookie()).present;
      await clearShopGateCookie();
      const stored = await storageGet(["shopWidgetTokenSource"]);
      if (stored.shopWidgetTokenSource === "tools-bridge") {
        await storageSet({
          shopWidgetToken: "",
          shopWidgetTokenExpiresAt: 0,
          shopGateFromToolsAt: 0,
        });
        await setPinBadge(true);
      }
      if (hadGate && reloadUnlockTabs) {
        // Reload shop tabs so SPA notices missing gate (home → /unlock).
        if (runtime?.tabs?.query && runtime?.tabs?.reload) {
          try {
            const tabs = await runtime.tabs.query({
              url: ["https://shop.blackforestautomotive.com/*"],
            });
            for (const tab of tabs || []) {
              if (tab?.id != null) {
                try {
                  await runtime.tabs.reload(tab.id);
                } catch {
                  // ignore
                }
              }
            }
          } catch {
            // ignore
          }
        }
      }
      return {
        ok: false,
        locked: true,
        shouldReload: hadGate,
        reason: "tools_locked",
        error: "Tools is locked — shop website cookie cleared in this browser.",
      };
    }

    const fromTools = await importToolsWidgetSession();
    if (!fromTools.ok) {
      return fromTools;
    }
    // Importing from Tools means Tools unlocked — drop site-lock quiet window.
    siteLockQuietUntil = 0;
    const stored = await storageGet(["shopWidgetToken"]);
    const token = stored.shopWidgetToken;
    const gateBefore = (await readShopGateCookie()).present;
    if (gateBefore && !forceExchange) {
      const prefs = await applyToolsPersonSettingsToSite();
      return {
        ok: true,
        person: fromTools.person,
        source: "tools-bridge",
        siteGate: true,
        shouldReload: false,
        reason: "gate_present",
        prefsApplied: Boolean(prefs.ok),
        funMode: prefs.funMode,
      };
    }
    let exchanged = await exchangeWidgetSessionToGate(token);
    // If exchange path failed entirely, still try direct Tools jar gate copy.
    if (!exchanged.ok) {
      const copied = await importShopGateFromToolsBridge();
      if (copied.ok) {
        exchanged = copied;
      } else {
        return {
          ...fromTools,
          ok: false,
          error: exchanged.error,
          reason: exchanged.reason,
          deskOk: true,
        };
      }
    }
    const shouldReload = !gateBefore || forceExchange;
    if (shouldReload && reloadUnlockTabs) {
      await reloadShopUnlockTabs();
    }
    const prefs = await applyToolsPersonSettingsToSite();
    return {
      ok: true,
      person: exchanged.person || fromTools.person,
      source: exchanged.source || "tools-bridge",
      siteGate: true,
      shouldReload,
      prefsApplied: Boolean(prefs.ok),
      funMode: prefs.funMode,
    };
  }

  /**
   * Website shop session → Desk Bearer via POST /api/widget/session/from-gate.
   * Degrades cleanly when the route is missing (404/406): falls back to Tools/PIN.
   */
  async function importSiteGateSession({ publishToTools = true } = {}) {
    // Locked-site refresh / quiet: do not from-gate → POST :8788 (remints Tools).
    if (siteLockQuietActive() || publishToTools === false) {
      return { ok: false, skipped: "no_site_publish", reason: "site_lock" };
    }
    const gate = await readShopGateCookie();
    if (!gate.present) {
      return {
        error:
          "Shop site is not signed in in this Firefox profile. Unlock shop.blackforestautomotive.com first.",
        reason: "no_gate_cookie",
      };
    }

    const base = await shopBaseUrl();
    let response;
    try {
      response = await fetch(`${base}/api/widget/session/from-gate`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        credentials: "include",
        body: "{}",
        cache: "no-store",
      });
    } catch {
      return { error: "Could not reach the shop from-gate API.", reason: "network" };
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (response.status === 404 || response.status === 406) {
      return {
        error:
          "Shop is signed in, but from-gate is not on the site yet. Unlock Tools or enter desk PIN (Grok paste: grok-widget-from-gate).",
        reason: "from_gate_missing",
        gatePresent: true,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        error: "Shop cookie was rejected. Unlock the shop site again in this Firefox profile.",
        reason: "unauthorized",
      };
    }
    if (!response.ok) {
      return {
        error: friendlyWidgetError(data && data.error, response.status),
        reason: "from_gate_error",
      };
    }

    const token = data?.token || data?.accessToken || data?.bearer || data?.widgetToken;
    const expiresAt = data?.expiresAt || data?.widgetExpiresAt;
    if (!token) return { error: "from-gate returned no token.", reason: "bad_payload" };
    return storeWidgetToken({
      token,
      expiresAt,
      person: data.person,
      source: "site-gate",
      publishToTools,
    });
  }

  async function importToolsWidgetSession() {
    const base = await toolsBridgeBaseUrl();
    let response;
    try {
      response = await fetch(`${base}/v1/widget-session`, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
    } catch {
      return {
        error: "Black Forest Tools is not reachable. Open Tools unlocked, or use shop session / PIN.",
        reason: "bridge_unreachable",
      };
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (response.status === 404) {
      return {
        error: "Tools has no shared session. Unlock Tools or the shop site first.",
        reason: "no_session",
      };
    }
    if (!response.ok) {
      return { error: friendlyWidgetError(data && data.error, response.status), reason: "bridge_error" };
    }
    const token = data?.token || data?.accessToken || data?.bearer;
    if (!token) return { error: "Tools session missing token.", reason: "bad_payload" };
    return storeWidgetToken({
      token,
      expiresAt: data.expiresAt,
      person: data.person,
      source: "tools-bridge",
    });
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
    return storeWidgetToken({
      token,
      expiresAt: data.expiresAt,
      person: data.person || normalized,
      source: "pin",
    });
  }

  async function ensureWidgetToken({ trySite = true, tryTools = true } = {}) {
    const stored = await storageGet(["shopWidgetToken", "shopWidgetTokenExpiresAt"]);
    const token = stored.shopWidgetToken;
    const expiresAt = Number(stored.shopWidgetTokenExpiresAt || 0);
    if (token && expiresAt > Date.now() + 60_000) return { token };

    if (trySite) {
      const fromSite = await importSiteGateSession();
      if (fromSite.ok) {
        const again = await storageGet(["shopWidgetToken"]);
        if (again.shopWidgetToken) return { token: again.shopWidgetToken, source: "site-gate" };
      }
    }
    if (tryTools) {
      const fromTools = await importToolsWidgetSession();
      if (fromTools.ok) {
        const again = await storageGet(["shopWidgetToken"]);
        if (again.shopWidgetToken) return { token: again.shopWidgetToken, source: "tools-bridge" };
      }
    }
    return { needsAuth: true };
  }

  /**
   * Background happy path:
   * 1) Tools bridge up + locked → clear Firefox bf_shop_gate (no stale website unlock)
   * 2) Tools bridge up + session → import Bearer + exchange into Firefox jar
   * 3) else from-gate (site cookie) then Tools :8788 for Desk lot names
   * Throttled so alarms / tab loads / idle do not spam the shop (~20/min cap).
   */
  let autoUnlockInFlight = null;
  async function tryAutoUnlock({
    force = false,
    reason = "",
    allowSitePublish = true,
    tabUrl = "",
  } = {}) {
    if (autoUnlockInFlight) return autoUnlockInFlight;
    autoUnlockInFlight = (async () => {
      try {
        // Website→Tools unlock in flight — never clear-gate / site-lock (unlock-bounce-30s).
        if (unlockHoldActive()) {
          return { ok: true, skipped: "unlock_hold", reason: reason || "unlock_hold" };
        }
        const onUnlockPage = /\/unlock\b/i.test(String(tabUrl || ""));
        // Locked /unlock tab: only Tools→site clear path — never from-gate publish.
        const canPublishFromSite = allowSitePublish && !onUnlockPage && !siteLockQuietActive();
        const stored = await storageGet(["deskAutoUnlockAt"]);
        const lastAt = Number(stored.deskAutoUnlockAt || 0);
        const minGapMs = force ? 5_000 : 30_000;
        if (lastAt && Date.now() - lastAt < minGapMs) {
          const health = await probeToolsBridgeHealth();
          if (health.reachable && health.hasSession === false) {
            // Lock must win even during throttle — stale site cookie is the bug.
            // Skip while unlock-hold (website just unlocked Tools).
            if (unlockHoldActive()) {
              return { ok: true, skipped: "unlock_hold", reason };
            }
            return syncToolsSessionToSite({ reloadUnlockTabs: true });
          }
          const gate = await readShopGateCookie();
          const fresh = await hasFreshWidgetToken();
          if (fresh && gate.present) {
            await setPinBadge(false);
            return { ok: true, skipped: "throttle_fresh", reason };
          }
          if (!force && fresh && !gate.present && health.reachable && health.hasSession) {
            // Desk token OK but website jar empty — still need exchange.
            return syncToolsSessionToSite({ reloadUnlockTabs: true });
          }
          if (!force) return { ok: false, skipped: "throttle", reason };
        }

        await storageSet({ deskAutoUnlockAt: Date.now() });

        const health = await probeToolsBridgeHealth();
        if (health.reachable) {
          // Prefer Tools as source of truth when bridge is up (unlock + lock).
          const synced = await syncToolsSessionToSite({ reloadUnlockTabs: true });
          if (synced.ok) {
            await setPinBadge(false);
            return { ok: true, source: synced.source || "tools-bridge", reason, siteGate: true };
          }
          if (synced.locked) {
            return { ...synced, reason: reason || synced.reason };
          }
          // Tools had no session / exchange failed — fall through only if publish allowed.
        }

        if (!canPublishFromSite) {
          // Clear any leftover Firefox gate without minting Tools.
          if ((await readShopGateCookie()).present) {
            await clearShopGateCookie();
          }
          return { ok: false, skipped: "no_site_publish", reason: reason || "unlock_page" };
        }

        if (!force && (await hasFreshWidgetToken()) && (await readShopGateCookie()).present) {
          await setPinBadge(false);
          return { ok: true, skipped: "already_fresh", reason };
        }

        const auth = await ensureWidgetToken({ trySite: true, tryTools: true });
        if (auth.needsAuth) {
          await setPinBadge(true);
          return { ok: false, needsAuth: true, reason };
        }
        // Desk Bearer present — if website jar still empty, try exchange once.
        const gate = await readShopGateCookie();
        if (!gate.present && auth.token) {
          const exchanged = await exchangeWidgetSessionToGate(auth.token);
          if (exchanged.ok) {
            await reloadShopUnlockTabs();
            await setPinBadge(false);
            return { ok: true, source: auth.source || "stored", reason, siteGate: true };
          }
        }
        await setPinBadge(false);
        return { ok: true, source: auth.source || "stored", reason };
      } catch {
        return { ok: false, error: "auto_unlock_failed", reason };
      } finally {
        autoUnlockInFlight = null;
      }
    })();
    return autoUnlockInFlight;
  }

  async function resolveLotLastNames() {
    const cached = await storageGet(["lotLastNames", "lotLastNamesAt"]);
    const cachedNames = Array.isArray(cached.lotLastNames) ? cached.lotLastNames : [];
    const auth = await ensureWidgetToken({ trySite: true, tryTools: true });
    if (auth.needsAuth) {
      await setPinBadge(true);
      return {
        needsAuth: true,
        names: cachedNames,
        source: cachedNames.length ? "cache" : "auth",
        message:
          "Unlock the shop site in this Firefox profile (or Tools / desk PIN in the popup), then Refresh.",
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
  api.importSiteGateSession = importSiteGateSession;
  api.importToolsWidgetSession = importToolsWidgetSession;
  api.storeWidgetToken = storeWidgetToken;
  api.readShopGateCookie = readShopGateCookie;
  api.clearShopGateCookie = clearShopGateCookie;
  api.probeToolsBridgeHealth = probeToolsBridgeHealth;
  api.exchangeWidgetSessionToGate = exchangeWidgetSessionToGate;
  api.syncToolsSessionToSite = syncToolsSessionToSite;
  api.syncSiteLockToTools = syncSiteLockToTools;
  api.lockToolsViaBridge = lockToolsViaBridge;
  api.armSiteLockQuiet = armSiteLockQuiet;
  api.armUnlockHold = armUnlockHold;
  api.unlockHoldActive = unlockHoldActive;
  api.publishSessionToToolsBridge = publishSessionToToolsBridge;
  api.importShopGateFromToolsBridge = importShopGateFromToolsBridge;
  api.applyToolsPersonSettingsToSite = applyToolsPersonSettingsToSite;
  api.publishPersonSettingsToToolsBridge = publishPersonSettingsToToolsBridge;
  api.siteLockQuietActive = siteLockQuietActive;
  api.reloadShopUnlockTabs = reloadShopUnlockTabs;
  api.ensureWidgetToken = ensureWidgetToken;
  api.tryAutoUnlock = tryAutoUnlock;
  api.hasFreshWidgetToken = hasFreshWidgetToken;
  api.refreshUnlockBadge = refreshUnlockBadge;
  api.resolveLotLastNames = resolveLotLastNames;
  api.loadLotLastNames = loadLotLastNames;
})(globalThis);
