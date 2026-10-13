/* global globalThis */
/**
 * Work-screen scrapers for Manage Online.
 *
 * Assumptions (no live DevTools capture yet — fail closed if missing):
 * 1. Create / Update / Assign controls expose accessible name or visible text
 *    matching "Create R/O", "Update R/O", etc. (slash optional, spacing flexible).
 * 2. Customer name appears near a label containing Customer / Name / Last Name,
 *    or in an input/select whose name/id/aria-label mentions customer/name.
 * 3. Vehicle model appears near Model, or as the model token in a Year/Make/Model
 *    block (Porsche shop: Macan, 911, Cayman, Boxster, Panamera, Taycan, …).
 * 4. RO number (for idempotency) appears near "R/O" / "RO #" / document number
 *    after create succeeds; optional — print still works without it.
 */
(function (root) {
  const api = root.AllDataRoLabels || (root.AllDataRoLabels = {});

  const PORCHE_MODELS = [
    "911",
    "718",
    "Macan",
    "Cayenne",
    "Panamera",
    "Taycan",
    "Cayman",
    "Boxster",
    "Carrera",
    "Turbo",
    "GT3",
    "GT4",
    "Spyder",
  ];

  function visibleText(el) {
    if (!el) return "";
    const aria = (el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title"))) || "";
    const text = `${aria} ${el.innerText || el.textContent || ""}`;
    return text.replace(/\s+/g, " ").trim();
  }

  function controlLabel(el) {
    if (!el) return "";
    const labelled = el.getAttribute && el.getAttribute("aria-label");
    if (labelled) return labelled.replace(/\s+/g, " ").trim();
    return visibleText(el);
  }

  function isCreateControl(el) {
    const label = controlLabel(el);
    if (!api.CREATE_LABEL_RE.test(label)) return false;
    if (api.UPDATE_LABEL_RE.test(label)) return false;
    if (api.ASSIGN_LABEL_RE.test(label)) return false;
    if (api.SCHEDULE_NEW_RE.test(label)) return false;
    return true;
  }

  function isForbiddenControl(el) {
    const label = controlLabel(el);
    return (
      api.UPDATE_LABEL_RE.test(label) ||
      api.ASSIGN_LABEL_RE.test(label) ||
      api.SCHEDULE_NEW_RE.test(label)
    );
  }

  function fieldNearLabel(labelRe) {
    const nodes = document.querySelectorAll("label, span, div, th, td, dt, strong, b");
    for (const node of nodes) {
      const t = visibleText(node);
      if (!labelRe.test(t) || t.length > 48) continue;
      const forId = node.getAttribute && node.getAttribute("for");
      if (forId) {
        const target = document.getElementById(forId);
        const val = readValue(target);
        if (val) return val;
      }
      const sibling = node.nextElementSibling;
      const val =
        readValue(sibling) ||
        readValue(node.parentElement && node.parentElement.querySelector("input, select, textarea, [contenteditable='true']"));
      if (val) return val;
      const row = node.closest("tr, .form-group, .field, [class*='row'], [class*='Field']");
      if (row) {
        const nested = readValue(row.querySelector("input, select, textarea, [contenteditable='true']"));
        if (nested) return nested;
        const texts = visibleText(row).replace(t, "").trim();
        if (texts && texts.length < 60) return texts;
      }
    }
    return "";
  }

  function readValue(el) {
    if (!el) return "";
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      return String(el.value || "").replace(/\s+/g, " ").trim();
    }
    if (el.isContentEditable) return visibleText(el);
    const text = visibleText(el);
    return text.length <= 80 ? text : "";
  }

  function extractLastName(fullName) {
    const text = String(fullName || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    const parts = text.split(" ").filter(Boolean);
    return parts[parts.length - 1] || text;
  }

  function scrapeCustomerLastName() {
    const last = fieldNearLabel(/^\s*(last\s*name|customer\s*last\s*name)\s*:?\s*$/i);
    if (last) return extractLastName(last);

    const named = document.querySelector(
      "input[name*='last' i], input[id*='lastName' i], input[aria-label*='last name' i], input[name*='customer' i], input[id*='customer' i], input[aria-label*='customer' i]",
    );
    const fromInput = readValue(named);
    if (fromInput) return extractLastName(fromInput);

    const customer = fieldNearLabel(/^\s*(customer|customer\s*name|name)\s*:?\s*$/i);
    if (customer) return extractLastName(customer);

    return "";
  }

  function scrapeModel() {
    const direct = fieldNearLabel(/^\s*(model|vehicle\s*model|car\s*model)\s*:?\s*$/i);
    if (direct) return cleanModel(direct);

    const named = document.querySelector(
      "input[name*='model' i], select[name*='model' i], input[id*='model' i], select[id*='model' i], input[aria-label*='model' i], select[aria-label*='model' i]",
    );
    const fromInput = readValue(named);
    if (fromInput) return cleanModel(fromInput);

    const vehicle = fieldNearLabel(/^\s*(vehicle|year\s*\/?\s*make\s*\/?\s*model|ymm)\s*:?\s*$/i);
    if (vehicle) {
      const fromYmm = modelFromVehicleLine(vehicle);
      if (fromYmm) return fromYmm;
    }

    // Last resort: known Porsche model tokens visible on the Work screen.
    const bodyText = visibleText(document.body);
    for (const model of PORCHE_MODELS) {
      const re = new RegExp(`\\b${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(bodyText)) return model;
    }
    return "";
  }

  function modelFromVehicleLine(line) {
    const text = String(line || "").replace(/\s+/g, " ").trim();
    for (const model of PORCHE_MODELS) {
      const re = new RegExp(`\\b${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      const match = re.exec(text);
      if (match) return match[0];
    }
    // "2018 Porsche Macan S" → take token after make-ish words
    const parts = text.split(" ").filter(Boolean);
    if (parts.length >= 3 && /^\d{4}$/.test(parts[0])) {
      return cleanModel(parts.slice(2).join(" "));
    }
    return cleanModel(parts.at(-1) || "");
  }

  function cleanModel(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 32);
  }

  function scrapeRoNumber() {
    const near = fieldNearLabel(/^\s*(r\s*\/?\s*o\s*#?|ro\s*number|repair\s*order|document\s*#?)\s*:?\s*$/i);
    if (near && /[A-Za-z0-9]/.test(near)) return near.replace(/^RO\s*/i, "").slice(0, 24);

    const body = visibleText(document.body);
    const match = /\bRO\s*#?\s*([A-Z]?\d{5,})\b/i.exec(body) || /\b([A-Z]\d{6,})\b/.exec(body);
    return match ? String(match[1]).slice(0, 24) : "";
  }

  function createButtonPresent() {
    return Boolean(findCreateControl());
  }

  function updateButtonPresent() {
    const candidates = document.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']");
    for (const el of candidates) {
      if (api.UPDATE_LABEL_RE.test(controlLabel(el))) return true;
    }
    return false;
  }

  function findCreateControl() {
    const candidates = document.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']");
    for (const el of candidates) {
      if (isCreateControl(el)) return el;
    }
    return null;
  }

  function scrapePayload() {
    const lastName = scrapeCustomerLastName();
    const model = scrapeModel();
    const roNumber = scrapeRoNumber();
    return {
      event: "create-ro",
      source: "alldata-extension",
      lastName,
      model,
      roNumber,
      customerName: lastName,
    };
  }

  api.visibleText = visibleText;
  api.controlLabel = controlLabel;
  api.isCreateControl = isCreateControl;
  api.isForbiddenControl = isForbiddenControl;
  api.extractLastName = extractLastName;
  api.scrapeCustomerLastName = scrapeCustomerLastName;
  api.scrapeModel = scrapeModel;
  api.scrapeRoNumber = scrapeRoNumber;
  api.createButtonPresent = createButtonPresent;
  api.updateButtonPresent = updateButtonPresent;
  api.findCreateControl = findCreateControl;
  api.scrapePayload = scrapePayload;
})(globalThis);
