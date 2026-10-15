/* global chrome, browser, AllDataRoLabels */
/**
 * Black Forest Desk background:
 * - AllData Create RO → POST local Labels /api/print-ro
 * - SSF → On the Lot last names (widget lot API, never book-today)
 * - Soft auto-update check against label-connect extension/version.json
 * - Auto unlock: shop from-gate (preferred) then Tools :8788 — no popup / Sync click
 */
(function () {
  const runtime = typeof browser !== "undefined" ? browser : chrome;
  const DEFAULT_BASE = "http://127.0.0.1:8080";
  const VERSION_URL =
    "https://raw.githubusercontent.com/BlackForestPorsche/label-connect/main/extension/version.json";
  const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
  const AUTO_UNLOCK_ALARM = "desk-auto-unlock";
  /** Backup only — Tools↔site sync is edge-driven via :8788 health watch (~1s). */
  const AUTO_UNLOCK_PERIOD_MIN = 5;
  const BRIDGE_WAKE_ALARM = "desk-bridge-wake";
  const IS_CHROMIUM = typeof runtime.runtime.getBrowserInfo !== "function";
  const CHROMIUM_ZIP_NAME = "Black.Forest.Desk-chromium.zip";
  const SHOP_HOST_RE = /^https:\/\/shop\.blackforestautomotive\.com(\/|$)/i;

  // Chromium MV3 service worker: pull shared helpers.
  if (typeof importScripts === "function") {
    try {
      importScripts("config.js", "lot-names.js");
    } catch {
      // Firefox loads scripts via manifest background.scripts instead.
    }
  }

  async function labelsBaseUrl() {
    try {
      const stored = await runtime.storage.local.get(["labelsBaseUrl"]);
      const value = stored && stored.labelsBaseUrl;
      if (typeof value === "string" && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(value.trim())) {
        return value.trim().replace(/\/$/, "");
      }
    } catch {
      // storage may be unavailable in some test loads
    }
    return DEFAULT_BASE;
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
      const code = data && data.error;
      if (response.status === 401 || response.status === 403) {
        return {
          error:
            "Labels rejected the print request. Confirm Labels is running at 127.0.0.1:8080 (Create RO does not use the desk PIN).",
        };
      }
      return { error: code || `Labels returned ${response.status}.` };
    }
    return data || { ok: true };
  }

  function localVersion() {
    try {
      return String(runtime.runtime.getManifest()?.version || "0");
    } catch {
      return "0";
    }
  }

  function parseVersion(v) {
    return String(v || "0")
      .split(/[.+-]/)
      .map((part) => Number.parseInt(part, 10) || 0);
  }

  function isNewer(remote, local) {
    const a = parseVersion(remote);
    const b = parseVersion(local);
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i += 1) {
      const x = a[i] || 0;
      const y = b[i] || 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  }

  async function checkForUpdate(force) {
    try {
      const stored = await runtime.storage.local.get(["deskUpdateCheckedAt", "deskUpdateAvailable"]);
      const checkedAt = Number(stored.deskUpdateCheckedAt || 0);
      if (!force && checkedAt && Date.now() - checkedAt < UPDATE_CHECK_MS && stored.deskUpdateAvailable) {
        return stored.deskUpdateAvailable;
      }
      const response = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`version.json ${response.status}`);
      const remote = await response.json();
      const remoteVersion = String(remote.version || "");
      const local = localVersion();
      const available = remoteVersion && isNewer(remoteVersion, local)
        ? {
            version: remoteVersion,
            local,
            message:
              (IS_CHROMIUM && remote.chromiumMessage) ||
              remote.message ||
              (IS_CHROMIUM
                ? "Click Download update, unzip over the Desk folder, then Reload Desk."
                : "Firefox installs Hub-signed updates by itself; click Update to apply it now."),
            url: remote.url || "https://github.com/BlackForestPorsche/label-connect",
          }
        : null;
      const patch = {
        deskUpdateCheckedAt: Date.now(),
        deskUpdateAvailable: available,
      };
      if (!available) patch.deskUpdateAppliedVersion = null;
      await runtime.storage.local.set(patch);
      const api = globalThis.AllDataRoLabels;
      if (available && runtime.action?.setBadgeText) {
        await runtime.action.setBadgeText({ text: "↑" });
        await runtime.action.setBadgeBackgroundColor?.({ color: "#1f4d2a" });
        await runtime.action.setTitle?.({
          title: `Black Forest Desk — update ${available.version} ready`,
        });
      } else if (api?.refreshUnlockBadge) {
        await api.refreshUnlockBadge();
      }
      return available;
    } catch {
      return null;
    }
  }

  const RELEASE_XPI_BASE =
    "https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension";
  const UPDATES_JSON_URL = `${RELEASE_XPI_BASE}/updates.json`;
  const DESK_ADDON_ID = "black-forest-desk@blackforestautomotive.com";

  async function fetchSignedFeedUpdate() {
    try {
      const response = await fetch(`${UPDATES_JSON_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) return null;
      const data = await response.json();
      const updates = data?.addons?.[DESK_ADDON_ID]?.updates;
      if (!Array.isArray(updates) || !updates.length) return null;
      let best = updates[0];
      for (const entry of updates) {
        if (entry?.version && isNewer(entry.version, best.version)) best = entry;
      }
      const version = String(best.version || "");
      const updateLink = String(best.update_link || "");
      if (!version || !updateLink) return null;
      return { version, updateLink, updateHash: best.update_hash ? String(best.update_hash) : null };
    } catch {
      return null;
    }
  }

  /**
   * Firefox fires onUpdateAvailable when it has a newer signed Desk (daily background check,
   * about:addons → Check for Updates, or the install prompt). Listening postpones the swap, so
   * reload right away to apply it. runtime.requestUpdateCheck is NOT implemented in Firefox
   * (Bugzilla 1740508 — the schema marks it unsupported), so it cannot be used to force a check.
   */
  let pendingUpdateDetails = null;
  if (runtime.runtime.onUpdateAvailable?.addListener) {
    try {
      runtime.runtime.onUpdateAvailable.addListener((details) => {
        pendingUpdateDetails = details || { version: "" };
        try {
          runtime.runtime.reload();
        } catch {
          // reload may throw if already shutting down
        }
      });
    } catch {
      // onUpdateAvailable unavailable
    }
  }

  async function markFirefoxApplying(version) {
    const local = localVersion();
    await runtime.storage.local.set({
      deskUpdateAppliedVersion: version,
      deskUpdateAvailable: {
        version,
        local,
        message: "Firefox is applying the signed update…",
        applied: true,
      },
    });
    if (runtime.action?.setBadgeText) {
      await runtime.action.setBadgeText({ text: "↻" });
      await runtime.action.setBadgeBackgroundColor?.({ color: "#1f4d2a" });
    }
    return {
      ok: true,
      mode: "firefox_update",
      version,
      applied: true,
      restartRequired: false,
      message: `Firefox is applying signed Desk ${version} (reload).`,
    };
  }

  async function openSignedXpiPrompt(feed) {
    const url =
      String(feed?.updateLink || "").trim() ||
      `${RELEASE_XPI_BASE}/Black.Forest.Desk-${feed?.version}.xpi`;
    if (!runtime.tabs?.create) return false;
    try {
      await runtime.tabs.create({ url, active: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Apply a Hub/AMO-signed Desk upgrade through Firefox itself. Never stages a Desktop XPI and
   * never calls Labels: Firefox only upgrades a signed install from a signed XPI, and the
   * onUpdateAvailable listener above reloads the add-on the moment Firefox has the new version
   * (daily background check, about:addons → Check for Updates, or the install prompt below).
   */
  async function chromiumFeedVersion() {
    const feed = await fetchSignedFeedUpdate();
    if (feed) return feed.version;
    try {
      const response = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) return null;
      const remote = await response.json();
      return remote?.version ? String(remote.version) : null;
    } catch {
      return null;
    }
  }

  /**
   * Chrome/Edge have no signed self-update until a store listing exists: download the release zip
   * (Downloads folder), the user unzips over the Desk folder and presses Reload Desk.
   */
  async function applyChromiumUpdate() {
    const local = localVersion();
    const version = await chromiumFeedVersion();
    if (!version) {
      return {
        ok: false,
        error: "feed_unreachable",
        mode: "feed_unreachable",
        applied: false,
        message: "Couldn’t reach the Desk update feed. Check the connection and try again.",
      };
    }
    if (!isNewer(version, local)) {
      await runtime.storage.local.set({ deskUpdateAvailable: null, deskUpdateAppliedVersion: null });
      return {
        ok: true,
        mode: "up_to_date",
        applied: false,
        version: local,
        message: `Desk ${local} is already the newest version.`,
      };
    }
    const url = `${RELEASE_XPI_BASE}/${CHROMIUM_ZIP_NAME}`;
    const manual = (reason) => ({
      ok: false,
      error: "chromium_manual",
      mode: "chromium_manual",
      applied: false,
      version,
      url,
      message: `Desk ${version} is ready (${reason}). Download ${CHROMIUM_ZIP_NAME} from the label-connect desk-extension release, unzip over the Desk folder, then Reload Desk.`,
    });
    if (!runtime.downloads?.download) return manual("downloads unavailable");
    try {
      await runtime.downloads.download({ url, filename: CHROMIUM_ZIP_NAME, conflictAction: "uniquify" });
    } catch {
      return manual("download blocked");
    }
    return {
      ok: true,
      mode: "chromium_zip",
      applied: false,
      version,
      url,
      message: `Downloaded Desk ${version} to your Downloads folder. Unzip it over the Desk folder, then press Reload Desk. Still running ${local} until you do.`,
    };
  }

  async function applyDeskUpdate() {
    if (IS_CHROMIUM) return applyChromiumUpdate();
    const local = localVersion();
    const feed = await fetchSignedFeedUpdate();
    if (!feed) {
      return {
        ok: false,
        error: "feed_unreachable",
        mode: "feed_unreachable",
        applied: false,
        message:
          "Couldn’t reach the Desk update feed. Try again, or open about:addons → ⚙ → Check for Updates.",
      };
    }
    if (!isNewer(feed.version, local)) {
      await runtime.storage.local.set({ deskUpdateAvailable: null, deskUpdateAppliedVersion: null });
      return {
        ok: true,
        mode: "up_to_date",
        applied: false,
        version: local,
        message: `Desk ${local} is already the newest version.`,
      };
    }

    if (pendingUpdateDetails) {
      const ver = String(pendingUpdateDetails.version || feed.version);
      try {
        runtime.runtime.reload();
      } catch {
        // reload may throw if already shutting down
      }
      return markFirefoxApplying(ver);
    }

    const opened = await openSignedXpiPrompt(feed);
    if (opened) {
      return {
        ok: true,
        mode: "firefox_xpi_prompt",
        version: feed.version,
        applied: false,
        awaitingFirefox: true,
        message: `Firefox is asking to install Desk ${feed.version}. Click Allow, then Add — Desk reloads itself. Still Installed ${local} until you do.`,
      };
    }
    return {
      ok: false,
      error: "firefox_check_needed",
      mode: "firefox_check_needed",
      version: feed.version,
      applied: false,
      message: `Desk ${feed.version} is ready. Open about:addons → ⚙ → Check for Updates — Firefox applies it and Desk reloads itself.`,
    };
  }

  function tryAutoUnlock(reason, force) {
    const api = globalThis.AllDataRoLabels;
    if (!api?.tryAutoUnlock) return;
    void api.tryAutoUnlock({ force: Boolean(force), reason: reason || "" });
  }

  function isShopTabUrl(url) {
    return typeof url === "string" && SHOP_HOST_RE.test(url);
  }

  runtime.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;
    if (message.type === "print-ro") {
      printRo(message.payload).then(sendResponse);
      return true;
    }
    if (message.type === "lot-last-names") {
      const api = globalThis.AllDataRoLabels;
      if (!api?.resolveLotLastNames) {
        sendResponse({ names: [], source: "error", message: "Lot helper missing." });
        return false;
      }
      api.resolveLotLastNames().then(sendResponse);
      return true;
    }
    if (message.type === "widget-session") {
      const api = globalThis.AllDataRoLabels;
      if (!api?.createWidgetSession) {
        sendResponse({ error: "Lot helper missing." });
        return false;
      }
      api.createWidgetSession(message.payload || {}).then(sendResponse);
      return true;
    }
    if (message.type === "site-session-import") {
      const api = globalThis.AllDataRoLabels;
      if (!api?.importSiteGateSession) {
        sendResponse({ error: "Lot helper missing." });
        return false;
      }
      api.importSiteGateSession().then(sendResponse);
      return true;
    }
    if (message.type === "tools-session-import") {
      const api = globalThis.AllDataRoLabels;
      if (!api?.importToolsWidgetSession) {
        sendResponse({ error: "Lot helper missing." });
        return false;
      }
      api.importToolsWidgetSession().then(sendResponse);
      return true;
    }
    if (message.type === "shop-site-session") {
      const api = globalThis.AllDataRoLabels;
      if (!api?.storeWidgetToken) {
        sendResponse({ error: "Lot helper missing." });
        return false;
      }
      const payload = message.payload || {};
      // Website unlock JSON → Desk storage + POST :8788 (Tools unlock).
      api
        .storeWidgetToken({
          token: payload.token,
          expiresAt: payload.expiresAt,
          person: payload.person,
          source: payload.source || "shop-site",
          publishToTools: true,
        })
        .then(sendResponse);
      return true;
    }
    if (message.type === "tools-to-site-unlock") {
      const api = globalThis.AllDataRoLabels;
      if (!api?.syncToolsSessionToSite) {
        sendResponse({ error: "Lot helper missing." });
        return false;
      }
      // Tools unlock → Firefox gate (exchange). forceExchange heals stale gate /
      // post-lock quiet. Also clears gate when Tools locked.
      api
        .syncToolsSessionToSite({
          reloadUnlockTabs: true,
          forceExchange: Boolean(message.forceExchange),
        })
        .then(sendResponse);
      return true;
    }
    if (message.type === "site-lock") {
      const api = globalThis.AllDataRoLabels;
      if (!api?.syncSiteLockToTools) {
        sendResponse({ error: "Lot helper missing." });
        return false;
      }
      // Website lock → clear Firefox gate + DELETE + POST /v1/lock (remint-safe).
      api.syncSiteLockToTools({ reloadShopTabs: false }).then(sendResponse);
      return true;
    }
    if (message.type === "site-unlock-page") {
      // Delivery fallback when lockShop hook missed: /unlock page + Tools still open.
      const api = globalThis.AllDataRoLabels;
      if (!api?.probeToolsBridgeHealth || !api?.syncSiteLockToTools) {
        sendResponse({ ok: false, error: "Lot helper missing." });
        return false;
      }
      if (api.unlockHoldActive && api.unlockHoldActive()) {
        sendResponse({ ok: true, skipped: "unlock_hold" });
        return false;
      }
      api.probeToolsBridgeHealth().then(async (health) => {
        if (!health.reachable || health.hasSession === false) {
          sendResponse({ ok: true, skipped: "tools_already_locked" });
          return;
        }
        // /unlock because the site session simply ran out is not a Lock.
        if (api.siteUnlockPageIsExpiry && (await api.siteUnlockPageIsExpiry())) {
          sendResponse({ ok: true, skipped: "gate_expired" });
          return;
        }
        return api.syncSiteLockToTools({ reloadShopTabs: false }).then(sendResponse);
      });
      return true;
    }
    if (message.type === "check-update") {
      checkForUpdate(Boolean(message.force)).then((available) => sendResponse({ available }));
      return true;
    }
    if (message.type === "reload-extension") {
      sendResponse({ ok: true });
      setTimeout(() => {
        try {
          runtime.runtime.reload();
        } catch {
          // reload may throw if already shutting down
        }
      }, 150);
      return false;
    }
    if (message.type === "apply-update") {
      applyDeskUpdate().then(sendResponse);
      return true;
    }
    if (message.type === "site-person-settings") {
      const api = globalThis.AllDataRoLabels;
      if (!api?.publishPersonSettingsToTools) {
        sendResponse({ ok: false, error: "Lot helper missing." });
        return false;
      }
      const payload =
        message.payload ||
        (message.person || message.settings
          ? { person: message.person, settings: message.settings }
          : {});
      api.publishPersonSettingsToTools(payload).then(sendResponse);
      return true;
    }
    if (message.type === "auto-unlock") {
      const api = globalThis.AllDataRoLabels;
      if (!api?.tryAutoUnlock) {
        sendResponse({ error: "Lot helper missing." });
        return false;
      }
      api.tryAutoUnlock({ force: Boolean(message.force), reason: message.reason || "message" }).then(sendResponse);
      return true;
    }
    return false;
  });

  function refreshToolbarState() {
    void globalThis.AllDataRoLabels?.refreshUnlockBadge?.();
  }

  refreshToolbarState();
  if (runtime.storage?.onChanged?.addListener) {
    try {
      runtime.storage.onChanged.addListener((changes, area) => {
        if (area && area !== "local") return;
        if (changes.shopWidgetToken || changes.shopWidgetTokenExpiresAt) refreshToolbarState();
      });
    } catch {
      // storage.onChanged unavailable
    }
  }

  void checkForUpdate(false);
  tryAutoUnlock("startup", true);
  try {
    globalThis.AllDataRoLabels?.startBridgeSyncPoll?.() ||
      globalThis.AllDataRoLabels?.startToolsBridgeWatch?.();
    // person-settings folded into 400ms bridge poll tick
  } catch {
    // bridge watch optional until lot-names loads
  }

  if (runtime.alarms?.create) {
    try {
      runtime.alarms.create("desk-update-check", { periodInMinutes: 360 });
      runtime.alarms.create("desk-icon-refresh", { periodInMinutes: 1 });
      runtime.alarms.create(AUTO_UNLOCK_ALARM, { periodInMinutes: AUTO_UNLOCK_PERIOD_MIN });
      // MV3 service workers stop when idle; a 30s alarm respawns the worker so the 400ms bridge poll resumes.
      if (IS_CHROMIUM) runtime.alarms.create(BRIDGE_WAKE_ALARM, { periodInMinutes: 0.5 });
      runtime.alarms.onAlarm.addListener((alarm) => {
        if (alarm?.name === "desk-update-check") void checkForUpdate(false);
        if (alarm?.name === "desk-icon-refresh") refreshToolbarState();
        if (alarm?.name === AUTO_UNLOCK_ALARM) tryAutoUnlock("alarm", false);
        if (alarm?.name === BRIDGE_WAKE_ALARM) {
          globalThis.AllDataRoLabels?.startBridgeSyncPoll?.();
        }
      });
    } catch {
    }
  }

  if (runtime.idle?.onStateChanged?.addListener) {
    try {
      runtime.idle.onStateChanged.addListener((state) => {
        if (state === "active") tryAutoUnlock("idle-active", false);
      });
    } catch {
    }
  }

  if (runtime.tabs?.onUpdated?.addListener) {
    try {
      runtime.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
        if (changeInfo.status !== "complete") return;
        const url = tab?.url || changeInfo.url || "";
        if (!isShopTabUrl(url)) return;
        tryAutoUnlock("shop-tab-complete", false);
      });
    } catch {
    }
  }

  // Website lock that only clears bf_shop_gate (no lockShop body) still must lock Tools.
  // Debounce remove→set during exchange so we do not false-lock.
  if (runtime.cookies?.onChanged?.addListener) {
    let gateRemovalTimer = null;
    const GATE_REMOVAL_MS = 700;
    try {
      runtime.cookies.onChanged.addListener((changeInfo) => {
        const cookie = changeInfo?.cookie;
        if (!cookie || cookie.name !== "bf_shop_gate") return;
        if (!/blackforestautomotive\.com$/i.test(String(cookie.domain || ""))) return;
        if (!changeInfo.removed) {
          if (gateRemovalTimer) {
            clearTimeout(gateRemovalTimer);
            gateRemovalTimer = null;
          }
          return;
        }
        if (gateRemovalTimer) clearTimeout(gateRemovalTimer);
        const removalInfo = { cause: changeInfo.cause, expirationDate: cookie.expirationDate };
        gateRemovalTimer = setTimeout(() => {
          gateRemovalTimer = null;
          const api = globalThis.AllDataRoLabels;
          if (!api?.handleGateCookieRemoved) return;
          void api.handleGateCookieRemoved(removalInfo);
        }, GATE_REMOVAL_MS);
      });
    } catch {
      // cookies.onChanged unavailable
    }
  }
})();
