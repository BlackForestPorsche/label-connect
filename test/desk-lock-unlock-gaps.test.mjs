import test from "node:test";
import assert from "node:assert/strict";

/**
 * Runs the real extension/shared/lot-names.js against a fake Tools bridge, fake
 * shop and fake clock, then walks lock/unlock in both directions with 10s gaps.
 */

import { GATE, makeWorld } from "./helpers/desk-world.mjs";

const GAP = 10_000;

test("10s gaps: Tools unlock → Tools lock → site unlock → site lock → Tools unlock → site lock", async () => {
  const w = makeWorld();
  await w.run(1_000);
  assert.equal(w.gate(), false);

  w.toolsUnlock();
  await w.run(GAP);
  assert.equal(w.gate(), true, "Tools unlock → site gets gate");

  w.toolsLock();
  await w.run(GAP);
  assert.equal(w.gate(), false, "Tools lock → site gate cleared (10s after unlock)");

  await w.siteUnlockPageLoad();
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, true, "site unlock → Tools unlocked");
  assert.equal(w.gate(), true, "site unlock must not be cleared by Desk");

  await w.siteLock();
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, false, "site lock → Tools locked (10s after unlock)");
  assert.equal(w.gate(), false);

  w.toolsUnlock();
  await w.run(GAP);
  assert.equal(w.gate(), true, "Tools unlock after site lock → site gets gate");

  await w.siteLock();
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, false, "site lock again → Tools locked");
});

test("Tools lock 10s after a site unlock clears the site gate", async () => {
  const w = makeWorld();
  await w.run(800);
  await w.siteUnlockPageLoad();
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, true);
  w.toolsLock();
  await w.run(GAP);
  assert.equal(w.gate(), false);
});

test("site lock 10s after a Tools unlock locks Tools", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  assert.equal(w.gate(), true);
  await w.siteLock();
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, false);
});

test("site unlock 10s after a Tools lock unlocks Tools and keeps the gate", async () => {
  const w = makeWorld();
  w.toolsUnlock();
  await w.run(2_000);
  w.toolsLock();
  await w.run(GAP);
  assert.equal(w.gate(), false);
  await w.siteUnlockPageLoad();
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, true);
  assert.equal(w.gate(), true);
});

test("a fresh site unlock is not cleared while Tools is still catching up", async () => {
  const w = makeWorld();
  await w.run(800);
  w.world.dropPublish = true;
  await w.siteUnlockPageLoad();
  await w.run(5_000);
  assert.equal(w.gate(), true, "hold protects the unlock until Tools reflects it");
  w.world.dropPublish = false;
  await w.api.publishSessionToToolsBridge({ token: "t-fresh", expiresAt: new Date().toISOString(), person: "logan" });
  await w.run(1_000);
  assert.equal(w.world.tools.hasSession, true);
  assert.equal(w.gate(), true);
});

test("Tools lock replays after a lock edge landed inside the hold", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(1_200);
  w.api.armUnlockHold();
  w.world.tools.hasSession = false;
  await w.api.tickBridgeSyncPoll();
  assert.equal(w.gate(), true, "still held");
  await w.advance(40_000);
  await w.run(1_200);
  assert.equal(w.gate(), false, "edge replayed after hold ended");
});

test("site lock stays locked for 10 minutes through every Desk trigger", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  assert.equal(w.gate(), true);

  await w.siteLock();
  await w.run(2_000);
  assert.equal(w.world.tools.hasSession, false);
  assert.equal(w.gate(), false);

  for (let minute = 0; minute < 10; minute++) {
    await w.run(30_000);
    await w.api.tryAutoUnlock({ force: false, reason: "shop-tab-complete" });
    await w.api.tryAutoUnlock({ force: false, reason: "idle-active" });
    if (minute % 5 === 4) await w.api.tryAutoUnlock({ force: false, reason: "alarm" });
    await w.run(30_000);
    assert.equal(w.gate(), false, `gate stays absent at minute ${minute + 1}`);
    assert.equal(w.world.tools.hasSession, false, `Tools stays locked at minute ${minute + 1}`);
  }
});

