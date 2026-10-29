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
  const GATE_EXPIRY_KEY = "deskGateExpiry";
  const GATE_SEEN_SESSION_KEY = "deskGateSeenSession";
  /** An unlock this fresh is never undone by an inferred (not user-clicked) site lock. */
  const RECENT_UNLOCK_MS = 8_000;
  /** Desk polls every 400ms: a gate gone this long past its own expiry was not removed by a Lock. */
  const GATE_EXPIRY_STALE_MS = 120_000;
  /** Renew the Firefox gate this long before it runs out (Tools renews its Bearer at 30m). */
  const GATE_RENEW_MARGIN_MS = 20 * 60 * 1000;
  const GATE_RENEW_RETRY_MS = 2 * 60 * 1000;
  /** Site shop-time lock: the gate cookie's own expiry is 8pm America/Los_Angeles. */
  const LOCK_TIME_ZONE = "America/Los_Angeles";
  const LOCK_HOUR = 20;
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
    if (value) bindGateSeenSession();
    else clearGateSeenSession();
    if (gateSeen === value) return;
    gateSeen = value;
    void storageSet({ [GATE_SEEN_KEY]: value });
  }
  /**
   * Tools sessionId in force when the gate was last seen. A gate that is gone under a
   * DIFFERENT Tools session (new sign-in, overnight 8pm lock, browser closed) was not
   * removed by a website Lock of the session now on :8788 — it is just stale.
   */
  let gateSeenSessionId = "";
  function bindGateSeenSession() {
    const id = lastToolsSessionId || "";
    if (!id || gateSeenSessionId === id) return;
    gateSeenSessionId = id;
    void storageSet({ [GATE_SEEN_SESSION_KEY]: id });
  }
  function clearGateSeenSession() {
    if (!gateSeenSessionId) return;
    gateSeenSessionId = "";
    void storageSet({ [GATE_SEEN_SESSION_KEY]: "" });
  }
  /**
   * Expiry (ms) of the gate cookie Desk last saw. A gate that vanishes AFTER this time just
   * ran out; a gate that vanishes before it was removed on purpose (site Lock).
   */
  let gateExpiryMs = 0;
  function noteGateExpiry(ms) {
    const next = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
    if (gateExpiryMs === next) return;
    gateExpiryMs = next;
    void storageSet({ [GATE_EXPIRY_KEY]: next });
  }
  function isLockHourExpiry(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return false;
    let fmt;
    try {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: LOCK_TIME_ZONE,
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
      });
    } catch {
      return false;
    }
    for (const delta of [0, 90_000, -90_000]) {
      const parts = fmt.formatToParts(new Date(ms + delta));
      const hour = Number(parts.find((x) => x.type === "hour")?.value);
      const minute = Number(parts.find((x) => x.type === "minute")?.value);
      if (hour === LOCK_HOUR && minute === 0) return true;
    }
    return false;
  }
  /** The gate is gone because its (non-8pm) expiry passed — session expiry, not a lock. */
  function gateLapsedNaturally(nowMs = Date.now()) {
    return gateExpiryMs > 0 && nowMs >= gateExpiryMs - 5_000 && !isLockHourExpiry(gateExpiryMs);
  }
  /**
   * Is a missing gate evidence of a website Lock of the Tools session now on :8788?
   * Returns "" when it is (lock Tools), otherwise why it is not (do not lock).
   * Only INFERRED lock paths use this (page/cookie state); a user-clicked Lock arrives
   * through the lockShop hook and always wins.
   */
  function siteLockEvidence(health, nowMs = Date.now()) {
    if (recentUnlockActive(nowMs)) return "recent_unlock";
    if (!gateSeen) return "gate_never_seen";
    const sessionId = health && typeof health.sessionId === "string" ? health.sessionId : "";
    if (gateSeenSessionId && sessionId && gateSeenSessionId !== sessionId) return "stale_session";
    if (gateExpiryMs > 0 && nowMs > gateExpiryMs + GATE_EXPIRY_STALE_MS) return "expired_unobserved";
    if (gateLapsedNaturally(nowMs)) return "expired";
    return "";
  }
  /** Same, from a cookies.onChanged removal. Only cause "expired" at/after its own expiry. */
  function removalIsNaturalExpiry(cause, expirationDateSec, nowMs = Date.now()) {
    if (String(cause || "").toLowerCase() !== "expired") return false;
    const expMs = Number(expirationDateSec) * 1000;
    if (!Number.isFinite(expMs) || expMs > nowMs + 5_000) return false;
    return !isLockHourExpiry(expMs);
  }
  function gateRenewalDue(nowMs = Date.now()) {
    return (
      gateExpiryMs > 0 &&
      gateExpiryMs - nowMs < GATE_RENEW_MARGIN_MS &&
      !isLockHourExpiry(gateExpiryMs)
    );
  }
  let lastToolsSessionId = null;
  /** Last time something other than Desk removed bf_shop_gate (site Lock). */
  let lastForeignGateRemovedAt = 0;
  const FOREIGN_REMOVAL_SETTLE_MS = 1_500;
  let deskGateWriteUntil = 0;
  let lastDeskGateValue = "";
  /** Page-context report: the shop tab's own cookie, not the extension jar. */
  const PAGE_GATE_REPORT_MS = 120_000;
  const HANDOFF_DEBOUNCE_MS = 10_000;
  let lastPageGateReport = null;
  let lastHandoffAt = 0;
  let lastHandoffSessionId = "";

  function notePageGate({ ok, person, tabId } = {}) {
    lastPageGateReport = {
      ok: Boolean(ok),
      person: normalizePerson(person),
      tabId: tabId == null ? null : tabId,
      at: Date.now(),
    };
  }

  function freshPageGateReport(nowMs = Date.now()) {
    if (!lastPageGateReport) return null;
    if (nowMs - lastPageGateReport.at > PAGE_GATE_REPORT_MS) return null;
    return lastPageGateReport;
  }

  function isShopHandoffUrl(url, base) {
    try {
      const parsed = new URL(url);
      const expected = new URL(base);
      if (parsed.origin !== expected.origin) return false;
      return /^\/api\/widget\/session\/handoff\/[A-Za-z0-9_-]{20,}$/.test(parsed.pathname);
    } catch {
      return false;
    }
  }
  /** After Tools→site exchange, ignore gate-removal → site-lock (unlock bounce). */
  const UNLOCK_HOLD_MS = 35_000;
  let unlockHoldUntil = 0;
  function armUnlockHold(ms = UNLOCK_HOLD_MS) {
    unlockHoldUntil = Date.now() + ms;
    lastUnlockAt = Date.now();
  }
  /**
   * The hold above is zeroed by the first probe that sees Tools signed in (~400ms), so
   * it cannot cover the reloaded /unlock page or the cookie swap. This window can.
   */
  let lastUnlockAt = 0;
  function recentUnlockActive(nowMs = Date.now()) {
    return lastUnlockAt > 0 && nowMs - lastUnlockAt < RECENT_UNLOCK_MS;
  }
  function unlockHoldActive(nowMs = Date.now()) {
    return nowMs < unlockHoldUntil;
  }

  async function persistLatch() {
    await storageSet({ [LATCH_KEY]: siteLatch });
  }

  async function loadLatch() {
    const stored = await storageGet([
      LATCH_KEY,
      GATE_SEEN_KEY,
      GATE_EXPIRY_KEY,
      GATE_SEEN_SESSION_KEY,
    ]);
    if (stored[GATE_SEEN_KEY] === true) gateSeen = true;
    if (!gateSeenSessionId && typeof stored[GATE_SEEN_SESSION_KEY] === "string") {
      gateSeenSessionId = stored[GATE_SEEN_SESSION_KEY];
    }
    if (!gateExpiryMs && Number(stored[GATE_EXPIRY_KEY]) > 0) {
      gateExpiryMs = Number(stored[GATE_EXPIRY_KEY]);
    }
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

  /**
   * Person id baked into a shop gate (`v2.<until>.<person>.<kind>.<mac>`).
   * Empty when the value is not that shape. Never log the cookie.
   */
  function personFromGateValue(value) {
    const parts = String(value || "").split(".");
    let person = "";
    if (parts[0] === "v2" && parts.length === 5) person = parts[2];
    else if (parts[0] === "v1" && parts.length === 4) person = parts[2];
    person = normalizePerson(person);
    return PERSON_ID_RE.test(person) ? person : "";
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
    let toolsPublished = false;
    if (
      publishToTools &&
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
      toolsPublished = Boolean(published && published.ok);
    }
    return { ok: true, person: normalized, source: src, toolsPublished };
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

  /**
   * Host-only bf_shop_gate (path /, no Domain). Firefox Total Cookie Protection
   * stores that first-party cookie under the shop top-level site. cookies.get
   * without partitionKey reads a different jar and misses the unlocked page.
   */
  function shopGateQueries(base, name) {
    const url = `${base}/`;
    const queries = [{ url, name }];
    try {
      const topLevelSite = new URL(url).origin;
      if (topLevelSite) queries.push({ url, name, partitionKey: { topLevelSite } });
    } catch {
      // unpartitioned query only
    }
    return queries;
  }

  async function findShopGateCookie() {
    const base = await shopBaseUrl();
    const name = api.SHOP_GATE_COOKIE || GATE_COOKIE;
    if (!runtime?.cookies?.get) {
      return { present: false, unknown: true, reason: "no_cookies_api", value: "", person: "" };
    }
    const queries = shopGateQueries(base, name);
    let failures = 0;
    const consider = (cookie, partitioned) => {
      if (!cookie || !cookie.value) return null;
      markGateSeen(true);
      noteGateExpiry(
        Number.isFinite(cookie.expirationDate) ? cookie.expirationDate * 1000 : 0,
      );
      return {
        present: true,
        value: String(cookie.value),
        person: personFromGateValue(cookie.value),
        partitioned: Boolean(partitioned),
      };
    };
    for (const query of queries) {
      try {
        const found = consider(await runtime.cookies.get(query), query.partitionKey);
        if (found) return found;
      } catch {
        failures += 1;
      }
    }
    if (runtime.cookies.getAll) {
      for (const query of queries) {
        try {
          const details = query.partitionKey
            ? { name, partitionKey: query.partitionKey }
            : { url: query.url, name };
          const all = await runtime.cookies.getAll(details);
          const cookie = (all || []).find((item) => item && item.value);
          const found = consider(cookie, query.partitionKey);
          if (found) return found;
        } catch {
          failures += 1;
        }
      }
    }
    const attempts = queries.length * (runtime.cookies.getAll ? 2 : 1);
    if (failures === attempts) {
      return { present: false, unknown: true, reason: "cookie_error", value: "", person: "" };
    }
    return { present: false, value: "", person: "", reason: "missing" };
  }

  /** Read bf_shop_gate from the default browser profile. Never logs the value. */
  async function readShopGateCookie() {
    const found = await findShopGateCookie();
    return {
      present: Boolean(found.present),
      person: found.person || "",
      unknown: Boolean(found.unknown),
      reason: found.reason,
      partitioned: Boolean(found.partitioned),
    };
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
    const sessionExpired = !hasSession && Boolean(data && data.sessionExpired);
    if (hasSession && sessionId) lastToolsSessionId = sessionId;
    if (!hasSession) lastToolsSessionId = "";
    return {
      reachable: true,
      sessionId,
      locked: data && typeof data.locked === "boolean" ? data.locked : undefined,
      sessionExpired,
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
    noteGateExpiry(0);
    let removed = false;
    for (const query of shopGateQueries(base, name)) {
      try {
        await runtime.cookies.remove(query);
        removed = true;
      } catch {
        // try the other jar
      }
    }
    return removed ? { ok: true } : { ok: false, reason: "remove_failed" };
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
    };
    const parsed = expiresAt ? Date.parse(expiresAt) : NaN;
    if (Number.isFinite(parsed)) {
      details.expirationDate = Math.floor(parsed / 1000);
    }
    deskGateWriteUntil = Date.now() + DESK_GATE_WRITE_MS;
    lastDeskGateValue = String(value);
    // Shop writes SameSite=Lax on shop.blackforestautomotive.com. None is only
    // for a different host. Try Lax first so the page's gate check receives it.
    let topLevelSite = "";
    try {
      topLevelSite = new URL(`${base}/`).origin;
    } catch {
      topLevelSite = "";
    }
    const attempts = [
      topLevelSite ? { ...details, sameSite: "lax", partitionKey: { topLevelSite } } : null,
      { ...details, sameSite: "lax" },
      { ...details, sameSite: "no_restriction" },
      { ...details },
    ].filter(Boolean);
    for (const attempt of attempts) {
      try {
        await runtime.cookies.set(attempt);
        markGateSeen(true);
        noteGateExpiry(details.expirationDate ? details.expirationDate * 1000 : 0);
        return { ok: true };
      } catch {
        // next attribute set
      }
    }
    return { ok: false, reason: "set_failed" };
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

  /**
   * After Tools → Firefox exchange, the shop SPA will not notice a new gate on its own.
   * `/unlock` never checks the cookie in beforeLoad (it polls), and other pages cache
   * the previous person. Send `/unlock` home and reload every other shop tab when the
   * person changed or the jar was empty. Otherwise only reload `/unlock` tabs.
   */
  async function reloadShopUnlockTabs({ leaveUnlock = false } = {}) {
    if (!runtime?.tabs?.query) return { reloaded: 0 };
    let tabs = [];
    try {
      tabs = await runtime.tabs.query({ url: ["https://shop.blackforestautomotive.com/*"] });
    } catch {
      return { reloaded: 0 };
    }
    const base = await shopBaseUrl();
    let reloaded = 0;
    for (const tab of tabs || []) {
      if (tab?.id == null || typeof tab.url !== "string") continue;
      const onUnlock = tab.url.includes("/unlock");
      if (!leaveUnlock && !onUnlock) continue;
      try {
        if (leaveUnlock && onUnlock && runtime.tabs.update) {
          await runtime.tabs.update(tab.id, { url: `${base}/` });
        } else if (runtime.tabs.reload) {
          await runtime.tabs.reload(tab.id);
        } else {
          continue;
        }
        reloaded += 1;
      } catch {
        // ignore
      }
    }
    return { reloaded };
  }

  /**
   * Tools Bearer → one-time shop handoff URL. GET of that URL Set-Cookies on a
   * document response the page will actually send. Extension cookies.set does not.
   */
  async function mintShopHandoff(token) {
    if (!token) return { ok: false, reason: "no_token" };
    const base = await shopBaseUrl();
    let response;
    try {
      response = await fetch(`${base}/api/widget/session/handoff`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        cache: "no-store",
      });
    } catch {
      return { ok: false, reason: "network" };
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "unauthorized" };
    }
    if (response.status === 429) return { ok: false, reason: "rate_limited" };
    const url = data && typeof data.url === "string" ? data.url : "";
    if (!response.ok || !isShopHandoffUrl(url, base)) {
      return { ok: false, reason: "handoff_failed" };
    }
    return { ok: true, url };
  }

  function shopPathname(url) {
    try {
      const path = new URL(url).pathname.replace(/\/+$/, "");
      return path || "/";
    } catch {
      return "";
    }
  }

  /** Live PIN is UnlockScreen on `/` as well as `/unlock`. */
  function isShopPinUrl(url) {
    const path = shopPathname(url);
    return path === "/" || path === "/unlock";
  }

  async function findShopPinTab() {
    if (!runtime?.tabs?.query) return null;
    let tabs = [];
    try {
      tabs = await runtime.tabs.query({ url: ["https://shop.blackforestautomotive.com/*"] });
    } catch {
      return null;
    }
    return (tabs || []).find((tab) => tab && tab.id != null && isShopPinUrl(tab.url)) || null;
  }

  /** Open the handoff in the signed-out shop tab. One tab: the ticket is single-use. */
  async function navigateShopHandoff(url, preferredTabId) {
    if (!url || !runtime?.tabs?.query || !runtime?.tabs?.update) return { navigated: false };
    let tabs = [];
    try {
      tabs = await runtime.tabs.query({ url: ["https://shop.blackforestautomotive.com/*"] });
    } catch {
      return { navigated: false };
    }
    const shop = (tabs || []).filter((tab) => tab && tab.id != null);
    const preferred = shop.find((tab) => tab.id === preferredTabId);
    const pin = shop.find((tab) => isShopPinUrl(tab.url));
    const target = preferred || pin;
    if (!target) return { navigated: false };
    try {
      await runtime.tabs.update(target.id, { url });
      return { navigated: true, tabId: target.id };
    } catch {
      return { navigated: false };
    }
  }

  /**
   * End-to-end: Tools :8788 Bearer → shop page.
   * The page jar is not the extension jar. When the shop tab says it is signed
   * out, open the one-time handoff so the server Set-Cookies for that tab.
   * When the shop tab says it just signed in, do not clear its cookie while
   * Tools is still locked. A shop load also keeps the cookie: deleting it here
   * is what signed the site out. An observed Tools lock (session was on, now off)
   * still clears. Extension cookies.set remains the fallback when the page has
   * not reported and the jar is empty or a different person.
   * forceExchange=true on explicit Sync Tools (heal stale gate).
   */
  async function syncToolsSessionToSite({
    reloadUnlockTabs = true,
    forceExchange = false,
    pageSignedIn,
    pagePerson = "",
    handoffNavigate = true,
    tabId = null,
    shopLoad = false,
    observedToolsLock = false,
  } = {}) {
    if (typeof pageSignedIn === "boolean") {
      notePageGate({ ok: pageSignedIn, person: pagePerson, tabId });
    }
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
      !unlockHoldActive()
    ) {
      const gateNow = await readShopGateCookie();
      if (!gateNow.present && !gateNow.unknown) {
        const why = siteLockEvidence(health);
        if (why) {
          // The gate is gone but nothing says a Lock removed it: it ran out, or it
          // belongs to an older Tools session, or we just unlocked (first sign-in).
          // Fall through and exchange instead of locking Tools back.
          markGateSeen(false);
          noteGateExpiry(0);
        } else {
          await syncSiteLockToTools({ reloadShopTabs: true });
          return {
            ok: false,
            locked: true,
            shouldReload: false,
            reason: "site_lock",
            error: "Website was locked — Tools locked to match.",
          };
        }
      }
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
      // Tools' Bearer ran out (not a Tools lock): the website session is still its own
      // thing. Clearing the gate here is what turned a quiet expiry into a lock of both.
      if (health.sessionExpired && health.locked !== true) {
        return {
          ok: true,
          skipped: "tools_session_expired",
          reason: "tools_session_expired",
          siteGate: (await readShopGateCookie()).present,
        };
      }
      // Not a Tools lock click. An unlocked shop page (cookie in the page jar,
      // including Firefox's first-party partition) must sign Tools and Desk in.
      // A shop load that cannot see a session still must not delete the cookie.
      if (!observedToolsLock) {
        const imported = await importSiteGateSession();
        if (imported && imported.ok && imported.toolsPublished !== false) {
          return {
            ok: true,
            person: imported.person || "",
            source: "site-gate",
            reason: "site_signed_in",
            shouldReload: false,
            siteGate: true,
          };
        }
        if (pageSignedIn === true) {
          return {
            ok: true,
            skipped: "page_signed_in",
            reason: "page_signed_in",
            shouldReload: false,
            siteGate: (await readShopGateCookie()).present,
          };
        }
        if (shopLoad || pageSignedIn !== false) {
          return {
            ok: true,
            skipped: shopLoad ? "shop_load" : "tools_already_locked",
            reason: shopLoad ? "shop_load" : "tools_already_locked",
            shouldReload: false,
            siteGate: (await readShopGateCookie()).present,
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
    const stored = await storageGet(["shopWidgetToken"]);
    const token = stored.shopWidgetToken;
    const gateNow = await readShopGateCookie();
    const gateBefore = gateNow.present;
    const toolsPerson = normalizePerson(fromTools.person || "");
    const differentPerson = Boolean(
      gateBefore && toolsPerson && gateNow.person && toolsPerson !== gateNow.person,
    );
    const pagePersonNorm = normalizePerson(pagePerson);
    const pageDifferent = Boolean(
      pageSignedIn === true && toolsPerson && pagePersonNorm && toolsPerson !== pagePersonNorm,
    );
    // The open shop tab already has this person. The extension jar is irrelevant.
    if (pageSignedIn === true && !pageDifferent && !forceExchange && !differentPerson && !gateRenewalDue()) {
      return {
        ok: true,
        person: fromTools.person,
        source: "tools-bridge",
        siteGate: true,
        shouldReload: false,
        reason: "page_signed_in",
      };
    }
    // Page is on the PIN screen (or a different person). A cookie cookies.get can
    // see is not a cookie peekShopGate will accept. First-party handoff is.
    if (pageSignedIn === false || pageDifferent) {
      const sessionId = String(health.sessionId || lastToolsSessionId || "");
      const nowMs = Date.now();
      const debounced =
        !forceExchange &&
        sessionId &&
        lastHandoffSessionId === sessionId &&
        nowMs - lastHandoffAt < HANDOFF_DEBOUNCE_MS;
      if (debounced) {
        return {
          ok: true,
          person: fromTools.person,
          source: "tools-bridge",
          siteGate: gateBefore,
          shouldReload: false,
          skipped: "handoff_debounce",
          reason: "handoff_debounce",
        };
      }
      lastHandoffAt = nowMs;
      lastHandoffSessionId = sessionId;
      const handed = await mintShopHandoff(token);
      if (handed.ok) {
        armUnlockHold();
        let navigated = false;
        if (handoffNavigate !== false && reloadUnlockTabs) {
          const nav = await navigateShopHandoff(handed.url, tabId);
          navigated = Boolean(nav.navigated);
        }
        return {
          ok: true,
          person: fromTools.person,
          source: "tools-handoff",
          siteGate: gateBefore,
          shouldReload: false,
          handoffUrl: handed.url,
          navigated,
        };
      }
      lastHandoffAt = 0;
    }
    if (gateBefore && !forceExchange && !differentPerson && !gateRenewalDue() && pageSignedIn !== false) {
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
    const healPage = !gateBefore || differentPerson;
    const shouldReload = healPage || forceExchange;
    if (shouldReload && reloadUnlockTabs) {
      await reloadShopUnlockTabs({ leaveUnlock: healPage });
    }
    return {
      ok: true,
      person: exchanged.person || fromTools.person,
      source: "tools-bridge",
      siteGate: true,
      shouldReload,
    };
  }

  async function shopGateCookieValue() {
    const found = await findShopGateCookie();
    return found.value || "";
  }

  /**
   * Ask an open shop tab to POST from-gate in the page. That fetch sends
   * SameSite=Lax. An extension fetch does not, and a Cookie header may be dropped.
   */
  async function pullGateTokenFromShopTabs() {
    if (!runtime?.tabs?.query || !runtime?.tabs?.sendMessage) return null;
    let tabs = [];
    try {
      tabs = await runtime.tabs.query({ url: ["https://shop.blackforestautomotive.com/*"] });
    } catch {
      return null;
    }
    for (const tab of tabs || []) {
      if (tab?.id == null) continue;
      try {
        const page = await runtime.tabs.sendMessage(tab.id, { type: "pull-shop-gate" });
        if (page && page.ok && page.token) {
          return {
            token: String(page.token),
            expiresAt: page.expiresAt ? String(page.expiresAt) : "",
            person: page.person ? String(page.person) : "",
          };
        }
      } catch {
        // tab has no content script yet
      }
    }
    return null;
  }

  async function postShopFromGate(base, headers) {
    return fetch(`${base}/api/widget/session/from-gate`, {
      method: "POST",
      headers,
      credentials: "include",
      body: "{}",
      cache: "no-store",
    });
  }

  /**
   * Website shop session → Desk Bearer via POST /api/widget/session/from-gate.
   * Degrades cleanly when the route is missing (404/406): falls back to Tools/PIN.
   * Background fetch does not send SameSite=Lax, so this passes the jar value when
   * cookies.get can see it. The shop tab's own fetch is what sees a real site login.
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
    const fromPage = await pullGateTokenFromShopTabs();
    if (fromPage && fromPage.token) {
      if (epoch !== latchEpoch) {
        return { error: "Website was locked mid-import.", reason: "site_locked" };
      }
      return storeWidgetToken({
        token: fromPage.token,
        expiresAt: fromPage.expiresAt,
        person: fromPage.person,
        source: "site-gate",
        publishToTools: true,
      });
    }
    if (!gate.present) {
      return {
        error:
          "Shop site is not signed in in this browser profile. Unlock shop.blackforestautomotive.com first.",
        reason: "no_gate_cookie",
      };
    }

    const base = await shopBaseUrl();
    const name = api.SHOP_GATE_COOKIE || GATE_COOKIE;
    const gateValue = await shopGateCookieValue();
    const headers = { Accept: "application/json", "Content-Type": "application/json" };
    // Extension fetch does not attach SameSite=Lax. Send the jar value when we have it.
    // The page's own from-gate call is the path that actually sees the site login.
    if (gateValue) headers.Cookie = `${name}=${gateValue}`;
    let response;
    try {
      response = await postShopFromGate(base, headers);
    } catch {
      try {
        response = await postShopFromGate(base, {
          Accept: "application/json",
          "Content-Type": "application/json",
        });
      } catch {
        return { error: "Could not reach the shop from-gate API.", reason: "network" };
      }
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
        error: "Shop cookie was rejected. Unlock the shop site again in this browser profile.",
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
  /** A Tools lock arrived during unlock-hold and must still clear the gate once the hold ends. */
  let replayToolsLock = false;

  async function handleGateCookieRemoved(info = {}) {
    // Unlock bounce: gateToken cookies.set can remove→set; do not lock Tools.
    await latchReady;
    if (siteLatch) return { skipped: "already_latched" };
    if (unlockHoldActive()) return { skipped: "unlock_hold" };
    const gate = await readShopGateCookie();
    if (gate.present) return { skipped: "gate_present" };
    if (gate.unknown) return { skipped: "gate_unknown" };
    if (unlockHoldActive()) return { skipped: "unlock_hold" };
    // cookies.set over an existing gate removes (cause "overwrite") then re-adds it.
    if (String(info.cause || "").toLowerCase() === "overwrite") return { skipped: "gate_overwrite" };
    if (removalIsNaturalExpiry(info.cause, info.expirationDate) || gateLapsedNaturally()) {
      markGateSeen(false);
      noteGateExpiry(0);
      const health = await probeToolsBridgeHealth();
      if (health.reachable && health.hasSession) {
        const renewed = await syncToolsSessionToSite({
          reloadUnlockTabs: true,
          forceExchange: true,
        });
        return { skipped: "gate_expired_renewed", renewed: Boolean(renewed && renewed.ok) };
      }
      return { skipped: "gate_expired" };
    }
    const health = await probeToolsBridgeHealth();
    if (health.reachable && health.hasSession === false) return { skipped: "tools_already_locked" };
    return syncSiteLockToTools({ reloadShopTabs: true });
  }

  let lastRelockAt = 0;
  let mirrorRetryAt = 0;
  let mirrorRetries = 0;
  const MIRROR_RETRY_MS = 3_000;
  const MIRROR_RETRY_MAX = 20;

  let lastGateRenewTryAt = 0;
  async function tickGateRenewal() {
    const now = Date.now();
    if (now - lastGateRenewTryAt < GATE_RENEW_RETRY_MS) return;
    const gate = await readShopGateCookie();
    if (!gate.present || !gateRenewalDue(now)) return;
    lastGateRenewTryAt = now;
    await syncToolsSessionToSite({ reloadUnlockTabs: false });
  }

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
          // Opening on a Tools that is already locked is not a lock click. A shop
          // sign-in must survive that. A real lock edge, including one replayed
          // after unlock-hold, still clears the gate.
          const openingLocked = first && !has && !replayToolsLock;
          const observedToolsLock = !has && !openingLocked;
          if (replayToolsLock && !has) replayToolsLock = false;
          const synced = await syncToolsSessionToSite({
            reloadUnlockTabs: true,
            forceExchange: has && !swapped,
            shopLoad: openingLocked,
            observedToolsLock,
          });
          if (synced && synced.skipped === "unlock_hold") {
            // Edge was swallowed by the hold. Replay it once the hold ends.
            lastBridgeHasSession = null;
            lastBridgeFingerprint = "";
            if (!has) replayToolsLock = true;
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
      // While both sides are signed in, extend the Firefox gate before it runs out.
      // A shop tab that already said it is signed out keeps getting a handoff until
      // that tab reports the page cookie, even when the extension jar looks full.
      if (has && !siteLatch) {
        const page = freshPageGateReport();
        // Only a shop tab that said it is signed out. A bare `/` is also the
        // signed-in home, so do not hand off every home tab that has not reported.
        if (page && page.ok === false && Date.now() - lastHandoffAt >= HANDOFF_DEBOUNCE_MS) {
          const pin = await findShopPinTab();
          await syncToolsSessionToSite({
            reloadUnlockTabs: true,
            forceExchange: false,
            pageSignedIn: false,
            pagePerson: page.person,
            tabId: page.tabId || (pin && pin.id) || null,
            handoffNavigate: true,
            shopLoad: true,
          });
        }
      }
      if (has && !siteLatch && !unlockHoldActive()) {
        await tickGateRenewal();
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
   * 1) Observed Tools lock → clear Firefox bf_shop_gate. A shop load does not.
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
            // Real Tools lock (not mid-website-unlock). A shop load keeps the site cookie.
            return syncToolsSessionToSite({
              reloadUnlockTabs: true,
              shopLoad: reason === "shop-tab-complete",
            });
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
          // shop-tab-complete must not delete bf_shop_gate just because Tools is locked.
          const synced = await syncToolsSessionToSite({
            reloadUnlockTabs: true,
            shopLoad: reason === "shop-tab-complete",
          });
          if (synced.ok && !synced.skipped) {
            await setPinBadge(false);
            return { ok: true, source: synced.source || "tools-bridge", reason, siteGate: true };
          }
          if (synced.ok && synced.skipped) {
            return { ...synced, reason: reason || synced.reason };
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
          "Unlock the shop site in this browser profile (or Tools / desk PIN in the popup), then Refresh.",
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
  /**
   * Why an /unlock page load is NOT proof of a website Lock ("" = it is). Gate present
   * or unreadable, gate ran out, gate belonged to an older Tools session, or this is
   * the first sign-in landing on an /unlock tab that has not reloaded yet.
   */
  api.siteUnlockPageNotLockReason = async (health) => {
    await latchReady;
    const gate = await readShopGateCookie();
    if (gate.present) return "gate_present";
    if (gate.unknown) return "gate_unknown";
    return siteLockEvidence(health);
  };
  api.siteUnlockPageIsExpiry = async (health) => Boolean(await api.siteUnlockPageNotLockReason(health));
  /**
   * The shop tab landed on /unlock. Lock Tools only with proof of a website Lock;
   * otherwise it is a stale tab, an expired gate, or the first sign-in not yet reloaded.
   */
  api.handleSiteUnlockPage = async () => {
    await latchReady;
    if (unlockHoldActive()) return { ok: true, skipped: "unlock_hold" };
    const health = await probeToolsBridgeHealth();
    if (!health.reachable || health.hasSession === false) {
      return { ok: true, skipped: "tools_already_locked" };
    }
    const notLock = await api.siteUnlockPageNotLockReason(health);
    if (notLock) {
      return { ok: true, skipped: notLock === "gate_present" ? notLock : "not_a_lock", reason: notLock };
    }
    return syncSiteLockToTools({ reloadShopTabs: false });
  };
  api.noteGateCookieAdded = async () => {
    await latchReady;
    await readShopGateCookie();
  };
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
