/* global chrome, browser, AllDataRoLabels */
/**
 * AllData Manage Online — arm only on Create R/O, then print last name + model.
 */
(function () {
  const runtime = typeof browser !== "undefined" ? browser : chrome;
  const api = globalThis.AllDataRoLabels || {};
  const SUCCESS_WAIT_MS = api.SUCCESS_WAIT_MS || 12000;

  let armed = false;
  let armedAt = 0;
  let pendingTimer = null;
  let lastPrintedKey = "";
  let lastPrintedAt = 0;

  function toast(message, kind) {
    if (typeof api.showToast === "function") api.showToast(message, kind);
  }

  function disarm() {
    armed = false;
    armedAt = 0;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  }

  function armFromCreate() {
    armed = true;
    armedAt = Date.now();
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      if (armed) {
        disarm();
        toast("Label skipped — Create R/O success not confirmed.", "skip");
      }
    }, SUCCESS_WAIT_MS);
    scheduleSuccessChecks();
  }

  function alreadyPrinted(fields) {
    const key = `${fields.roNumber || ""}|${fields.lastName}|${fields.model}`;
    if (key && key === lastPrintedKey && Date.now() - lastPrintedAt < 60_000) return true;
    return false;
  }

  function markPrinted(fields) {
    lastPrintedKey = `${fields.roNumber || ""}|${fields.lastName}|${fields.model}`;
    lastPrintedAt = Date.now();
  }

  async function requestPrint(fields) {
    if (alreadyPrinted(fields)) {
      toast("Label skipped — already sent.", "skip");
      return;
    }
    let response;
    try {
      response = await runtime.runtime.sendMessage({
        type: "print-ro",
        payload: {
          event: "create-ro",
          lastName: fields.lastName,
          model: fields.model,
          roNumber: fields.roNumber || "",
          source: "alldata-extension",
        },
      });
    } catch {
      toast("Label skipped — extension background unavailable.", "error");
      return;
    }
    if (!response || response.error) {
      toast(response?.error || "Label skipped — Labels error.", "error");
      return;
    }
    if (response.skipped) {
      toast("Label skipped — already printed this RO.", "skip");
      markPrinted(fields);
      return;
    }
    if (response.printed || response.dryRun) {
      markPrinted(fields);
      toast(
        response.dryRun
          ? `Dry run: ${fields.lastName} / ${fields.model}`
          : `Printed ${fields.lastName} / ${fields.model}`,
        "ok",
      );
      return;
    }
    toast("Label skipped — unexpected Labels response.", "skip");
  }

  function tryCompleteAfterCreate() {
    if (!armed) return;
    const createStillThere = typeof api.createControlPresent === "function" && api.createControlPresent();
    const updateThere = typeof api.updateControlPresent === "function" && api.updateControlPresent();
    const fields = typeof api.scrapeWorkScreen === "function" ? api.scrapeWorkScreen() : {};
    const success = (!createStillThere && Boolean(fields.lastName && fields.model)) ||
      (updateThere && Boolean(fields.lastName && fields.model)) ||
      (Boolean(fields.roNumber) && Boolean(fields.lastName && fields.model) && Date.now() - armedAt > 400);

    if (!success) return;
    if (!fields.lastName || !fields.model) {
      disarm();
      toast("Label skipped — could not read last name or model.", "skip");
      return;
    }
    disarm();
    requestPrint(fields);
  }

  function scheduleSuccessChecks() {
    const delays = [300, 800, 1500, 2500, 4000, 6500, 9000, 11500];
    for (const ms of delays) {
      setTimeout(() => {
        if (armed) tryCompleteAfterCreate();
      }, ms);
    }
  }

  function eventPath(event) {
    if (typeof event.composedPath === "function") return event.composedPath();
    const path = [];
    let node = event.target;
    while (node) {
      path.push(node);
      node = node.parentNode;
    }
    return path;
  }

  function onPointer(event) {
    const path = eventPath(event);
    for (const node of path) {
      if (!node || node.nodeType !== 1) continue;
      if (typeof api.isForbiddenControl === "function" && api.isForbiddenControl(node)) {
        disarm();
        return;
      }
      if (typeof api.isCreateControl === "function" && api.isCreateControl(node)) {
        armFromCreate();
        return;
      }
    }
  }

  document.addEventListener("click", onPointer, true);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    onPointer(event);
  }, true);

  // MutationObserver: if Create disappears after arm, try scrape.
  const mo = new MutationObserver(() => {
    if (armed) tryCompleteAfterCreate();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
})();
