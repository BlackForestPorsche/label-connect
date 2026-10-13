/* global chrome, browser, AllDataRoLabels */
/**
 * SSF Autoparts checkout — Order reference (PO # / RO #) ← On the Lot last names.
 * Same Black Forest Desk package as AllData Create RO print.
 */
(function () {
  const runtime = typeof browser !== "undefined" ? browser : chrome;
  const api = globalThis.AllDataRoLabels || {};
  const UI_ID = "bf-desk-ssf-lot-names";
  let refreshTimer = null;

  function isCheckoutPath() {
    return /\/checkout(?:\/|$|\?)/i.test(location.pathname + location.search) ||
      /checkout/i.test(location.pathname);
  }

  function findOrderReferenceInput() {
    const inputs = document.querySelectorAll("input, textarea");
    for (const input of inputs) {
      const ph = String(input.getAttribute("placeholder") || "");
      const aria = String(input.getAttribute("aria-label") || "");
      const name = String(input.getAttribute("name") || "");
      const id = String(input.id || "");
      const labelText = input.labels && input.labels[0]
        ? String(input.labels[0].textContent || "")
        : "";
      const blob = `${ph} ${aria} ${name} ${id} ${labelText}`.toLowerCase();
      if (
        /po\s*#\s*\/\s*ro\s*#/.test(blob) ||
        /order\s*reference/.test(blob) ||
        (blob.includes("po") && blob.includes("ro"))
      ) {
        return input;
      }
    }
    // Fallback: label text near field
    const labels = document.querySelectorAll("label");
    for (const label of labels) {
      const text = String(label.textContent || "");
      if (/order\s*reference/i.test(text) || /po\s*#\s*\/\s*ro\s*#/i.test(text)) {
        const forId = label.getAttribute("for");
        if (forId) {
          const el = document.getElementById(forId);
          if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return el;
        }
        const nested = label.querySelector("input, textarea");
        if (nested) return nested;
      }
    }
    return null;
  }

  function fillInput(input, value) {
    const proto = input.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function ensureUi(input, names, status) {
    let wrap = document.getElementById(UI_ID);
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = UI_ID;
      Object.assign(wrap.style, {
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        margin: "8px 0",
        maxWidth: "320px",
        font: "600 12px/1.3 system-ui, sans-serif",
        color: "#1a1a1a",
      });
      const title = document.createElement("div");
      title.textContent = "On the Lot (Black Forest Desk)";
      title.style.opacity = "0.75";
      const select = document.createElement("select");
      select.id = `${UI_ID}-select`;
      Object.assign(select.style, {
        width: "100%",
        padding: "6px 8px",
        border: "1px solid #b9b2a4",
        borderRadius: "4px",
        background: "#fff",
      });
      const hint = document.createElement("div");
      hint.id = `${UI_ID}-hint`;
      hint.style.fontWeight = "500";
      hint.style.opacity = "0.7";
      wrap.append(title, select, hint);
      select.addEventListener("change", () => {
        const value = select.value;
        if (!value || !input.isConnected) return;
        fillInput(input, value);
      });
      if (input.parentElement) {
        input.parentElement.insertBefore(wrap, input.nextSibling);
      } else {
        input.insertAdjacentElement("afterend", wrap);
      }
    }

    const select = wrap.querySelector(`#${UI_ID}-select`);
    const hint = wrap.querySelector(`#${UI_ID}-hint`);
    const previous = select.value;
    select.replaceChildren();

    const placeholder = document.createElement("option");
    placeholder.value = "";
    if (status === "auth") {
      placeholder.textContent = "Unlock desk extension (person + PIN)…";
      select.disabled = true;
      hint.textContent = "Open the extension popup, sign in once, then reload checkout.";
    } else if (status === "error") {
      placeholder.textContent = "Lot names unavailable";
      select.disabled = true;
      hint.textContent = "Could not reach the shop lot API. Create RO print still works alone.";
    } else if (!names.length) {
      placeholder.textContent = "No cars on the lot";
      select.disabled = true;
      hint.textContent = "List refreshes when checkout is open. Book names are never used.";
    } else {
      placeholder.textContent = "Pick last name for PO / RO…";
      select.disabled = false;
      hint.textContent = `${names.length} on the lot`;
    }
    select.appendChild(placeholder);

    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    }
    if (previous && names.includes(previous)) select.value = previous;
  }

  async function loadNames() {
    try {
      const response = await runtime.runtime.sendMessage({ type: "lot-last-names" });
      if (!response) return { names: [], status: "error" };
      if (response.needsAuth) return { names: [], status: "auth" };
      if (response.error) return { names: response.names || [], status: "error" };
      const names = Array.isArray(response.names) ? response.names : [];
      return { names, status: "ok" };
    } catch {
      return { names: [], status: "error" };
    }
  }

  async function mount() {
    if (!isCheckoutPath()) {
      const existing = document.getElementById(UI_ID);
      if (existing) existing.remove();
      return;
    }
    const input = findOrderReferenceInput();
    if (!input) return;
    const { names, status } = await loadNames();
    // Prefer content-side normalize if background sent raw labels
    const normalized =
      typeof api.lotLabelsToLastNames === "function" && names.length && typeof names[0] === "object"
        ? api.lotLabelsToLastNames(names)
        : names;
    ensureUi(input, normalized, status);
  }

  function start() {
    mount();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(mount, 45000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }

  const mo = new MutationObserver(() => {
    if (isCheckoutPath() && !document.getElementById(UI_ID)) mount();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
