/* global globalThis */
/**
 * Heuristic AllData Manage Online scrape. Fail closed — empty fields mean skip.
 * Tighten selectors after a live DevTools pass (no Manjaro GUI automation).
 *
 * Label payload is lastName + model only. Never scrape VIN, license plate, or
 * account # into either field; a 1–2 letter state/region code (CA) is never a model. Last name strips first initial
 * ("J. Whatcott", "LWhatcott" → "Whatcott").
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

  /** US states, DC/territories, Canadian provinces — a 2-letter code is never a model. */
  const STATE_CODES = new Set(
    (
      "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC " +
      "ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR VI GU AS MP " +
      "AB BC MB NB NL NS NT NU ON PE QC SK YT"
    ).split(" "),
  );

  const KNOWN_MAKES = new Set(
    (
      "porsche audi bmw mercedes mercedes-benz mini volkswagen vw volvo jaguar land rover range ford chevrolet chevy " +
      "dodge jeep chrysler ram gmc cadillac buick lincoln toyota lexus honda acura nissan infiniti mazda subaru " +
      "mitsubishi hyundai kia genesis tesla fiat alfa romeo maserati ferrari lamborghini bentley aston martin " +
      "mclaren lotus saab suzuki scion pontiac saturn oldsmobile mercury"
    ).split(" "),
  );

  /** Labels/values that must never become lastName or model (AllData Work screen). */
  const FIELD_NOISE_LABEL_RE =
    /^\s*(license\s*plate|lic(?:ense)?\.?\s*pl(?:ate)?\.?|plate\s*#?|tag\s*#?|account\s*(?:#|no\.?|number)?|acct\.?\s*#?|stock\s*#?|phone|cell|mobile|email|e-?mail|vin|mileage|odometer|unit\s*#?)\s*:?\s*$/i;
  const FIELD_NOISE_HINT_RE =
    /\b(license\s*plate|lic(?:ense)?\.?\s*pl(?:ate)?|plate\s*#|account\s*#|acct\.?\s*#|stock\s*#|vin)\b/i;

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

  function isKnownPorscheModel(value) {
    const text = String(value || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return false;
    return PORSCHE_MODELS.some((model) => new RegExp(`^${model}$`, "i").test(text));
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
   * License plate / account # / similar Work-screen fields — never lastName or model.
   * Broad `[class*='row']` association was picking these as Customer/Model values.
   */
  function isPlateOrAccountNoise(value) {
    const text = String(value || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return false;
    if (FIELD_NOISE_LABEL_RE.test(text)) return true;
    if (/^(license\s*plate|account\s*#?|acct\.?\s*#?)\b/i.test(text)) return true;
    if (isKnownPorscheModel(text)) return false;
    const compact = text.replace(/[\s-]/g, "");
    // Account-like: optional letter prefix + 4+ digits, or pure digit id.
    if (/^[A-Z]?\d{4,}$/i.test(compact)) return true;
    // Plate-like: 5–8 alnum with at least one digit (not a known model).
    if (/^(?=.*\d)[A-Z0-9]{5,8}$/i.test(compact)) return true;
    return false;
  }

  function isScrapeNoise(value) {
    return isVinNoise(value) || isPlateOrAccountNoise(value);
  }

  /** "CA", "Tx.", or any 1–2 letter token: a state/region code or trim letter, never a model. */
  function isStateOrRegionNoise(value) {
    const text = String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\.$/, "");
    if (!text) return false;
    if (STATE_CODES.has(text.toUpperCase())) return true;
    return /^[A-Za-z]{1,2}$/.test(text);
  }

  /** "Anytown, CA 92101" / "CA 92101" — address blobs must not feed the model scrape. */
  function looksLikeAddress(value) {
    const text = String(value || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return false;
    if (/\b\d{5}(?:-\d{4})?\b/.test(text)) return true;
    return /,\s*[A-Za-z]{2}\b\.?\s*$/.test(text) && STATE_CODES.has(text.slice(-2).toUpperCase());
  }

  let activeValueGuard = null;

  /**
   * Last name only — strip "LAST, FIRST", leading "J." / "J ", trailing bare
   * initial, and glued shop codes like "LWhatcott" → "Whatcott".
   */
  function lastNameFromFull(name) {
    let text = String(name || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return "";
    if (isScrapeNoise(text)) return "";
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
    if (isScrapeNoise(last) || /^vin:?$/i.test(last)) return "";
    // Last names are letters (hyphen/apostrophe ok) — reject digit codes.
    if (/\d/.test(last)) return "";
    return last;
  }

  function acceptFieldValue(v) {
    const text = String(v || "").trim();
    if (!text || isScrapeNoise(text)) return "";
    if (activeValueGuard && !activeValueGuard(text)) return "";
    return text;
  }

  /** Label-only text (no value) — allow trailing * / required marks. */
  function isExactFieldLabel(text, labelRe) {
    const t = String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s*[*†‡]\s*$/, "")
      .replace(/\s*:\s*$/, "");
    return Boolean(t && labelRe.test(t));
  }

  /**
   * Value after "Label:" on the same node ("Customer: Whatcott").
   * Only short leftovers — never a whole Work-screen blob. Plate/account still rejected.
   */
  function valueAfterLabelPrefix(text, labelRe) {
    const raw = String(text || "").replace(/\s+/g, " ").trim();
    if (!raw) return "";
    const m = labelRe.exec(raw);
    if (!m || m.index !== 0) return "";
    const rest = raw
      .slice(m[0].length)
      .replace(/^[\s*:·\-–—]+/, "")
      .trim();
    if (!rest || rest.length > 48) return "";
    if (FIELD_NOISE_HINT_RE.test(rest) || /^\s*vin\b/i.test(rest)) return "";
    // Single field value only (not "Name Plate Account" composites).
    if (rest.split(/\s+/).length > 4) return "";
    return acceptFieldValue(rest);
  }

  function firstCleanInputValue(root) {
    if (!root?.querySelectorAll) return "";
    const inputs = root.querySelectorAll("input, select, textarea");
    for (const input of inputs) {
      const hint = controlLabel(input);
      if (/vin/i.test(hint) || FIELD_NOISE_HINT_RE.test(hint)) continue;
      if (!String(input.value || "").trim()) continue;
      const v = acceptFieldValue(input.value);
      if (v) return v;
    }
    return "";
  }

  /**
   * Pull a value from a field wrapper. Broad `[class*='row']` is allowed again
   * (AllData often uses it) but plate/account inputs and noise text are rejected
   * — that is what 0.1.20 was trying to stop, not the wrapper itself.
   */
  function valueFromFieldWrapper(row, labelText) {
    if (!row) return "";
    // td/th tables: value cell next to the label cell.
    if (row.tagName === "TD" || row.tagName === "TH") {
      const cellSibling = row.nextElementSibling;
      if (cellSibling) {
        const fromInput = firstCleanInputValue(cellSibling);
        if (fromInput) return fromInput;
        const cellText = visibleText(cellSibling);
        const v = acceptFieldValue(cellText);
        if (v) return v;
      }
    }
    if (row.tagName === "DT") {
      const dd = row.nextElementSibling;
      if (dd && dd.tagName === "DD") {
        const fromInput = firstCleanInputValue(dd);
        if (fromInput) return fromInput;
        const v = acceptFieldValue(visibleText(dd));
        if (v) return v;
      }
    }

    const fromInput = firstCleanInputValue(row);
    if (fromInput) return fromInput;

    // Whole-row text only when it does not also advertise plate/account/VIN.
    const rowText = visibleText(row);
    if (/^\s*vin\b/i.test(rowText) || FIELD_NOISE_HINT_RE.test(rowText)) {
      return "";
    }
    const stripped = rowText
      .replace(labelText, "")
      .replace(/^[:\s*]+/, "")
      .trim();
    // Avoid multi-field blobs (name + phone + email in one row).
    if (stripped.length > 64 || /\b(phone|email|@)\b/i.test(stripped)) return "";
    return acceptFieldValue(stripped);
  }

  function labeledValue(doc, labelRe) {
    // Prefix form for "Customer: Whatcott" on one node (anchors at start).
    const labelPrefixRe = new RegExp(
      labelRe.source.replace(/\$$/, "").replace(/^\^/, "^"),
      labelRe.flags.includes("i") ? "i" : labelRe.flags,
    );
    const nodes = collectMatching(doc, "label, span, div, th, td, dt, dd, strong, b, p");
    for (const node of nodes) {
      const label = visibleText(node);
      if (!label) continue;
      // Never treat a VIN / plate / account caption as the Customer/Model label.
      if (FIELD_NOISE_LABEL_RE.test(label) || /^\s*vin\b/i.test(label)) continue;

      const exact = isExactFieldLabel(label, labelRe);
      // Inline "Label: value" only on small nodes (avoid form-root divs).
      const childCount = node.children ? node.children.length : 0;
      const inline =
        !exact && childCount <= 2 ? valueAfterLabelPrefix(label, labelPrefixRe) : "";
      if (!exact && !inline) continue;
      if (inline) return inline;

      const forId = node.getAttribute?.("for");
      if (forId) {
        const input = doc.getElementById(forId);
        if (input && "value" in input && String(input.value || "").trim()) {
          const hint = controlLabel(input);
          if (!FIELD_NOISE_HINT_RE.test(hint) && !/vin/i.test(hint)) {
            const v = acceptFieldValue(input.value);
            if (v) return v;
          }
        }
      }
      // Prefer immediate next sibling — parent.querySelector can jump to License Plate / Account.
      const sibling = node.nextElementSibling;
      if (sibling) {
        if ("value" in sibling && String(sibling.value || "").trim()) {
          const hint = controlLabel(sibling);
          if (!FIELD_NOISE_HINT_RE.test(hint) && !/vin/i.test(hint)) {
            const v = acceptFieldValue(sibling.value);
            if (v) return v;
          }
        }
        const sibInput = firstCleanInputValue(sibling);
        if (sibInput) return sibInput;
        const text = visibleText(sibling);
        if (text && text !== label && !FIELD_NOISE_HINT_RE.test(text) && !/^\s*vin\b/i.test(text)) {
          const stripped = text
            .replace(new RegExp("^" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[:\\s]*", "i"), "")
            .trim();
          const v = acceptFieldValue(stripped);
          if (v) return v;
        }
      }
      // Include row wrappers AllData uses; noise filters (not omitting the wrapper) stop plate bleed.
      const row = node.closest(
        "tr, li, dl, .form-group, .field, [class*='form-field'], [class*='FormField'], [class*='formField'], [class*='row'], [class*='Row'], [class*='Field']",
      );
      if (row) {
        const v = valueFromFieldWrapper(row, label);
        if (v) return v;
      }
    }
    return "";
  }

  function findInputByHint(doc, hintRe) {
    const inputs = collectMatching(doc, "input, select, textarea");
    for (const input of inputs) {
      const hint = controlLabel(input);
      if (/vin/i.test(hint) || FIELD_NOISE_HINT_RE.test(hint)) continue;
      if (hintRe.test(hint) && String(input.value || "").trim()) {
        const v = acceptFieldValue(input.value);
        if (v) return v;
      }
    }
    return "";
  }

  function isModelToken(token) {
    if (!token || isScrapeNoise(token) || /^vin:?$/i.test(token)) return false;
    if (isStateOrRegionNoise(token)) return false;
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,20}$/.test(token)) return false;
    if (/\d/.test(token)) {
      if (isKnownPorscheModel(token)) return true;
      // M3, X5, Q50, 328i — short letter+digit codes. Plates/accounts are 5+ and already noise.
      if (/^(?=.*[A-Za-z])[A-Za-z0-9-]{2,4}$/.test(token)) return true;
      return /^\d{3}$/.test(token);
    }
    return true;
  }

  function normalizeModelToken(raw) {
    let text = String(raw || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || isScrapeNoise(text)) return "";
    text = text.replace(/^vin\s*:\s*/i, "").trim();
    if (!text || isScrapeNoise(text)) return "";
    if (isStateOrRegionNoise(text) || looksLikeAddress(text)) return "";
    for (const model of PORSCHE_MODELS) {
      const re = new RegExp(`\\b${model}\\b`, "i");
      if (re.test(text)) return model;
    }
    const tokens = text
      .split(/[\s,/|]+/)
      .filter(Boolean)
      .filter((t) => !/^(?:19|20)\d{2}$/.test(t));
    // "2019 BMW M3 CA": take what follows the make, never a trailing state code.
    const makeIndex = tokens.findIndex((t) => KNOWN_MAKES.has(t.toLowerCase()));
    if (makeIndex >= 0) {
      const afterMake = tokens.slice(makeIndex + 1).find(isModelToken);
      if (afterMake) return afterMake;
    }
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
      if (isModelToken(tokens[i])) return tokens[i];
    }
    return "";
  }

  function modelFromPage(doc) {
    const previousGuard = activeValueGuard;
    activeValueGuard = (v) => !isStateOrRegionNoise(v) && !looksLikeAddress(v);
    try {
      const direct =
        labeledValue(doc, /^\s*model\s*$/i) ||
        findInputByHint(doc, /(^|[^a-z])model([^a-z]|$)/i);
      const fromDirect = normalizeModelToken(direct);
      if (fromDirect) return fromDirect;

      const ymm =
        labeledValue(doc, /^\s*year\s*\/?\s*make\s*\/?\s*model\s*$/i) ||
        labeledValue(doc, /^\s*vehicle\s*$/i);
      const fromYmm = normalizeModelToken(ymm);
      if (fromYmm) return fromYmm;
    } finally {
      activeValueGuard = previousGuard;
    }

    const body = visibleText(doc.body).slice(0, 20000);
    for (const model of PORSCHE_MODELS) {
      const re = new RegExp(`\\b${model}\\b`, "i");
      if (re.test(body)) return model;
    }
    return "";
  }

  function scrapeCustomerLastName(doc) {
    const last =
      labeledValue(doc, /^\s*last\s*name\s*$/i) ||
      findInputByHint(doc, /last\s*name/i);
    if (last) {
      const parsed = lastNameFromFull(last);
      if (parsed) return parsed;
    }

    // Prefer explicit customer/owner labels — never bare /name/i (matches HTML name= attrs).
    const full =
      labeledValue(doc, /^\s*(customer|customer\s*name)\s*$/i) ||
      findInputByHint(doc, /customer(\s*name)?|owner(\s*name)?/i);
    if (full) {
      const parsed = lastNameFromFull(full);
      if (parsed) return parsed;
    }

    const nameOnly = labeledValue(doc, /^\s*name\s*$/i);
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
    // (open RO already shows Update — that must not alone confirm a new Create).
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
  api.isPlateOrAccountNoise = isPlateOrAccountNoise;
  api.isStateOrRegionNoise = isStateOrRegionNoise;
  api.normalizeModelToken = normalizeModelToken;
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
