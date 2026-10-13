/* global globalThis, chrome, browser */
/**
 * On the Lot → customer last names for SSF checkout PO/RO dropdown.
 * Book appointments are intentionally out of scope (Logan).
 *
 * Sources (first hit wins):
 * 1. storage.local.lotLastNames — cached / manually seeded list
 * 2. GET {shopBase}/api/widget/views/lot with Bearer shopWidgetToken
 *    (same widget contract as Black Forest Tools / plasmoid)
 * Empty list → UI shows stub empty state; never invents names.
 */
(function (root) {
  const api = root.AllDataRoLabels || (root.AllDataRoLabels = {});
  const runtime = typeof browser !== "undefined" ? browser : chrome;

  function extractLastName(fullName) {
    const text = String(fullName || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || /^no name$/i.test(text)) return "";
    const parts = text.split(" ").filter(Boolean);
    return (parts[parts.length - 1] || text).slice(0, 40);
  }

  function uniqueSorted(names) {
    const seen = new Set();
    const out = [];
    for (const name of names) {
      const clean = String(name || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clean);
    }
    return out.sort((a, b) => a.localeCompare(b));
  }

  function lastNamesFromLotPayload(data) {
    const items = Array.isArray(data?.items) ? data.items : [];
    return uniqueSorted(items.map((item) => extractLastName(item?.label || item?.owner || item?.customer || "")));
  }

  async function readStorage() {
    try {
      return await runtime.storage.local.get(["lotLastNames", "shopWidgetToken", "shopBaseUrl"]);
    } catch {
      return {};
    }
  }

  /** Page/content scripts ask the background so shop fetch uses extension host perms. */
  async function loadLotLastNames() {
    if (runtime?.runtime?.sendMessage) {
      try {
        const response = await runtime.runtime.sendMessage({ type: "lot-last-names" });
        if (response && Array.isArray(response.names)) return response.names;
      } catch {
        // fall through to local read
      }
    }
    const stored = await readStorage();
    if (Array.isArray(stored.lotLastNames) && stored.lotLastNames.length) {
      return uniqueSorted(stored.lotLastNames);
    }
    return [];
  }

  /** Background-only resolution. */
  async function resolveLotLastNames() {
    const stored = await readStorage();
    if (Array.isArray(stored.lotLastNames) && stored.lotLastNames.length) {
      return { names: uniqueSorted(stored.lotLastNames), source: "storage" };
    }
    const token = typeof stored.shopWidgetToken === "string" ? stored.shopWidgetToken.trim() : "";
    if (!token) {
      return { names: [], source: "empty", message: "No On the Lot names yet. Unlock shop / set shopWidgetToken." };
    }
    const base = (typeof stored.shopBaseUrl === "string" && stored.shopBaseUrl.trim()) || api.DEFAULT_SHOP_BASE;
    const url = `${base.replace(/\/$/, "")}/api/widget/views/lot`;
    let response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
    } catch {
      return { names: [], source: "error", message: "Could not reach shop On the Lot." };
    }
    if (!response.ok) {
      return { names: [], source: "error", message: `Lot request failed (${response.status}).` };
    }
    let data;
    try {
      data = await response.json();
    } catch {
      return { names: [], source: "error", message: "Lot response was not JSON." };
    }
    const names = lastNamesFromLotPayload(data);
    if (names.length) {
      try {
        await runtime.storage.local.set({ lotLastNames: names, lotLastNamesAt: new Date().toISOString() });
      } catch {
        // cache optional
      }
    }
    return { names, source: "lot-api" };
  }

  api.extractLastName = api.extractLastName || extractLastName;
  api.loadLotLastNames = loadLotLastNames;
  api.resolveLotLastNames = resolveLotLastNames;
  api.lastNamesFromLotPayload = lastNamesFromLotPayload;
})(globalThis);
