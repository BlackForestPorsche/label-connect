import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shared = path.join(root, "extension/shared");

async function openPopup(storage, onMessage) {
  const html = fs.readFileSync(path.join(shared, "popup.html"), "utf8");
  const { window, document } = parseHTML(html);
  const listeners = [];
  const runtime = {
    runtime: {
      getManifest: () => ({ version: "0.1.29" }),
      sendMessage: async (message) =>
        (onMessage && onMessage(message)) || { ok: false, error: "unauthorized" },
    },
    storage: {
      local: {
        get: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter((k) => k in storage).map((k) => [k, storage[k]]));
        },
        set: async (obj) => Object.assign(storage, obj),
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
  };
  const context = vm.createContext({ console, document, window, browser: runtime, chrome: runtime, Date, Promise });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(shared, "popup.js"), "utf8"), context, { filename: "popup.js" });
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  await settle();
  const visible = (id) => !document.getElementById(id).hasAttribute("hidden");
  return { document, storage, listeners, settle, visible };
}

const loginControls = ["useShopSession", "useTools", "person", "pin", "unlock"];

test("popup shows plain Logged in as <name> and hides sync / PIN controls", async () => {
  const p = await openPopup({
    shopWidgetToken: "t",
    shopWidgetTokenExpiresAt: Date.now() + 3_600_000,
    deskSessionPerson: "logan",
  });
  assert.equal(p.visible("loggedIn"), true);
  assert.equal(p.document.getElementById("loggedIn").textContent, "Logged in as Logan");
  assert.equal(p.visible("loginBox"), false);
  for (const id of loginControls) {
    assert.equal(p.document.getElementById("loginBox").contains(p.document.getElementById(id)), true, id);
  }
  assert.equal(p.visible("status"), false);
  assert.equal(p.visible("checkUpdate"), true);
});

test("popup shows login controls when logged out or the session expired", async () => {
  for (const storage of [
    {},
    { shopWidgetToken: "t", shopWidgetTokenExpiresAt: Date.now() - 1_000, deskSessionPerson: "logan" },
  ]) {
    const p = await openPopup(storage);
    assert.equal(p.visible("loggedIn"), false);
    assert.equal(p.visible("loginBox"), true);
  }
});

test("popup flips live when the session starts and ends", async () => {
  const p = await openPopup({});
  assert.equal(p.visible("loginBox"), true);
  Object.assign(p.storage, {
    shopWidgetToken: "t",
    shopWidgetTokenExpiresAt: Date.now() + 3_600_000,
    deskSessionPerson: "carla",
  });
  for (const fn of p.listeners) fn({ shopWidgetToken: {} }, "local");
  await p.settle();
  assert.equal(p.document.getElementById("loggedIn").textContent, "Logged in as Carla");
  assert.equal(p.visible("loginBox"), false);
  Object.assign(p.storage, { shopWidgetToken: "", shopWidgetTokenExpiresAt: 0 });
  for (const fn of p.listeners) fn({ shopWidgetToken: {} }, "local");
  await p.settle();
  assert.equal(p.visible("loggedIn"), false);
  assert.equal(p.visible("loginBox"), true);
});

test("Create RO listener key saves locally and stays visible while logged in", async () => {
  const p = await openPopup({
    shopWidgetToken: "t",
    shopWidgetTokenExpiresAt: Date.now() + 3_600_000,
    deskSessionPerson: "logan",
    dwightCreateRoToken: "already-on-desk",
  });
  const input = p.document.getElementById("dwightCreateRoToken");
  assert.ok(input);
  assert.equal(p.document.getElementById("loginBox").contains(input), false);
  assert.equal(input.value, "already-on-desk");
  assert.equal(p.document.getElementById("dwightKeyHint").textContent.includes("already-on-desk"), false);
  input.value = "desk-listener-test";
  input.dispatchEvent(new p.document.defaultView.Event("input", { bubbles: true }));
  await p.settle();
  assert.equal(p.storage.dwightCreateRoToken, "desk-listener-test");
  assert.equal(p.document.getElementById("status").textContent.includes("desk-listener-test"), false);
  assert.equal(p.document.getElementById("dwightKeyHint").textContent.includes("desk-listener-test"), false);
});

test("logged in without a known person still reads Logged in", async () => {
  const p = await openPopup({
    shopWidgetToken: "t",
    shopWidgetTokenExpiresAt: Date.now() + 3_600_000,
    deskSessionPerson: "",
  });
  assert.equal(p.document.getElementById("loggedIn").textContent, "Logged in");
});

test("Check for update says so when the feed cannot be reached, and when a build is still publishing", async () => {
  let reply = { state: "unreachable", available: null };
  const p = await openPopup({}, (message) => (message.type === "check-update" ? reply : null));
  const check = async () => {
    p.document.getElementById("checkUpdate").dispatchEvent(new p.document.defaultView.Event("click"));
    await p.settle();
    return p.document.getElementById("update");
  };
  let line = await check();
  assert.match(line.textContent, /Couldn’t check for updates/);
  assert.doesNotMatch(line.textContent, /up to date/i);
  assert.equal(line.className, "err");

  reply = { state: "publishing", available: null, version: "0.1.60" };
  line = await check();
  assert.match(line.textContent, /Desk 0\.1\.60 is being published/);
  assert.doesNotMatch(line.textContent, /up to date/i);

  reply = { state: "current", available: null };
  line = await check();
  assert.match(line.textContent, /up to date/i);
  assert.equal(p.visible("applyUpdate"), false);
});

const click = async (p, id) => {
  p.document.getElementById(id).dispatchEvent(new p.document.defaultView.Event("click"));
  await p.settle();
};
const text = (p, id) => p.document.getElementById(id).textContent;

