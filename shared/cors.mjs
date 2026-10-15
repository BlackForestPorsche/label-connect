export const SHOP_ORIGINS = new Set(["https://shop.blackforestautomotive.com"]);

/**
 * Read-only status for the shop's /labels tile. Only the shop origin, only
 * GET /api/printer and the dry-run print-ro preview. Real prints stay same-origin
 * or via the Desk extension (Lock/gate never goes through this server).
 */
export function corsAllowed(origin, method, pathname, query) {
  if (!SHOP_ORIGINS.has(origin)) return false;
  if (pathname === "/api/printer") return method === "GET" || method === "OPTIONS";
  if (pathname === "/api/print-ro") {
    const dry = query.get("dryRun") === "1" || query.get("dryRun") === "true";
    return dry && (method === "POST" || method === "OPTIONS");
  }
  return false;
}
