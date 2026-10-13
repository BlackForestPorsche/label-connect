/* global chrome, browser, AllDataRoLabels */
(function () {
  const runtime = typeof browser !== "undefined" ? browser : chrome;
  const personEl = document.getElementById("person");
  const pinEl = document.getElementById("pin");
  const button = document.getElementById("unlock");
  const checkBtn = document.getElementById("checkUpdate");
  const status = document.getElementById("status");
  const updateEl = document.getElementById("update");
  const versionEl = document.getElementById("version");

  /** Fallback if lot-names.js did not load (should not happen in packaged builds). */
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

  function looksLikeApiCode(text) {
    return typeof text === "string" && /^[a-z][a-z0-9_]{0,40}$/.test(text.trim());
  }

  function humanizeUnlockError(raw) {
    if (!raw) return "Unlock failed. Enter your desk PIN and try again.";
    const text = String(raw).trim();
    const lower = text.toLowerCase();
    // Never surface raw API codes like "unauthorized".
    if (lower === "unauthorized" || lower === "unauthorised") {
      return "Desk PIN rejected (or person not found). Use the desk/shop widget PIN for the selected person \u2014 not another password.";
    }
    if (looksLikeApiCode(text)) {
      const map = {
        unauthorized:
          "Desk PIN rejected (or person not found). Use the desk/shop widget PIN for the selected person \u2014 not another password.",
        locked: "Too many PIN tries \u2014 wait, then unlock again.",
        pin_change_required: "Set a PIN on the shop site first, then unlock here.",
        bad_request: "Pick a shop person from the list and enter a 4\u201312 digit desk PIN.",
        rate_limited: "Too many tries. Wait a minute, then enter your desk PIN again.",
      };
      return map[lower] || `Unlock failed (${text}). Enter your desk PIN and try again.`;
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
      // Desk default when nothing stored yet.
      personEl.value = "logan";
    } else if (people.length) {
      personEl.selectedIndex = 0;
    }
  }

  async function restore() {
    try {
      const manifest = runtime.runtime.getManifest();
      versionEl.textContent = `Installed ${manifest.version} \u00b7 updates via git / update-desk-extension.sh`;
      const stored = await runtime.storage.local.get([
        "shopPerson",
        "shopWidgetTokenExpiresAt",
        "deskUpdateAvailable",
      ]);
      fillPersonSelect(stored.shopPerson);
      if (stored.shopWidgetTokenExpiresAt && Number(stored.shopWidgetTokenExpiresAt) > Date.now()) {
        setStatus("Lot names unlocked with desk PIN.", "ok");
      } else {
        setStatus("Select person, enter desk PIN to unlock On the Lot names for SSF.");
      }
      if (stored.deskUpdateAvailable?.version) {
        setUpdate(
          `Update ${stored.deskUpdateAvailable.version} ready \u2014 run bash scripts/update-desk-extension.sh on the desk.`,
          "warn",
        );
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
      setStatus("Select a person and enter your desk PIN.", "err");
      return;
    }
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(person)) {
      setStatus("Pick a shop person from the list.", "err");
      return;
    }
    if (!/^\d{4,12}$/.test(pin)) {
      setStatus("Desk PIN must be 4\u201312 digits (shop / Plasma widget PIN).", "err");
      return;
    }
    button.disabled = true;
    setStatus(`Signing in as \u201c${person}\u201d with desk PIN\u2026`);
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
      setStatus(`Lot names unlocked as \u201c${person}\u201d. Open SSF checkout and Refresh if needed.`, "ok");
    } catch {
      setStatus("Extension background unavailable. Reload the temporary add-on, then enter your desk PIN.", "err");
    } finally {
      button.disabled = false;
    }
  });

  checkBtn.addEventListener("click", async () => {
    checkBtn.disabled = true;
    setUpdate("Checking\u2026");
    try {
      const response = await runtime.runtime.sendMessage({ type: "check-update", force: true });
      const available = response?.available;
      if (available?.version) {
        setUpdate(
          `Update ${available.version} ready \u2014 on the desk run: bash ~/label-connect/scripts/update-desk-extension.sh`,
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

  fillPersonSelect("logan");
  restore();
})();
