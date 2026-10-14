/* global chrome, browser, AllDataRoLabels */
(function () {
  const runtime = typeof browser !== "undefined" ? browser : chrome;
  const personEl = document.getElementById("person");
  const pinEl = document.getElementById("pin");
  const button = document.getElementById("unlock");
  const siteBtn = document.getElementById("useShopSession");
  const toolsBtn = document.getElementById("useTools");
  const checkBtn = document.getElementById("checkUpdate");
  const applyBtn = document.getElementById("applyUpdate");
  const status = document.getElementById("status");
  const updateEl = document.getElementById("update");
  const versionEl = document.getElementById("version");

  const FALLBACK_PEOPLE = ["logan", "stephen", "steve", "carla", "john"];

  function deskPeople() {
    const fromApi = globalThis.AllDataRoLabels?.DESK_PEOPLE;
    if (Array.isArray(fromApi) && fromApi.length) {
      return fromApi.map((p) => String(p).trim().toLowerCase()).filter(Boolean);
    }
    return FALLBACK_PEOPLE.slice();
  }

  function normalizePerson(person) {
    if (typeof globalThis.AllDataRoLabels?.normalizePerson === "function") {
      return globalThis.AllDataRoLabels.normalizePerson(person);
    }
    return String(person || "")
      .trim()
      .toLowerCase();
  }

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = kind === "ok" ? "ok" : kind === "err" ? "err" : "";
  }

  function setUpdate(text, kind) {
    updateEl.textContent = text;
    updateEl.className = kind === "ok" ? "ok" : kind === "warn" ? "warn" : kind === "err" ? "err" : "";
  }

  function showApply(show) {
    if (!applyBtn) return;
    applyBtn.hidden = !show;
  }

  function parseVersionParts(v) {
    return String(v || "0")
      .split(/[.+-]/)
      .map((part) => Number.parseInt(part, 10) || 0);
  }

  function isNewerVersion(remote, local) {
    const a = parseVersionParts(remote);
    const b = parseVersionParts(local);
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i += 1) {
      const x = a[i] || 0;
      const y = b[i] || 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  }

  function installedVersion() {
    try {
      return String(runtime.runtime.getManifest()?.version || "0");
    } catch {
      return "0";
    }
  }

  function paintVersionLine({ staged } = {}) {
    const installed = installedVersion();
    if (staged?.version && isNewerVersion(staged.version, installed)) {
      versionEl.textContent = `Installed ${installed} · Staged ${staged.version} (NOT applied)`;
      return;
    }
    versionEl.textContent = `Installed ${installed}`;
  }

  function paintUpdateState({ available, appliedVersion, staged } = {}) {
    const installed = installedVersion();
    paintVersionLine({ staged });
    const version = available?.version;
    if (!version || !isNewerVersion(version, installed)) {
      showApply(false);
      setUpdate("Desk extension is up to date.", "ok");
      if (version && !isNewerVersion(version, installed)) {
        void runtime.storage.local.set({
          deskUpdateAvailable: null,
          deskUpdateAppliedVersion: null,
          deskUpdateStaged: null,
        });
      }
      return;
    }
    if (appliedVersion && String(appliedVersion) === String(version)) {
      showApply(false);
      setUpdate(`Update ${version} downloading/applying — restart Firefox if Desk does not reload.`, "ok");
      return;
    }
    showApply(true);
    if (available?.staged || staged?.version) {
      const path = staged?.path || available?.path || `Black.Forest.Desk-${version}.xpi`;
      setUpdate(
        `Still Installed ${installed} — ${version} is staged, NOT installed. about:addons → gear → Install Add-on From File… → ${path}`,
        "warn",
      );
      return;
    }
    const hint =
      typeof available?.message === "string" && available.message.trim()
        ? available.message.trim()
        : "Update applies via Firefox signed feed, or Install from File";
    setUpdate(`Update ${version} available (still Installed ${installed}) — ${hint}`, "warn");
  }

  function looksLikeApiCode(text) {
    return typeof text === "string" && /^[a-z][a-z0-9_]{0,40}$/.test(text.trim());
  }

  function humanizeUnlockError(raw) {
    if (!raw) return "Unlock failed. Sync shop session, Sync Tools, or desk PIN.";
    const text = String(raw).trim();
    const lower = text.toLowerCase();
    if (lower === "unauthorized" || lower === "unauthorised") {
      return "Desk PIN rejected (or person not found). Or unlock the shop site and Sync shop session.";
    }
    if (looksLikeApiCode(text)) {
      const map = {
        unauthorized:
          "Desk PIN rejected (or person not found). Or unlock the shop site and Sync shop session.",
        locked: "Too many PIN tries — wait, then unlock again.",
        pin_change_required: "Set a PIN on the shop site first, then unlock here.",
        bad_request: "Pick a shop person from the list and enter a 4–12 digit desk PIN.",
        rate_limited: "Too many tries. Wait a minute, then try again.",
      };
      return map[lower] || `Unlock failed (${text}).`;
    }
    return text;
  }

  function fillPersonSelect(selected) {
    const people = deskPeople();
    personEl.replaceChildren();
    for (const id of people) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = id;
      personEl.appendChild(opt);
    }
    const want = normalizePerson(selected);
    if (want && people.includes(want)) {
      personEl.value = want;
    } else if (people.length === 1) {
      personEl.value = people[0];
    } else if (people.includes("logan")) {
      personEl.value = "logan";
    } else if (people.length) {
      personEl.selectedIndex = 0;
    }
  }

  async function tryImport(type, { quiet } = {}) {
    try {
      const response = await runtime.runtime.sendMessage({ type });
      if (response?.ok) {
        if (response.person) fillPersonSelect(response.person);
        const label =
          response.source === "tools-bridge" || type === "tools-session-import"
            ? "Lot names unlocked from Black Forest Tools."
            : "Lot names unlocked from the shop site session.";
        setStatus(label, "ok");
        return true;
      }
      if (!quiet) setStatus(humanizeUnlockError(response?.error), "err");
      return false;
    } catch {
      if (!quiet) setStatus("Extension background unavailable. Reload the add-on.", "err");
      return false;
    }
  }

  async function restore() {
    try {
      const stored = await runtime.storage.local.get([
        "shopPerson",
        "shopWidgetTokenExpiresAt",
        "shopWidgetTokenSource",
        "deskUpdateAvailable",
        "deskUpdateAppliedVersion",
        "deskUpdateStaged",
      ]);
      paintVersionLine({ staged: stored.deskUpdateStaged });
      fillPersonSelect(stored.shopPerson);
      if (stored.shopWidgetTokenExpiresAt && Number(stored.shopWidgetTokenExpiresAt) > Date.now()) {
        const src = stored.shopWidgetTokenSource;
        setStatus(
          src === "site-gate"
            ? "Lot names unlocked from the shop site session."
            : src === "tools-bridge"
              ? "Lot names unlocked from Black Forest Tools."
              : "Lot names unlocked with desk PIN.",
          "ok",
        );
      } else {
        const fromSite = await tryImport("site-session-import", { quiet: true });
        if (!fromSite) {
          const fromTools = await tryImport("tools-session-import", { quiet: true });
          if (!fromTools) {
            setStatus("Waiting for background unlock — or Sync shop / Tools, or person + PIN.");
          }
        }
      }
      if (stored.deskUpdateAvailable?.version || stored.deskUpdateStaged?.version) {
        paintUpdateState({
          available: stored.deskUpdateAvailable,
          appliedVersion: stored.deskUpdateAppliedVersion,
          staged: stored.deskUpdateStaged,
        });
      } else {
        showApply(false);
      }
    } catch {
      fillPersonSelect("logan");
      paintVersionLine({});
    }
  }

  button.addEventListener("click", async () => {
    const person = normalizePerson(personEl.value);
    const pin = pinEl.value;
    if (person && personEl.value !== person) personEl.value = person;
    if (!person || !pin) {
      setStatus("Select a person and enter your desk PIN (or Sync shop session).", "err");
      return;
    }
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(person)) {
      setStatus("Pick a shop person from the list.", "err");
      return;
    }
    if (!/^\d{4,12}$/.test(pin)) {
      setStatus("Desk PIN must be 4–12 digits (shop / Plasma widget PIN).", "err");
      return;
    }
    button.disabled = true;
    setStatus(`Signing in as “${person}” with desk PIN…`);
    try {
      await runtime.storage.local.set({ shopPerson: person });
      const response = await runtime.runtime.sendMessage({
        type: "widget-session",
        payload: { person, pin },
      });
      pinEl.value = "";
      if (!response || response.error) {
        setStatus(humanizeUnlockError(response?.error), "err");
        return;
      }
      setStatus(`Lot names unlocked as “${person}”. Open SSF checkout and Refresh if needed.`, "ok");
    } catch {
      setStatus("Extension background unavailable. Reload the add-on, then enter your desk PIN.", "err");
    } finally {
      button.disabled = false;
    }
  });

  if (siteBtn) {
    siteBtn.addEventListener("click", async () => {
      siteBtn.disabled = true;
      setStatus("Using shop site session…");
      try {
        await tryImport("site-session-import", { quiet: false });
      } finally {
        siteBtn.disabled = false;
      }
    });
  }

  if (toolsBtn) {
    toolsBtn.addEventListener("click", async () => {
      toolsBtn.disabled = true;
      setStatus("Asking Black Forest Tools…");
      try {
        await tryImport("tools-session-import", { quiet: false });
      } finally {
        toolsBtn.disabled = false;
      }
    });
  }

  checkBtn.addEventListener("click", async () => {
    checkBtn.disabled = true;
    setUpdate("Checking…");
    showApply(false);
    try {
      const response = await runtime.runtime.sendMessage({ type: "check-update", force: true });
      const available = response?.available;
      const stored = await runtime.storage.local.get(["deskUpdateAppliedVersion", "deskUpdateStaged"]);
      if (available?.version) {
        paintUpdateState({
          available,
          appliedVersion: stored.deskUpdateAppliedVersion,
          staged: stored.deskUpdateStaged,
        });
      } else {
        paintUpdateState({ staged: stored.deskUpdateStaged });
      }
    } catch {
      setUpdate("Update check failed.", "err");
      showApply(false);
    } finally {
      checkBtn.disabled = false;
    }
  });

  if (applyBtn) {
    applyBtn.addEventListener("click", async () => {
      applyBtn.disabled = true;
      checkBtn.disabled = true;
      setUpdate("Updating…", "warn");
      try {
        const response = await runtime.runtime.sendMessage({ type: "apply-update" });
        const staged = {
          version: response?.version,
          path: response?.signedXpiPath || response?.hubUploadPath,
        };
        if (response?.mode === "firefox_update" && response?.ok) {
          showApply(false);
          paintVersionLine({});
          setUpdate(
            response.message || "Firefox is applying the signed update. Desk will reload.",
            "ok",
          );
        } else if (
          response?.mode === "signed_staged" ||
          response?.staged === true ||
          response?.mode === "hub_upload" ||
          response?.error === "hub_signed_kept"
        ) {
          // Staged ≠ installed — warn (never green “done”).
          paintVersionLine({ staged });
          setUpdate(
            response?.message ||
              `Still Installed ${installedVersion()} — staged update NOT applied. about:addons → Install Add-on From File.`,
            "warn",
          );
          showApply(true);
        } else if (response?.ok && response?.applied !== false) {
          const version = response.version || "";
          showApply(false);
          paintVersionLine({});
          setUpdate(
            version ? `Updated to ${version}. Restart Firefox.` : "Updated. Restart Firefox.",
            "ok",
          );
        } else {
          setUpdate(response?.message || "Update failed.", "err");
          showApply(true);
        }
      } catch {
        setUpdate(
          "Could not reach Labels — try about:addons → Check for Updates, or Install Add-on From File (signed desk-extension XPI).",
          "warn",
        );
        showApply(true);
      } finally {
        applyBtn.disabled = false;
        checkBtn.disabled = false;
      }
    });
  }

  fillPersonSelect("logan");
  restore();
})();
