/* global chrome, browser */
(function () {
  const runtime = typeof browser !== "undefined" ? browser : chrome;
  const personEl = document.getElementById("person");
  const pinEl = document.getElementById("pin");
  const button = document.getElementById("unlock");
  const status = document.getElementById("status");

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = kind === "ok" ? "ok" : kind === "err" ? "err" : "";
  }

  async function restore() {
    try {
      const stored = await runtime.storage.local.get(["shopPerson", "shopWidgetTokenExpiresAt"]);
      if (stored.shopPerson) personEl.value = stored.shopPerson;
      if (stored.shopWidgetTokenExpiresAt && Number(stored.shopWidgetTokenExpiresAt) > Date.now()) {
        setStatus("Lot names unlocked.", "ok");
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

  restore();
})();
