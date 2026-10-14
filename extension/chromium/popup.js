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

  function paintUpdateState({ available, appliedVersion } = {}) {
    const version = available?.version;
    if (!version) {
      showApply(false);
      setUpdate("Desk extension is up to date.", "ok");
      return;
    }
    if (appliedVersion && String(appliedVersion) === String(version)) {
      showApply(false);
      setUpdate(`Update ${version} installed — Restart Firefox.`, "ok");
      return;
    }
    showApply(true);
    setUpdate(`Update ${version} ready`, "warn");
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
      const manifest = runtime.runtime.getManifest();
      versionEl.textContent = `Installed ${manifest.version}`;
      const stored = await runtime.storage.local.get([
        "shopPerson",
        "shopWidgetTokenExpiresAt",
        "shopWidgetTokenSource",
        "deskUpdateAvailable",
        "deskUpdateAppliedVersion",
      ]);
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
      if (stored.deskUpdateAvailable?.version) {
        paintUpdateState({
          available: stored.deskUpdateAvailable,
          appliedVersion: stored.deskUpdateAppliedVersion,
        });
      } else {
        showApply(false);
      }
    } catch {
      fillPersonSelect("logan");
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
      const stored = await runtime.storage.local.get(["deskUpdateAppliedVersion"]);
      if (available?.version) {
        paintUpdateState({
          available,
          appliedVersion: stored.deskUpdateAppliedVersion,
        });
      } else {
        paintUpdateState({});
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
        if (response?.ok) {
          const version = response.version || "";
          showApply(false);
          setUpdate(
            version ? `Updated to ${version}. Restart Firefox.` : "Updated. Restart Firefox.",
            "ok",
          );
        } else {
          setUpdate(response?.message || "Update failed.", "err");
          showApply(true);
        }
      } catch {
        setUpdate("Update failed — Labels may not be running.", "err");
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
