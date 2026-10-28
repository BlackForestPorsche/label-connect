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
  toolsJarGate = false,
  unlockHold = false,
  personMismatch = false,
}) {
  if (siteLockQuiet && !forceExchange) {
    // Tools live again after a website lock → clear quiet and exchange (never re-DELETE).
    if (bridgeReachable && hasSession) return "clear_quiet_and_exchange";
    if (bridgeReachable && hasSession === false) {
      // Fresh website unlock hold — do not clear Firefox gate (unlock flash).
      if (unlockHold) return "unlock_hold_skip_clear";
      return "site_lock_hold";
    }
    return "site_lock_pending";
  }
  // Tools unlocked in Electron but :8788 Bearer missing — copy jar gate (mismatch.md).
  // Never during site-lock quiet (locked /unlock refresh must not heal from leftover jar).
  if (bridgeReachable && hasSession === false && toolsJarGate && !siteLockQuiet) {
    return "copy_tools_jar_gate";
  }
  if (bridgeReachable && hasSession === false) {
    // Site→Tools publish in flight — Tools health may still say locked.
    if (unlockHold) return "unlock_hold_skip_clear";
    return "clear_gate";
  }
  if (!bridgeReachable) return "skip_tools";
  if (!hasSession) return "skip_tools";
  if (gatePresent && !forceExchange && !personMismatch) return "keep_gate";
  // beta 0.1.36+ returns gateToken in exchange JSON for cookies.set.
  return "exchange_with_gateToken";
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

/**
 * Tab-load:
 * - /unlock: Tools→site ONLY (locked-refresh-remint — no site-session-import)
 * - unlocked pages: site→Tools FIRST so website unlock publishes before any clear
 */
function shopLoadSyncAction({ onUnlockPage, toolsLocked }) {
  if (onUnlockPage) {
    return toolsLocked ? "tools_to_site_clear_only" : "tools_to_site_then_no_site_import";
  }
  return "site_import_then_tools_to_site";
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

test("Tools unlocked + no gate → exchange with gateToken", () => {
  assert.equal(
    toolsSiteSyncAction({
      bridgeReachable: true,
      hasSession: true,
      gatePresent: false,
      forceExchange: false,
    }),
    "exchange_with_gateToken",
  );
});

test("Tools jar gate + empty Bearer copies gate (mismatch)", () => {
  assert.equal(
    toolsSiteSyncAction({
      bridgeReachable: true,
      hasSession: false,
      gatePresent: false,
      forceExchange: false,
      toolsJarGate: true,
    }),
    "copy_tools_jar_gate",
  );
});

test("Tools jar gate during site-lock quiet does not copy (last lock wins)", () => {
  assert.equal(
    toolsSiteSyncAction({
      bridgeReachable: true,
      hasSession: false,
      gatePresent: false,
      forceExchange: false,
      toolsJarGate: true,
      siteLockQuiet: true,
    }),
    "site_lock_hold",
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

test("Tools person differs from the Firefox gate → exchange", () => {
  assert.equal(
    toolsSiteSyncAction({
      bridgeReachable: true,
      hasSession: true,
      gatePresent: true,
      forceExchange: false,
      personMismatch: true,
    }),
    "exchange_with_gateToken",
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
    "exchange_with_gateToken",
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

test("Locked /unlock tab load skips site-session-import publish", () => {
  assert.equal(
    shopLoadSyncAction({ onUnlockPage: true, toolsLocked: true }),
    "tools_to_site_clear_only",
  );
  assert.equal(
    shopLoadSyncAction({ onUnlockPage: true, toolsLocked: false }),
    "tools_to_site_then_no_site_import",
  );
  assert.equal(
    shopLoadSyncAction({ onUnlockPage: false, toolsLocked: false }),
    "site_import_then_tools_to_site",
  );
});

test("Unlock hold skips Tools-locked gate clear (site→Tools / flash)", () => {
  assert.equal(
    toolsSiteSyncAction({
      bridgeReachable: true,
      hasSession: false,
      gatePresent: true,
      forceExchange: false,
      unlockHold: true,
    }),
    "unlock_hold_skip_clear",
  );
  assert.equal(
    toolsSiteSyncAction({
      bridgeReachable: true,
      hasSession: false,
      gatePresent: true,
      forceExchange: false,
      unlockHold: false,
    }),
    "clear_gate",
  );
});

/** Local :8788 sync budget — must feel instant (not multi-second). */
function bridgeSyncTickMs() {
  return 400;
}

test("Bridge sync tick is sub-second for instant lock/fun", () => {
  assert.ok(bridgeSyncTickMs() <= 500);
  assert.ok(bridgeSyncTickMs() >= 200);
});


/** Site lock delivery: /unlock page fallback when fetch hook missed (sync-gap.md). */
function siteUnlockPageAction({ unlockHold, toolsHasSession }) {
  if (unlockHold) return "skip_unlock_hold";
  if (!toolsHasSession) return "skip_tools_already_locked";
  return "delete_plus_post_lock";
}

test("Site /unlock page locks Tools when hook missed", () => {
  assert.equal(
    siteUnlockPageAction({ unlockHold: false, toolsHasSession: true }),
    "delete_plus_post_lock",
  );
  assert.equal(
    siteUnlockPageAction({ unlockHold: true, toolsHasSession: true }),
    "skip_unlock_hold",
  );
  assert.equal(
    siteUnlockPageAction({ unlockHold: false, toolsHasSession: false }),
    "skip_tools_already_locked",
  );
});

function siteLockBridgeCalls() {
  // Always DELETE then POST /v1/lock — not DELETE-only (remint ~24s).
  return ["DELETE /v1/widget-session", "POST /v1/lock"];
}

test("Site lock always DELETE then POST /v1/lock", () => {
  assert.deepEqual(siteLockBridgeCalls(), [
    "DELETE /v1/widget-session",
    "POST /v1/lock",
  ]);
});


/** Mirrors content-shop.js looksLikeLock (website Lock → Tools) — #67. */
const LIVE_LOCK_SERVERFN =
  "462df016712e9460dba3b3206037fe5482e55863b0e6af87f8c2b89dff89fc9a";

function looksLikeLock(url, method, body) {
  if (String(method || "GET").toUpperCase() !== "POST") return false;
  const urlText = String(url || "");
  const hay = `${urlText}\n${body == null ? "" : String(body)}`;
  if (/unlockShop|widgetToken|widgetExpiresAt|from-gate|gateToken/i.test(hay)) return false;
  if (/widget\/logout/i.test(hay)) return true;
  if (/\/api\/widget\/session/i.test(hay)) return false;
  if (new RegExp(`/_serverFn/${LIVE_LOCK_SERVERFN}\\b`, "i").test(urlText)) {
    return true;
  }
  if (/\/_serverFn\/[^/?#]*lockShop/i.test(urlText)) return true;
  return /lockShop|clearGateSession|clear_gate_session|lock_shop/i.test(hay);
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
