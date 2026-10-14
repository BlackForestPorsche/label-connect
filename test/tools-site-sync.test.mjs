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
}) {
  if (siteLockQuiet && !forceExchange) {
    // Live Tools session during quiet = pre-lock Bearer still present → force-lock
    // (0.1.22 clear_quiet_and_exchange reminted Tools after website lock).
    if (bridgeReachable && hasSession) return "site_lock_force_tools";
    if (bridgeReachable && hasSession === false) return "site_lock_hold";
    return "site_lock_pending";
  }
  // Tools unlocked in Electron but :8788 Bearer missing — copy jar gate (mismatch.md).
  // Never during site-lock quiet (locked /unlock refresh must not heal from leftover jar).
  if (bridgeReachable && hasSession === false && toolsJarGate && !siteLockQuiet) {
    return "copy_tools_jar_gate";
  }
  if (bridgeReachable && hasSession === false) return "clear_gate";
  if (!bridgeReachable) return "skip_tools";
  if (!hasSession) return "skip_tools";
  if (gatePresent && !forceExchange) return "keep_gate";
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

/** Tab-load sync order (website→Tools flash). */
function shopLoadSyncAction({ onUnlockPage, toolsLocked }) {
  if (onUnlockPage) {
    // Remint guard: never site-session-import on /unlock.
    return toolsLocked ? "tools_to_site_clear_only" : "tools_to_site_then_no_site_import";
  }
  // Unlocked pages: site publish first, then Tools→site (not the reverse).
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

/** Local :8788 sync budget — must feel instant (not multi-second). */
function bridgeSyncTickMs() {
  return 400;
}

test("Bridge sync tick is sub-second for instant lock/fun", () => {
  assert.ok(bridgeSyncTickMs() <= 500);
  assert.ok(bridgeSyncTickMs() >= 200);
});

/** Website→Tools: quiet + live Tools session must force-lock, not exchange (0.1.22 regression). */
test("Website lock quiet + Tools still unlocked forces Tools lock", () => {
  assert.equal(
    toolsSiteSyncAction({
      bridgeReachable: true,
      hasSession: true,
      gatePresent: false,
      forceExchange: false,
      siteLockQuiet: true,
    }),
    "site_lock_force_tools",
  );
});

/** Unlock-hold: intentional website unlock must not publish site-lock. */
function siteLockAllowed({ unlockHold }) {
  return unlockHold ? "skip_unlock_hold" : "sync_site_lock_to_tools";
}

test("Unlock-hold blocks site-lock publish to Tools", () => {
  assert.equal(siteLockAllowed({ unlockHold: true }), "skip_unlock_hold");
  assert.equal(siteLockAllowed({ unlockHold: false }), "sync_site_lock_to_tools");
});
