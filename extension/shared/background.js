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
  const AUTO_UNLOCK_PERIOD_MIN = 2;
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
        // Local Labels /api/print-ro has no shop PIN — this is almost always a misconfigured
        // bridge/proxy. Do not echo cryptic "unauthorized".
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
            message: remote.message || "Use Update in the Desk popup (Labels applies it on this machine).",
            url: remote.url || "https://github.com/BlackForestPorsche/label-connect",
          }
        : null;
      const patch = {
        deskUpdateCheckedAt: Date.now(),
        deskUpdateAvailable: available,
      };
      // Clear applied marker when remote no longer reports newer (after Firefox restart).
      if (!available) patch.deskUpdateAppliedVersion = null;
      await runtime.storage.local.set(patch);
      // Preserve PIN / unlocked badge state; only force ↑ when an update is ready.
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

  /** One-click apply via local Labels (localhost-only shell helper). */
  async function applyDeskUpdate() {
    const base = await labelsBaseUrl();
    let response;
    try {
      response = await fetch(`${base}/api/update-desk-extension`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: "{}",
      });
    } catch {
      return {
        ok: false,
        error: "labels_unreachable",
        message: "Labels isn’t running. Open Labels (or Black Forest Tools), then try Update again.",
      };
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok || !data?.ok) {
      const code = data?.error || `http_${response.status}`;
      if (response.status === 403 || code === "localhost_only") {
        return { ok: false, error: code, message: "Desk update refused — Labels only accepts updates from this machine." };
      }
      return {
        ok: false,
        error: code,
        message: data?.message || "Desk update failed.",
      };
    }
    const version = String(data.version || "");
    await runtime.storage.local.set({
      deskUpdateAppliedVersion: version || true,
      deskUpdateAvailable: version
        ? {
            version,
            local: localVersion(),
            message: "Restart Firefox to finish.",
            applied: true,
          }
        : null,
    });
    if (runtime.action?.setBadgeText) {
      await runtime.action.setBadgeText({ text: "↻" });
      await runtime.action.setBadgeBackgroundColor?.({ color: "#1f4d2a" });
      await runtime.action.setTitle?.({
        title: version
          ? `Black Forest Desk — v${version} ready; restart Firefox`
          : "Black Forest Desk — restart Firefox to finish update",
      });
    }
    return {
      ok: true,
      version,
      restartRequired: true,
      message: data.message || (version ? `Updated to ${version}. Restart Firefox.` : "Updated. Restart Firefox."),
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
      api
        .storeWidgetToken({
          token: payload.token,
          expiresAt: payload.expiresAt,
          person: payload.person,
          source: payload.source || "shop-site",
        })
        .then(sendResponse);
      return true;
    }
    if (message.type === "check-update") {
      checkForUpdate(Boolean(message.force)).then((available) => sendResponse({ available }));
      return true;
    }
    if (message.type === "apply-update") {
      applyDeskUpdate().then(sendResponse);
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

  // Soft update check on worker start + daily-ish alarm when available.
  void checkForUpdate(false);
  // Happy path: mint widget token without opening the popup / pressing Sync.
  tryAutoUnlock("startup", true);

  if (runtime.alarms?.create) {
    try {
      runtime.alarms.create("desk-update-check", { periodInMinutes: 360 });
      runtime.alarms.create(AUTO_UNLOCK_ALARM, { periodInMinutes: AUTO_UNLOCK_PERIOD_MIN });
      runtime.alarms.onAlarm.addListener((alarm) => {
        if (alarm?.name === "desk-update-check") void checkForUpdate(false);
        if (alarm?.name === AUTO_UNLOCK_ALARM) tryAutoUnlock("alarm", false);
      });
    } catch {
      // alarms permission optional
    }
  }

  // After idle / lock, retry from-gate + Tools when the user is back.
  if (runtime.idle?.onStateChanged?.addListener) {
    try {
      runtime.idle.onStateChanged.addListener((state) => {
        if (state === "active") tryAutoUnlock("idle-active", false);
      });
    } catch {
      // idle permission optional
    }
  }

  // Shop tab finished loading → from-gate (cookie present) then Tools fallback.
  if (runtime.tabs?.onUpdated?.addListener) {
    try {
      runtime.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
        if (changeInfo.status !== "complete") return;
        const url = tab?.url || changeInfo.url || "";
        if (!isShopTabUrl(url)) return;
        tryAutoUnlock("shop-tab-complete", false);
      });
    } catch {
      // tabs permission optional
    }
  }
})();
