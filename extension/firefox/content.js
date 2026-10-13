/* global globalThis, chrome, browser */
/**
 * Content script: arm only on Create R/O activation, wait for success, scrape, ask background to print.
 * Never arms Update R/O, Schedule New R/O, or Assign R/O.
 */
(function () {
  const api = globalThis.AllDataRoLabels;
  if (!api) return;

  const runtime = typeof browser !== "undefined" ? browser : chrome;
  let armed = null;
  let printing = false;

  function closestControl(target) {
    if (!(target instanceof Element)) return null;
    return target.closest("button, a, [role='button'], input[type='button'], input[type='submit']");
  }

  function armCreate(control) {
    if (printing) return;
    if (api.isForbiddenControl(control)) return;
    if (!api.isCreateControl(control)) return;
    armed = {
      at: Date.now(),
      // Snapshot before create mutates the Work screen.
      pre: api.scrapePayload(),
    };
  }

  async function tryPrintAfterSuccess() {
    if (!armed || printing) return;
    if (Date.now() - armed.at > api.SUCCESS_WAIT_MS) {
      armed = null;
      return;
    }

    // Success gate: Create control gone / Update appeared, or RO number newly visible.
    const createGone = !api.createButtonPresent();
    const updateHere = api.updateButtonPresent();
    const payload = api.scrapePayload();
    const roNow = payload.roNumber;
    const roNew = Boolean(roNow && roNow !== (armed.pre.roNumber || ""));

    if (!(createGone || updateHere || roNew)) return;

    const lastName = payload.lastName || armed.pre.lastName;
    const model = payload.model || armed.pre.model;
    if (!lastName || !model) {
      api.showToast("Label skipped — need last name and model.", "skip");
      armed = null;
      return;
    }

    printing = true;
    const body = {
      event: "create-ro",
      source: "alldata-extension",
      lastName,
      model,
      roNumber: roNow || armed.pre.roNumber || "",
      customerName: lastName,
    };
    armed = null;

    try {
      const response = await runtime.runtime.sendMessage({ type: "print-ro", payload: body });
      if (!response || response.error) {
        api.showToast(response?.error || "Labels did not print.", "error");
      } else if (response.skipped) {
        api.showToast(response.message || "Label skipped — already printed.", "skip");
      } else if (response.printed) {
        api.showToast(`Label: ${lastName} / ${model}`, "ok");
      } else {
        api.showToast(response.message || "Label request finished.", "ok");
      }
    } catch (error) {
      api.showToast(error instanceof Error ? error.message : "Labels bridge failed.", "error");
    } finally {
      printing = false;
    }
  }

  document.addEventListener(
    "click",
    (event) => {
      const control = closestControl(event.target);
      if (!control) return;
      if (api.isForbiddenControl(control)) {
        armed = null;
        return;
      }
      armCreate(control);
    },
    true,
  );

  // Capture keyboard activation of the focused Create control.
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const control = closestControl(event.target);
      if (!control) return;
      if (api.isForbiddenControl(control)) {
        armed = null;
        return;
      }
      armCreate(control);
    },
    true,
  );

  const observer = new MutationObserver(() => {
    void tryPrintAfterSuccess();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // Poll lightly while armed — some SPA updates skip useful mutation records.
  setInterval(() => {
    if (armed) void tryPrintAfterSuccess();
  }, 400);
})();
