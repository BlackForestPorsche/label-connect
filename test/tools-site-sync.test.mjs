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
    if (bridgeReachable && hasSession) return "lock_tools";
    return "site_lock_hold";
  }
  if (bridgeReachable && hasSession === false) return "clear_gate";
  if (!bridgeReachable) return "skip_tools";
  if (!hasSession) return "skip_tools";
  if (gatePresent && !forceExchange) return "keep_gate";
  return "exchange";
}

function websiteLockAction({ bridgeReachable, hasSession }) {
  // Always clear Firefox gate + Desk token; lock Tools when bridge is up.
  if (bridgeReachable && hasSession) return "lock_tools_and_clear_gate";
  if (bridgeReachable) return "clear_gate_tools_already_locked";
  return "clear_gate_bridge_down";
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

test("Website lock quiet blocks Tools→site re-exchange", () => {
  assert.equal(
    toolsSiteSyncAction({
      bridgeReachable: true,
      hasSession: true,
      gatePresent: false,
      forceExchange: false,
      siteLockQuiet: true,
    }),
    "lock_tools",
  );
});

test("Website lock quiet holds when Tools already cleared", () => {
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

test("Website lock when Tools already locked still clears gate", () => {
  assert.equal(
    websiteLockAction({ bridgeReachable: true, hasSession: false }),
    "clear_gate_tools_already_locked",
  );
});
