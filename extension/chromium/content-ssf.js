/* global globalThis, chrome, browser */
/**
 * SSF Autoparts checkout helper (same extension as AllData Create RO → Labels).
 * On https://www.ssfautoparts.com/checkout (and /checkout paths):
 * find Order reference / PO # / RO # field and offer a dropdown of
 * On the Lot customer last names. Pick → fill the field.
 *
 * Does not touch AllData Create RO print. Book names are not used.
 */
(function () {
  const api = globalThis.AllDataRoLabels;
  if (!api) return;

  const ROOT_ID = "bf-ssf-lot-names";
  let mountedFor = null;
  let mounted = null;

  function isOrderReferenceField(el) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
    if (el.type === "hidden" || el.disabled || el.readOnly) return false;
    const bits = [
      el.name,
      el.id,
      el.placeholder,
      el.getAttribute("aria-label"),
      el.getAttribute("autocomplete"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (/\b(po|ro|order\s*ref|reference|purchase\s*order)\b/.test(bits)) return true;

    const labelText = labelTextFor(el).toLowerCase();
    return /order\s*reference|po\s*#?\s*\/\s*ro\s*#?|po\s*#|ro\s*#|purchase\s*order/.test(labelText);
  }

  function labelTextFor(el) {
    if (!el) return "";
    const id = el.id;
    if (id) {
      const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lab) return (lab.innerText || lab.textContent || "").replace(/\s+/g, " ").trim();
    }
    const wrap = el.closest("label, .form-group, .field, [class*='form'], tr, li");
    if (!wrap) return "";
    return (wrap.innerText || wrap.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
  }

  function findOrderReferenceField() {
    const candidates = document.querySelectorAll("input, textarea");
    for (const el of candidates) {
      if (isOrderReferenceField(el)) return el;
    }
    // Fallback: label text walk
    for (const lab of document.querySelectorAll("label")) {
      const text = (lab.innerText || lab.textContent || "").replace(/\s+/g, " ").trim();
      if (!/order\s*reference|po\s*#?\s*\/\s*ro|po\s*\/\s*ro/i.test(text)) continue;
      const forId = lab.getAttribute("for");
      if (forId) {
        const el = document.getElementById(forId);
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el;
      }
      const nested = lab.querySelector("input, textarea");
      if (nested) return nested;
    }
    return null;
  }

  function ensureMount(field) {
    if (!field || mountedFor === field) {
      const existing = document.getElementById(ROOT_ID);
      if (existing && field && !field.isConnected) {
        existing.remove();
        mountedFor = null;
      }
      if (mountedFor === field && existing) return existing;
    }
    document.getElementById(ROOT_ID)?.remove();

    const root = document.createElement("div");
    root.id = ROOT_ID;
    Object.assign(root.style, {
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      margin: "6px 0 10px",
      maxWidth: "360px",
      font: "13px/1.35 system-ui, sans-serif",
    });

    const label = document.createElement("label");
    label.textContent = "On the Lot — last name";
    Object.assign(label.style, { color: "#1c1914", fontWeight: "600" });

    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "6px", alignItems: "center" });

    const select = document.createElement("select");
    select.setAttribute("aria-label", "Customer last name from On the Lot");
    Object.assign(select.style, {
      flex: "1",
      minHeight: "32px",
      padding: "4px 8px",
      border: "1px solid #b9b2a4",
      borderRadius: "5px",
      background: "#fff",
      color: "#1c1914",
      font: "inherit",
    });

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "Refresh";
    Object.assign(refresh.style, {
      minHeight: "32px",
      padding: "4px 10px",
      cursor: "pointer",
      border: "1px solid #1f4d2a",
      borderRadius: "5px",
      background: "#1f4d2a",
      color: "#f4f1ea",
      font: "inherit",
      fontWeight: "700",
    });

    const hint = document.createElement("div");
    hint.style.color = "#666";
    hint.style.fontSize = "12px";

    row.append(select, refresh);
    root.append(label, row, hint);

    // Insert after the field or its form-group.
    const host = field.closest(".form-group, .field, [class*='Form'], td, li") || field.parentElement;
    if (host && host.parentElement) {
      host.insertAdjacentElement("afterend", root);
    } else {
      field.insertAdjacentElement("afterend", root);
    }

    select.addEventListener("change", () => {
      const value = select.value;
      if (!value) return;
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      if (api.showToast) api.showToast(`Order reference set to ${value}`, "ok");
    });

    refresh.addEventListener("click", () => {
      void populate(select, hint, refresh, true);
    });

    mountedFor = field;
    mounted = { select, hint, refresh };
    void populate(select, hint, refresh, false);
    return root;
  }

  let loadSerial = 0;
  /** The list is waiting on a login. Only then does a new Desk session reload it. */
  let waitingForLogin = false;
  let lastAutoLoadAt = 0;

  async function populate(select, hint, refresh, forceRefresh) {
    const serial = ++loadSerial;
    waitingForLogin = false;
    const keep = select.value;
    select.disabled = true;
    refresh.disabled = true;
    hint.style.color = "#666";
    hint.textContent = "Loading On the Lot…";

    let result = { names: [] };
    let failed = false;
    try {
      const runtime = typeof browser !== "undefined" ? browser : chrome;
      if (forceRefresh) {
        await runtime.storage.local.remove(["lotLastNames", "lotLastNamesAt"]);
      }
      if (runtime?.runtime?.sendMessage) {
        result = (await runtime.runtime.sendMessage({ type: "lot-last-names" })) || { names: [] };
      } else if (api.loadLotLastNames) {
        result = { names: await api.loadLotLastNames() };
      }
    } catch {
      result = { names: [] };
      failed = true;
    }
    // A newer load (Refresh, or Desk just logged in) owns the list now.
    if (serial !== loadSerial) return;

    const names = result.needsAuth ? [] : Array.isArray(result.names) ? result.names : [];
    select.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = names.length ? "Select last name…" : "No names to pick";
    select.append(placeholder);
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      select.append(opt);
    }
    if (keep && names.includes(keep)) select.value = keep;
    select.disabled = !names.length;
    refresh.disabled = false;

    const problem = (text) => {
      hint.style.color = "#7a1f1f";
      hint.textContent = text;
    };
    if (failed) {
      problem("Desk is restarting. Press Refresh in a moment.");
      return;
    }
    if (result.needsAuth) {
      waitingForLogin = true;
      problem(
        result.message ||
          "Desk is logged out. Unlock Tools or the shop site and the names load by themselves.",
      );
      return;
    }
    if (result.error && !names.length) {
      problem(result.error);
      return;
    }
    if (result.error) {
      problem(`Showing the last list (${names.length}). Couldn’t refresh it just now.`);
      return;
    }
    if (!names.length) {
      hint.textContent = "No cars on the lot right now.";
      return;
    }
    hint.textContent = `${names.length} last name${names.length === 1 ? "" : "s"} from On the Lot`;
  }

  // Logging in (Tools, the shop site, or the popup) loads the names without a Refresh click.
  try {
    const runtime = typeof browser !== "undefined" ? browser : chrome;
    runtime.storage?.onChanged?.addListener?.((changes, area) => {
      if (area && area !== "local") return;
      if (!changes.shopWidgetToken || !changes.shopWidgetToken.newValue) return;
      if (!mounted || !waitingForLogin || !document.getElementById(ROOT_ID)) return;
      // Once per login, never a loop: a session the shop then rejects is not retried here.
      if (Date.now() - lastAutoLoadAt < 5000) return;
      lastAutoLoadAt = Date.now();
      void populate(mounted.select, mounted.hint, mounted.refresh, false);
    });
  } catch {
    // storage events unavailable; Refresh still works
  }

  function tick() {
    if (!/\/checkout/i.test(location.pathname + location.search)) {
      document.getElementById(ROOT_ID)?.remove();
      mountedFor = null;
      mounted = null;
      return;
    }
    const field = findOrderReferenceField();
    if (field) ensureMount(field);
  }

  tick();
  const observer = new MutationObserver(() => tick());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(tick, 1500);
})();