test("lock survives a suspended and restarted background page", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  await w.siteLock();
  await w.run(1_000);
  assert.equal(w.world.tools.hasSession, false);

  w.boot();
  await w.api.tryAutoUnlock({ force: true, reason: "startup" });
  await w.run(3_000);
  assert.equal(w.gate(), false, "startup exchange must not remint");
  assert.equal(w.world.tools.hasSession, false);
  await w.advance(150_000);
  await w.api.tryAutoUnlock({ force: false, reason: "shop-tab-complete" });
  await w.run(2_000);
  assert.equal(w.gate(), false, "still locked 2.5 minutes later");
});

test("a site lock the cookie listener only sees after wake still sticks", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  w.world.jar.delete(GATE);
  w.boot();
  await w.api.tryAutoUnlock({ force: false, reason: "shop-tab-complete" });
  await w.api.handleGateCookieRemoved();
  await w.run(5_000);
  assert.equal(w.world.tools.hasSession, false, "Tools locked");
  assert.equal(w.gate(), false);
});

test("an exchange already in flight when the site locks is discarded", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  w.world.jar.delete(GATE);
  let release;
  w.world.exchangeGate = new Promise((r) => {
    release = r;
  });
  const pending = w.api.exchangeWidgetSessionToGate(w.world.tools.token);
  await w.settle();
  await w.api.syncSiteLockToTools({ reloadShopTabs: false });
  release();
  const result = await pending;
  w.world.exchangeGate = null;
  assert.equal(result.ok, undefined);
  assert.equal(w.gate(), false, "stale exchange must not set the gate");
  assert.equal(w.world.tools.hasSession, false);
});

test("a revoked Tools session coming back is relocked, not exchanged", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  const staleId = w.world.tools.sessionId;
  const staleToken = w.world.tools.token;
  await w.siteLock();
  await w.run(1_000);
  w.world.tools.hasSession = true;
  w.world.tools.sessionId = staleId;
  w.world.tools.token = staleToken;
  await w.run(3_000);
  assert.equal(w.world.tools.hasSession, false, "relocked");
  assert.equal(w.gate(), false);
});

test("Tools unlock any time after a site lock opens the site again", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  await w.siteLock();
  await w.run(1_000);
  await w.advance(600_000);
  w.toolsUnlock();
  await w.run(3_000);
  assert.equal(w.gate(), true, "intentional Tools unlock mirrors to the site");
});

test("site PIN unlock after a site lock releases the latch", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  await w.siteLock();
  await w.run(1_000);
  await w.siteUnlockPageLoad();
  await w.run(3_000);
  assert.equal(w.world.tools.hasSession, true, "Tools follows the site unlock");
  assert.equal(w.gate(), true);
  assert.equal(w.api.siteLatchState(), null);
});

test("a failed exchange after Tools unlock is retried", async () => {
  const w = makeWorld();
  await w.run(800);
  w.world.exchangeFails = 2;
  w.toolsUnlock();
  await w.run(12_000);
  assert.equal(w.gate(), true, "site follows Tools after retries");
});

test("toolbar icon is green while logged in and red when logged out", async () => {
  const w = makeWorld();
  await w.api.refreshUnlockBadge();
  assert.equal(w.world.icons.at(-1), "red");
  w.toolsUnlock();
  await w.run(GAP);
  assert.equal(w.world.icons.at(-1), "green");
  assert.equal(w.world.storage.deskSessionPerson, "logan");
  await w.siteLock();
  await w.run(GAP);
  assert.equal(w.world.icons.at(-1), "red");
  w.toolsUnlock();
  await w.run(GAP);
  assert.equal(w.world.icons.at(-1), "green");
});

const HOUR = 3_600_000;

test("a gate that simply ran out, with Tools still signed in, is renewed — not a lock", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  assert.equal(w.gate(), true);
  const exp = w.world.jarExp.get(GATE);
  assert.ok(exp, "Desk wrote the gate with an expiry");

  await w.advance(HOUR + 1_000);
  w.world.jar.delete(GATE);
  w.world.jarExp.delete(GATE);
  await w.api.handleGateCookieRemoved({ cause: "expired", expirationDate: exp });
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, true, "Tools stays signed in");
  assert.equal(w.gate(), true, "site gets a fresh gate");
  assert.equal(w.api.siteLatchState(), null, "no sticky lock was engaged");
});

