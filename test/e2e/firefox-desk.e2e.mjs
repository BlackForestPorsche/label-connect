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
import { createWorld, until, sleep, SHOP_ORIGIN, PROXY_PORT } from "./world.mjs";
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
  const state = await stored(["shopWidgetTokenSource", "deskSessionPerson"]);
  assert.equal(state.shopWidgetTokenSource, "site-gate");
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
