import test from "node:test";
import assert from "node:assert/strict";

function toolsSiteSyncAction({
  bridgeReachable,
  hasSession,
  gatePresent,
  forceExchange,
  siteLockQuiet,
}) {
  if (siteLockQuiet && !forceExchange) {
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

function lockedSiteRefreshAction({ onUnlockPath, siteLockQuiet }) {
  if (onUnlockPath) return "tools_to_site_only";
  if (siteLockQuiet) return "skip_from_gate_publish";
  return "tools_to_site_and_site_import";
}

test("Locked /unlock refresh does not from-gate publish to Tools", () => {
  assert.equal(
    lockedSiteRefreshAction({ onUnlockPath: true, siteLockQuiet: true }),
    "tools_to_site_only",
  );
});

test("Unlocked shop load may import site gate", () => {
  assert.equal(
    lockedSiteRefreshAction({ onUnlockPath: false, siteLockQuiet: false }),
    "tools_to_site_and_site_import",
  );
});

function toolsLockedGateAction({ gatePresent, unlockHoldActive, siteLockQuiet }) {
  if (gatePresent && unlockHoldActive && !siteLockQuiet) return "keep_site_gate";
  if (gatePresent) return "clear_gate";
  return "already_clear";
}

test("Tools flap keeps Firefox gate during site unlock hold", () => {
  assert.equal(
    toolsLockedGateAction({
      gatePresent: true,
      unlockHoldActive: true,
      siteLockQuiet: false,
    }),
    "keep_site_gate",
  );
});

test("Intentional Tools lock still clears Firefox gate", () => {
  assert.equal(
    toolsLockedGateAction({
      gatePresent: true,
      unlockHoldActive: false,
      siteLockQuiet: false,
    }),
    "clear_gate",
  );
});
