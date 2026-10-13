/* global globalThis */
/**
 * Heuristic AllData Manage Online scrape. Fail closed — empty fields mean skip.
 * Tighten selectors after a live DevTools pass (no Manjaro GUI automation).
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
    const bits = [
      el.getAttribute?.("aria-label"),
      el.getAttribute?.("title"),
      el.getAttribute?.("value"),
      el.getAttribute?.("data-testid"),
      el.getAttribute?.("name"),
      el.getAttribute?.("id"),
      visibleText(el),
    ];
    return bits.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  function lastNameFromFull(name) {
    const text = String(name || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return "";
    const parts = text.split(" ").filter(Boolean);
    return parts[parts.length - 1] || "";
  }

  function labeledValue(doc, labelRe) {
    const nodes = doc.querySelectorAll("label, span, div, th, dt, strong, b");
    for (const node of nodes) {
      const label = visibleText(node);
      if (!label || !labelRe.test(label)) continue;
      const forId = node.getAttribute?.("for");
      if (forId) {
        const input = doc.getElementById(forId);
        if (input && "value" in input && String(input.value || "").trim()) {
          return String(input.value).trim();
        }
      }
      const sibling =
        node.nextElementSibling ||
        node.parentElement?.querySelector("input, select, textarea, .value, [class*='value']");
      if (sibling) {
        if ("value" in sibling && String(sibling.value || "").trim()) return String(sibling.value).trim();
        const text = visibleText(sibling);
        if (text && text !== label) return text.replace(new RegExp("^" + label + "[:\\s]*", "i"), "").trim();
      }
      const row = node.closest("tr, li, .form-group, .field, [class*='row']");
      if (row) {
        const input = row.querySelector("input, select, textarea");
        if (input && String(input.value || "").trim()) return String(input.value).trim();
        const text = visibleText(row).replace(label, "").replace(/^[:\s]+/, "").trim();
        if (text) return text;
      }
    }
    return "";
  }

  function findInputByHint(doc, hintRe) {
    const inputs = doc.querySelectorAll("input, select, textarea");
    for (const input of inputs) {
      const hint = controlLabel(input);
      if (hintRe.test(hint) && String(input.value || "").trim()) {
        return String(input.value).trim();
      }
    }
    return "";
  }

  function modelFromPage(doc) {
    const direct =
      labeledValue(doc, /^\s*model\s*:?\s*$/i) ||
      findInputByHint(doc, /model/i);
    if (direct) {
      const token = direct.split(/[\s,/|]+/).filter(Boolean).pop();
      return token || direct;
    }
    const ymm = labeledValue(doc, /year\s*\/?\s*make\s*\/?\s*model/i) ||
      labeledValue(doc, /^\s*vehicle\s*:?\s*$/i);
    if (ymm) {
      const parts = ymm.split(/[\s,/|]+/).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
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
      labeledValue(doc, /^\s*last\s*name\s*:?\s*$/i) ||
      findInputByHint(doc, /last\s*name/i);
    if (last) return lastNameFromFull(last);

    const full =
      labeledValue(doc, /^\s*(customer|customer\s*name|name)\s*:?\s*$/i) ||
      findInputByHint(doc, /customer|owner|name/i);
    return lastNameFromFull(full);
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

  function createControlPresent(doc = document) {
    const nodes = doc.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']");
    for (const node of nodes) {
      if (isCreateControl(node)) return true;
    }
    return false;
  }

  function updateControlPresent(doc = document) {
    const nodes = doc.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']");
    for (const node of nodes) {
      const label = controlLabel(node);
      if (label && api.UPDATE_LABEL_RE && api.UPDATE_LABEL_RE.test(label)) return true;
    }
    return false;
  }

  api.scrapeWorkScreen = scrapeWorkScreen;
  api.lastNameFromFull = lastNameFromFull;
  api.isCreateControl = isCreateControl;
  api.isForbiddenControl = isForbiddenControl;
  api.createControlPresent = createControlPresent;
  api.updateControlPresent = updateControlPresent;
  api.controlLabel = controlLabel;
})(globalThis);
