import test from "node:test";
import assert from "node:assert/strict";

/** The popup's read of Tools must only read: no effect on the unlock hold or the lock latch. */

import { makeWorld } from "./helpers/desk-world.mjs";

test("readToolsStatus tells not running, locked and unlocked apart", async () => {
  const w = makeWorld();
  await w.run(800);
  w.world.bridgeDown = true;
  assert.deepEqual({ ...(await w.api.readToolsStatus()) }, { reachable: false, hasSession: false, person: "" });
  w.world.bridgeDown = false;
  assert.deepEqual({ ...(await w.api.readToolsStatus()) }, { reachable: true, hasSession: false, person: "" });
  w.toolsUnlock();
  assert.deepEqual({ ...(await w.api.readToolsStatus()) }, { reachable: true, hasSession: true, person: "logan" });
});

test("readToolsStatus leaves the unlock hold and the latch alone", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(10_000);
  await w.siteLock();
  await w.run(2_000);
  const latch = { ...w.api.siteLatchState() };
  assert.ok(latch, "latched by the website Lock");

  w.api.armUnlockHold();
  assert.equal(w.api.unlockHoldActive(), true);
  w.toolsUnlock();
  await w.api.readToolsStatus();
  assert.equal(w.api.unlockHoldActive(), true, "the hold is not cut short by a popup read");
  assert.deepEqual({ ...w.api.siteLatchState() }, latch, "the latch is not touched by a popup read");
});
