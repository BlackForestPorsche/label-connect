import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseHTML } from "linkedom";
import { normalizeRoPayload, roLabelLines } from "../shared/ro-label.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RealDate = Date;

const FORM = (model = "") => `
  <div class="row"><label for="ln">Last Name</label><input id="ln" value="Whatcott"></div>
  <div class="row"><label for="pl">License Plate</label><input id="pl" value="7ABC123"></div>
  <div class="row"><label for="md">Model</label><input id="md" value="${model}"></div>
  <button>Create R/O</button>`;

/**
 * Runs the real config.js + scrape.js + content.js against a linkedom page with a manual clock,
 * so the Create click → success → print timing can be driven step by step.
 */
function startDesk({ html, contentFile = "extension/shared/content.js", dir = "extension/shared", nudgeFails = false } = {}) {
  const { document: realDoc } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const listeners = {};
  const doc = new Proxy(realDoc, {
    get(target, key) {
      if (key === "addEventListener") return (type, fn) => (listeners[type] = fn);
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const clock = { now: 1_000_000 };
  const timers = [];
  let nextId = 1;
  const sent = [];
  const messages = [];
  const toasts = [];
  const observers = [];

  const sandbox = {
    document: doc,
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          messages.push(message);
          if (message?.type === "dwight-nudge" || message?.type === "dwight-create-ro") {
            if (nudgeFails) throw new Error("listener down");
            return { ok: true };
          }
          sent.push(message.payload);
          return { printed: true };
        },
      },
    },
    MutationObserver: class {
      constructor(cb) {
        this.cb = cb;
        observers.push(this);
      }
      observe() {}
    },
    Date: Object.assign(function FakeDate() {
      return new RealDate(clock.now);
    }, { now: () => clock.now }),
    setTimeout(fn, ms = 0) {
      const id = nextId++;
      timers.push({ id, at: clock.now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  sandbox.globalThis = sandbox;
  const ctx = createContext(sandbox);
  for (const file of [`${dir}/config.js`, `${dir}/scrape.js`]) {
    runInContext(readFileSync(join(root, file), "utf8"), ctx, { filename: file });
  }
  sandbox.AllDataRoLabels.showToast = (message, kind) => toasts.push({ message, kind });
  runInContext(readFileSync(join(root, contentFile), "utf8"), ctx, { filename: contentFile });

  const button = realDoc.querySelector("button");

  function advance(ms) {
    const until = clock.now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > until) break;
      timers.shift();
      clock.now = Math.max(clock.now, next.at);
      next.fn();
    }
    clock.now = until;
  }

  function mutate() {
    for (const mo of observers) mo.cb([]);
  }

  function fire(type, target = button) {
    const path = [];
    for (let n = target; n; n = n.parentNode) path.push(n);
    listeners[type]?.({ type, target, composedPath: () => path });
  }

  return {
    document: realDoc,
    button,
    sent,
    messages,
    toasts,
    advance,
    mutate,
    fire,
    clickCreate() {
      fire("pointerdown");
      fire("click");
    },
    setModel(value) {
      realDoc.querySelector("#md")?.setAttribute("value", value);
      mutate();
    },
    removeCreate() {
      button.remove();
      mutate();
    },
    wipeForm(replacement = "<div>Repair order created</div>") {
      realDoc.body.innerHTML = replacement;
      mutate();
    },
  };
}

function labelOf(payload) {
  const normalized = normalizeRoPayload({ event: "create-ro", lastName: payload.lastName, model: payload.model });
  assert.equal(normalized.ok, true);
  return roLabelLines(normalized.fields);
}

test("model appears after the old 3.5s grace: label still gets last name and model", () => {
  const desk = startDesk({ html: FORM("") });
  desk.clickCreate();
  desk.advance(500);
  desk.removeCreate();
  desk.advance(4200);
  assert.equal(desk.sent.length, 0, "must still be waiting for the model");
  desk.setModel("Camry");
  desk.advance(500);
  assert.equal(desk.sent.length, 1);
  assert.equal(desk.sent[0].lastName, "Whatcott");
  assert.equal(desk.sent[0].model, "Camry");
  assert.equal(labelOf(desk.sent[0])[0], "Whatcott - Camry");
});

test("slow Create: success confirmed after 4s still waits for the model", () => {
  const desk = startDesk({ html: FORM("") });
  desk.clickCreate();
  desk.advance(4000);
  desk.removeCreate();
  desk.advance(1500);
  assert.equal(desk.sent.length, 0, "grace runs from confirmation, not from the click");
  desk.setModel("Q5");
  desk.advance(300);
  assert.equal(desk.sent.length, 1);
  assert.equal(desk.sent[0].model, "Q5");
});

test("form wiped by the SPA on success: model read before the click is still printed", () => {
  const desk = startDesk({ html: FORM("GLC300") });
  desk.clickCreate();
  desk.advance(300);
  desk.wipeForm("<div>Creating…</div><button>Create R/O</button>");
  desk.advance(300);
  desk.wipeForm("<div>Work screen</div>");
  desk.advance(600);
  assert.equal(desk.sent.length, 1);
  assert.equal(desk.sent[0].lastName, "Whatcott");
  assert.equal(desk.sent[0].model, "GLC300");
  assert.equal(labelOf(desk.sent[0])[0], "Whatcott - GLC300");
});

test("form values that only exist at pointer-down survive a blur re-render before click", () => {
  const desk = startDesk({ html: FORM("RX350") });
  desk.fire("pointerdown");
  desk.wipeForm(`<div class="row"><label>Last Name</label><input value=""></div><button>Create R/O</button>`);
  const create = desk.document.querySelector("button");
  desk.fire("click", create);
  desk.advance(300);
  desk.wipeForm("<div>Work screen</div>");
  desk.advance(600);
  assert.equal(desk.sent.length, 1);
  assert.equal(desk.sent[0].lastName, "Whatcott");
  assert.equal(desk.sent[0].model, "RX350");
});

test("model field wins over another vehicle named elsewhere on the post-Create page", () => {
  const desk = startDesk({ html: FORM("Camry") });
  desk.clickCreate();
  desk.advance(300);
  desk.wipeForm(
    `<div class="row"><label>Last Name</label><input value="Whatcott"></div>
     <aside>Next appointment: 2021 Honda Accord</aside>`,
  );
  desk.advance(600);
  assert.equal(desk.sent.length, 1);
  assert.equal(desk.sent[0].model, "Camry");
});

test("model never appears: still prints, model blank, after the grace", () => {
  const desk = startDesk({ html: FORM("") });
  desk.clickCreate();
  desk.advance(300);
  desk.removeCreate();
  desk.advance(2000);
  assert.equal(desk.sent.length, 0);
  desk.advance(5000);
  assert.equal(desk.sent.length, 1);
  assert.equal(desk.sent[0].lastName, "Whatcott");
  assert.equal(desk.sent[0].model, "");
  assert.equal(labelOf(desk.sent[0])[0], "Whatcott - ");
  assert.equal(labelOf(desk.sent[0])[1], "Out Mileage _____________");
});

test("Create confirmed late in the window: deadline prints instead of skipping", () => {
  const desk = startDesk({ html: FORM("") });
  desk.clickCreate();
  desk.advance(16000);
  desk.removeCreate();
  desk.advance(3000);
  assert.equal(desk.sent.length, 1);
  assert.equal(desk.sent[0].lastName, "Whatcott");
  assert.equal(desk.sent[0].model, "");
  assert.equal(desk.toasts.filter((t) => t.kind === "skip").length, 0);
});

test("last name that shows up after success is waited for, then printed with the model", () => {
  const desk = startDesk({
    html: `<div class="row"><label for="md">Model</label><input id="md" value="Defender"></div><button>Create R/O</button>`,
  });
  desk.clickCreate();
  desk.advance(300);
  desk.removeCreate();
  desk.advance(3000);
  assert.equal(desk.sent.length, 0);
  desk.wipeForm(`<div class="row"><label>Last Name</label><input value="Okafor"></div>`);
  desk.advance(600);
  assert.equal(desk.sent.length, 1);
  assert.equal(desk.sent[0].lastName, "Okafor");
  assert.equal(desk.sent[0].model, "Defender");
});

test("plate is never printed as the model on the race paths", () => {
  const desk = startDesk({ html: FORM("") });
  desk.clickCreate();
  desk.advance(300);
  desk.removeCreate();
  desk.advance(7000);
  assert.equal(desk.sent.length, 1);
  assert.equal(desk.sent[0].model, "");
  assert.ok(!/7ABC123|ABC/i.test(desk.sent[0].model));
});

test("mutation storms do not scrape on every mutation", () => {
  const desk = startDesk({ html: FORM("Camry") });
  let reads = 0;
  const orig = desk.document.querySelectorAll.bind(desk.document);
  desk.document.querySelectorAll = (...a) => {
    reads += 1;
    return orig(...a);
  };
  desk.clickCreate();
  reads = 0;
  for (let i = 0; i < 200; i++) desk.mutate();
  assert.ok(reads < 400, `reads=${reads}`);
});

test("chromium and firefox content scripts match shared", () => {
  const shared = readFileSync(join(root, "extension/shared/content.js"), "utf8");
  for (const dir of ["chromium", "firefox"]) {
    assert.equal(readFileSync(join(root, `extension/${dir}/content.js`), "utf8"), shared);
  }
});

function scrapeHtml(html) {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const sandbox = { globalThis: null };
  sandbox.globalThis = sandbox;
  const ctx = createContext(sandbox);
  for (const file of ["config.js", "scrape.js"]) {
    runInContext(readFileSync(join(root, "extension/shared", file), "utf8"), ctx, { filename: file });
  }
  return sandbox.AllDataRoLabels.scrapeWorkScreen(document);
}

test("a row wrapper holding its own input never borrows the next row as its value", () => {
  const rows = (model) => `
    <div class="row"><label for="ln">Last Name</label><input id="ln" value="Whatcott"></div>
    <div class="row"><label for="md">Model</label><input id="md" value="${model}"></div>
    <button>Create R/O</button>`;
  const filled = scrapeHtml(rows("Camry"));
  assert.equal(filled.lastName, "Whatcott");
  assert.equal(filled.model, "Camry");
  const empty = scrapeHtml(rows(""));
  assert.equal(empty.lastName, "Whatcott", "empty Model row must not become the last name");
  assert.equal(empty.model, "", "the Create button text must not become the model");
});

test("mergeCreateFields: a model field beats a page-wide guess; empty reads never erase", () => {
  const api = (() => {
    const sandbox = { globalThis: null };
    sandbox.globalThis = sandbox;
    const ctx = createContext(sandbox);
    for (const file of ["config.js", "scrape.js"]) {
      runInContext(readFileSync(join(root, "extension/shared", file), "utf8"), ctx, { filename: file });
    }
    return sandbox.AllDataRoLabels;
  })();
  const remembered = { lastName: "Whatcott", model: "Camry", modelSource: "field" };
  const guess = api.mergeCreateFields({ lastName: "", model: "Accord", modelSource: "body" }, remembered);
  assert.equal(guess.model, "Camry");
  assert.equal(guess.lastName, "Whatcott");
  const fresh = api.mergeCreateFields({ lastName: "Okafor", model: "Q5", modelSource: "field" }, remembered);
  assert.equal(fresh.model, "Q5");
  assert.equal(fresh.lastName, "Okafor");
  const kept = api.rememberCreateFields(remembered, { lastName: "", model: "", modelSource: "" });
  assert.equal(kept.model, "Camry");
  assert.equal(kept.lastName, "Whatcott");
});

function formWithRo(ro) {
  return `
    <div class="row"><label for="ln">Last Name</label><input id="ln" value="Whatcott"></div>
    <div class="row"><label for="md">Model</label><input id="md" value="Camry"></div>
    <div class="row"><label for="ro">RO #</label><input id="ro" value="${ro}"></div>
    <button>Create R/O</button>`;
}

function listenerMessages(desk) {
  return desk.messages.filter((message) => message?.type === "dwight-nudge");
}

test("Create RO print kickoff also pings the listener with the new page RO", () => {
  const desk = startDesk({ html: formWithRo("") });
  desk.clickCreate();
  desk.advance(200);
  const roInput = desk.document.getElementById("ro");
  roInput.value = "J1001";
  roInput.setAttribute("value", "J1001");
  desk.removeCreate();
  desk.advance(800);
  assert.equal(desk.sent.length, 1);
  assert.equal(desk.sent[0].roNumber, "J1001");
  assert.equal(desk.sent[0].event, "create-ro");
  const prints = desk.messages.filter((message) => message?.type === "print-ro");
  const nudges = listenerMessages(desk);
  assert.equal(prints.length, 1);
  assert.equal(nudges.length, 1);
  assert.ok(desk.messages.indexOf(prints[0]) < desk.messages.indexOf(nudges[0]));
  assert.equal(nudges[0].event, "create_ro");
  assert.equal(nudges[0].fields.ro, "J1001");
  assert.equal(Object.hasOwn(nudges[0].fields, "phone"), false);
  assert.equal(Object.hasOwn(nudges[0].fields, "email"), false);
});

test("open RO on the page is sent to the listener and kept off the label payload", () => {
  const desk = startDesk({ html: formWithRo("J1001") });
  desk.clickCreate();
  desk.advance(200);
  desk.removeCreate();
  desk.advance(800);
  assert.equal(desk.sent.length, 1);
  assert.equal(desk.sent[0].roNumber, "");
  const nudges = listenerMessages(desk);
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].event, "create_ro");
  assert.equal(nudges[0].fields.ro, "J1001");
});

