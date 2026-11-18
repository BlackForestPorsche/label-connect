/* global chrome, browser, AllDataRoLabels */
/**
 * AllData Manage Online — arm only on Create R/O, then print last name + model.
 * Every Create click prints once after success — including when an open RO already exists
 * and when the same customer is used again for a new Create.
 * Also pings Tools Follow mode (fire-and-forget) when the visible RO loads or changes.
 */
(function () {
  const runtime = typeof browser !== "undefined" ? browser : chrome;
  const api = globalThis.AllDataRoLabels || {};
  const SUCCESS_WAIT_MS = api.SUCCESS_WAIT_MS || 18000;
  /** After Create is confirmed, how long to wait for the model before printing with it blank. */
  const MODEL_GRACE_MS = api.MODEL_GRACE_MS || 6000;
  /** A pointer-down snapshot this fresh still counts when the click-time read comes back empty. */
  const PRE_CLICK_MAX_AGE_MS = 4000;
  const CHECK_THROTTLE_MS = 150;

  let armed = false;
  let armedAt = 0;
  let armedBaselineRo = "";
  let armedHadUpdate = false;
  let armedHadCreate = false;
  let armedCreateEl = null;
  let armedFields = { lastName: "", model: "", modelSource: "", roNumber: "" };
  let createArmId = "";
  let pendingTimer = null;
  let confirmedAt = 0;
  let graceTimer = null;
  let checkTimer = null;
  let lastCheckAt = 0;
  let preClick = null;
  /** UI success seen but scrape still empty — keep polling; timeout uses scrape toast. */
  let sawUiConfirm = false;
  /** createArmId values that already got a print attempt — never key on customer/person. */
  const printedArms = new Set();
  /** Last non-empty listener fields. A wiped form must not erase them. */
  let armedDwight = {};
  const DWIGHT_KEYS = ["ro", "customer", "car", "plate", "vin", "tech"];
  /** Last RO posted to Tools Follow — avoid thrashing on scrape noise. */
  let lastFollowRo = "";
  let lastFollowAt = 0;
  const FOLLOW_DEBOUNCE_MS = 1500;
  let followWatchTimer = null;

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
    armedCreateEl = null;
    armedFields = { lastName: "", model: "", modelSource: "", roNumber: "" };
    armedDwight = {};
    sawUiConfirm = false;
    confirmedAt = 0;
    // keep createArmId until print finishes so requestPrint can mark it
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    if (checkTimer) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
  }

  function scrapeNow() {
    return typeof api.scrapeWorkScreen === "function" ? api.scrapeWorkScreen() : {};
  }

  /** Read the form just before the click lands; AllData can re-render on blur / mousedown. */
  function notePreClick() {
    const fields = scrapeNow();
    rememberDwight(fields);
    preClick = { at: Date.now(), fields };
  }

  function dwightFromScrape(scraped) {
    const src = scraped || {};
    const out = {};
    for (const key of DWIGHT_KEYS) {
      const value = String(src[key] || "").trim();
      if (value) out[key] = value;
    }
    if (!out.ro) {
      const ro = String(src.roNumber || "").trim();
      if (ro) out.ro = ro;
    }
    if (!out.customer) {
      const customer = String(src.lastName || "").trim();
      if (customer) out.customer = customer;
    }
    if (!out.car) {
      const car = String(src.model || "").trim();
      if (car) out.car = car;
    }
    const submodel = String(src.submodel || "").trim();
    if (submodel) out.submodel = submodel.slice(0, 48);
    const year = String(src.year || "").trim();
    if (year) out.year = year.slice(0, 8);
    return out;
  }

  function rememberDwight(scraped) {
    const next = dwightFromScrape(scraped);
    for (const key of DWIGHT_KEYS) {
      if (next[key]) armedDwight[key] = next[key];
    }
  }

  function listenerFields(scraped) {
    return { ...armedDwight, ...dwightFromScrape(scraped) };
  }

  function lotBoardUrl(ro) {
    const base = String(api.DEFAULT_SHOP_BASE || "https://shop.blackforestautomotive.com").replace(/\/$/, "");
    const pageRo = String(ro || "").trim();
    if (!pageRo) return `${base}/lot`;
    return `${base}/lot?ro=${encodeURIComponent(pageRo)}`;
  }

  function remember(fields) {
    if (typeof api.rememberCreateFields === "function") {
      armedFields = { ...armedFields, ...api.rememberCreateFields(armedFields, fields) };
    } else {
      armedFields = {
        ...armedFields,
        lastName: String(fields.lastName || armedFields.lastName || "").trim(),
        model: String(fields.model || armedFields.model || "").trim(),
      };
    }
    rememberDwight(fields);
  }

  function snapshotAtArm() {
    const fields = scrapeNow();
    armedBaselineRo = String(fields.roNumber || "").trim();
    armedFields = { lastName: "", model: "", modelSource: "", roNumber: armedBaselineRo };
    if (preClick && Date.now() - preClick.at <= PRE_CLICK_MAX_AGE_MS) remember(preClick.fields);
    preClick = null;
    remember(fields);
    const present =
      typeof api.createControlPresent === "function" && api.createControlPresent();
    // Click path sees shadow DOM; global scan might miss — trust the armed element.
    armedHadCreate = present || Boolean(armedCreateEl);
    armedHadUpdate = typeof api.updateControlPresent === "function" && api.updateControlPresent();
  }

  function armFromCreate(createEl) {
    armedCreateEl = createEl && createEl.nodeType === 1 ? createEl : null;
    snapshotAtArm();
    createArmId = newCreateArmId();
    armed = true;
    armedAt = Date.now();
    sawUiConfirm = false;
    confirmedAt = 0;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      if (!armed) return;
      // Create was confirmed but the model never showed: print what we have, never drop the label.
      if (confirmedAt) {
        tryCompleteAfterCreate(true);
        if (!armed) return;
      }
      const scrapeMiss = sawUiConfirm;
      disarm();
      toast(
        scrapeMiss
          ? "No label printed. Desk could not read the customer’s last name on this page."
          : "No label printed. AllData did not confirm the new R/O.",
        "skip",
      );
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
      // Page RO for the listener, including an open RO that Labels must not receive.
      pageRo: scrapedRo,
      createArmId: armId || "",
    };
  }

  function mergeScrapedWithArm(scraped) {
    if (typeof api.mergeCreateFields === "function") {
      return api.mergeCreateFields(scraped, armedFields);
    }
    return {
      lastName: String(scraped.lastName || armedFields.lastName || "").trim(),
      model: String(scraped.model || armedFields.model || "").trim(),
      roNumber: String(scraped.roNumber || "").trim(),
    };
  }

  async function sendPrintPayload(payload) {
    return runtime.runtime.sendMessage({
      type: "print-ro",
      payload,
    });
  }

  /**
   * Read-only listener ping. Never clicks or types in AllData.
   * A failure here must not affect label printing.
   */
  function notifyDwight(event, fields) {
    const bodyFields = {};
    const src = fields || {};
    for (const key of DWIGHT_KEYS) {
      const value = String(src[key] || "").trim();
      if (!value) continue;
      if (value.includes("@")) continue;
      bodyFields[key] = value;
    }
    try {
      const pending = runtime.runtime.sendMessage({
        type: "dwight-nudge",
        event,
        fields: bodyFields,
      });
      if (pending && typeof pending.catch === "function") void pending.catch(() => {});
    } catch {
      // Listener nudge must never affect label printing.
    }
  }

  /**
   * Tools Follow mode — never blocks labels. RO string as scraped (digits / J-style).
   */
  function notifyFollow(event, fields, opts = {}) {
    const src = fields || {};
    const ro = String(src.ro || src.roNumber || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!ro) return;
    const now = Date.now();
    const force = Boolean(opts.force);
    if (!force && ro === lastFollowRo && now - lastFollowAt < FOLLOW_DEBOUNCE_MS) return;
    lastFollowRo = ro;
    lastFollowAt = now;
    const bodyFields = {};
    for (const key of DWIGHT_KEYS) {
      const value = String(src[key] || "").trim();
      if (!value || value.includes("@")) continue;
      bodyFields[key] = value;
    }
    bodyFields.ro = ro;
    if (src.year) bodyFields.year = String(src.year).trim();
    if (src.job) bodyFields.job = String(src.job).trim();
    if (src.owner && !bodyFields.customer) bodyFields.customer = String(src.owner).trim();
    if (src.model && !bodyFields.car) bodyFields.car = String(src.model).trim();
    if (src.submodel) bodyFields.submodel = String(src.submodel).trim().slice(0, 48);
    try {
      const pending = runtime.runtime.sendMessage({
        type: "follow-ro",
        event: event || "open",
        fields: bodyFields,
        ro,
      });
      if (pending && typeof pending.catch === "function") void pending.catch(() => {});
    } catch {
      // Follow must never affect label printing.
    }
  }

  function watchFollowRo() {
    try {
      const scraped = scrapeNow();
      const ro = String(scraped.roNumber || scraped.ro || "").trim();
      if (!ro) return;
      const event = lastFollowRo && lastFollowRo !== ro ? "change" : "open";
      notifyFollow(event, {
        ...listenerFields(scraped),
        ro,
        year: scraped.year,
        job: scraped.job,
        submodel: scraped.submodel,
      });
    } catch {
      // scrape noise
    }
  }

  async function requestPrint(fields) {
    const armId = fields.createArmId || createArmId;
    if (alreadyPrintedThisCreate(armId)) {
      toast("This R/O already has its label.", "skip");
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
      const printPromise = sendPrintPayload({
        ...basePayload,
        roNumber: fields.roNumber || "",
        lotUrl: lotBoardUrl(fields.pageRo || fields.dwight?.ro || ""),
      });
      notifyDwight("create_ro", fields.dwight);
      notifyFollow("create", fields.dwight || { ro: fields.pageRo || fields.roNumber }, { force: true });
      response = await printPromise;
      // If Labels skipped on an RO# (stale open RO, etc.), retry once with no RO#.
      if (response && response.skipped && fields.roNumber) {
        response = await sendPrintPayload({
          ...basePayload,
          roNumber: "",
        });
      }
    } catch {
      toast("No label printed. Desk is restarting. Reload this page, then print from Labels.", "error");
      return;
    }

    if (!response || response.error) {
      toast(response?.error || "No label printed. Labels on this PC did not answer. Check that Labels is running.", "error");
      return;
    }
    if (response.skipped) {
      // Still skipped with no RO# should be rare; do not mark arm so a later Create can try.
      toast("This R/O already has its label.", "skip");
      return;
    }
    if (response.printed || response.dryRun) {
      markPrintedThisCreate(armId);
      toast(
        response.dryRun
          ? `Test mode, nothing printed: ${fields.lastName} - ${fields.model}`.trimEnd()
          : `Printed ${fields.lastName} - ${fields.model}`.trimEnd(),
        "ok",
      );
      return;
    }
    toast("No label printed. Labels gave an answer Desk did not understand.", "skip");
  }

  function tryCompleteAfterCreate(force = false) {
    if (!armed) return;
    lastCheckAt = Date.now();
    const scrapedRaw = scrapeNow();
    const scraped = mergeScrapedWithArm(scrapedRaw);
    // The form is often wiped a beat after Create; keep the last good read.
    remember(scrapedRaw);
    const createStillThere =
      typeof api.createControlPresent === "function" && api.createControlPresent();
    const updateThere =
      typeof api.updateControlPresent === "function" && api.updateControlPresent();
    const pageSuccess =
      typeof api.pageShowsCreateSuccess === "function" && api.pageShowsCreateSuccess();

    const result =
      typeof api.evaluateCreateSuccess === "function"
        ? api.evaluateCreateSuccess({
            armedHadCreate,
            armedHadUpdate,
            armedBaselineRo,
            armedAt,
            armedCreateEl,
            scraped,
            createStillThere,
            updateThere,
            pageSuccess,
            now: Date.now(),
          })
        : { confirmed: false };

    if (!result.confirmed) return;
    const now = Date.now();
    if (!confirmedAt) confirmedAt = now;

    const plan =
      typeof api.planCreatePrint === "function"
        ? api.planCreatePrint({
            confirmed: true,
            fields: scraped,
            now,
            confirmedAt,
            modelGraceMs: MODEL_GRACE_MS,
            deadlineAt: force ? now : armedAt + SUCCESS_WAIT_MS,
          })
        : { action: scraped.lastName ? "print" : "wait" };

    // UI confirmed but scrape empty — do NOT disarm yet. Dom/fields often settle
    // a beat after Create disappears; early "could not read" was aborting polls.
    if (plan.action === "no-last-name" || (plan.action === "wait" && !scraped.lastName)) {
      sawUiConfirm = true;
      return;
    }
    // Model often settles a beat after last name. Wait out the grace from the moment Create was
    // confirmed, then print anyway with the model blank — every Create R/O prints.
    if (plan.action === "wait") {
      if (!graceTimer) {
        graceTimer = setTimeout(() => {
          graceTimer = null;
          if (armed) tryCompleteAfterCreate();
        }, (plan.waitMs || 0) + 50);
      }
      return;
    }
    const armId = createArmId;
    rememberDwight(scrapedRaw);
    const fields = fieldsForPrint(scraped, armId);
    // Same read as Close, Cancel and the estimate events: the page's own customer and
    // year/make/model. The label's last name and model only fill what the page left blank.
    fields.dwight = { ...dwightFromScrape(scraped), ...listenerFields(scrapedRaw) };
    disarm();
    requestPrint(fields);
  }

  /** Mutation bursts are frequent on a busy SPA; a full scrape each time is wasteful. */
  function scheduleThrottledCheck() {
    if (!armed || checkTimer) return;
    const wait = Math.max(0, CHECK_THROTTLE_MS - (Date.now() - lastCheckAt));
    checkTimer = setTimeout(() => {
      checkTimer = null;
      if (armed) tryCompleteAfterCreate();
    }, wait);
  }

  function scheduleSuccessChecks() {
    const delays = [200, 500, 900, 1500, 2500, 4000, 6500, 9000, 12000, 15000, 17500];
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

  function nudgeFromPage(eventName) {
    const scraped = scrapeNow();
    rememberDwight(scraped);
    const fields = listenerFields(scraped);
    notifyDwight(eventName, fields);
    notifyFollow(eventName, fields, { force: true });
  }

  function onPointer(event) {
    const path = eventPath(event);
    for (const node of path) {
      if (!node || node.nodeType !== 1) continue;
      if (typeof api.isCloseControl === "function" && api.isCloseControl(node)) {
        nudgeFromPage("close_ro");
        disarm();
        return;
      }
      if (typeof api.isCancelControl === "function" && api.isCancelControl(node)) {
        nudgeFromPage("cancel_ro");
        disarm();
        return;
      }
      const estimateEvent = typeof api.estimateAction === "function" ? api.estimateAction(node) : "";
      if (estimateEvent) {
        nudgeFromPage(estimateEvent);
        disarm();
        return;
      }
      if (typeof api.isForbiddenControl === "function" && api.isForbiddenControl(node)) {
        disarm();
        return;
      }
      if (typeof api.isCreateControl === "function" && api.isCreateControl(node)) {
        armFromCreate(node);
        return;
      }
    }
  }

  function onPointerDown(event) {
    for (const node of eventPath(event)) {
      if (!node || node.nodeType !== 1) continue;
      if (typeof api.isCreateControl === "function" && api.isCreateControl(node)) {
        notePreClick();
        return;
      }
    }
  }

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("mousedown", onPointerDown, true);
  document.addEventListener("touchstart", onPointerDown, true);
  document.addEventListener("click", onPointer, true);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    onPointer(event);
  }, true);

  // MutationObserver: if Create disappears after arm, try scrape.
  const mo = new MutationObserver(() => {
    if (armed) scheduleThrottledCheck();
    if (!followWatchTimer) {
      followWatchTimer = setTimeout(() => {
        followWatchTimer = null;
        watchFollowRo();
      }, 400);
    }
  });
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["disabled", "aria-disabled", "aria-busy", "class"],
  });
  // Initial open once the page has had a beat to paint the RO.
  setTimeout(() => watchFollowRo(), 800);
})();
