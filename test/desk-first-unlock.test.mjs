import test from "node:test";
import assert from "node:assert/strict";
import { GATE, makeWorld } from "./helpers/desk-world.mjs";

/**
 * First sign-in must stick. Symptom (Logan, Manjaro): sign in once → UI flashes and
 * locks → sign in a second time → clear everywhere. A gate or /unlock page that was
 * never evidence of a website Lock of THIS Tools session must not lock Tools.
 */

const GAP = 10_000;
const T0 = 1_800_000_000_000;
const EIGHT_PM = 1_800_072_000_000;
const HOUR = 3_600_000;

async function signedInThenOvernight(w) {
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  assert.equal(w.gate(), true);
  w.world.jarExp.set(GATE, EIGHT_PM / 1000);
  await w.api.readShopGateCookie();
  // Desk was not running through the 8pm shop lock: the cookie vanished with no event.
  w.world.jar.delete(GATE);
  w.world.jarExp.delete(GATE);
  w.toolsLock();
  await w.advance(EIGHT_PM - T0 + 12 * HOUR);
}

test("morning first sign-in after an unobserved 8pm gate expiry sticks even when the first exchange fails", async () => {
  const w = makeWorld();
  await signedInThenOvernight(w);
  w.toolsUnlock();
  w.boot();
  w.world.exchangeFails = 1;
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, true, "Tools stays signed in");
  assert.equal(w.gate(), true, "site gets its gate on the first sign-in");
  assert.equal(w.api.siteLatchState(), null, "no sticky lock engaged");
  await w.run(60_000);
  assert.equal(w.world.tools.hasSession, true);
  assert.equal(w.gate(), true);
});

test("a gate seen under an older Tools session is stale: a shop-tab load racing the first sign-in does not lock", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  const firstId = w.world.tools.sessionId;
  w.world.jar.delete(GATE);
  w.world.jarExp.delete(GATE);
  w.toolsLock();
  await w.advance(5 * 60_000);
  w.toolsUnlock();
  assert.notEqual(w.world.tools.sessionId, firstId);
  w.boot();
  const tabLoad = w.api.syncToolsSessionToSite({ reloadUnlockTabs: true, forceExchange: false });
  await w.run(GAP);
  await tabLoad;
  assert.equal(w.world.tools.hasSession, true);
  assert.equal(w.gate(), true);
  assert.equal(w.api.siteLatchState(), null);
});

test("an /unlock tab landing before the first sign-in reaches the site does not lock Tools", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  const health = await w.api.probeToolsBridgeHealth();
  assert.equal(health.hasSession, true);
  assert.equal(w.gate(), false, "site gate not minted yet");

  const result = await w.api.handleSiteUnlockPage();
  assert.equal(result.skipped, "not_a_lock");
  assert.equal(w.world.tools.hasSession, true, "Tools untouched");
  assert.equal(w.api.siteLatchState(), null);

  await w.run(GAP);
  assert.equal(w.gate(), true);
  assert.equal(w.world.tools.hasSession, true);
});

test("the reloaded /unlock tab seconds after the exchange does not lock Tools", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(800);
  assert.equal(w.gate(), true);
  w.world.jar.delete(GATE);
  w.world.jarExp.delete(GATE);

  const racing = await w.api.handleSiteUnlockPage();
  assert.equal(racing.ok, true);
  assert.equal(racing.skipped, "not_a_lock");
  assert.equal(w.world.tools.hasSession, true);

  w.world.jar.set(GATE, "v2.gate");
  const present = await w.api.handleSiteUnlockPage();
  assert.equal(present.skipped, "gate_present");
  assert.equal(w.world.tools.hasSession, true);
});

test("cookie overwrite during the first exchange (remove → add) does not lock Tools", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(800);
  w.world.jar.delete(GATE);
  const result = await w.api.handleGateCookieRemoved({ cause: "overwrite" });
  assert.equal(result.skipped, "gate_overwrite");
  assert.equal(w.world.tools.hasSession, true);
  assert.equal(w.api.siteLatchState(), null);
});

test("a deliberate site Lock whose hook never fired still locks Tools via /unlock", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  w.world.jar.delete(GATE);
  w.world.jarExp.delete(GATE);
  await w.advance(GAP);

  const result = await w.api.handleSiteUnlockPage();
  assert.equal(result.locked, true);
  assert.equal(w.world.tools.hasSession, false);
  assert.notEqual(w.api.siteLatchState(), null);
});

test("a deliberate site Lock noticed only by the poll still locks Tools (same session)", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  w.world.jar.delete(GATE);
  w.world.jarExp.delete(GATE);
  w.boot();
  await w.api.tryAutoUnlock({ force: false, reason: "shop-tab-complete" });
  await w.run(5_000);
  assert.equal(w.world.tools.hasSession, false);
  assert.equal(w.gate(), false);
});

test("site PIN first unlock with an /unlock tab still open never locks Tools", async () => {
  const w = makeWorld();
  await w.run(800);
  await w.siteUnlockPageLoad();
  await w.api.noteGateCookieAdded();
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, true, "Tools follows the site unlock");
  const result = await w.api.handleSiteUnlockPage();
  assert.equal(result.skipped, "gate_present");
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, true);
  assert.equal(w.gate(), true);
});