test("Create with no RO on the page still pings the listener once", () => {
  const desk = startDesk({ html: FORM("Camry") });
  desk.clickCreate();
  desk.advance(200);
  desk.removeCreate();
  desk.advance(800);
  assert.equal(desk.sent.length, 1);
  assert.equal(listenerMessages(desk).length, 1);
  assert.equal(listenerMessages(desk)[0].event, "create_ro");
  assert.equal(listenerMessages(desk)[0].fields.ro, undefined);
});

function buttonNamed(desk, text) {
  return [...desk.document.querySelectorAll("button")].find((el) => el.textContent.trim() === text);
}

test("Close, Cancel, and estimate actions ping and do not print", () => {
  const close = startDesk({
    html: `${formWithRo("J1001")}
      <div class="row"><label for="ph">Phone</label><input id="ph" value="8015551212"></div>
      <button>Close R/O</button>`,
  });
  close.fire("click", buttonNamed(close, "Close R/O"));
  assert.equal(close.sent.length, 0);
  assert.equal(listenerMessages(close).length, 1);
  assert.equal(listenerMessages(close)[0].event, "close_ro");
  assert.equal(listenerMessages(close)[0].fields.ro, "J1001");
  assert.equal(listenerMessages(close)[0].fields.customer, "Whatcott");
  assert.equal(Object.hasOwn(listenerMessages(close)[0].fields, "phone"), false);
  assert.equal(Object.hasOwn(listenerMessages(close)[0].fields, "email"), false);

  const cancel = startDesk({
    html: `${formWithRo("J1001")}<button>Cancel R/O</button>`,
  });
  cancel.fire("click", buttonNamed(cancel, "Cancel R/O"));
  assert.equal(cancel.sent.length, 0);
  assert.equal(listenerMessages(cancel)[0].event, "cancel_ro");

  const saved = startDesk({
    html: `<h1>Estimate</h1>${formWithRo("J1001")}<button>Save</button>`,
  });
  saved.fire("click", buttonNamed(saved, "Save"));
  assert.equal(saved.sent.length, 0);
  assert.equal(listenerMessages(saved)[0].event, "estimate_saved");

  const emailed = startDesk({
    html: `${formWithRo("J1001")}<button>Email Estimate</button>`,
  });
  emailed.fire("click", buttonNamed(emailed, "Email Estimate"));
  assert.equal(emailed.sent.length, 0);
  assert.equal(listenerMessages(emailed)[0].event, "estimate_emailed");
  assert.equal(listenerMessages(emailed)[0].fields.car, "Camry");
});

