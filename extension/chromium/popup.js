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
        setStatus("Lot names unlocked.", "ok");
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
    const person = personEl.value.trim();
    const pin = pinEl.value;
    if (!person || !pin) {
      setStatus("Person and PIN required.", "err");
      return;
    }
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
        setStatus(response?.error || "Unlock failed.", "err");
        return;
      }
      setStatus("Lot names unlocked.", "ok");
    } catch {
      setStatus("Extension background unavailable.", "err");
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
