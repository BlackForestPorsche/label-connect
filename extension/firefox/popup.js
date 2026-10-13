/* global chrome, browser */
(function () {
  const runtime = typeof browser !== "undefined" ? browser : chrome;
  const personEl = document.getElementById("person");
  const pinEl = document.getElementById("pin");
  const button = document.getElementById("unlock");
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

  function looksLikeApiCode(text) {
    return typeof text === "string" && /^[a-z][a-z0-9_]{0,40}$/.test(text.trim());
  }

  function humanizeUnlockError(raw) {
    if (!raw) return "Unlock failed. Enter your desk PIN and try again.";
    const text = String(raw).trim();
    const lower = text.toLowerCase();
    if (lower === "unauthorized" || lower === "unauthorised") {
      return "Wrong person or desk PIN. Use the same shop unlock name (lowercase), then enter your desk PIN.";
    }
    if (looksLikeApiCode(text)) {
      const map = {
        unauthorized: "Wrong person or desk PIN. Enter your desk PIN and try again.",
        locked: "Too many PIN tries — wait, then unlock again.",
        pin_change_required: "Set a PIN on the shop site first, then unlock here.",
        bad_request: "Enter a valid shop person (lowercase) and a 4–12 digit desk PIN.",
        rate_limited: "Too many tries. Wait a minute, then enter your desk PIN again.",
      };
      return map[lower] || `Unlock failed (${text}). Enter your desk PIN and try again.`;
    }
    return text;
  }

  async function restore() {
    try {
      const manifest = runtime.runtime.getManifest();
      versionEl.textContent = `Installed ${manifest.version} · updates via git / update-desk-extension.sh`;
      const stored = await runtime.storage.local.get([
        "shopPerson",
        "shopWidgetTokenExpiresAt",
        "deskUpdateAvailable",
      ]);
      if (stored.shopPerson) personEl.value = stored.shopPerson;
      if (stored.shopWidgetTokenExpiresAt && Number(stored.shopWidgetTokenExpiresAt) > Date.now()) {
        setStatus("Lot names unlocked with desk PIN.", "ok");
      } else {
        setStatus("Enter your desk PIN to unlock On the Lot names for SSF.");
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
    const person = personEl.value.trim().toLowerCase();
    const pin = pinEl.value;
    personEl.value = person;
    if (!person || !pin) {
      setStatus("Person and desk PIN required.", "err");
      return;
    }
    button.disabled = true;
    setStatus("Signing in with desk PIN…");
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
      setStatus("Lot names unlocked. Open SSF checkout and Refresh if needed.", "ok");
    } catch {
      setStatus("Extension background unavailable. Reload the temporary add-on, then enter your desk PIN.", "err");
    } finally {
      button.disabled = false;
    }
  });

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
