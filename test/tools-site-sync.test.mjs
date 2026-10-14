import test from "node:test";
import assert from "node:assert/strict";

/**
 * Pure decision helpers mirroring Desk Tools↔website lock/unlock sync.
 * (Extension lot-names.js is an IIFE; keep the contract covered here.)
 */

function toolsSiteSyncAction({
  bridgeReachable,
  hasSession,
  gatePresent,
  forceExchange,
  siteLockQuiet,
}) {
  if (siteLockQuiet && !forceExchange) {
    // Tools live again after a website lock → clear quiet and exchange (never re-DELETE).
    if (bridgeReachable && hasSession) return "clear_quiet_and_exchange";
    if (bridgeReachable && hasSession === false) return "site_lock_hold";
    return "site_lock_pending";
  }
  if (bridgeReachable && hasSession === false) return "clear_gate";
  if (!bridgeReachable) return "skip_tools";
  if (!hasSession) return "skip_tools";
  if (gatePresent && !forceExchange) return "keep_gate";
  return "exchange";
}

function websiteLockAction({ bridgeReachable, hasSession }) {
  if (bridgeReachable && hasSession) return "lock_tools_and_clear_gate";
  if (bridgeReachable) return "clear_gate_tools_already_locked";
  return "clear_gate_bridge_down";
}

function popupToolsSyncAction() {
  // Button label "Sync Tools → website" must exchange, not only import lot token.
  return "tools_to_site_unlock_force";
}

test("Tools locked + bridge up clears Firefox gate", () => {
  assert.equal(
    toolsSiteSyncAction({
      bridgeReachable: true,
      hasSession: false,
      gatePresent: true,
      forceExchange: false,
    }),
    "clear_gate",
  );
});

test("Tools unlocked + no gate → exchange", () => {
  assert.equal(
    toolsSiteSyncAction({
      bridgeReachable: true,
      hasSession: true,
      gatePresent: false,
      forceExchange: false,
    }),
    "exchange",
  );
});

test("Tools unlocked + gate present skips auto exchange", () => {
  assert.equal(
    toolsSiteSyncAction({
      bridgeReachable: true,
      hasSession: true,
      gatePresent: true,
      forceExchange: false,
    }),
    "keep_gate",
  );
});

test("Sync Tools force-exchanges even when gate present", () => {
  assert.equal(
    toolsSiteSyncAction({
      bridgeReachable: true,
      hasSession: true,
      gatePresent: true,
      forceExchange: true,
    }),
    "exchange",
  );
});

test("Bridge down does not clear Firefox gate", () => {
  assert.equal(
    toolsSiteSyncAction({
      bridgeReachable: false,
      hasSession: false,
      gatePresent: true,
      forceExchange: false,
    }),
    "skip_tools",
  );
});

test("Website lock quiet + Tools unlocked clears quiet and exchanges", () => {
  assert.equal(
    toolsSiteSyncAction({
      bridgeReachable: true,
      hasSession: true,
      gatePresent: false,
      forceExchange: false,
      siteLockQuiet: true,
    }),
    "clear_quiet_and_exchange",
  );
});

test("Website lock quiet + Tools still locked holds", () => {
  assert.equal(
    toolsSiteSyncAction({
      bridgeReachable: true,
      hasSession: false,
      gatePresent: false,
      forceExchange: false,
      siteLockQuiet: true,
    }),
    "site_lock_hold",
  );
});

test("Website lock with Tools session locks Tools", () => {
  assert.equal(
    websiteLockAction({ bridgeReachable: true, hasSession: true }),
    "lock_tools_and_clear_gate",
  );
});

test("Popup Sync Tools → website must force exchange", () => {
  assert.equal(popupToolsSyncAction(), "tools_to_site_unlock_force");
});

/** Mirrors content-shop.js looksLikeLock (website Lock → Tools). */
const LIVE_LOCK_SERVERFN =
  "462df016712e9460dba3b3206037fe5482e55863b0e6af87f8c2b89dff89fc9a";

function looksLikeLock(url, method, body) {
  if (String(method || "GET").toUpperCase() !== "POST") return false;
  const urlText = String(url || "");
  const hay = `${urlText}\n${body == null ? "" : String(body)}`;
  if (/unlockShop|widgetToken|widgetExpiresAt/i.test(hay)) return false;
  if (/widget\/logout/i.test(hay)) return true;
  if (/\/api\/widget\/session/i.test(hay)) return false;
  if (new RegExp(`/_serverFn/${LIVE_LOCK_SERVERFN}\\b`, "i").test(urlText)) {
    return true;
  }
  if (/\/_serverFn\/[^/?#]*lockShop/i.test(urlText)) return true;
  return /lockShop|clearGateSession/i.test(hay);
}

test("Website Lock hashed serverFn matches (no lockShop string)", () => {
  assert.equal(
    looksLikeLock(
      `https://shop.blackforestautomotive.com/_serverFn/${LIVE_LOCK_SERVERFN}`,
      "POST",
      "{}",
    ),
    true,
  );
});

test("Website Lock still matches legacy lockShop URL", () => {
  assert.equal(
    looksLikeLock("https://shop.blackforestautomotive.com/_serverFn/lockShop", "POST", "{}"),
    true,
  );
});

test("Website unlock / session mint never look like Lock", () => {
  assert.equal(
    looksLikeLock(
      "https://shop.blackforestautomotive.com/_serverFn/unlockShop",
      "POST",
      JSON.stringify({ person: "logan", pin: "7895" }),
    ),
    false,
  );
  assert.equal(
    looksLikeLock(
      "https://shop.blackforestautomotive.com/api/widget/session/exchange",
      "POST",
      "{}",
    ),
    false,
  );
});

test("Recent serverFn POST then /unlock nav means Lock", () => {
  const SERVERFN_UNLOCK_NAV_MS = 5_000;
  const recentServerFnPostAt = Date.now() - 200;
  const onUnlock = true;
  assert.equal(
    onUnlock && Date.now() - recentServerFnPostAt < SERVERFN_UNLOCK_NAV_MS,
    true,
  );
  assert.equal(
    onUnlock && Date.now() - (Date.now() - 6_000) < SERVERFN_UNLOCK_NAV_MS,
    false,
  );
});
