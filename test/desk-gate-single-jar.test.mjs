import test from "node:test";
import assert from "node:assert/strict";

/**
 * The shop gate is one first-party cookie, the same one the site sets and clears.
 * Desk 0.1.47 to 0.1.51 also wrote a copy into the partitioned jar. Chromium never removed
 * that copy (a remove needs the full partition key), so a lock left the site signed in.
 */

import { GATE, PARTITION_SITE, makeWorld } from "./helpers/desk-world.mjs";

const GAP = 10_000;
const HOUR = 3_600_000;

function oldDeskCopy(w, value = "v2.old") {
  w.world.partitioned.set(PARTITION_SITE, {
    value,
    expirationDate: Math.floor((Date.now() + HOUR) / 1000) + 400_000_000,
    partitionKey: { topLevelSite: PARTITION_SITE, hasCrossSiteAncestor: false },
  });
}

async function reboot(w) {
  delete w.world.storage.deskGateJarSettled;
  w.boot();
  await w.api.latchReady;
  await w.settle();
}

test("Tools unlock writes one first-party gate, never a partitioned copy", async () => {
  const w = makeWorld();
  await w.run(1_000);
  w.toolsUnlock();
  await w.run(GAP);
  assert.equal(w.gate(), true);
  assert.equal(w.world.partitioned.size, 0);
  assert.ok(w.world.cookieSets.length > 0);
  assert.ok(w.world.cookieSets.every((jar) => jar === "first-party"), w.world.cookieSets.join(","));
});

test("Tools lock removes a partitioned copy even when the browser wants the exact key", async () => {
  const w = makeWorld();
  w.world.exactPartitionKeys = true;
  await w.run(1_000);
  w.toolsUnlock();
  await w.run(GAP);
  oldDeskCopy(w);

  w.toolsLock();
  await w.run(GAP);
  assert.equal(w.gate(), false, "first-party gate cleared");
  assert.equal(w.world.partitioned.size, 0, "partitioned copy cleared");
  assert.equal((await w.api.listShopGateCookies()).length, 0);
});

test("a new unlock sweeps a copy left by an older Desk", async () => {
  const w = makeWorld();
  w.world.exactPartitionKeys = true;
  await w.run(1_000);
  w.world.storage.deskGateJarSettled = 1;
  oldDeskCopy(w);
  w.toolsUnlock();
  await w.run(GAP);
  assert.equal(w.gate(), true);
  assert.equal(w.world.partitioned.size, 0);
});

test("upgrade: a duplicate gate becomes the single first-party one", async () => {
  const w = makeWorld();
  w.world.exactPartitionKeys = true;
  await w.run(1_000);
  w.toolsUnlock();
  await w.run(GAP);
  const gate = w.world.jar.get(GATE);
  oldDeskCopy(w);

  await reboot(w);
  assert.equal(w.world.jar.get(GATE), gate, "the site's own gate is untouched");
  assert.equal(w.world.partitioned.size, 0);
  assert.equal(w.world.storage.deskGateJarSettled, 1);
});

test("upgrade while signed in: a gate that only exists as the old copy moves over", async () => {
  const w = makeWorld();
  await w.run(1_000);
  w.toolsUnlock();
  await w.run(GAP);
  w.world.jar.delete(GATE);
  w.world.jarExp.delete(GATE);
  oldDeskCopy(w, "v2.kept");

  await reboot(w);
  assert.equal(w.world.jar.get(GATE), "v2.kept", "site stays signed in");
  assert.equal(w.world.partitioned.size, 0);
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, true, "the clean-up is not read as a website Lock");
});

test("upgrade while signed out: a leftover copy is removed and signs nobody in", async () => {
  const w = makeWorld();
  await w.run(1_000);
  oldDeskCopy(w);

  await reboot(w);
  assert.equal(w.gate(), false);
  assert.equal(w.world.partitioned.size, 0);
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, false, "Tools stays locked");
  assert.equal(w.gate(), false);
});

test("upgrade while latched: a leftover copy is removed and the lock holds", async () => {
  const w = makeWorld();
  await w.run(1_000);
  w.toolsUnlock();
  await w.run(GAP);
  await w.siteLock();
  await w.run(GAP);
  assert.ok(w.api.siteLatchState(), "latched after the website Lock");
  oldDeskCopy(w);

  await reboot(w);
  assert.equal(w.gate(), false);
  assert.equal(w.world.partitioned.size, 0);
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, false);
  assert.ok(w.api.siteLatchState(), "latch still engaged");
});

test("the one-time clean-up runs once", async () => {
  const w = makeWorld();
  await w.run(1_000);
  assert.equal(w.world.storage.deskGateJarSettled, 1);
  oldDeskCopy(w);
  w.boot();
  await w.api.latchReady;
  await w.settle();
  assert.equal(w.world.partitioned.size, 1, "a later start does not touch the jar on its own");
});
