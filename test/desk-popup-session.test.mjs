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
