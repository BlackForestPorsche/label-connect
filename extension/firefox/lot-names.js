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
  /** Legacy Tools (no sessionId on /health): old quiet window after a website lock. */
  const LEGACY_LOCK_QUIET_MS = 90_000;
  const LATCH_KEY = "deskSiteLatch";
  const GATE_SEEN_KEY = "deskGateSeen";
  /** Desk's own cookie writes (exchange / clear) must not look like a site lock or unlock. */
  const DESK_GATE_WRITE_MS = 4_000;
  /** Desk unlock roster (plasmoid fallback). */
  const DESK_PEOPLE = Object.freeze(["logan", "stephen", "steve", "carla", "john"]);
  /**
   * Sticky website lock. Set by every intentional site lock, persisted in storage so
   * a suspended background page does not forget it, and released only by an intentional
   * unlock: a new Tools session (different sessionId on :8788) or a site PIN unlock.
   * No timer ends it.
   */
  let siteLatch = null;
  let latchEpoch = 0;
  /**
   * True once this browser has held a website gate that Desk has not itself cleared.
   * If the gate is gone and Desk did not remove it, the site was locked — even if the
   * cookie listener has not fired yet (event page wake, suspended page).
   */
  let gateSeen = false;
  function markGateSeen(value) {
    if (gateSeen === value) return;
    gateSeen = value;
    void storageSet({ [GATE_SEEN_KEY]: value });
  }
  let lastToolsSessionId = null;
  /** Last time something other than Desk removed bf_shop_gate (site Lock). */
  let lastForeignGateRemovedAt = 0;
  const FOREIGN_REMOVAL_SETTLE_MS = 1_500;
  let deskGateWriteUntil = 0;
  let lastDeskGateValue = "";
  /** After Tools→site exchange, ignore gate-removal → site-lock (unlock bounce). */
  const UNLOCK_HOLD_MS = 35_000;
  let unlockHoldUntil = 0;
  function armUnlockHold(ms = UNLOCK_HOLD_MS) {
    unlockHoldUntil = Date.now() + ms;
  }
  function unlockHoldActive(nowMs = Date.now()) {
    return nowMs < unlockHoldUntil;
  }

  async function persistLatch() {
    await storageSet({ [LATCH_KEY]: siteLatch });
  }

  async function loadLatch() {
    const stored = await storageGet([LATCH_KEY, GATE_SEEN_KEY]);
    if (stored[GATE_SEEN_KEY] === true) gateSeen = true;
    const value = stored[LATCH_KEY];
    if (value && typeof value === "object" && !siteLatch) {
      siteLatch = {
        at: Number(value.at) || Date.now(),
        toolsSessionId: value.toolsSessionId == null ? null : String(value.toolsSessionId),
      };
    }
  }

  const latchReady = loadLatch().catch(() => {});

  function engageSiteLatch(toolsSessionId = lastToolsSessionId) {
    latchEpoch += 1;
    siteLatch = {
      at: siteLatch ? siteLatch.at : Date.now(),
      toolsSessionId: toolsSessionId == null ? null : String(toolsSessionId),
    };
    void persistLatch();
  }

  function releaseSiteLatch() {
    if (!siteLatch) return;
    siteLatch = null;
    void persistLatch();
  }

  function siteLockQuietActive() {
    return Boolean(siteLatch);
  }

  /**
   * What the sticky site lock says about Tools' current :8788 health.
   * - none: not latched
   * - release: Tools has a different session than the one locked — user unlocked Tools
   * - relock: Tools still shows the session we locked — keep it locked, never exchange
   * - hold: Tools is locked or away — stay locked, never exchange
   */
  function latchVerdict(health, nowMs = Date.now()) {
    if (!siteLatch) return "none";
    if (!health || !health.reachable || !health.hasSession) return "hold";
    if (typeof health.sessionId === "string") {
      if (health.sessionId && health.sessionId !== siteLatch.toolsSessionId) return "release";
      return "relock";
    }
    return nowMs - siteLatch.at >= LEGACY_LOCK_QUIET_MS ? "release" : "relock";
  }

  async function relockTools() {
    const locked = await lockToolsViaBridge();
    await clearShopGateCookie();
    return locked;
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

  const ICON_SIZES = [16, 32, 48, 128];
  const ICON_GREEN = "#2e7d32";
  const ICON_RED = "#c62828";
  const iconCache = {};

  function makeCanvas(size) {
    if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(size, size);
    if (typeof document !== "undefined" && document.createElement) {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      return canvas;
    }
    return null;
  }

  function drawStatusIcon(loggedIn, size) {
    const canvas = makeCanvas(size);
    const ctx = canvas?.getContext?.("2d");
    if (!ctx) return null;
    const c = size / 2;
    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    ctx.arc(c, c, size * 0.47, 0, Math.PI * 2);
    ctx.fillStyle = loggedIn ? ICON_GREEN : ICON_RED;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, size * 0.07);
    ctx.strokeStyle = "#ffffff";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    if (loggedIn) {
      ctx.moveTo(size * 0.27, size * 0.52);
      ctx.lineTo(size * 0.43, size * 0.68);
      ctx.lineTo(size * 0.74, size * 0.34);
    } else {
      ctx.moveTo(size * 0.33, size * 0.33);
      ctx.lineTo(size * 0.67, size * 0.67);
      ctx.moveTo(size * 0.67, size * 0.33);
      ctx.lineTo(size * 0.33, size * 0.67);
    }
    ctx.stroke();
    return ctx.getImageData(0, 0, size, size);
  }

  function statusIconImages(loggedIn) {
    const key = loggedIn ? "in" : "out";
    if (iconCache[key]) return iconCache[key];
    const images = {};
    for (const size of ICON_SIZES) {
      const image = drawStatusIcon(loggedIn, size);
      if (!image) return null;
      images[size] = image;
    }
    iconCache[key] = images;
    return images;
  }

  /** Toolbar icon: green = logged in (shop / Tools session), red = logged out. */
  async function setToolbarIcon(loggedIn) {
    const action = runtime?.action || runtime?.browserAction;
    if (!action?.setIcon) return false;
    try {
      const imageData = statusIconImages(Boolean(loggedIn));
      if (!imageData) return false;
      await action.setIcon({ imageData });
      return true;
    } catch {
      return false;
    }
  }

  async function setPinBadge(needsPin) {
    await setToolbarIcon(!needsPin);
    if (!runtime?.action?.setBadgeText) return;
    try {
      if (needsPin) {
        await runtime.action.setBadgeText({ text: "" });
        await runtime.action.setTitle?.({
          title: "Black Forest Desk — logged out",
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
            title: "Black Forest Desk — logged in",
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

  async function storeWidgetToken({ token, expiresAt, person, source, publishToTools = true } = {}) {
    const parsedExpiry = expiresAt ? Date.parse(expiresAt) : NaN;
    const ttlMs = Number.isFinite(parsedExpiry)
      ? Math.max(parsedExpiry - Date.now(), 60_000)
      : 8 * 60 * 60 * 1000;
    const normalized = normalizePerson(person);
    const src = source || "pin";
    // Website unlock wins — clear quiet + arm hold so throttle lock-wins cannot
    // clear the Firefox gate ~30s later (unlock-bounce-30s.md).
    if (src === "shop-site" || src === "site-gate" || src === "pin") {
      releaseSiteLatch();
      armUnlockHold();
    }
    await storageSet({
      shopWidgetToken: token,
      shopWidgetTokenExpiresAt: Date.now() + ttlMs,
      shopPerson: normalized || undefined,
      deskSessionPerson: normalized || "",
      shopWidgetTokenSource: src,
    });
    await setPinBadge(false);
    // Website → Tools unlock: push Bearer into :8788 so Tools SPA leaves /unlock.
    if (
      publishToTools &&
      token &&
      (src === "shop-site" || src === "site-gate" || src === "pin")
    ) {
      const expiresIso = Number.isFinite(parsedExpiry)
        ? new Date(parsedExpiry).toISOString()
        : new Date(Date.now() + ttlMs).toISOString();
      await publishSessionToToolsBridge({
        token,
        expiresAt: expiresIso,
        person: normalized,
      });
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
    // Website unlock must land in Tools even if :8788 briefly flaps — retry.
    const base = await toolsBridgeBaseUrl();
    const body = JSON.stringify({
      token: String(token),
      expiresAt: String(expiresAt),
      person: person ? String(person) : "",
    });
    let last = { ok: false, reason: "bridge_unreachable" };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
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
      armUnlockHold();
      return { ok: true, reason: "published", attempts: attempt + 1 };
    }
    return last;
  }

  /**
   * Website lock → Tools lock. DELETE session (Tools 1.5.11+) then POST /v1/lock alias.
   * Clears Electron jar via Tools onLock so from-gate remint cannot revive the session.
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
    // Always DELETE then POST /v1/lock — DELETE-only reminted ~24s when Firefox gate stayed (Manjaro).
    const deleted = await tryOnce("DELETE", "/v1/widget-session");
    const locked = await tryOnce("POST", "/v1/lock");
    if (locked.ok) return { ...locked, deleted: deleted.ok, via: "delete+post-lock" };
    if (deleted.ok) return { ...deleted, via: "delete-only" };
    if (deleted.reason === "lock_unsupported" || locked.reason === "lock_unsupported") {
      return { ok: false, reason: "lock_unsupported" };
    }
    return locked.ok ? locked : deleted;
  }

  /**
   * Firefox website lock: clear gate + Desk token, lock Tools bridge, block re-exchange.
   */
  async function syncSiteLockToTools({ reloadShopTabs = true, force = false } = {}) {
    // Unlock bounce: gateToken cookies.set can briefly remove/re-add — do not lock Tools.
    if (!force && unlockHoldActive()) {
      return { ok: false, skipped: "unlock_hold", reason: "unlock_hold" };
    }
    const pre = await probeToolsBridgeHealth();
    engageSiteLatch(
      pre.reachable ? (pre.hasSession ? (pre.sessionId ?? null) : "") : lastToolsSessionId,
    );
    const hadGate = (await readShopGateCookie()).present;
    // Clear Firefox gate BEFORE Tools DELETE — otherwise Desk republishes Bearer (~24s).
    await clearShopGateCookie();
    if ((await readShopGateCookie()).present) {
      await clearShopGateCookie();
    }
    await storageSet({
      shopWidgetToken: "",
      shopWidgetTokenExpiresAt: 0,
      shopGateFromToolsAt: 0,
      shopWidgetTokenSource: "",
    });
    await setPinBadge(true);
    const locked = await lockToolsViaBridge();
    if (locked.ok) {
      const health = await probeToolsBridgeHealth();
      if (health.reachable && health.hasSession) {
        await lockToolsViaBridge();
      }
    } else {
      await lockToolsViaBridge();
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
    // Remint suppress (site-lock-tools-stays.md): DELETE-only came back ~24s when
    // Firefox still had a gate. We cleared the gate + DELETE+POST; still re-lock
    // a few times while quiet if Tools shows a session again (republish race).
    return {
      ok: true,
      locked: true,
      toolsLocked: Boolean(locked.ok),
      reason: locked.ok ? "site_lock" : locked.reason || "site_lock_tools_pending",
      shouldReload: hadGate,
      via: locked.via,
    };
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
      if (cookie && cookie.value) {
        markGateSeen(true);
        return { present: true };
      }
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
    // Tools now shows the unlock the hold was guarding. Holding on past this point
    // swallows a real lock 10s later (Tools lock edge, site Lock, gate removal).
    if (hasSession) unlockHoldUntil = 0;
    const sessionId = data && typeof data.sessionId === "string" ? data.sessionId : undefined;
    if (hasSession && sessionId) lastToolsSessionId = sessionId;
    if (!hasSession) lastToolsSessionId = "";
    return {
      reachable: true,
      sessionId,
      locked: data && typeof data.locked === "boolean" ? data.locked : undefined,
      hasSession,
      person: data && data.person ? String(data.person) : "",
      reason: hasSession ? "has_session" : "no_session",
    };
  }

  async function clearShopGateCookie() {
    const base = await shopBaseUrl();
    const name = api.SHOP_GATE_COOKIE || GATE_COOKIE;
    if (!runtime?.cookies?.remove) return { ok: false, reason: "no_cookies_api" };
    deskGateWriteUntil = Date.now() + DESK_GATE_WRITE_MS;
    markGateSeen(false);
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
    deskGateWriteUntil = Date.now() + DESK_GATE_WRITE_MS;
    lastDeskGateValue = String(value);
    try {
      await runtime.cookies.set(details);
      markGateSeen(true);
      return { ok: true };
    } catch {
      try {
        delete details.sameSite;
        await runtime.cookies.set(details);
        markGateSeen(true);
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
  async function exchangeWidgetSessionToGate(token) {
    if (!token) return { error: "No Tools session token.", reason: "no_token" };
    await latchReady;
    if (siteLatch) return { error: "Website is locked.", reason: "site_locked" };
    const epoch = latchEpoch;
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
    if (epoch !== latchEpoch || siteLatch) {
      await clearShopGateCookie();
      return { error: "Website was locked mid-exchange.", reason: "site_locked" };
    }
    const gateToken = data.gateToken || data.gate || data.cookieValue || "";
    if (gateToken) {
      armUnlockHold();
      await applyGateCookie(gateToken, data.expiresAt);
    }
    const gate = await readShopGateCookie();
    if (!gate.present) {
      return {
        error:
          "Exchange succeeded but bf_shop_gate is missing in this browser. Paste grok-exchange-gate-token so exchange returns gateToken.",
        reason: "cookie_missing",
        person: data.person ? String(data.person) : "",
      };
    }
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

    await latchReady;
    if (siteLatch) {
      const verdict = latchVerdict(health);
      if (verdict === "release") {
        releaseSiteLatch();
      } else if (verdict === "relock") {
        await relockTools();
        return {
          ok: false,
          locked: true,
          shouldReload: false,
          reason: "site_lock",
          error: "Website locked — Tools session cleared.",
        };
      } else {
        if (unlockHoldActive()) {
          return {
            ok: true,
            skipped: "unlock_hold",
            reason: "unlock_hold",
            siteGate: (await readShopGateCookie()).present,
          };
        }
        return {
          ok: false,
          locked: true,
          shouldReload: false,
          reason: "site_lock",
          error: "Website locked — stays locked until you unlock.",
        };
      }
    }

    if (
      !siteLatch &&
      !forceExchange &&
      gateSeen &&
      health.reachable &&
      health.hasSession &&
      !unlockHoldActive() &&
      !(await readShopGateCookie()).present
    ) {
      await syncSiteLockToTools({ reloadShopTabs: true });
      return {
        ok: false,
        locked: true,
        shouldReload: false,
        reason: "site_lock",
        error: "Website was locked — Tools locked to match.",
      };
    }

    if (health.reachable && health.hasSession === false) {
      // Site→Tools unlock race: website just unlocked and POSTed Bearer, but Tools
      // health may still say locked for a few hundred ms. Clearing Firefox gate here
      // is the unlock→relock flash. Hold wins until Tools hasSession or hold ends.
      if (unlockHoldActive()) {
        return {
          ok: true,
          skipped: "unlock_hold",
          reason: "unlock_hold",
          siteGate: (await readShopGateCookie()).present,
        };
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
    const stored = await storageGet(["shopWidgetToken"]);
    const token = stored.shopWidgetToken;
    const gateBefore = (await readShopGateCookie()).present;
    if (gateBefore && !forceExchange) {
      return {
        ok: true,
        person: fromTools.person,
        source: "tools-bridge",
        siteGate: true,
        shouldReload: false,
        reason: "gate_present",
      };
    }
    const exchanged = await exchangeWidgetSessionToGate(token);
    if (!exchanged.ok) {
      return {
        ...fromTools,
        ok: false,
        error: exchanged.error,
        reason: exchanged.reason,
        deskOk: true,
      };
    }
    const shouldReload = !gateBefore || forceExchange;
    if (shouldReload && reloadUnlockTabs) {
      await reloadShopUnlockTabs();
    }
    return {
      ok: true,
      person: exchanged.person || fromTools.person,
      source: "tools-bridge",
      siteGate: true,
      shouldReload,
    };
  }

  /**
   * Website shop session → Desk Bearer via POST /api/widget/session/from-gate.
   * Degrades cleanly when the route is missing (404/406): falls back to Tools/PIN.
   */
  async function importSiteGateSession() {
    await latchReady;
    const epoch = latchEpoch;
    const gate = await readShopGateCookie();
    if (gate.present) {
      // A just-unlocked shop page can race tab-complete auto-unlock before from-gate
      // lands in Tools. Hold until Tools shows the session (probe releases it).
      armUnlockHold();
    }
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

    if (epoch !== latchEpoch) {
      return { error: "Website was locked mid-import.", reason: "site_locked" };
    }
    const token = data?.token || data?.accessToken || data?.bearer || data?.widgetToken;
    const expiresAt = data?.expiresAt || data?.widgetExpiresAt;
    if (!token) return { error: "from-gate returned no token.", reason: "bad_payload" };
    return storeWidgetToken({
      token,
      expiresAt,
      person: data.person,
      source: "site-gate",
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
   * Watch local Tools :8788 /health and push unlock/lock to the website on change.
   * Edge-triggered (not a multi-second “hope the alarm fires” poll for sync).
   */
  const BRIDGE_SYNC_MS = 400;
  let bridgeWatchTimer = null;
  let lastBridgeHasSession = null;
  let lastBridgeFingerprint = "";
  let bridgeWatchInFlight = false;

  async function handleGateCookieRemoved() {
    // Unlock bounce: gateToken cookies.set can remove→set; do not lock Tools.
    await latchReady;
    if (siteLatch) return { skipped: "already_latched" };
    if (unlockHoldActive()) return { skipped: "unlock_hold" };
    const gate = await readShopGateCookie();
    if (gate.present) return { skipped: "gate_present" };
    if (unlockHoldActive()) return { skipped: "unlock_hold" };
    const health = await probeToolsBridgeHealth();
    if (health.reachable && health.hasSession === false) return { skipped: "tools_already_locked" };
    return syncSiteLockToTools({ reloadShopTabs: true });
  }

  let lastRelockAt = 0;
  let mirrorRetryAt = 0;
  let mirrorRetries = 0;
  const MIRROR_RETRY_MS = 3_000;
  const MIRROR_RETRY_MAX = 20;

  async function tickBridgeSyncPoll() {
    if (bridgeWatchInFlight) return;
    bridgeWatchInFlight = true;
    try {
      await latchReady;
      const health = await probeToolsBridgeHealth();
      if (!health.reachable) {
        lastBridgeHasSession = null;
        lastBridgeFingerprint = "";
        return;
      }
      const has = Boolean(health.hasSession);
      // Level-triggered: while the site is locked, a Tools session that is still the
      // one we locked is never allowed to stand (belt and braces for a missed DELETE).
      if (siteLatch && latchVerdict(health) === "relock" && Date.now() - lastRelockAt > 2_000) {
        lastRelockAt = Date.now();
        await relockTools();
      }
      const fp = `${has ? 1 : 0}|${health.person || ""}|${health.reason || ""}|${health.sessionId || ""}`;
      if (lastBridgeFingerprint !== fp) {
        const first = lastBridgeHasSession === null;
        const edge = !first && lastBridgeHasSession !== has;
        const swapped = !first && has && lastBridgeHasSession === true;
        lastBridgeHasSession = has;
        lastBridgeFingerprint = fp;
        if (first || edge || swapped) {
          mirrorRetries = 0;
          const synced = await syncToolsSessionToSite({
            reloadUnlockTabs: true,
            forceExchange: has && !swapped,
          });
          if (synced && synced.skipped === "unlock_hold") {
            // Edge was swallowed by the hold. Replay it once the hold ends.
            lastBridgeHasSession = null;
            lastBridgeFingerprint = "";
          } else if (has && synced && !synced.ok && !synced.locked) {
            mirrorRetryAt = Date.now() + MIRROR_RETRY_MS;
          } else {
            mirrorRetryAt = 0;
          }
        }
      } else if (has && mirrorRetryAt && Date.now() >= mirrorRetryAt && !siteLatch) {
        // Tools unlocked but the site did not follow (failed exchange): keep trying.
        if (mirrorRetries >= MIRROR_RETRY_MAX) {
          mirrorRetryAt = 0;
        } else {
          mirrorRetries += 1;
          const retried = await syncToolsSessionToSite({ reloadUnlockTabs: true });
          mirrorRetryAt = retried && (retried.ok || retried.locked) ? 0 : Date.now() + MIRROR_RETRY_MS;
        }
      }
      // Same tick: Tools → Firefox person-settings (fun on/off).
      await tickPersonSettingsWatch();
    } catch {
      // ignore single tick failures
    } finally {
      bridgeWatchInFlight = false;
    }
  }

  /**
   * Partner (bc-0eb7ffe4) contract: Tools 1.5.14+ GET/POST /v1/person-settings.
   * Push Firefox toggles immediately; pull Tools prefs on a short watch (~1.5s).
   * No-op while the route is missing (404) — unlock sync does not depend on it.
   */
  const PERSON_SETTINGS_WATCH_MS = 400; // folded into bridge sync tick
  const PERSON_SETTINGS_KEY = "bf-person-settings";
  let personSettingsTimer = null;
  let lastPersonSettingsJson = null;
  let personSettingsBridgeMissing = false;

  async function fetchToolsPersonSettings() {
    if (personSettingsBridgeMissing) return null;
    const base = await toolsBridgeBaseUrl();
    let response;
    try {
      response = await fetch(`${base}/v1/person-settings`, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
    } catch {
      return null;
    }
    if (response.status === 404 || response.status === 405) {
      personSettingsBridgeMissing = true;
      return null;
    }
    if (!response.ok) return null;
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  async function publishPersonSettingsToTools(input) {
    if (!input || personSettingsBridgeMissing) return { ok: false, reason: "missing" };
    const body =
      input.person && input.settings
        ? { person: input.person, settings: input.settings }
        : input;
    const base = await toolsBridgeBaseUrl();
    let response;
    try {
      response = await fetch(`${base}/v1/person-settings`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
    } catch {
      return { ok: false, reason: "network" };
    }
    if (response.status === 404 || response.status === 405) {
      personSettingsBridgeMissing = true;
      return { ok: false, reason: "missing" };
    }
    return { ok: response.ok };
  }

  async function pushPersonSettingsToShopTabs(settings) {
    if (!settings || !runtime?.tabs?.query) return { pushed: 0 };
    let tabs = [];
    try {
      tabs = await runtime.tabs.query({ url: ["https://shop.blackforestautomotive.com/*"] });
    } catch {
      return { pushed: 0 };
    }
    const payload = JSON.stringify(settings);
    let pushed = 0;
    for (const tab of tabs || []) {
      if (tab?.id == null) continue;
      try {
        const person = settings.person || "";
        const prefs = settings.settings || settings;
        await runtime.tabs.sendMessage(tab.id, {
          type: "apply-tools-person-settings",
          person,
          settings: prefs,
          updatedAt: Date.now(),
        });
        pushed += 1;
      } catch {
        // content script may be absent on this tab
      }
    }
    await storageSet({ deskPersonSettingsCache: payload, deskPersonSettingsAt: Date.now() });
    return { pushed };
  }

  async function tickPersonSettingsWatch() {
    const data = await fetchToolsPersonSettings();
    if (!data || typeof data !== "object") return;
    const json = JSON.stringify(data);
    if (json === lastPersonSettingsJson) return;
    lastPersonSettingsJson = json;
    await pushPersonSettingsToShopTabs(data);
  }

  function startPersonSettingsBridge() {
    if (personSettingsTimer != null) return { ok: true, already: true };
    try {
      personSettingsTimer = setInterval(() => {
        void tickPersonSettingsWatch();
      }, PERSON_SETTINGS_WATCH_MS);
      void tickPersonSettingsWatch();
      return { ok: true, periodMs: PERSON_SETTINGS_WATCH_MS };
    } catch {
      return { ok: false };
    }
  }

  function startBridgeSyncPoll() {
    if (bridgeWatchTimer != null) return { ok: true, already: true };
    try {
      bridgeWatchTimer = setInterval(() => {
        void tickBridgeSyncPoll();
      }, BRIDGE_SYNC_MS);
      void tickBridgeSyncPoll();
      return { ok: true, periodMs: BRIDGE_SYNC_MS };
    } catch {
      return { ok: false };
    }
  }
  /** @deprecated alias — Update-apply + thrash fold uses startBridgeSyncPoll */
  function startToolsBridgeWatch() {
    return startBridgeSyncPoll();
  }

  /**
   * Background happy path:
   * 1) Tools bridge up + locked → clear Firefox bf_shop_gate (no stale website unlock)
   * 2) Tools bridge up + session → import Bearer + exchange into Firefox jar
   * 3) else from-gate (site cookie) then Tools :8788 for Desk lot names
   * Alarm/idle path is throttled; bridge-watch edges bypass this (push on change).
   */
  let autoUnlockInFlight = null;
  async function tryAutoUnlock({ force = false, reason = "" } = {}) {
    if (autoUnlockInFlight) return autoUnlockInFlight;
    autoUnlockInFlight = (async () => {
      try {
        await latchReady;
        const stored = await storageGet(["deskAutoUnlockAt"]);
        const lastAt = Number(stored.deskAutoUnlockAt || 0);
        const bridgeEdge = reason === "bridge-edge" || reason === "bridge-watch";
        // Bridge edges must be near-instant; force clicks ~1s; alarm/idle backup ~8s.
        const minGapMs = bridgeEdge ? 0 : force ? 1_000 : 8_000;
        if (lastAt && Date.now() - lastAt < minGapMs) {
          const health = await probeToolsBridgeHealth();
          // unlock-bounce-30s.md: throttle + "lock must win" cleared Firefox ~30s after
          // intentional site unlock. Skip lock-wins while unlock-hold is armed.
          if (
            health.reachable &&
            health.hasSession === false &&
            !unlockHoldActive() &&
            !siteLockQuietActive()
          ) {
            // Real Tools lock (not mid-website-unlock) — clear stale Firefox gate.
            return syncToolsSessionToSite({ reloadUnlockTabs: true });
          }
          if (unlockHoldActive() && health.reachable && health.hasSession === false) {
            return { ok: true, skipped: "unlock_hold_throttle", reason };
          }
          const gate = await readShopGateCookie();
          const fresh = await hasFreshWidgetToken();
          if (fresh && gate.present) {
            await setPinBadge(false);
            return { ok: true, skipped: "throttle_fresh", reason };
          }
          if (
            !force &&
            fresh &&
            !gate.present &&
            health.reachable &&
            health.hasSession &&
            !unlockHoldActive()
          ) {
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
          // Tools had no session / exchange failed — fall through to site from-gate.
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
  api.publishSessionToToolsBridge = publishSessionToToolsBridge;
  api.siteLockQuietActive = siteLockQuietActive;
  api.latchReady = latchReady;
  api.siteLatchState = () => (siteLatch ? { ...siteLatch } : null);
  api.engageSiteLatch = engageSiteLatch;
  api.releaseSiteLatch = releaseSiteLatch;
  api.reloadShopUnlockTabs = reloadShopUnlockTabs;
  api.ensureWidgetToken = ensureWidgetToken;
  api.tryAutoUnlock = tryAutoUnlock;
  api.startToolsBridgeWatch = startToolsBridgeWatch;
  api.startBridgeSyncPoll = startBridgeSyncPoll;
  api.handleGateCookieRemoved = handleGateCookieRemoved;
  api.tickBridgeSyncPoll = tickBridgeSyncPoll;
  api.armUnlockHold = armUnlockHold;
  api.unlockHoldActive = unlockHoldActive;
  api.startPersonSettingsBridge = startPersonSettingsBridge;
  api.publishPersonSettingsToTools = publishPersonSettingsToTools;
  api.pushPersonSettingsToShopTabs = pushPersonSettingsToShopTabs;
  api.hasFreshWidgetToken = hasFreshWidgetToken;
  api.refreshUnlockBadge = refreshUnlockBadge;
  api.setToolbarIcon = setToolbarIcon;
  api.resolveLotLastNames = resolveLotLastNames;
  api.loadLotLastNames = loadLotLastNames;
})(globalThis);
