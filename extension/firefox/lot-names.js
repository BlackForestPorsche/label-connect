/* global globalThis */
/**
 * On the Lot last-name helpers for SSF checkout.
 * Never reads book-today — only lot labels (cars.owner).
 */
(function (root) {
  const api = root.AllDataRoLabels || (root.AllDataRoLabels = {});

  function lastNameFromLotLabel(label) {
    const text = String(label || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || /^no\s*name$/i.test(text)) return "";
    // "LAST, FIRST" → LAST
    if (text.includes(",")) {
      const head = text.split(",")[0].trim();
      if (head) return head;
    }
    const parts = text.split(" ").filter(Boolean);
    return parts[parts.length - 1] || "";
  }

  function lotLabelsToLastNames(items) {
    const seen = new Set();
    const names = [];
    for (const item of items || []) {
      const label = item && typeof item === "object" ? item.label : item;
      const last = lastNameFromLotLabel(label);
      if (!last) continue;
      const key = last.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(last);
    }
    names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    return names;
  }

  api.lastNameFromLotLabel = lastNameFromLotLabel;
  api.lotLabelsToLastNames = lotLabelsToLastNames;
})(globalThis);
