import test from "node:test";
import assert from "node:assert/strict";

/**
 * Pure decision helpers mirroring Desk 0.1.17 Tools→website unlock.
 * (Extension lot-names.js is an IIFE; keep the contract covered here.)
 */

function toolsSiteSyncAction({
  bridgeReachable,
  hasSession,
  gatePresent,
  forceExchange,
}) {
  if (bridgeReachable && hasSession === false) return "clear_gate";
  if (!bridgeReachable) return "skip_tools";
  if (!hasSession) return "skip_tools";
  if (gatePresent && !forceExchange) return "keep_gate";
  return "exchange";
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