test("an expired gate noticed without a cookie event (suspended page) does not lock either", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  await w.advance(HOUR + 1_000);
  w.world.jar.delete(GATE);
  w.world.jarExp.delete(GATE);
  w.world.tools.n += 1;
  w.world.tools.token = `tools-renewed-${w.world.tools.n}`;
  w.world.tools.sessionId = `id-${w.world.tools.token}`;
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, true);
  assert.equal(w.gate(), true);
  assert.equal(w.api.siteLatchState(), null);
});

test("removing the gate before it expires is still a lock and stays sticky", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  const exp = w.world.jarExp.get(GATE);
  w.world.jar.delete(GATE);
  w.world.jarExp.delete(GATE);
  await w.advance(700);
  await w.api.handleGateCookieRemoved({ cause: "explicit", expirationDate: exp });
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, false);
  assert.notEqual(w.api.siteLatchState(), null);
  await w.run(60_000);
  assert.equal(w.gate(), false, "nothing reopens the site on its own");
});

test("the 8pm shop-time expiry is still a lock", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  const eightPm = 1_800_072_000_000;
  w.world.jarExp.set(GATE, eightPm / 1000);
  await w.api.readShopGateCookie();
  await w.advance(eightPm - 1_800_000_000_000 + 1_000);
  w.world.jar.delete(GATE);
  w.world.jarExp.delete(GATE);
  await w.api.handleGateCookieRemoved({ cause: "expired", expirationDate: eightPm / 1000 });
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, false);
  assert.notEqual(w.api.siteLatchState(), null);
});

test("an expired Tools Bearer (not a Tools lock) never clears the site gate", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  assert.equal(w.gate(), true);
  w.world.tools.hasSession = false;
  w.world.tools.expired = true;
  await w.run(GAP);
  assert.equal(w.gate(), true, "site session is untouched by Tools' Bearer expiry");
  assert.equal(w.api.siteLatchState(), null);
  w.world.tools.expired = false;
  w.world.tools.hasSession = true;
  await w.run(GAP);
  assert.equal(w.gate(), true);
});

test("an unreadable cookie store is unknown, not a website lock", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  w.world.cookieError = true;
  await w.api.handleGateCookieRemoved({ cause: "explicit" });
  w.world.tools.n += 1;
  w.world.tools.token = `tools-swap-${w.world.tools.n}`;
  w.world.tools.sessionId = `id-${w.world.tools.token}`;
  await w.run(GAP);
  assert.equal(w.world.tools.hasSession, true);
  assert.equal(w.api.siteLatchState(), null);
});

test("while both are signed in, Desk extends the gate before it runs out", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  const first = w.world.jarExp.get(GATE);
  const before = w.world.exchanges;
  await w.advance(45 * 60_000);
  await w.run(2_000);
  assert.ok(w.world.exchanges > before, "gate was re-exchanged ahead of expiry");
  assert.ok(w.world.jarExp.get(GATE) > first, "new gate expires later");
  assert.equal(w.world.tools.hasSession, true);
});

test("/unlock: gate present or ran out is not a lock; gate removed early under the same session is", async () => {
  const w = makeWorld();
  await w.run(800);
  w.toolsUnlock();
  await w.run(GAP);
  const health = await w.api.probeToolsBridgeHealth();
  assert.equal(await w.api.siteUnlockPageNotLockReason(health), "gate_present");
  assert.equal(await w.api.siteUnlockPageIsExpiry(health), true);

  w.world.jar.delete(GATE);
  w.world.jarExp.delete(GATE);
  assert.equal(await w.api.siteUnlockPageNotLockReason(health), "", "removed early: a deliberate lock");

  await w.advance(HOUR + 1_000);
  assert.notEqual(await w.api.siteUnlockPageNotLockReason(health), "", "ran out: expiry");
});
