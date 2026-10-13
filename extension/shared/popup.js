/* global chrome, browser */
(function () {
  const runtime = typeof browser !== "undefined" ? browser : chrome;
  const personEl = document.getElementById("person");
  const pinEl = document.getElementById("pin");
  const button = document.getElementById("unlock");
  const siteBtn = document.getElementById("useShopSession");
  const toolsBtn = document.getElementById("useTools");
  const checkBtn = document.getElementById("checkUpdate");
  const status = document.getElementById("status");
  const updateEl = document.getElementById("update");
  const versionEl = document.getElementById("version");

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = kind === "ok" ? "ok" : kind === "err" ? "err" : "";
  }

  function setUpdate(text, kind) {
    updateEl.textContent = text;
    updateEl.className = kind === "ok" ? "ok" : kind === "warn" ? "warn" : kind === "err" ? "err" : "";
  }

  function normalizePerson(person) {
    return String(person || "")
      .trim()
      .toLowerCase();
  }

  function setPersonValue(person) {
    if (!personEl || !person) return;
    const value = normalizePerson(person);
    if (personEl.tagName === "SELECT") {
      const opt = Array.from(personEl.options || []).find((o) => o.value === value);
      if (opt) personEl.value = value;
    } else {
      personEl.value = value;
    }
  }

  function looksLikeApiCode(text) {
    return typeof text === "string" && /^[a-z][a-z0-9_]{0,40}$/.test(text.trim());
  }

  function humanizeUnlockError(raw) {
    if (!raw) return "Unlock failed. Use shop session, Tools, or desk PIN.";
    const text = String(raw).trim();
    const lower = text.toLowerCase();
    if (lower === "unauthorized" || lower === "unauthorised") {
      return "Wrong person or desk PIN. Or unlock the shop site in this Firefox profile and click Use shop session.";
    }
    if (looksLikeApiCode(text)) {
      const map = {
        unauthorized: "Wrong person or desk PIN. Try Use shop session if the site is unlocked.",
        locked: "Too many PIN tries — wait, then unlock again.",
        pin_change_required: "Set a PIN on the shop site first, then unlock here.",
        bad_request: "Enter a valid shop person (lowercase) and a 4–12 digit desk PIN.",
        rate_limited: "Too many tries. Wait a minute, then try again.",
        from_gate_missing: text,
      };
      return map[lower] || `Unlock failed (${text}).`;
    }
    return text;
  }

  async function tryImport(type, { quiet } = {}) {
    try {
      const response = await runtime.runtime.sendMessage({ type });
      if (response?.ok) {
        if (response.person) setPersonValue(response.person);
        const label =
          response.source === "tools-bridge"
            ? "Lot names unlocked from Black Forest Tools."
            : response.source === "site-gate" || type === "site-session-import"
              ? "Lot names unlocked from the shop site session."
              : "Lot names unlocked.";
        setStatus(label, "ok");
        return true;
      }
      if (!quiet) setStatus(humanizeUnlockError(response?.error), "err");
      return false;
    } catch {
      if (!quiet) setStatus("Extension background unavailable. Reload the temporary add-on.", "err");
      return false;
    }
  }

  async function restore() {
    try {
      const manifest = runtime.runtime.getManifest();
      versionEl.textContent = `Installed ${manifest.version} · updates via git / update-desk-extension.sh`;
      const stored = await runtime.storage.local.get([
        "shopPerson",
        "shopWidgetTokenExpiresAt",
        "shopWidgetTokenSource",
        "deskUpdateAvailable",
      ]);
      if (stored.shopPerson) setPersonValue(stored.shopPerson);
      if (stored.shopWidgetTokenExpiresAt && Number(stored.shopWidgetTokenExpiresAt) > Date.now()) {
        const src = stored.shopWidgetTokenSource;
        setStatus(
          src === "site-gate"
            ? "Lot names unlocked from the shop site session."
            : src === "tools-bridge"
              ? "Lot names unlocked from Black Forest Tools."
              : "Lot names unlocked.",
          "ok",
        );
      } else {
        // Site first (reported gap), then Tools — no PIN retype when already signed in.
        const fromSite = await tryImport("site-session-import", { quiet: true });
        if (!fromSite) await tryImport("tools-session-import", { quiet: true });
      }
      if (stored.deskUpdateAvailable?.version) {
        setUpdate(
          `Update ${stored.deskUpdateAvailable.version} ready — run bash scripts/update-desk-extension.sh on the desk.`,
          "warn",
        );
      }
    } catch {
      // ignore
    }
  }

  button.addEventListener("click", async () => {
    const person = normalizePerson(personEl.value);
    const pin = pinEl.value;
    if (!person || !pin) {
      setStatus("Person and PIN required (or Use shop session).", "err");
      return;
    }
    setPersonValue(person);
    button.disabled = true;
    setStatus("Signing in…");
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
      setStatus("Lot names unlocked.", "ok");
    } catch {
      setStatus("Extension background unavailable. Reload the temporary add-on.", "err");
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
    try {
      const response = await runtime.runtime.sendMessage({ type: "check-update", force: true });
      const available = response?.available;
      if (available?.version) {
        setUpdate(
          `Update ${available.version} ready — on the desk run: bash ~/label-connect/scripts/update-desk-extension.sh`,
          "warn",
        );
      } else {
        setUpdate("Desk extension is up to date.", "ok");
      }
    } catch {
      setUpdate("Update check failed.", "err");
    } finally {
      checkBtn.disabled = false;
    }
  });

  restore();
})();
