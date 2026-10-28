import test from "node:test";
import assert from "node:assert/strict";
import { GATE, makeWorld } from "./helpers/desk-world.mjs";

/**
 * Tools/extension → shop page.
 * Extension status follows :8788. The shop page follows bf_shop_gate.
 * A gate for someone else must be replaced, and an open shop tab must reload
 * (beforeLoad on /unlock does not read the cookie; other pages cache the person).
 */

test("Tools person replaces a different Firefox gate and reloads the shop tab", async () => {
  const w = makeWorld();
  w.world.jar.set(GATE, "v2.1893456000000.stephen.desk.abc");
  w.toolsUnlock();
  const result = await w.api.syncToolsSessionToSite({
    reloadUnlockTabs: true,
    forceExchange: false,
  });
  assert.equal(result.ok, true);
  assert.notEqual(result.reason, "gate_present");
  assert.equal(w.world.exchanges, 1);
  assert.equal(w.world.jar.get(GATE), "v2.gate");
  assert.deepEqual(w.world.reloads, [1]);
});

test("same Tools person keeps the Firefox gate", async () => {
  const w = makeWorld();
  w.world.jar.set(GATE, "v2.1893456000000.logan.desk.abc");
  w.toolsUnlock();
  const result = await w.api.syncToolsSessionToSite({
    reloadUnlockTabs: true,
    forceExchange: false,
  });
  assert.equal(result.reason, "gate_present");
  assert.equal(w.world.exchanges, 0);
  assert.equal(w.world.reloads.length, 0);
  assert.equal(w.world.jar.get(GATE), "v2.1893456000000.logan.desk.abc");
});

test("no Firefox gate reloads the open shop page, not only /unlock", async () => {
  const w = makeWorld();
  w.toolsUnlock();
  const result = await w.api.syncToolsSessionToSite({
    reloadUnlockTabs: true,
    forceExchange: false,
  });
  assert.equal(result.ok, true);
  assert.equal(w.gate(), true);
  assert.deepEqual(w.world.reloads, [1]);
});

test("/unlock tab is sent home after Tools fills an empty gate", async () => {
  const w = makeWorld();
  w.world.tabs = [{ id: 7, url: "https://shop.blackforestautomotive.com/unlock?next=/lot" }];
  w.toolsUnlock();
  const result = await w.api.syncToolsSessionToSite({
    reloadUnlockTabs: true,
    forceExchange: false,
  });
  assert.equal(result.ok, true);
  assert.equal(w.gate(), true);
  assert.deepEqual(w.world.tabUpdates, [
    { id: 7, url: "https://shop.blackforestautomotive.com/" },
  ]);
  assert.equal(w.world.reloads.length, 0);
});
