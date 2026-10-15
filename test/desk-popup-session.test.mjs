import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shared = path.join(root, "extension/shared");

async function openPopup(storage) {
  const html = fs.readFileSync(path.join(shared, "popup.html"), "utf8");
  const { window, document } = parseHTML(html);
  const listeners = [];
  const runtime = {
    runtime: {
      getManifest: () => ({ version: "0.1.29" }),
      sendMessage: async () => ({ ok: false, error: "unauthorized" }),
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

test("logged in without a known person still reads Logged in", async () => {
  const p = await openPopup({
    shopWidgetToken: "t",
    shopWidgetTokenExpiresAt: Date.now() + 3_600_000,
    deskSessionPerson: "",
  });
  assert.equal(p.document.getElementById("loggedIn").textContent, "Logged in");
});
