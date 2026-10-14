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
              remote.message ||
              "Hub On your own → Upload New Version, then about:addons → Install Add-on From File (Hub-signed XPI).",
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

  async function openAboutAddons() {
    try {
      if (runtime.tabs?.create) {
        await runtime.tabs.create({ url: "about:addons" });
      }
    } catch {
      // about:addons open is best-effort
    }
  }

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

  async function downloadSignedXpi(version, updateLink) {
    const ver = String(version || "").trim();
    const url = String(updateLink || "").trim() || `${RELEASE_XPI_BASE}/Black.Forest.Desk-${ver}.xpi`;
    if (!ver || !runtime.downloads?.download) return null;
    try {
      const downloadId = await runtime.downloads.download({
        url,
        filename: `Black.Forest.Desk-${ver}.xpi`,
        saveAs: false,
        conflictAction: "overwrite",
      });
      return { downloadId, filename: `Black.Forest.Desk-${ver}.xpi`, url };
    } catch {
      return null;
    }
  }

  /** @deprecated name kept for older call sites — downloads the signed feed XPI. */
  async function downloadHubUploadZip(version) {
    return downloadSignedXpi(version, `${RELEASE_XPI_BASE}/Black.Forest.Desk-${version}.xpi`);
  }

  function signedStagedMessage(version, pathHint) {
    const ver = version ? ` ${version}` : "";
    const where = pathHint ? ` Saved: ${pathHint}.` : " Check Downloads / Desktop.";
    return `Signed Desk${ver} ready.${where} about:addons → gear → Install Add-on From File… (or Check for Updates). Not a failure.`;
  }

  async function requestFirefoxSignedUpdate() {
    if (typeof runtime.runtime.requestUpdateCheck !== "function") return null;
    try {
      const result = await runtime.runtime.requestUpdateCheck();
      if (typeof result === "string") return result;
      if (result && typeof result.status === "string") return result.status;
      return result == null ? null : String(result);
    } catch {
      return null;
    }
  }

  async function stageSignedFeedSuccess(detail) {
    const feed = await fetchSignedFeedUpdate();
    const version = feed?.version || "";
    const dl = version ? await downloadSignedXpi(version, feed?.updateLink) : null;
    await openAboutAddons();
    return {
      ok: true,
      error: null,
      mode: "signed_staged",
      version,
      staged: true,
      applied: false,
      restartRequired: false,
      message: dl
        ? `${signedStagedMessage(version, dl.filename)}${detail ? ` ${detail}` : ""}`
        : detail ||
          "Open about:addons → Check for Updates, or Install Add-on From File from the desk-extension release.",
    };
  }

  async function clearUpdateAvailable() {
    await runtime.storage.local.set({ deskUpdateAvailable: null, deskUpdateAppliedVersion: null });
    if (runtime.action?.setBadgeText) {
      const api = globalThis.AllDataRoLabels;
      if (api?.refreshUnlockBadge) await api.refreshUnlockBadge();
      else await runtime.action.setBadgeText({ text: "" });
    }
  }

  async function applyDeskUpdate() {
    const local = localVersion();
    const feed = await fetchSignedFeedUpdate();
    // Also refresh version.json soft-check so stale storage can't force a fake Update.
    const available = await checkForUpdate(true);
    const newestRemote =
      feed?.version && available?.version
        ? isNewer(feed.version, available.version)
          ? feed.version
          : available.version
        : feed?.version || available?.version || "";

    // Feed / storage may still advertise the version we already have — don't POST a fake fail.
    if (!newestRemote || !isNewer(newestRemote, local)) {
      await clearUpdateAvailable();
      return {
        ok: true,
        upToDate: true,
        mode: "up_to_date",
        version: local,
        applied: false,
        restartRequired: false,
        message: `Desk ${local} is up to date.`,
      };
    }

    // Prefer Firefox-native apply when the signed feed is newer than this install.
    if (feed?.version && isNewer(feed.version, local)) {
      const ffStatus = await requestFirefoxSignedUpdate();
      if (ffStatus === "update_available") {
        await runtime.storage.local.set({
          deskUpdateAppliedVersion: feed.version,
          deskUpdateAvailable: {
            version: feed.version,
            local,
            message: "Restart Firefox to finish the signed update.",
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
          version: feed.version,
          applied: true,
          restartRequired: true,
          message: `Firefox is applying signed Desk ${feed.version}. Restart when prompted.`,
        };
      }
    }

    const base = await labelsBaseUrl();
    let response;
    try {
      response = await fetch(`${base}/api/update-desk-extension`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ localVersion: local }),
      });
    } catch {
      // Labels down — stage signed feed / Firefox path (never bare "failed").
      if (feed?.version && isNewer(feed.version, local)) {
        const ffStatus = await requestFirefoxSignedUpdate();
        if (ffStatus === "update_available") {
          return {
            ok: true,
            mode: "firefox_update",
            version: feed.version,
            applied: true,
            restartRequired: true,
            message: `Firefox is applying signed Desk ${feed.version}. Restart when prompted.`,
          };
        }
      }
      return stageSignedFeedSuccess("(Labels wasn’t reachable.)");
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    const code = data?.error || `http_${response.status}`;
    const mode = data?.mode || "";

    if (data?.upToDate || mode === "up_to_date") {
      await clearUpdateAvailable();
      return {
        ok: true,
        upToDate: true,
        mode: "up_to_date",
        version: String(data?.version || local),
        applied: false,
        restartRequired: false,
        message: data?.message || `Desk ${local} is up to date.`,
      };
    }

    // Labels staged signed feed / Hub pack — success UX (not an error toast).
    if (mode === "signed_staged" || data?.staged === true) {
      const version = String(data?.version || feed?.version || "");
      if (!data?.signedXpiPath && !data?.hubUploadPath && version) {
        await downloadSignedXpi(version, feed?.updateLink);
      }
      await openAboutAddons();
      return {
        ok: true,
        error: null,
        mode: "signed_staged",
        version,
        signedXpiPath: data?.signedXpiPath || null,
        hubUploadPath: data?.hubUploadPath || null,
        staged: true,
        applied: false,
        restartRequired: false,
        message: data?.message || signedStagedMessage(version, data?.signedXpiPath || data?.hubUploadPath),
      };
    }

    // Legacy hub_upload / hub_signed_kept — still actionable, not a hard fail toast.
    if (mode === "hub_upload" || code === "hub_signed_kept" || code === "update_outcome_unclear") {
      const version = String(data?.version || feed?.version || "");
      if (!data?.hubUploadPath && version) {
        await downloadSignedXpi(version, feed?.updateLink);
      }
      await openAboutAddons();
      return {
        ok: true,
        error: null,
        mode: "signed_staged",
        version,
        hubUploadPath: data?.hubUploadPath || null,
        staged: true,
        applied: false,
        restartRequired: false,
        message: data?.message || signedStagedMessage(version, data?.hubUploadPath),
      };
    }

    if (!response.ok || !data?.ok) {
      if (response.status === 403 || code === "localhost_only") {
        return { ok: false, error: code, message: "Desk update refused — Labels only accepts updates from this machine." };
      }
      // Old Labels without the endpoint (404) or script failure — stage signed feed.
      if (response.status === 404 || code === "update_failed" || code.startsWith("http_")) {
        return stageSignedFeedSuccess(
          response.status === 404
            ? "(Labels has no update endpoint yet — pull label-connect / restart Labels.)"
            : "(Labels apply failed; staged signed feed instead.)",
        );
      }
      return stageSignedFeedSuccess(data?.message || "(Labels returned an error; staged signed feed.)");
    }

    // Only mark applied when Labels truly sideloaded (unsigned path).
    if (data.applied === false || data.mode === "hub_upload") {
      const version = String(data.version || feed?.version || "");
      await openAboutAddons();
      return {
        ok: true,
        error: null,
        mode: "signed_staged",
        version,
        staged: true,
        applied: false,
        restartRequired: false,
        message: data.message || signedStagedMessage(version, data.hubUploadPath),
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
      mode: data.mode || "unsigned_sideload",
      restartRequired: true,
      applied: true,
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

  void checkForUpdate(false);
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
})();
