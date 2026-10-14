/* global globalThis */
/**
 * Heuristic AllData Manage Online scrape. Fail closed — empty fields mean skip.
 * Tighten selectors after a live DevTools pass (no Manjaro GUI automation).
 *
 * Label payload is lastName + model only. Never scrape VIN into either field.
 * Last name strips first initial ("J. Whatcott", "LWhatcott" → "Whatcott").
 */
(function (root) {
  const api = root.AllDataRoLabels || (root.AllDataRoLabels = {});

  const PORSCHE_MODELS = [
    "911",
    "718",
    "Boxster",
    "Cayman",
    "Cayenne",
    "Macan",
    "Panamera",
    "Taycan",
    "Carrera",
    "Targa",
    "Turbo",
    "GT3",
    "GT4",
    "GTS",
  ];

  function visibleText(el) {
    if (!el) return "";
    const style = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
    if (style && (style.visibility === "hidden" || style.display === "none")) return "";
    return String(el.innerText || el.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function controlLabel(el) {
    if (!el) return "";
    // Do NOT include input.value here — it made /name/i match arbitrary filled fields
    // and let VIN / codes bleed into customer scrapes.
    const bits = [
      el.getAttribute?.("aria-label"),
      el.getAttribute?.("title"),
      el.getAttribute?.("placeholder"),
      el.getAttribute?.("data-testid"),
      el.getAttribute?.("name"),
      el.getAttribute?.("id"),
      visibleText(el),
    ];
    return bits.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  /** VIN label or 17-char VIN — never treat as last name or model. */
  function isVinNoise(value) {
    const text = String(value || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return false;
    if (/^vin:?$/i.test(text)) return true;
    if (/^vin\s*:/i.test(text)) return true;
    const compact = text.replace(/[\s-]/g, "");
    if (/^[A-HJ-NPR-Z0-9]{17}$/i.test(compact)) return true;
    return false;
  }

  /**
   * Last name only — strip "LAST, FIRST", leading "J." / "J ", trailing bare
   * initial, and glued shop codes like "LWhatcott" → "Whatcott".
   */
  function lastNameFromFull(name) {
    let text = String(name || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return "";
    if (isVinNoise(text)) return "";
    if (text.includes(",")) {
      text = text.split(",")[0].trim();
    }
    text = text.replace(/^[A-Za-z]\.?\s+/, "").replace(/^[A-Za-z]\.(?=[A-Za-z])/, "");
    // Glued first initial + PascalCase last ("LWhatcott") — not "McDonald".
    if (/^[A-Z][A-Z][a-z]/.test(text) && !/\s/.test(text)) {
      text = text.slice(1);
    }
    const parts = text.split(" ").filter(Boolean);
    if (!parts.length) return "";
    if (parts.length > 1 && /^[A-Za-z]\.?$/.test(parts[parts.length - 1])) {
      parts.pop();
    }
    const last = parts[parts.length - 1] || "";
    if (isVinNoise(last) || /^vin:?$/i.test(last)) return "";
    return last;
  }

  function labeledValue(doc, labelRe) {
    const nodes = collectMatching(doc, "label, span, div, th, dt, strong, b");
    for (const node of nodes) {
      const label = visibleText(node);
      if (!label || !labelRe.test(label)) continue;
      // Never take a VIN row even if the label regex somehow matched nearby text.
      if (/^\s*vin\b/i.test(label)) continue;
      const forId = node.getAttribute?.("for");
      if (forId) {
        const input = doc.getElementById(forId);
        if (input && "value" in input && String(input.value || "").trim()) {
          const v = String(input.value).trim();
          if (!isVinNoise(v)) return v;
        }
      }
      const sibling =
        node.nextElementSibling ||
        node.parentElement?.querySelector("input, select, textarea, .value, [class*='value']");
      if (sibling) {
        if ("value" in sibling && String(sibling.value || "").trim()) {
          const v = String(sibling.value).trim();
          if (!isVinNoise(v)) return v;
        }
        const text = visibleText(sibling);
        if (text && text !== label) {
          const stripped = text.replace(new RegExp("^" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[:\\s]*", "i"), "").trim();
          if (stripped && !isVinNoise(stripped) && !/^vin:?$/i.test(stripped)) return stripped;
        }
      }
      const row = node.closest("tr, li, .form-group, .field, [class*='row']");
      if (row) {
        if (/^\s*vin\b/i.test(visibleText(row).slice(0, 40))) {
          // Row is a VIN field — skip.
        } else {
          const input = row.querySelector("input, select, textarea");
          if (input && String(input.value || "").trim()) {
            const v = String(input.value).trim();
            if (!isVinNoise(v)) return v;
          }
          const text = visibleText(row).replace(label, "").replace(/^[:\s]+/, "").trim();
          if (text && !isVinNoise(text) && !/^vin:?$/i.test(text)) return text;
        }
      }
    }
    return "";
  }

  function findInputByHint(doc, hintRe) {
    const inputs = collectMatching(doc, "input, select, textarea");
    for (const input of inputs) {
      const hint = controlLabel(input);
      if (/vin/i.test(hint)) continue;
      if (hintRe.test(hint) && String(input.value || "").trim()) {
        const v = String(input.value).trim();
        if (!isVinNoise(v)) return v;
      }
    }
    return "";
  }

  function normalizeModelToken(raw) {
    let text = String(raw || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || isVinNoise(text)) return "";
    text = text.replace(/^vin\s*:\s*/i, "").trim();
    if (!text || isVinNoise(text)) return "";
    for (const model of PORSCHE_MODELS) {
      const re = new RegExp(`\\b${model}\\b`, "i");
      if (re.test(text)) return model;
    }
    const token = text.split(/[\s,/|]+/).filter(Boolean).pop();
    if (!token || isVinNoise(token) || /^vin:?$/i.test(token)) return "";
    return token;
  }

  function modelFromPage(doc) {
    const direct =
      labeledValue(doc, /^\s*model\s*:?\s*$/i) ||
      findInputByHint(doc, /(^|[^a-z])model([^a-z]|$)/i);
    const fromDirect = normalizeModelToken(direct);
    if (fromDirect) return fromDirect;

    const ymm =
      labeledValue(doc, /year\s*\/?\s*make\s*\/?\s*model/i) ||
      labeledValue(doc, /^\s*vehicle\s*:?\s*$/i);
    const fromYmm = normalizeModelToken(ymm);
    if (fromYmm) return fromYmm;

    const body = visibleText(doc.body).slice(0, 20000);
    for (const model of PORSCHE_MODELS) {
      const re = new RegExp(`\\b${model}\\b`, "i");
      if (re.test(body)) return model;
    }
    return "";
  }

  function scrapeCustomerLastName(doc) {
    const last =
      labeledValue(doc, /^\s*last\s*name\s*:?\s*$/i) ||
      findInputByHint(doc, /last\s*name/i);
    if (last) {
      const parsed = lastNameFromFull(last);
      if (parsed) return parsed;
    }

    // Prefer explicit customer/owner labels — never bare /name/i (matches HTML name= attrs).
    const full =
      labeledValue(doc, /^\s*(customer|customer\s*name)\s*:?\s*$/i) ||
      findInputByHint(doc, /customer(\s*name)?|owner(\s*name)?/i);
    if (full) {
      const parsed = lastNameFromFull(full);
      if (parsed) return parsed;
    }

    const nameOnly = labeledValue(doc, /^\s*name\s*:?\s*$/i);
    if (nameOnly) return lastNameFromFull(nameOnly);
    return "";
  }

  function scrapeRoNumber(doc) {
    const direct =
      labeledValue(doc, /^\s*(r\/?o|ro\s*#|repair\s*order)\s*:?\s*$/i) ||
      findInputByHint(doc, /\br\/?o\b|repair\s*order/i);
    if (direct) return direct.replace(/^RO\s*/i, "").trim();
    const body = visibleText(doc.body);
    const match = /\bRO\s*#?\s*([A-Z0-9-]{4,})\b/i.exec(body);
    return match ? match[1] : "";
  }

  function scrapeWorkScreen(doc = document) {
    const lastName = scrapeCustomerLastName(doc);
    const model = modelFromPage(doc);
    const roNumber = scrapeRoNumber(doc);
    return { lastName, model, roNumber };
  }

  function isCreateControl(el) {
    const cfg = api;
    const label = controlLabel(el);
    return Boolean(label && cfg.CREATE_LABEL_RE && cfg.CREATE_LABEL_RE.test(label));
  }

  function isForbiddenControl(el) {
    const cfg = api;
    const label = controlLabel(el);
    if (!label) return false;
    return (
      (cfg.UPDATE_LABEL_RE && cfg.UPDATE_LABEL_RE.test(label)) ||
      (cfg.ASSIGN_LABEL_RE && cfg.ASSIGN_LABEL_RE.test(label)) ||
      (cfg.SCHEDULE_NEW_RE && cfg.SCHEDULE_NEW_RE.test(label))
    );
  }

  const CONTROL_SELECTOR =
    "button, a, [role='button'], input[type='button'], input[type='submit']";

  /** Light + open shadow roots (Create often lives in a web component). */
  function collectMatching(root, selector, out = []) {
    if (!root) return out;
    if (root.querySelectorAll) {
      try {
        out.push(...root.querySelectorAll(selector));
      } catch {
        /* ignore bad selector roots */
      }
    }
    const walkRoot = root.querySelectorAll ? root : null;
    const all = walkRoot ? walkRoot.querySelectorAll("*") : [];
    for (const el of all) {
      if (el.shadowRoot) collectMatching(el.shadowRoot, selector, out);
    }
    return out;
  }

  function createControlPresent(doc = document) {
    const nodes = collectMatching(doc, CONTROL_SELECTOR);
    for (const node of nodes) {
      if (isCreateControl(node)) return true;
    }
    return false;
  }

  function updateControlPresent(doc = document) {
    const nodes = collectMatching(doc, CONTROL_SELECTOR);
    for (const node of nodes) {
      const label = controlLabel(node);
      if (label && api.UPDATE_LABEL_RE && api.UPDATE_LABEL_RE.test(label)) return true;
    }
    return false;
  }

  function isControlDisabled(el) {
    if (!el) return false;
    if (el.disabled === true) return true;
    const ariaDisabled = el.getAttribute?.("aria-disabled");
    if (ariaDisabled === "true") return true;
    const ariaBusy = el.getAttribute?.("aria-busy");
    if (ariaBusy === "true") return true;
    const cls = String(el.className || "");
    if (/\b(disabled|is-disabled|btn-disabled)\b/i.test(cls)) return true;
    return false;
  }

  /**
   * State of the specific Create control that was clicked (preferred over a
   * whole-document Create scan — menus can keep another Create visible).
   */
  function inspectArmedCreateControl(el) {
    if (!el) return { gone: false, disabled: false, relabeled: false };
    // Prefer isConnected — Node.contains() does not pierce shadow roots, and
    // Create often lives inside a web component.
    if (typeof el.isConnected === "boolean" && !el.isConnected) {
      return { gone: true, disabled: false, relabeled: false };
    }
    const disabled = isControlDisabled(el);
    const stillCreate = isCreateControl(el);
    if (!stillCreate && controlLabel(el)) {
      return { gone: false, disabled, relabeled: true };
    }
    return { gone: false, disabled, relabeled: false };
  }

  /**
   * Generic success copy in alerts / live regions / dialogs — no AllData-only
   * class names (we have no live HTML sample). Fail closed on vague "ok" text.
   */
  function pageShowsCreateSuccess(doc = document) {
    const SUCCESS_RE =
      /(?:repair\s*order|r\s*\/?\s*o)\s+(?:was\s+)?(?:created|saved|added)|(?:created|saved|added)\s+(?:repair\s*order|r\s*\/?\s*o)|successfully\s+created|create(?:d)?\s+successful/i;
    const nodes = collectMatching(
      doc,
      "[role='alert'], [role='status'], [role='dialog'], [aria-live], dialog, .toast, .Toast, .notification, .alert, .Alert",
    );
    for (const node of nodes) {
      const text = visibleText(node);
      if (text && SUCCESS_RE.test(text)) return true;
    }
    // Short body scan near the top for SPA banners that are not role=alert.
    const body = visibleText(doc.body).slice(0, 4000);
    return Boolean(body && SUCCESS_RE.test(body));
  }

  /**
   * Pure success gate used by content.js (unit-tested).
   * Prefer multiple weak signals over one brittle selector.
   */
  function evaluateCreateSuccess(state) {
    const scraped = state.scraped || {};
    const hasFields = Boolean(scraped.lastName && scraped.model);
    const armedEl = state.armedCreateEl;
    const el = inspectArmedCreateControl(armedEl);
    const createStillThere = Boolean(state.createStillThere);
    const updateThere = Boolean(state.updateThere);
    const armedHadCreate = Boolean(state.armedHadCreate);
    const armedHadUpdate = Boolean(state.armedHadUpdate);
    const armedBaselineRo = String(state.armedBaselineRo || "").trim();
    const scrapedRo = String(scraped.roNumber || "").trim();
    const roChanged = Boolean(scrapedRo && scrapedRo !== armedBaselineRo);
    const armedAt = Number(state.armedAt) || 0;
    const now = Number(state.now) || Date.now();
    const settled = now - armedAt > 400;
    const pageSuccess = Boolean(state.pageSuccess);

    const createGone = (armedHadCreate && !createStillThere) || el.gone || el.relabeled;
    const createDisabled = el.disabled;
    // Update appearing is only meaningful when Update was NOT already on screen
    // (open RO already shows Update — prompts must not alone confirm a new Create).
    const updateAppeared = !armedHadUpdate && updateThere;

    if (createGone && hasFields) return { confirmed: true, reason: "create-gone" };
    if (createDisabled && hasFields && settled) return { confirmed: true, reason: "create-disabled" };
    if (updateAppeared && hasFields) return { confirmed: true, reason: "update-appeared" };
    if (roChanged && hasFields && settled) return { confirmed: true, reason: "ro-changed" };
    if (pageSuccess && hasFields && settled) return { confirmed: true, reason: "page-success" };

    // UI confirmed but fields missing — caller toasts scrape failure, not timeout.
    if (createGone || (createDisabled && settled) || updateAppeared || (roChanged && settled) || (pageSuccess && settled)) {
      return { confirmed: true, reason: "ui-only", missingFields: true };
    }
    return { confirmed: false, reason: "" };
  }

  api.scrapeWorkScreen = scrapeWorkScreen;
  api.lastNameFromFull = lastNameFromFull;
  api.isVinNoise = isVinNoise;
  api.isCreateControl = isCreateControl;
  api.isForbiddenControl = isForbiddenControl;
  api.createControlPresent = createControlPresent;
  api.updateControlPresent = updateControlPresent;
  api.controlLabel = controlLabel;
  api.inspectArmedCreateControl = inspectArmedCreateControl;
  api.pageShowsCreateSuccess = pageShowsCreateSuccess;
  api.evaluateCreateSuccess = evaluateCreateSuccess;
  api.collectMatching = collectMatching;
})(globalThis);
