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
  const reloadBtn = document.getElementById("reloadDesk");
  const isChromium = typeof runtime.runtime.getBrowserInfo !== "function";
  if (isChromium && applyBtn) applyBtn.textContent = "Download update";
  const status = document.getElementById("status");
  const stateEl = document.getElementById("signInState");
  const updateEl = document.getElementById("update");
  const versionEl = document.getElementById("version");
  const loggedInEl = document.getElementById("loggedIn");
  const loginBoxEl = document.getElementById("loginBox");
  const dwightTokenEl = document.getElementById("dwightCreateRoToken");
  const dwightHintEl = document.getElementById("dwightKeyHint");

  const FALLBACK_PEOPLE = ["logan", "stephen", "steve", "carla", "john"];
  const DESK_RESTARTING = "Desk is restarting. Close this window and open it again.";
  const LISTENER_EVENTS = {
    create_ro: "Create RO",
    close_ro: "Close RO",
    cancel_ro: "Cancel RO",
    estimate_saved: "Estimate saved",
    estimate_emailed: "Estimate emailed",
  };

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

  function displayName(person) {
    const text = String(person || "").trim();
    if (!text) return "";
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  let wasLoggedIn = false;
  /** Bumped by every sign-in state read so a slow answer never overwrites a newer one. */
  let stateSerial = 0;

  function setState(text) {
    if (stateEl) stateEl.textContent = text;
  }

  /**
   * The line above the sign-in buttons: why Desk is logged out and the next step.
   * Tools not running, Tools locked, and Tools unlocked are three different answers.
   */
  async function refreshSignInState() {
    if (!stateEl || wasLoggedIn) return;
    const serial = ++stateSerial;
    let reply = null;
    try {
      reply = await runtime.runtime.sendMessage({ type: "desk-status" });
    } catch {
      reply = null;
    }
    if (serial !== stateSerial || wasLoggedIn) return;
    const tools = reply && reply.tools;
    if (!tools) {
      setState(`Logged out. ${DESK_RESTARTING}`);
    } else if (!tools.reachable) {
      setState("Logged out. Black Forest Tools is not running on this PC. Start Tools, or sign in below.");
    } else if (tools.hasSession) {
      const name = displayName(tools.person);
      setState(
        `Logged out. Tools is unlocked${name ? ` as ${name}` : ""}. Press Sync Tools → website to sign in here too.`,
      );
    } else {
      setState("Logged out. Unlock Tools or the shop site and Desk logs in by itself. Or sign in below.");
    }
  }

  function renderSession({ loggedIn, person } = {}) {
    if (!loggedInEl || !loginBoxEl) return;
    loggedInEl.hidden = !loggedIn;
    loginBoxEl.hidden = Boolean(loggedIn);
    status.hidden = Boolean(loggedIn);
    if (!loggedIn) {
      if (wasLoggedIn) {
        wasLoggedIn = false;
        setStatus("");
        if (pinEl) pinEl.value = "";
        void refreshSignInState();
      }
      return;
    }
    wasLoggedIn = true;
    setStatus("");
    const name = displayName(person);
    loggedInEl.textContent = name ? `Logged in as ${name}` : "Logged in";
  }

  async function refreshSession() {
    try {
      const stored = await runtime.storage.local.get([
        "shopWidgetToken",
        "shopWidgetTokenExpiresAt",
        "shopPerson",
        "deskSessionPerson",
      ]);
      const loggedIn = Boolean(
        stored.shopWidgetToken && Number(stored.shopWidgetTokenExpiresAt || 0) > Date.now(),
      );
      const person =
        typeof stored.deskSessionPerson === "string" ? stored.deskSessionPerson : stored.shopPerson;
      renderSession({ loggedIn, person });
      return loggedIn;
    } catch {
      renderSession({ loggedIn: false });
      return false;
    }
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

  /** One action at a time: the pressed button says what it is doing, the others wait. */
  async function busy(el, label, work) {
    const buttons = [button, siteBtn, toolsBtn].filter(Boolean);
    const idle = el.textContent;
    for (const b of buttons) b.disabled = true;
    el.textContent = label;
    try {
      return await work();
    } finally {
      el.textContent = idle;
      for (const b of buttons) b.disabled = false;
    }
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
      setUpdate(
        isChromium
          ? `Update ${version} downloaded — unzip over the Desk folder, then Reload Desk.`
          : `Update ${version} installed — Restart Firefox.`,
        "ok",
      );
      if (isChromium && reloadBtn) reloadBtn.hidden = false;
      return;
    }
    showApply(true);
    const hint =
      typeof available?.message === "string" && available.message.trim()
        ? available.message.trim()
        : "click Update";
    setUpdate(`Update ${version} ready — ${hint}`, "warn");
  }

  function looksLikeApiCode(text) {
    return typeof text === "string" && /^[a-z][a-z0-9_]{0,40}$/.test(text.trim());
  }

  function humanizeUnlockError(raw) {
    const fallback = "Couldn’t sign in. Unlock Tools or the shop site, or use your desk PIN.";
    if (!raw) return fallback;
    const text = String(raw).trim();
    const lower = text.toLowerCase();
    if (looksLikeApiCode(text)) {
      const map = {
        unauthorized: "That PIN didn’t work. Check the person and PIN, then try again.",
        unauthorised: "That PIN didn’t work. Check the person and PIN, then try again.",
        locked: "Too many tries. Wait a few minutes, then try again.",
        pin_change_required: "Set a new PIN on the shop site first, then sign in here.",
        bad_request: "Pick your name and enter your 4 to 12 digit desk PIN.",
        rate_limited: "Too many tries. Wait a minute, then try again.",
      };
      return map[lower] || fallback;
    }
    return text;
  }

  function fillPersonSelect(selected) {
    const people = deskPeople();
    personEl.replaceChildren();
    for (const id of people) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = displayName(id);
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
        await refreshSession();
        return true;
      }
      if (!quiet) setStatus(humanizeUnlockError(response?.error), "err");
      return false;
    } catch {
      if (!quiet) setStatus(DESK_RESTARTING, "err");
      return false;
    }
  }

  function timeOfDay(at) {
    const when = new Date(at);
    const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const sameDay = when.toDateString() === new Date().toDateString();
    return sameDay ? time : `${when.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
  }

  /** Under the key: is one saved, and did the last RO event reach the listener. Never the key. */
  async function paintListenerState() {
    if (!dwightHintEl) return;
    let stored = {};
    try {
      stored = await runtime.storage.local.get(["dwightCreateRoToken", "deskListenerLast"]);
    } catch {
      stored = {};
    }
    const hasKey = typeof stored.dwightCreateRoToken === "string" && stored.dwightCreateRoToken.trim();
    const last = stored.deskListenerLast;
    dwightHintEl.className = "meta";
    if (!hasKey) {
      dwightHintEl.textContent =
        "No key yet, so RO events are not sent. Paste the key once. It stays on this browser and survives updates.";
      return;
    }
    if (!last || !last.at) {
      dwightHintEl.textContent = "Key saved on this browser. RO events are sent as they happen.";
      return;
    }
    const what = LISTENER_EVENTS[last.event] || "RO event";
    if (last.ok) {
      dwightHintEl.textContent = `Key saved. Last sent: ${what}, ${timeOfDay(last.at)}.`;
      return;
    }
    dwightHintEl.className = "meta err";
    dwightHintEl.textContent =
      last.status === 401 || last.status === 403
        ? "The listener did not accept this key. Paste the key again."
        : `${what} at ${timeOfDay(last.at)} did not reach the listener. Labels still print. Desk sends the next event as usual.`;
  }

  async function restore() {
    try {
      const manifest = runtime.runtime.getManifest();
      versionEl.textContent = `Installed ${manifest.version}`;
      const stored = await runtime.storage.local.get([
        "shopPerson",
        "shopWidgetTokenExpiresAt",
        "deskUpdateAvailable",
        "deskUpdateAppliedVersion",
        "dwightCreateRoToken",
      ]);
      if (dwightTokenEl && typeof stored.dwightCreateRoToken === "string") {
        dwightTokenEl.value = stored.dwightCreateRoToken;
      }
      void paintListenerState();
      fillPersonSelect(stored.shopPerson);
      if (stored.deskUpdateAvailable?.version) {
        paintUpdateState({
          available: stored.deskUpdateAvailable,
          appliedVersion: stored.deskUpdateAppliedVersion,
        });
      } else {
        showApply(false);
      }
      if (!(stored.shopWidgetTokenExpiresAt && Number(stored.shopWidgetTokenExpiresAt) > Date.now())) {
        const fromSite = await tryImport("site-session-import", { quiet: true });
        const fromTools = fromSite || (await tryImport("tools-session-import", { quiet: true }));
        if (!fromTools) await refreshSignInState();
      }
    } catch {
      fillPersonSelect("logan");
      void refreshSignInState();
    }
  }

  async function signInWithPin() {
    const person = normalizePerson(personEl.value);
    const pin = pinEl.value;
    if (person && personEl.value !== person) personEl.value = person;
    if (!person || !/^[a-z][a-z0-9-]{0,31}$/.test(person)) {
      setStatus("Pick your name from the list.", "err");
      return;
    }
    if (!pin) {
      setStatus("Enter your desk PIN.", "err");
      pinEl.focus?.();
      return;
    }
    if (!/^\d{4,12}$/.test(pin)) {
      setStatus("A desk PIN is 4 to 12 digits.", "err");
      pinEl.focus?.();
      return;
    }
    setStatus("");
    await busy(button, "Signing in…", async () => {
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
        await refreshSession();
      } catch {
        pinEl.value = "";
        setStatus(DESK_RESTARTING, "err");
      }
    });
    if (!wasLoggedIn) pinEl.focus?.();
  }

  button.addEventListener("click", () => {
    void signInWithPin();
  });
  pinEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || button.disabled) return;
    event.preventDefault?.();
    void signInWithPin();
  });

  if (siteBtn) {
    siteBtn.addEventListener("click", async () => {
      setStatus("");
      // from-gate → Desk storage + POST :8788 (website unlock → Tools unlock).
      await busy(siteBtn, "Syncing…", () => tryImport("site-session-import", { quiet: false }));
      void refreshSignInState();
    });
  }

  if (toolsBtn) {
    toolsBtn.addEventListener("click", async () => {
      setStatus("");
      await busy(toolsBtn, "Syncing…", async () => {
        try {
          // Must exchange Bearer → bf_shop_gate (not only import lot-name token).
          const response = await runtime.runtime.sendMessage({
            type: "tools-to-site-unlock",
            forceExchange: true,
          });
          if (response?.ok && response.siteGate) {
            if (response.person) fillPersonSelect(response.person);
            const loggedIn = await refreshSession();
            if (!loggedIn) {
              setStatus(
                response.shouldReload
                  ? "The shop site is signed in from Tools. Reload the shop tab if it still asks for a PIN."
                  : "The shop site already matches Tools.",
                "ok",
              );
            }
            return;
          }
          if (response?.locked || /^tools_(already_)?locked$/.test(String(response?.reason || ""))) {
            setStatus(response.error || "Tools is locked. Unlock Tools first.", "err");
            return;
          }
          if (response?.ok) {
            setStatus("Desk is finishing the last sign-in. Try again in a moment.");
            return;
          }
          setStatus(humanizeUnlockError(response?.error), "err");
        } catch {
          setStatus(DESK_RESTARTING, "err");
        }
      });
      void refreshSignInState();
    });
  }

  async function saveDwightToken() {
    if (!dwightTokenEl) return;
    const value = dwightTokenEl.value.trim();
    try {
      // A result recorded for the old key says nothing about the new one.
      await runtime.storage.local.set({ dwightCreateRoToken: value, deskListenerLast: null });
      await paintListenerState();
    } catch {
      if (dwightHintEl) {
        dwightHintEl.className = "meta err";
        dwightHintEl.textContent = "Couldn’t save the key on this browser. Paste it again.";
      }
    }
  }

  if (dwightTokenEl) {
    dwightTokenEl.addEventListener("input", () => {
      void saveDwightToken();
    });
    dwightTokenEl.addEventListener("change", () => {
      void saveDwightToken();
    });
  }

  checkBtn.addEventListener("click", async () => {
    checkBtn.disabled = true;
    setUpdate("Checking…");
    showApply(false);
    try {
      const response = await runtime.runtime.sendMessage({ type: "check-update", force: true });
      const available = response?.available;
      const stored = await runtime.storage.local.get(["deskUpdateAppliedVersion", "deskUpdateAvailable"]);
      if (available?.version) {
        paintUpdateState({
          available,
          appliedVersion: stored.deskUpdateAppliedVersion,
        });
      } else if (!response || response.state === "unreachable") {
        // Not knowing is not the same as being up to date.
        showApply(Boolean(stored.deskUpdateAvailable?.version));
        setUpdate("Couldn’t check for updates. Check the internet connection and try again.", "err");
      } else if (response.state === "publishing") {
        showApply(false);
        setUpdate(`Desk ${response.version} is being published. Check again in a few minutes.`, "warn");
      } else {
        paintUpdateState({});
      }
    } catch {
      setUpdate("Couldn’t check for updates. Check the internet connection and try again.", "err");
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
        if (response?.mode === "firefox_update" && response?.ok) {
          showApply(false);
          setUpdate(response.message || "Firefox is applying the signed update (reload)…", "ok");
        } else if (response?.mode === "up_to_date" && response?.ok) {
          showApply(false);
          setUpdate(response.message || "Desk is already the newest version.", "ok");
        } else if (response?.mode === "firefox_xpi_prompt" && response?.ok) {
          showApply(true);
          setUpdate(response.message || "Firefox is asking to install the update — click Allow, then Add.", "warn");
        } else if (response?.mode === "chromium_zip" && response?.ok) {
          showApply(true);
          if (reloadBtn) reloadBtn.hidden = false;
          await runtime.storage.local.set({ deskUpdateAppliedVersion: response.version });
          setUpdate(response.message || "Downloaded. Unzip over the Desk folder, then Reload Desk.", "ok");
        } else if (response?.mode === "chromium_manual") {
          showApply(true);
          if (reloadBtn) reloadBtn.hidden = false;
          setUpdate(response.message || "Download the Desk zip from the release, unzip, then Reload Desk.", "warn");
        } else if (response?.ok && response?.applied) {
          showApply(false);
          setUpdate(response.message || "Updated.", "ok");
        } else {
          setUpdate(response?.message || (isChromium ? "Update failed. Try again." : "Update failed. Try about:addons → ⚙ → Check for Updates."), "err");
          showApply(true);
        }
      } catch {
        setUpdate(isChromium ? "Update failed. Try again." : "Update failed. Try about:addons → ⚙ → Check for Updates.", "err");
        showApply(true);
      } finally {
        applyBtn.disabled = false;
        checkBtn.disabled = false;
      }
    });
  }

  if (reloadBtn) {
    reloadBtn.addEventListener("click", async () => {
      reloadBtn.disabled = true;
      setUpdate("Reloading Desk…", "warn");
      try {
        await runtime.runtime.sendMessage({ type: "reload-extension" });
      } catch {
        // worker restarts mid-message
      }
      setTimeout(() => window.close(), 400);
    });
  }

  if (runtime.storage?.onChanged?.addListener) {
    runtime.storage.onChanged.addListener((changes, area) => {
      if (area && area !== "local") return;
      if (
        changes.shopWidgetToken ||
        changes.shopWidgetTokenExpiresAt ||
        changes.deskSessionPerson ||
        changes.shopPerson
      ) {
        void refreshSession();
      }
      if (changes.deskListenerLast) void paintListenerState();
    });
  }

  fillPersonSelect("logan");
  void refreshSession();
  restore().then(refreshSession);
})();
