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

test("PIN page signed out still handoffs when the extension jar already has the same person", async () => {
  const w = makeWorld();
  w.world.jar.set(GATE, "v2.1893456000000.logan.desk.abc");
  w.world.tabs = [{ id: 7, url: "https://shop.blackforestautomotive.com/unlock" }];
  w.toolsUnlock();
  const result = await w.api.syncToolsSessionToSite({
    reloadUnlockTabs: true,
    forceExchange: false,
    pageSignedIn: false,
    handoffNavigate: true,
    tabId: 7,
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, "tools-handoff");
  assert.equal(w.world.exchanges, 0);
  assert.equal(w.world.handoffs, 1);
  assert.equal(w.world.jar.get(GATE), "v2.1893456000000.logan.desk.abc");
  assert.equal(w.world.reloads.length, 0);
  assert.equal(w.world.tabUpdates.length, 1);
  assert.match(w.world.tabUpdates[0].url, /\/api\/widget\/session\/handoff\/[A-Za-z0-9_-]{20,}$/);
});

test("shop tab handoff URL is not also opened by the background", async () => {
  const w = makeWorld();
  w.toolsUnlock();
  const result = await w.api.syncToolsSessionToSite({
    reloadUnlockTabs: true,
    pageSignedIn: false,
    handoffNavigate: false,
  });
  assert.equal(result.ok, true);
  assert.match(result.handoffUrl, /\/api\/widget\/session\/handoff\/[A-Za-z0-9_-]{20,}$/);
  assert.equal(w.world.tabUpdates.length, 0);
  assert.equal(w.world.exchanges, 0);
  const again = await w.api.syncToolsSessionToSite({
    pageSignedIn: false,
    handoffNavigate: false,
  });
  assert.equal(again.reason, "handoff_debounce");
  assert.equal(w.world.handoffs, 1);
});

test("page signed in while Tools is locked signs Tools in and keeps the shop gate", async () => {
  const w = makeWorld();
  w.world.jar.set(GATE, "v2.1893456000000.logan.desk.abc");
  w.toolsLock();
  const result = await w.api.syncToolsSessionToSite({
    reloadUnlockTabs: true,
    pageSignedIn: true,
    pagePerson: "logan",
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "site_signed_in");
  assert.equal(result.source, "site-gate");
  assert.equal(result.shouldReload, false);
  assert.equal(w.world.tools.hasSession, true);
  assert.equal(w.world.storage.shopWidgetToken, w.world.tools.token);
  assert.equal(w.world.icons.at(-1), "green");
  assert.equal(w.world.jar.get(GATE), "v2.1893456000000.logan.desk.abc");
  assert.equal(w.world.reloads.length, 0);
});

test("shop load while Tools is locked keeps the shop gate and signs Tools in", async () => {
  const w = makeWorld();
  w.world.jar.set(GATE, "v2.1893456000000.logan.desk.abc");
  w.toolsLock();
  const result = await w.api.syncToolsSessionToSite({
    reloadUnlockTabs: true,
    shopLoad: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "site_signed_in");
  assert.equal(w.world.tools.hasSession, true);
  assert.equal(w.world.icons.at(-1), "green");
  assert.notEqual(result.reason, "tools_locked");
  assert.equal(w.world.jar.get(GATE), "v2.1893456000000.logan.desk.abc");
  assert.equal(w.world.reloads.length, 0);
});

test("shop load while Tools is locked and the shop cookie is missing does not sign anyone in", async () => {
  const w = makeWorld();
  w.toolsLock();
  const result = await w.api.syncToolsSessionToSite({
    reloadUnlockTabs: true,
    shopLoad: true,
  });
  assert.equal(result.skipped, "shop_load");
  assert.equal(w.world.tools.hasSession, false);
  assert.equal(w.world.storage.shopWidgetToken || "", "");
  assert.equal(w.gate(), false);
});

test("shop load on the PIN page still handoffs when Tools is signed in", async () => {
  const w = makeWorld();
  w.world.jar.set(GATE, "v2.1893456000000.logan.desk.abc");
  w.world.tabs = [{ id: 7, url: "https://shop.blackforestautomotive.com/unlock" }];
  w.toolsUnlock();
  const result = await w.api.syncToolsSessionToSite({
    reloadUnlockTabs: true,
    forceExchange: false,
    pageSignedIn: false,
    handoffNavigate: false,
    shopLoad: true,
    tabId: 7,
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, "tools-handoff");
  assert.match(result.handoffUrl, /\/api\/widget\/session\/handoff\/[A-Za-z0-9_-]{20,}$/);
  assert.equal(w.world.handoffs, 1);
  assert.equal(w.world.exchanges, 0);
  assert.equal(w.world.tabUpdates.length, 0);
});

test("shop tab complete while Tools is locked does not clear the shop gate", async () => {
  const w = makeWorld();
  w.world.jar.set(GATE, "v2.1893456000000.logan.desk.abc");
  w.toolsLock();
  const result = await w.api.tryAutoUnlock({ force: false, reason: "shop-tab-complete" });
  assert.notEqual(result.reason, "tools_locked");
  assert.equal(w.world.jar.get(GATE), "v2.1893456000000.logan.desk.abc");
  assert.equal(w.world.reloads.length, 0);
});

test("first look at a locked Tools signs in from the shop gate and does not clear it", async () => {
  const w = makeWorld();
  w.world.jar.set(GATE, "v2.1893456000000.logan.desk.abc");
  w.toolsLock();
  await w.api.tickBridgeSyncPoll();
  assert.equal(w.world.tools.hasSession, true);
  assert.equal(w.world.icons.at(-1), "green");
  assert.equal(w.world.jar.get(GATE), "v2.1893456000000.logan.desk.abc");
  assert.equal(w.world.reloads.length, 0);
});

test("an observed Tools lock still clears the shop gate", async () => {
  const w = makeWorld();
  w.world.jar.set(GATE, "v2.1893456000000.logan.desk.abc");
  w.toolsLock();
  const result = await w.api.syncToolsSessionToSite({
    reloadUnlockTabs: true,
    observedToolsLock: true,
  });
  assert.equal(result.reason, "tools_locked");
  assert.equal(result.locked, true);
  assert.equal(w.gate(), false);
  assert.equal(w.world.tools.hasSession, false);
});

test("home PIN tab is handed off when Tools is signed in", async () => {
  const w = makeWorld();
  w.world.tabs = [{ id: 3, url: "https://shop.blackforestautomotive.com/" }];
  w.toolsUnlock();
  const result = await w.api.syncToolsSessionToSite({
    reloadUnlockTabs: true,
    forceExchange: false,
    pageSignedIn: false,
    handoffNavigate: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, "tools-handoff");
  assert.equal(w.world.handoffs, 1);
  assert.equal(w.world.tabUpdates.length, 1);
  assert.equal(w.world.tabUpdates[0].id, 3);
  assert.match(w.world.tabUpdates[0].url, /\/api\/widget\/session\/handoff\/[A-Za-z0-9_-]{20,}$/);
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