test("logged out: the popup says why and what to do, for each Tools state", async () => {
  const stateFor = async (tools) => {
    const p = await openPopup({}, (message) => (message.type === "desk-status" ? { ok: true, tools } : null));
    return text(p, "signInState");
  };
  assert.match(await stateFor({ reachable: false, hasSession: false, person: "" }), /Tools is not running on this PC/);
  assert.match(await stateFor({ reachable: true, hasSession: false, person: "" }), /Unlock Tools or the shop site/);
  assert.match(await stateFor({ reachable: true, hasSession: true, person: "carla" }), /Tools is unlocked as Carla/);
  for (const line of [
    await stateFor({ reachable: false, hasSession: false, person: "" }),
    await stateFor({ reachable: true, hasSession: false, person: "" }),
  ]) {
    assert.match(line, /^Logged out\./);
    assert.doesNotMatch(line, /cookie|\/unlock|background|from-gate/i);
  }
});

test("desk PIN: Enter signs in, a wrong PIN says so and clears the field, one request at a time", async () => {
  const sent = [];
  let reply = { error: "That PIN didn’t work. Check the person and PIN, then try again." };
  const p = await openPopup({}, (message) => {
    if (message.type !== "widget-session") return null;
    sent.push(message.payload);
    return reply;
  });
  const pin = p.document.getElementById("pin");
  // linkedom only reads a select's value from the selected attribute.
  p.document.querySelector('#person option[value="logan"]').setAttribute("selected", "");
  const enter = async () => {
    const event = new p.document.defaultView.Event("keydown", { bubbles: true });
    event.key = "Enter";
    pin.dispatchEvent(event);
    await p.settle();
  };

  await enter();
  assert.equal(text(p, "status"), "Enter your desk PIN.");
  pin.value = "12";
  await enter();
  assert.equal(text(p, "status"), "A desk PIN is 4 to 12 digits.");
  assert.equal(sent.length, 0, "nothing is sent until the PIN is well formed");

  pin.value = "000000";
  await enter();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].person, "logan");
  assert.match(text(p, "status"), /That PIN didn’t work/);
  assert.equal(p.document.getElementById("status").className, "err");
  assert.equal(pin.value, "", "the PIN never stays in the field");
  assert.equal(text(p, "unlock"), "Unlock with desk PIN");
  assert.equal(p.document.getElementById("unlock").disabled, false);

  reply = { ok: true, person: "logan" };
  Object.assign(p.storage, {
    shopWidgetToken: "t",
    shopWidgetTokenExpiresAt: Date.now() + 3_600_000,
    deskSessionPerson: "logan",
  });
  pin.value = "000000";
  await click(p, "unlock");
  assert.equal(text(p, "loggedIn"), "Logged in as Logan");
  assert.equal(p.visible("loginBox"), false);
  assert.equal(pin.value, "");
});

test("Sync buttons say what went wrong in plain words", async () => {
  let reply = null;
  const p = await openPopup({}, (message) => {
    if (message.type === "tools-to-site-unlock") return reply;
    return null;
  });
  reply = { ok: true, skipped: "tools_already_locked", reason: "tools_already_locked", siteGate: false };
  await click(p, "useTools");
  assert.equal(text(p, "status"), "Tools is locked. Unlock Tools first.");
  reply = { error: "Black Forest Tools is not running on this PC. Start Tools, or sign in another way." };
  await click(p, "useTools");
  assert.match(text(p, "status"), /Tools is not running on this PC/);
  reply = { error: "exchange_failed" };
  await click(p, "useTools");
  assert.match(text(p, "status"), /^Couldn’t sign in\./);
  assert.equal(text(p, "useTools"), "Sync Tools → website");
});

test("listener key line: no key, saved, last sent, not accepted, not delivered", async () => {
  const hint = async (storage) => {
    const p = await openPopup({ ...storage });
    const el = p.document.getElementById("dwightKeyHint");
    return { text: el.textContent, error: /\berr\b/.test(el.className) };
  };
  const key = { dwightCreateRoToken: "desk-listener-test" };
  const at = Date.now();

  assert.match((await hint({})).text, /^No key yet, so RO events are not sent\./);
  assert.match((await hint(key)).text, /^Key saved on this browser\./);

  const sent = await hint({ ...key, deskListenerLast: { at, event: "close_ro", ok: true, status: 200 } });
  assert.match(sent.text, /^Key saved\. Last sent: RO closed, /);
  assert.equal(sent.error, false);

  const refused = await hint({ ...key, deskListenerLast: { at, event: "create_ro", ok: false, status: 401 } });
  assert.equal(refused.text, "The listener did not accept this key. Paste the key again.");
  assert.equal(refused.error, true);

  const lost = await hint({ ...key, deskListenerLast: { at, event: "create_ro", ok: false, status: 0 } });
  assert.match(lost.text, /^RO created at .* did not reach the listener\. Labels still print\./);
  assert.equal(lost.error, true);

  for (const state of [sent, refused, lost]) assert.equal(state.text.includes("desk-listener-test"), false);
});

test("a new listener key forgets the result recorded for the old one", async () => {
  const p = await openPopup({
    dwightCreateRoToken: "old-key",
    deskListenerLast: { at: Date.now(), event: "create_ro", ok: false, status: 401 },
  });
  const input = p.document.getElementById("dwightCreateRoToken");
  input.value = "new-key";
  input.dispatchEvent(new p.document.defaultView.Event("input", { bubbles: true }));
  await p.settle();
  assert.equal(p.storage.deskListenerLast, null);
  assert.match(text(p, "dwightKeyHint"), /^Key saved on this browser\./);
});
