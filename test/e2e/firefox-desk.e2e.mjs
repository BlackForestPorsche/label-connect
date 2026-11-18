/**
 * Real-Firefox check of the shop sign-in and lock sync (extension/firefox).
 *
 *   npm run test:firefox
 *
 * Installs Desk as a temporary add-on in headless Firefox through geckodriver, with mock
 * Tools (:8788) and a mock shop site, and walks the four paths the shop relies on:
 *   A. signing in on the website signs Desk and Tools in
 *   B. Lock on the website locks Tools, and stays locked
 *   C. a new Tools unlock signs the website in
 *   D. a Tools lock signs the website out
 *
 * Needs Firefox and geckodriver:
 *   DESK_FIREFOX=/path/to/firefox   DESK_GECKODRIVER=/path/to/geckodriver
 * (defaults: PATH, and $GECKOWEBDRIVER on GitHub runners). Skips when either is missing,
 * unless DESK_E2E_REQUIRED=1.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorld, until, sleep, SHOP_ORIGIN, PROXY_PORT, MOCK_PIN } from "./world.mjs";
import { findFirefox, findGeckodriver, startFirefox } from "./firefox-driver.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXT = process.env.DESK_EXTENSION_DIR || path.join(root, "extension/firefox");

if (!findFirefox() || !findGeckodriver()) {
  if (process.env.DESK_E2E_REQUIRED === "1") {
    console.error("Firefox or geckodriver not found (set DESK_FIREFOX and DESK_GECKODRIVER)");
    process.exit(1);
  }
  console.log("Firefox or geckodriver not found — skipping Firefox e2e (set DESK_FIREFOX and DESK_GECKODRIVER)");
  process.exit(0);
}

// Desk ignores a lock it only inferred within 8s of an unlock (RECENT_UNLOCK_MS), so every
// lock step waits out the unlock hold and that window first, the way a person would.
const AFTER_UNLOCK_MS = 9000;

let world;
let ff;
let ctl;
let shopTab;

const ext = async (script, args) => {
  await ff.switchTo(ctl);
  return ff.exec(script, args);
};
const gateCookies = () =>
  ext(
    `return (await browser.cookies.getAll({ name: "bf_shop_gate", partitionKey: {} })).map((c) => ({
       partition: c.partitionKey ? c.partitionKey.topLevelSite : "",
       person: c.value.split(".")[2],
     }));`,
  );
const stored = (keys) => ext(`return browser.storage.local.get(arguments[0]);`, [keys]);
const toolbarTitle = () => ext(`return browser.action.getTitle({});`);
const latch = () =>
  ext(
    `const bg = await browser.runtime.getBackgroundPage();
     await bg.AllDataRoLabels.latchReady;
     return bg.AllDataRoLabels.siteLatchState();`,
  );
const unlockHold = () =>
  ext(`const bg = await browser.runtime.getBackgroundPage(); return bg.AllDataRoLabels.unlockHoldActive();`);
const shopPage = async () => {
  await ff.switchTo(shopTab);
  return ff.exec(
    `return { signedIn: document.body.dataset.signedIn, person: document.body.dataset.person, path: location.pathname };`,
  );
};
const settleAfterUnlock = async () => {
  await until(async () => !(await unlockHold()), { timeout: 45000, what: "unlock hold to lapse" });
  await sleep(AFTER_UNLOCK_MS);
};

before(async () => {
  world = await createWorld();
  ff = await startFirefox({ extension: EXT, proxyPort: PROXY_PORT });
  ctl = await ff.openExtensionPage("popup.html");
});

after(async () => {
  if (ff) await ff.quit().catch(() => {});
  if (world) await world.close().catch(() => {});
});

test("starts signed out with a red toolbar title", async () => {
  await until(async () => (await toolbarTitle()).includes("logged out"), { what: "logged out title" });
  assert.equal((await gateCookies()).length, 0);
});

test("a gate copy left in the partitioned jar by Desk 0.1.47–0.1.51 is removed and signs nobody in", async () => {
  await ext(
    `await browser.cookies.set({
       url: arguments[0] + "/",
       name: "bf_shop_gate",
       value: "v2.0.left.pin.x",
       path: "/",
       secure: true,
       httpOnly: true,
       sameSite: "lax",
       expirationDate: Math.floor(Date.now() / 1000) + 3600,
       partitionKey: { topLevelSite: arguments[0] },
     });
     await browser.storage.local.remove("deskGateJarSettled");`,
    [SHOP_ORIGIN],
  );
  const seeded = await gateCookies();
  assert.equal(seeded.length, 1);
  assert.ok(seeded[0].partition, "seeded copy is partitioned");

  await ext(`const bg = await browser.runtime.getBackgroundPage(); await bg.AllDataRoLabels.settleGateJar();`);
  assert.deepEqual(await gateCookies(), [], "partitioned copy removed");
  await sleep(1500);
  assert.equal(world.tools.session, null, "Tools stays locked");
  assert.ok((await toolbarTitle()).includes("logged out"));
});

test("Create R/O prints one label and tells the listener; Close, Cancel and estimates only tell the listener", async () => {
  await ext(`await browser.storage.local.set({ dwightCreateRoToken: "mock-listener-key" });`);
  const tab = await ff.newTab("https://manageonline.alldata.com/ro");
  await sleep(1200);
  await ff.exec(`document.querySelector(".go").click();`);
  await until(() => world.labels.prints.length === 1, { timeout: 15000, what: "label print" });
  await until(() => world.listener.pings.length === 1, { timeout: 5000, what: "create_ro ping" });

  const print = world.labels.prints[0];
  assert.equal(print.lastName, "Whatcott");
  assert.equal(print.model, "Boxster");
  // "Repair order created" on the page is not an RO number.
  assert.equal(print.roNumber, "");
  assert.equal(print.lotUrl, `${SHOP_ORIGIN}/lot`);

  const created = world.listener.pings[0];
  assert.equal(created.authorized, true);
  assert.deepEqual(created.body, {
    event: "create_ro",
    customer: "J. Whatcott",
    car: "2018 Porsche Boxster",
  });

  for (const selector of [".close-ro", ".cancel-ro", ".save-est", ".email-est"]) {
    await ff.exec(`document.querySelector(arguments[0]).click();`, [selector]);
    await sleep(400);
  }
  await until(() => world.listener.pings.length === 5, { timeout: 8000, what: "four more pings" });
  assert.deepEqual(
    world.listener.pings.map((ping) => ping.body.event),
    ["create_ro", "close_ro", "cancel_ro", "estimate_saved", "estimate_emailed"],
  );
  for (const ping of world.listener.pings.slice(1)) {
    assert.equal(ping.body.customer, "J. Whatcott");
    assert.equal(ping.body.car, "2018 Porsche Boxster");
    assert.equal(ping.body.ro, undefined);
  }
  assert.equal(world.labels.prints.length, 1, "only Create R/O prints");
  await ff.switchTo(tab);
  await ff.closeTab();
  await ff.switchTo(ctl);
});

test("Check for update says when the feed cannot be reached", async () => {
  const check = async () => {
    await ext(`document.getElementById("checkUpdate").click();`);
    await until(async () => !(await ext(`return document.getElementById("checkUpdate").disabled;`)), {
      timeout: 15000,
      what: "update check to finish",
    });
    return ext(`return document.getElementById("update").textContent;`);
  };
  world.feed.status = 503;
  const unreachable = await check();
  assert.match(unreachable, /Couldn’t check for updates/);
  assert.doesNotMatch(unreachable, /up to date/i);

  world.feed.status = 200;
  assert.match(await check(), /up to date/i);
});

test("A. signing in on the website signs Desk and Tools in", async () => {
  shopTab = await ff.newTab(`${SHOP_ORIGIN}/unlock`);
  await sleep(800);
  await ff.exec(`document.getElementById("unlock").click();`);
  await until(() => world.tools.session, { timeout: 15000, what: "Tools session from the website sign-in" });
  assert.equal(world.tools.session.person, "logan");

  // The background's credentialed fetch must carry the page's own gate cookie.
  assert.ok(
    world.shop.fromGate.some((call) => call.cookie && call.person === "logan"),
    "from-gate never received the website's gate cookie from Desk",
  );
  // Tools holds the very session the website minted for Desk, not one from a PIN or from Tools.
  assert.match(world.tools.session.token, /^lot-from-gate-/);
  const state = await stored(["deskSessionPerson"]);
  assert.equal(state.deskSessionPerson, "logan");
  await until(async () => (await toolbarTitle()).includes("logged in"), { what: "logged in title" });

  const cookies = await gateCookies();
  assert.deepEqual(
    cookies.map((c) => c.partition),
    [""],
    `Desk must not add a second gate cookie: ${JSON.stringify(cookies)}`,
  );
});

test("B. Lock on the website locks Tools and stays locked", async () => {
  await settleAfterUnlock();
  const lockedSession = { ...world.tools.session };
  await ff.switchTo(shopTab);
  await ff.exec(`document.getElementById("lock").click();`);
  await until(() => world.tools.session === null, { timeout: 15000, what: "Tools to lock after the website Lock" });
  await sleep(1500);
  assert.deepEqual(await gateCookies(), [], "a gate cookie survived the website Lock");
  assert.ok(await latch(), "lock latch not engaged");
  assert.ok((await toolbarTitle()).includes("logged out"));

  // Tools still offering the locked session must not sign the website back in.
  world.tools.session = lockedSession;
  await sleep(3500);
  assert.equal(world.tools.session, null, "Desk did not re-lock the stale Tools session");
  assert.deepEqual(await gateCookies(), []);
});

test("C. a new Tools unlock signs the website in", async () => {
  world.toolsUnlock("stephen");
  await until(async () => (await gateCookies()).length > 0, { timeout: 15000, what: "gate cookie after Tools unlock" });
  await sleep(2500);
  await ff.switchTo(shopTab);
  await ff.go(`${SHOP_ORIGIN}/`);
  const page = await shopPage();
  assert.equal(page.signedIn, "true");
  assert.equal(page.person, "stephen");
  assert.ok((await toolbarTitle()).includes("logged in"));
  assert.ok(!(await latch()), "latch should release on a new Tools unlock");
  const cookies = await gateCookies();
  assert.deepEqual(
    cookies.map((c) => c.partition),
    [""],
    `gate must be one first-party cookie: ${JSON.stringify(cookies)}`,
  );
});

test("D. a Tools lock signs the website out", async () => {
  await settleAfterUnlock();
  world.toolsLock();
  await until(async () => (await gateCookies()).length === 0, { timeout: 15000, what: "gate cleared by Tools lock" });
  await sleep(1000);
  await ff.switchTo(shopTab);
  await ff.go(`${SHOP_ORIGIN}/`);
  assert.equal((await shopPage()).signedIn, "false");
  assert.ok((await toolbarTitle()).includes("logged out"));
  assert.equal(world.tools.session, null, "Tools must stay locked");
});

const reopenPopup = async () => {
  await ff.switchTo(ctl);
  await ff.exec(`location.reload();`).catch(() => {});
  await sleep(300);
  await ff.exec(`while (document.readyState !== "complete") await new Promise((r) => setTimeout(r, 25));`);
};
const popupText = (id) => ext(`return document.getElementById(arguments[0]).textContent;`, [id]);
const popupSettles = (id, pattern, what) =>
  until(async () => pattern.test(await popupText(id)), { timeout: 10000, what });

test("E. the logged-out popup says why, for Tools locked and Tools not running", async () => {
  await reopenPopup();
  await popupSettles("signInState", /Unlock Tools or the shop site and Desk logs in by itself/, "Tools locked line");
  assert.equal(await ext(`return document.getElementById("loginBox").hidden;`), false);

  world.tools.down = true;
  await reopenPopup();
  await popupSettles("signInState", /Black Forest Tools is not running on this PC/, "Tools not running line");
  await ext(`document.getElementById("useTools").click();`);
  await popupSettles("status", /Black Forest Tools is not running on this PC/, "Sync Tools error");
  world.tools.down = false;

  await ext(`document.getElementById("useTools").click();`);
  await popupSettles("status", /Tools is locked\. Unlock Tools first\./, "Sync Tools while locked");
  await ext(`document.getElementById("useShopSession").click();`);
  await popupSettles("status", /The shop site is not signed in on this browser/, "Sync shop session while signed out");
});

test("F. SSF Order reference: logged out, then names load by themselves after a desk PIN sign-in", async () => {
  const ssf = await ff.newTab("https://www.ssfautoparts.com/checkout");
  const hint = async () => {
    await ff.switchTo(ssf);
    return ff.exec(`const root = document.getElementById("bf-ssf-lot-names"); return root ? root.lastElementChild.textContent : "";`);
  };
  const names = async () => {
    await ff.switchTo(ssf);
    return ff.exec(`return [...document.querySelectorAll("#bf-ssf-lot-names option")].map((o) => o.value).filter(Boolean);`);
  };
  const refresh = async () => {
    await ff.switchTo(ssf);
    await ff.exec(`document.querySelector("#bf-ssf-lot-names button").click();`);
  };
  await until(async () => /Desk is logged out/.test(await hint()), { timeout: 10000, what: "logged-out hint" });
  assert.deepEqual(await names(), []);

  // A wrong PIN says so; the right one, sent with Enter, logs in.
  await ff.switchTo(ctl);
  // The popup offers the last person who was signed in; this shop PC is Logan's today.
  await ext(`const person = document.getElementById("person"); person.value = "logan"; person.dispatchEvent(new Event("change", { bubbles: true }));`);
  await ff.type("#pin", "999999\uE007");
  await popupSettles("status", /That PIN didn’t work/, "wrong PIN message");
  assert.equal(await ext(`return document.getElementById("pin").value;`), "");
  await until(async () => !(await ext(`return document.getElementById("unlock").disabled;`)), { what: "sign-in button free" });
  await ff.type("#pin", `${MOCK_PIN}\uE007`);
  await popupSettles("loggedIn", /^Logged in as Logan$/, "logged in by desk PIN");
  assert.equal(await ext(`return document.getElementById("loginBox").hidden;`), true);
  await until(() => world.tools.session && world.tools.session.person === "logan", { what: "Tools session from desk PIN" });

  // No Refresh click.
  await until(async () => (await names()).length === 3, { timeout: 10000, what: "names after login" });
  assert.deepEqual(await names(), ["Baker", "Chen", "Whatcott"]);
  assert.match(await hint(), /^3 last names from On the Lot$/);
  await ff.exec(
    `const s = document.querySelector("#bf-ssf-lot-names select"); s.value = "Chen"; s.dispatchEvent(new Event("change", { bubbles: true }));`,
  );
  assert.equal(await ff.exec(`return document.getElementById("po").value;`), "Chen");

  world.shop.lot.items = [];
  await refresh();
  await until(async () => /^No cars on the lot right now\.$/.test(await hint()), { what: "empty lot hint" });

  world.shop.lot.status = 500;
  await refresh();
  await until(async () => /Couldn’t load On the Lot \(shop error 500\)/.test(await hint()), { what: "lot error hint" });
  assert.doesNotMatch(await hint(), /PIN/);
  world.shop.lot.status = 200;
  world.shop.lot.items = [{ label: "Whatcott" }];
  await refresh();
  await until(async () => /^1 last name from On the Lot$/.test(await hint()), { what: "lot back" });
});

test("G. the popup shows when the last RO event reached the listener, and when the key was refused", async () => {
  await reopenPopup();
  await popupSettles("dwightKeyHint", /^Key saved\. Last sent: [A-Za-z ]+, /, "last sent line");
  world.listener.status = 401;
  const tab = await ff.newTab("https://manageonline.alldata.com/ro");
  await sleep(1000);
  await ff.exec(`document.querySelector(".close-ro").click();`);
  await popupSettles("dwightKeyHint", /^The listener did not accept this key\. Paste the key again\.$/, "key refused line");
  world.listener.status = 200;
  await ff.switchTo(tab);
  await ff.closeTab();
  await ff.switchTo(ctl);
});