test("Desk reads AllData and does not click or type", () => {
  const content = readFileSync(join(root, "extension/shared/content.js"), "utf8");
  assert.equal(/\.click\(/.test(content), false);
  assert.equal(/\.value\s*=/.test(content), false);
  assert.equal(/execCommand/.test(content), false);
});

test("listener failure does not block or change the label print", async () => {
  const desk = startDesk({ html: FORM("Camry"), nudgeFails: true });
  desk.clickCreate();
  desk.advance(200);
  desk.removeCreate();
  desk.advance(800);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(desk.sent.length, 1);
  assert.equal(desk.sent[0].lastName, "Whatcott");
  assert.equal(desk.sent[0].model, "Camry");
  assert.equal(desk.toasts.some((toast) => toast.kind === "ok" && /Printed Whatcott - Camry/.test(toast.message)), true);
});

test("planCreatePrint: grace counts from confirmation; deadline always prints", () => {
  const api = (() => {
    const sandbox = { globalThis: null };
    sandbox.globalThis = sandbox;
    const ctx = createContext(sandbox);
    for (const file of ["config.js", "scrape.js"]) {
      runInContext(readFileSync(join(root, "extension/shared", file), "utf8"), ctx, { filename: file });
    }
    return sandbox.AllDataRoLabels;
  })();
  const base = { confirmed: true, confirmedAt: 10_000, modelGraceMs: 6000, deadlineAt: 28_000 };
  assert.equal(api.planCreatePrint({ ...base, now: 10_100, fields: { lastName: "W", model: "" } }).action, "wait");
  assert.equal(api.planCreatePrint({ ...base, now: 10_100, fields: { lastName: "W", model: "Q5" } }).action, "print");
  const blank = api.planCreatePrint({ ...base, now: 16_000, fields: { lastName: "W", model: "" } });
  assert.deepEqual([blank.action, blank.modelBlank], ["print", true]);
  assert.equal(api.planCreatePrint({ ...base, now: 28_000, fields: { lastName: "W", model: "" } }).action, "print");
  assert.equal(api.planCreatePrint({ ...base, now: 12_000, fields: { lastName: "", model: "Q5" } }).action, "wait");
  assert.equal(api.planCreatePrint({ ...base, now: 28_000, fields: { lastName: "", model: "Q5" } }).action, "no-last-name");
  assert.equal(api.planCreatePrint({ ...base, confirmed: false, now: 12_000, fields: { lastName: "W", model: "Q5" } }).action, "wait");
});

test("Create pings the listener with the same customer and car the other events send", () => {
  const html = `
    <div class="row"><label for="cu">Customer</label><input id="cu" value="Ada Whatcott"></div>
    <div class="row"><label for="yr">Year</label><input id="yr" value="2018"></div>
    <div class="row"><label for="mk">Make</label><input id="mk" value="Porsche"></div>
    <div class="row"><label for="md">Model</label><input id="md" value="Boxster"></div>
    <div class="row"><label for="ro">RO #</label><input id="ro" value="J1001"></div>
    <button>Create R/O</button><button>Close R/O</button>`;
  const create = startDesk({ html });
  create.clickCreate();
  create.advance(200);
  create.removeCreate();
  create.advance(800);
  const close = startDesk({ html });
  close.fire("click", buttonNamed(close, "Close R/O"));

  const created = listenerMessages(create)[0];
  const closed = listenerMessages(close)[0];
  assert.equal(created.event, "create_ro");
  assert.equal(created.fields.customer, "Ada Whatcott");
  assert.equal(created.fields.car, "2018 Porsche Boxster");
  assert.deepEqual({ ...created.fields }, { ...closed.fields });
  // The label is unchanged: last name and model only.
  assert.equal(create.sent[0].lastName, "Whatcott");
  assert.equal(create.sent[0].model, "Boxster");
});

test("Create success copy on the page never becomes the RO number or the QR link", () => {
  const desk = startDesk({ html: FORM("Camry") });
  desk.clickCreate();
  desk.advance(200);
  desk.removeCreate();
  const note = desk.document.createElement("div");
  note.textContent = "Repair order created";
  desk.document.body.appendChild(note);
  desk.advance(800);
  assert.equal(desk.sent.length, 1);
  assert.equal(desk.sent[0].roNumber, "");
  assert.equal(desk.sent[0].lotUrl, "https://shop.blackforestautomotive.com/lot");
  assert.equal(listenerMessages(desk)[0].fields.ro, undefined);
});
