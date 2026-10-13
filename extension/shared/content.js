/* global chrome, browser, AllDataRoLabels */
/**
 * AllData Manage Online — arm only on Create R/O, then print last name + model.
 * Every Create click prints once after success — including when an open RO already exists
 * and when the same customer is used again for a new Create.
 */
(function () {
  const runtime = typeof browser !== "undefined" ? browser : chrome;
  const api = globalThis.AllDataRoLabels || {};
  const SUCCESS_WAIT_MS = api.SUCCESS_WAIT_MS || 12000;

  let armed = false;
  let armedAt = 0;
  let armedBaselineRo = "";
  let armedHadUpdate = false;
  let armedHadCreate = false;
  let createArmId = "";
  let pendingTimer = null;
  /** createArmId values that already got a print attempt — never key on customer/person. */
  const printedArms = new Set();

  function toast(message, kind) {
    if (typeof api.showToast === "function") api.showToast(message, kind);
  }

  function newCreateArmId() {
    return `create-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function disarm() {
    armed = false;
    armedAt = 0;
    armedBaselineRo = "";
    armedHadUpdate = false;
    armedHadCreate = false;
    // keep createArmId until print finishes so requestPrint can mark it
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  }

  function snapshotAtArm() {
    const fields = typeof api.scrapeWorkScreen === "function" ? api.scrapeWorkScreen() : {};
    armedBaselineRo = String(fields.roNumber || "").trim();
    armedHadUpdate = typeof api.updateControlPresent === "function" && api.updateControlPresent();
    armedHadCreate = typeof api.createControlPresent === "function" && api.createControlPresent();
  }

  function armFromCreate() {
    snapshotAtArm();
    createArmId = newCreateArmId();
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

  /**
   * Dedupe by this Create click only — never by customer, person, or open RO#.
   * Same customer + new Create always prints.
   */
  function alreadyPrintedThisCreate(armId) {
    return Boolean(armId && printedArms.has(armId));
  }

  function markPrintedThisCreate(armId) {
    if (!armId) return;
    printedArms.add(armId);
    // Bound memory if Desk stays open all day.
    if (printedArms.size > 200) {
      const first = printedArms.values().next().value;
      printedArms.delete(first);
    }
  }

  /**
   * Only attach an RO# when it is clearly NEW vs the open/pre-Create baseline.
   * Sending the open RO# hits Labels 24h idempotency → "already printed this RO".
   */
  function fieldsForPrint(scraped, armId) {
    const scrapedRo = String(scraped.roNumber || "").trim();
    const roNumber = scrapedRo && scrapedRo !== armedBaselineRo ? scrapedRo : "";
    return {
      lastName: scraped.lastName,
      model: scraped.model,
      roNumber,
      createArmId: armId || "",
    };
  }

  async function sendPrintPayload(payload) {
    return runtime.runtime.sendMessage({
      type: "print-ro",
      payload,
    });
  }

  async function requestPrint(fields) {
    const armId = fields.createArmId || createArmId;
    if (alreadyPrintedThisCreate(armId)) {
      toast("Label skipped — already sent for this Create.", "skip");
      return;
    }

    const basePayload = {
      event: "create-ro",
      lastName: fields.lastName,
      model: fields.model,
      source: "alldata-extension",
      createArmId: armId || "",
    };

    let response;
    try {
      // Prefer new RO# when known; omit otherwise so open-RO idempotency cannot block.
      response = await sendPrintPayload({
        ...basePayload,
        roNumber: fields.roNumber || "",
      });
      // If Labels skipped on an RO# (stale open RO, etc.), retry once with no RO#.
      if (response && response.skipped && fields.roNumber) {
        response = await sendPrintPayload({
          ...basePayload,
          roNumber: "",
        });
      }
    } catch {
      toast("Label skipped — extension background unavailable.", "error");
      return;
    }
    if (!response || response.error) {
      toast(response?.error || "Label skipped — Labels error.", "error");
      return;
    }
    if (response.skipped) {
      // Still skipped with no RO# should be rare; do not mark arm so a later Create can try.
      toast("Label skipped — Labels reported a duplicate.", "skip");
      return;
    }
    if (response.printed || response.dryRun) {
      markPrintedThisCreate(armId);
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
    const scraped = typeof api.scrapeWorkScreen === "function" ? api.scrapeWorkScreen() : {};
    const roChanged =
      Boolean(scraped.roNumber) &&
      String(scraped.roNumber).trim() !== armedBaselineRo;
    const createGone = armedHadCreate && !createStillThere;
    // When an open RO already shows Update, do not treat that as Create success.
    const updateAppeared = !armedHadUpdate && updateThere;

    const success =
      (createGone && Boolean(scraped.lastName && scraped.model)) ||
      (updateAppeared && Boolean(scraped.lastName && scraped.model)) ||
      (roChanged && Boolean(scraped.lastName && scraped.model) && Date.now() - armedAt > 400);

    if (!success) return;
    if (!scraped.lastName || !scraped.model) {
      disarm();
      toast("Label skipped — could not read last name or model.", "skip");
      return;
    }
    const armId = createArmId;
    const fields = fieldsForPrint(scraped, armId);
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
