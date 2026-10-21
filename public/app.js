import { code128 } from "/shared/code128.mjs";
import { prefersTurn, viewSize, viewSafeRect, formatInches, FALLBACK_MEDIA } from "/shared/media.mjs";
import { fitTextLayout, LINE_HEIGHT } from "/shared/text-fit.mjs";
import { normalizeCopies } from "/shared/copies.mjs";

const $ = (id) => document.getElementById(id);

const measureCanvas = document.createElement("canvas");
const measureCtx = measureCanvas.getContext("2d");

/** Width in pt for Liberation Sans at sizePt (1pt ≈ 1px in the measure space). */
function measureTextPt(text, sizePt, bold) {
  measureCtx.font = `${bold ? 700 : 500} ${sizePt}px Liberation Sans, sans-serif`;
  return measureCtx.measureText(String(text ?? "")).width;
}

function textLayoutFor(block) {
  return fitTextLayout(block.text, block.w, block.h, (text, size) => measureTextPt(text, size, block.bold));
}

const state = {
  printer: null,
  docs: [],
  activeId: "",
  selected: null,
  pristine: true,
};

function uid() {
  return crypto.randomUUID();
}

function blankDoc(media, turned = prefersTurn(media)) {
  const doc = {
    id: uid(),
    name: media.name,
    mediaKey: media.key,
    turned,
    copies: 1,
    blocks: addressBlocks(media, turned),
  };
  return doc;
}

function textBlock(id, text, x, y, w, h, size, bold) {
  return { id, kind: "text", x, y, w, h, text, size, bold, align: "left", fit: false, src: "" };
}

function addressBlocks(media, turned = prefersTurn(media)) {
  const view = viewSize(media, turned);
  const safe = viewSafeRect(media, turned);
  // Layout inside the printable ImageableArea (view coords), not the full die.
  const box = safe.w > 8 && safe.h > 6 ? safe : { x: 0, y: 0, w: view.widthPt, h: view.heightPt };
  const pad = Math.max(2, Math.min(box.w, box.h) * 0.06);
  const x0 = box.x + pad;
  const y0 = box.y + pad;
  const innerW = Math.max(8, box.w - pad * 2);
  const innerH = Math.max(6, box.h - pad * 2);
  const wide = box.w > box.h * 1.4;
  if (media?.sku === "30323" || media?.sku === "30256") {
    return [
      textBlock("from", "Black Forest Automotive", x0, y0, innerW, 18, 8, true),
      textBlock("to", "Ship to", x0, y0 + innerH * 0.18, innerW, 14, 8, false),
      textBlock("name", "Name", x0, y0 + innerH * 0.28, innerW, 22, 13, true),
      textBlock("street", "Street", x0, y0 + innerH * 0.42, innerW, 16, 10, false),
      textBlock("city", "City, ST", x0, y0 + innerH * 0.52, innerW, 16, 10, false),
      { id: "code", kind: "barcode", x: x0, y: y0 + innerH * 0.66, w: innerW, h: innerH * 0.28, text: "9400111899", size: 8, bold: false, align: "left", src: "" },
    ];
  }
  if (wide) {
    return [
      textBlock("name", "Name", x0, y0 + innerH * 0.06, innerW * 0.92, innerH * 0.28, 12, true),
      textBlock("street", "Street", x0, y0 + innerH * 0.38, innerW * 0.96, innerH * 0.22, 9, false),
      textBlock("city", "City, ST  ZIP", x0, y0 + innerH * 0.64, innerW * 0.96, innerH * 0.22, 9, false),
    ];
  }
  return [
    textBlock("title", media?.name || "Label", x0, y0, innerW, Math.min(28, innerH * 0.22), 14, true),
    textBlock("line", "Line two", x0, y0 + innerH * 0.3, innerW, 20, 11, false),
  ];
}

function active() {
  return state.docs.find((doc) => doc.id === state.activeId) ?? state.docs[0];
}

function mediaOf(doc) {
  const sizes = state.printer?.sizes ?? [];
  return sizes.find((item) => item.key === doc?.mediaKey) ?? sizes[0] ?? FALLBACK_MEDIA[0];
}

/** Keep a block inside the CUPS ImageableArea (view coordinates). */
function clampBlock(block, media, turned) {
  const safe = viewSafeRect(media, turned);
  const maxW = Math.max(8, safe.w);
  const maxH = Math.max(6, safe.h);
  block.w = Math.max(8, Math.min(block.w, maxW));
  block.h = Math.max(6, Math.min(block.h, maxH));
  block.x = Math.max(safe.x, Math.min(block.x, safe.x + safe.w - block.w));
  block.y = Math.max(safe.y, Math.min(block.y, safe.y + safe.h - block.h));
}

function applyMedia(doc, media, { keep }) {
  const turned = keep ? doc.turned : prefersTurn(media);
  doc.mediaKey = media.key;
  doc.turned = turned;
  if (!keep) {
    doc.name = media.name;
    doc.blocks = addressBlocks(media, turned);
    state.pristine = true;
    state.selected = null;
    return;
  }
  for (const block of doc.blocks) clampBlock(block, media, turned);
}

const qrCache = new Map();

function qrMatrix(value) {
  return qrCache.get(String(value || " ")) ?? null;
}

async function ensureQrs(doc) {
  await Promise.all(
    doc.blocks
      .filter((block) => block.kind === "qr")
      .map(async (block) => {
        const text = String(block.text || " ");
        if (qrCache.has(text)) return;
        const response = await fetch(`/api/qr?text=${encodeURIComponent(text)}`);
        if (!response.ok) return;
        qrCache.set(text, await response.json());
      }),
  );
}

function renderLabel(doc, pxPerPt) {
  const media = mediaOf(doc);
  const view = viewSize(media, doc.turned);
  const safe = viewSafeRect(media, doc.turned);
  const label = $("label");
  const width = Math.max(120, view.widthPt * pxPerPt);
  const height = Math.max(48, view.heightPt * pxPerPt);
  label.style.width = `${width}px`;
  label.style.height = `${height}px`;
  label.replaceChildren();
  const zone = document.createElement("div");
  zone.className = "safe-zone";
  zone.title = "Printable area (CUPS ImageableArea)";
  zone.style.left = `${safe.x * pxPerPt}px`;
  zone.style.top = `${safe.y * pxPerPt}px`;
  zone.style.width = `${safe.w * pxPerPt}px`;
  zone.style.height = `${safe.h * pxPerPt}px`;
  label.append(zone);
  for (const block of doc.blocks) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `block${state.selected === block.id ? " on" : ""}`;
    el.style.left = `${block.x * pxPerPt}px`;
    el.style.top = `${block.y * pxPerPt}px`;
    el.style.width = `${block.w * pxPerPt}px`;
    el.style.height = `${block.h * pxPerPt}px`;
    el.dataset.id = block.id;
    if (block.kind === "text") {
      const words = document.createElement("div");
      if (block.fit) {
        const layout = textLayoutFor(block);
        words.className = "words fit";
        words.style.fontSize = `${layout.size * pxPerPt}px`;
        words.style.fontWeight = block.bold ? "700" : "500";
        words.style.lineHeight = String(LINE_HEIGHT);
        words.textContent = layout.lines.join("\n");
      } else {
        words.className = "words";
        words.style.fontSize = `${block.size * pxPerPt}px`;
        words.style.fontWeight = block.bold ? "700" : "500";
        words.style.textAlign = block.align || "left";
        words.textContent = block.text;
      }
      el.append(words);
    } else if (block.kind === "barcode") {
      const bars = document.createElement("div");
      bars.className = "bars";
      for (const on of code128(block.text)) {
        const i = document.createElement("i");
        i.style.background = on ? "var(--label-ink)" : "var(--paper)";
        bars.append(i);
      }
      el.append(bars);
    } else if (block.kind === "qr") {
      const matrix = qrMatrix(block.text);
      const grid = document.createElement("div");
      grid.className = "qr";
      if (matrix) {
        grid.style.gridTemplateColumns = `repeat(${matrix.size}, 1fr)`;
        for (const cell of matrix.cells) {
          const b = document.createElement("b");
          b.style.background = cell ? "var(--label-ink)" : "var(--paper)";
          grid.append(b);
        }
      }
      el.append(grid);
    } else if (block.kind === "box") {
      el.style.border = "2px solid var(--label-ink)";
    }
    const handle = document.createElement("span");
    handle.className = "handle";
    handle.dataset.handle = "1";
    el.append(handle);
    el.addEventListener("pointerdown", (event) => startDrag(event, block, pxPerPt, media, doc.turned));
    label.append(el);
  }
  label.onpointerdown = (event) => {
    if (event.target === label || event.target?.classList?.contains("safe-zone")) {
      state.selected = null;
      render();
    }
  };
}

function startDrag(event, block, pxPerPt, media, turned) {
  event.preventDefault();
  event.stopPropagation();
  state.selected = block.id;
  state.pristine = false;
  const handle = event.target?.dataset?.handle === "1";
  const startX = event.clientX;
  const startY = event.clientY;
  const orig = { x: block.x, y: block.y, w: block.w, h: block.h };
  function move(ev) {
    const dx = (ev.clientX - startX) / pxPerPt;
    const dy = (ev.clientY - startY) / pxPerPt;
    if (handle) {
      block.w = orig.w + dx;
      block.h = orig.h + dy;
    } else {
      block.x = orig.x + dx;
      block.y = orig.y + dy;
    }
    clampBlock(block, media, turned);
    renderLabel(active(), pxPerPt);
    drawProof();
  }
  function up() {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    render();
  }
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function paint(canvas, doc, widthPt, heightPt, turned) {
  const dpi = 300;
  const pxPerPt = dpi / 72;
  const view = turned ? { widthPt: heightPt, heightPt: widthPt } : { widthPt, heightPt };
  const src = document.createElement("canvas");
  src.width = Math.max(1, Math.round(view.widthPt * pxPerPt));
  src.height = Math.max(1, Math.round(view.heightPt * pxPerPt));
  const ctx = src.getContext("2d");
  ctx.fillStyle = "#fffdf8";
  ctx.fillRect(0, 0, src.width, src.height);
  ctx.fillStyle = "#14120e";
  ctx.textBaseline = "top";
  for (const block of doc.blocks) {
    const x = block.x * pxPerPt;
    const y = block.y * pxPerPt;
    const w = block.w * pxPerPt;
    const h = block.h * pxPerPt;
    if (block.kind === "text") {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      if (block.fit) {
        const layout = textLayoutFor(block);
        const sizePx = layout.size * pxPerPt;
        const lineH = layout.lineHeight * pxPerPt;
        ctx.font = `${block.bold ? 700 : 500} ${sizePx}px Liberation Sans, sans-serif`;
        ctx.textAlign = "center";
        const tx = x + layout.centerX * pxPerPt;
        const startY = y + layout.startY * pxPerPt;
        layout.lines.forEach((line, index) => ctx.fillText(line, tx, startY + index * lineH));
      } else {
        ctx.font = `${block.bold ? 700 : 500} ${block.size * pxPerPt}px Liberation Sans, sans-serif`;
        ctx.textAlign = block.align === "center" ? "center" : block.align === "right" ? "right" : "left";
        const tx = block.align === "center" ? x + w / 2 : block.align === "right" ? x + w : x;
        const lines = String(block.text || "").split("\n");
        const lineH = block.size * pxPerPt * LINE_HEIGHT;
        lines.forEach((line, index) => ctx.fillText(line, tx, y + index * lineH, w));
      }
      ctx.restore();
    } else if (block.kind === "barcode") {
      const bits = code128(block.text);
      bits.forEach((on, index) => {
        if (!on) return;
        const bx = x + (index * w) / bits.length;
        ctx.fillRect(bx, y, w / bits.length + 0.4, h);
      });
    } else if (block.kind === "qr") {
      const matrix = qrMatrix(block.text);
      if (!matrix) continue;
      const cell = Math.min(w, h) / matrix.size;
      for (let row = 0; row < matrix.size; row += 1) {
        for (let col = 0; col < matrix.size; col += 1) {
          if (!matrix.cells[row * matrix.size + col]) continue;
          ctx.fillRect(x + col * cell, y + row * cell, cell + 0.3, cell + 0.3);
        }
      }
    } else if (block.kind === "box") {
      ctx.lineWidth = Math.max(2, 1.5 * pxPerPt);
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    }
  }
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(widthPt * pxPerPt));
  out.height = Math.max(1, Math.round(heightPt * pxPerPt));
  const octx = out.getContext("2d");
  octx.fillStyle = "#ffffff";
  octx.fillRect(0, 0, out.width, out.height);
  if (!turned) {
    octx.drawImage(src, 0, 0, out.width, out.height);
  } else {
    octx.translate(out.width, 0);
    octx.rotate(Math.PI / 2);
    octx.drawImage(src, 0, 0, out.height, out.width);
  }
  return out;
}

function drawProof() {
  const doc = active();
  if (!doc) return;
  const media = mediaOf(doc);
  const canvas = paint(null, doc, media.widthPt, media.heightPt, doc.turned);
  $("proof").src = canvas.toDataURL("image/png");
  $("orient").textContent = doc.turned
    ? "Edited on the long side. The 550 receives it turned onto the roll."
    : `Prints ${formatInches(media)}, the same way it sits on the roll.`;
}

function renderProps() {
  const doc = active();
  const block = doc?.blocks.find((item) => item.id === state.selected);
  const host = $("block-props");
  host.replaceChildren();
  $("remove").hidden = !block;
  if (!block) return;
  const title = document.createElement("h2");
  title.textContent = block.kind === "text" ? "Text" : block.kind === "barcode" ? "Barcode" : block.kind === "qr" ? "QR" : "Box";
  host.append(title);
  if (block.kind !== "box") {
    const field = document.createElement("label");
    field.className = "field";
    const span = document.createElement("span");
    span.textContent = block.kind === "text" ? "Words" : "Value";
    const input = block.kind === "text" ? document.createElement("textarea") : document.createElement("input");
    input.value = block.text;
    input.addEventListener("input", () => {
      block.text = input.value;
      state.pristine = false;
      renderLabelOnly();
      drawProof();
      if (block.kind === "text" && block.fit) {
        const sizeInput = host.querySelector('input[type="number"]');
        if (sizeInput) sizeInput.value = String(textLayoutFor(block).size);
      }
      void refreshQrs();
      scheduleSave();
    });
    field.append(span, input);
    host.append(field);
  }
  if (block.kind === "text") {
    const fit = document.createElement("label");
    fit.className = "check";
    const fitBox = document.createElement("input");
    fitBox.type = "checkbox";
    fitBox.checked = Boolean(block.fit);
    fitBox.addEventListener("change", () => {
      block.fit = fitBox.checked;
      block.align = block.fit ? "center" : "left";
      state.pristine = false;
      renderProps();
      renderLabelOnly();
      drawProof();
      scheduleSave();
    });
    fit.append(fitBox, document.createTextNode("Center and fit"));
    const size = document.createElement("label");
    size.className = "field";
    const span = document.createElement("span");
    span.textContent = block.fit ? "Size (fit)" : "Size";
    const input = document.createElement("input");
    input.type = "number";
    input.min = "6";
    input.max = "72";
    if (block.fit) {
      const layout = textLayoutFor(block);
      input.value = String(layout.size);
      input.disabled = true;
      input.title = "Size follows the box while Center and fit is on";
    } else {
      input.value = String(block.size);
      input.addEventListener("input", () => {
        block.size = Number(input.value) || 10;
        state.pristine = false;
        renderLabelOnly();
        drawProof();
        scheduleSave();
      });
    }
    size.append(span, input);
    const bold = document.createElement("label");
    bold.className = "check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = block.bold;
    box.addEventListener("change", () => {
      block.bold = box.checked;
      state.pristine = false;
      renderProps();
      renderLabelOnly();
      drawProof();
      scheduleSave();
    });
    bold.append(box, document.createTextNode("Bold"));
    host.append(fit, size, bold);
  }
}

function renderLabelOnly() {
  const doc = active();
  if (!doc) return;
  const stage = $("stage");
  const media = mediaOf(doc);
  for (const block of doc.blocks) clampBlock(block, media, doc.turned);
  const view = viewSize(media, doc.turned);
  const px = Math.min((stage.clientWidth - 32) / view.widthPt, (stage.clientHeight - 32) / view.heightPt, 3.2);
  renderLabel(doc, Math.max(0.8, px));
}

function renderSizes() {
  const doc = active();
  const select = $("size");
  const sizes = state.printer?.sizes ?? [];
  const roll = state.printer?.roll;
  select.replaceChildren();
  for (const item of sizes) {
    const option = document.createElement("option");
    option.value = item.key;
    option.textContent = `${item.name} · ${formatInches(item)}`;
    select.append(option);
  }
  if (doc) select.value = doc.mediaKey;
  select.disabled = Boolean(roll);
  $("size-note").textContent = roll
    ? "Size follows the roll in the printer."
    : "No roll read yet. Pick the label that is loaded. Print still goes to the 550.";
  $("turn").checked = Boolean(doc?.turned);
  $("name").value = doc?.name ?? "";
  // The poll re-renders every time the roll or printer state moves. Do not
  // overwrite a count Logan is typing and has not committed yet.
  if (document.activeElement !== $("copies")) $("copies").value = String(doc?.copies || 1);
}

function renderStatus() {
  const info = state.printer;
  const host = $("status");
  host.replaceChildren();
  const pill = document.createElement("span");
  pill.className = "pill";
  if (!info) {
    pill.classList.add("warn");
    pill.textContent = "Looking for the roll";
    host.append(pill);
    return;
  }
  if (info.roll) {
    pill.textContent = info.roll.bayLabel || "Roll in";
  } else if (!info.queuePresent) {
    pill.classList.add("bad");
    pill.textContent = "Queue missing";
  } else if (info.state === "paused") {
    pill.classList.add("warn");
    pill.textContent = "Paused";
  } else {
    pill.classList.add("warn");
    pill.textContent = info.usbError === "EACCES" ? "Can't read the roll" : "No roll yet";
  }
  const strong = document.createElement("strong");
  strong.textContent = info.message || info.queue;
  host.append(pill, strong);
}

function renderSaved() {
  const host = $("saved");
  host.replaceChildren();
  for (const doc of state.docs) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = doc.name || "Label";
    if (doc.id === state.activeId) button.style.borderColor = "var(--brand)";
    button.addEventListener("click", () => {
      state.activeId = doc.id;
      state.pristine = false;
      state.selected = null;
      render();
    });
    host.append(button);
  }
}

function renderTemplates() {
  const host = $("templates");
  if (host.childElementCount) return;
  const starters = [
    ["Address", "30252"],
    ["Return", "30330"],
    ["Shipping", "30323"],
    ["Folder", "30327"],
    ["Part bin", "30334"],
    ["Badge", "30857"],
  ];
  for (const [label, sku] of starters) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = label;
    button.addEventListener("click", () => {
      const sizes = state.printer?.sizes ?? [];
      const media = sizes.find((item) => item.sku === sku) ?? sizes[0];
      if (!media) return;
      if (state.printer?.roll && state.printer.roll.sku !== sku) {
        $("error").textContent = `The roll in the printer is ${state.printer.roll.name}. The size stays on that roll.`;
        const doc = active();
        const current = mediaOf(doc);
        doc.blocks = addressBlocks(current, doc.turned);
        if (sku === "30334") doc.blocks = partBin(current, doc.turned);
        state.pristine = false;
        render();
        return;
      }
      const doc = blankDoc(media);
      if (sku === "30334") doc.blocks = partBin(media, doc.turned);
      doc.name = label;
      state.docs.unshift(doc);
      state.activeId = doc.id;
      state.pristine = true;
      state.selected = null;
      render();
      scheduleSave();
    });
    host.append(button);
  }
}

function partBin(media, turned = prefersTurn(media)) {
  const view = viewSize(media, turned);
  const safe = viewSafeRect(media, turned);
  const box = safe.w > 8 && safe.h > 6 ? safe : { x: 0, y: 0, w: view.widthPt, h: view.heightPt };
  const pad = Math.max(2, Math.min(box.w, box.h) * 0.06);
  const x0 = box.x + pad;
  const y0 = box.y + pad;
  const innerW = Math.max(8, box.w - pad * 2);
  const innerH = Math.max(6, box.h - pad * 2);
  return [
    textBlock("part", "PART", x0, y0, innerW, innerH * 0.28, 16, true),
    textBlock("desc", "Description", x0, y0 + innerH * 0.32, innerW, innerH * 0.22, 9, false),
    { id: "bin", kind: "barcode", x: x0, y: y0 + innerH * 0.58, w: innerW, h: innerH * 0.34, text: "000000", size: 8, bold: false, align: "left", src: "" },
  ];
}

function render() {
  renderStatus();
  renderSizes();
  renderSaved();
  renderTemplates();
  renderLabelOnly();
  renderProps();
  drawProof();
  void refreshQrs();
}

async function refreshQrs() {
  const doc = active();
  if (!doc) return;
  const before = qrCache.size;
  await ensureQrs(doc);
  if (qrCache.size !== before) {
    renderLabelOnly();
    drawProof();
  }
}

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

async function save() {
  const docs = state.docs.slice(0, 40);
  localStorage.setItem("label-connect", JSON.stringify({ docs, activeId: state.activeId }));
  await fetch("/api/labels", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ docs, activeId: state.activeId }),
  }).catch(() => {});
}

async function refreshPrinter() {
  const response = await fetch("/api/printer");
  if (!response.ok) return;
  const info = await response.json();
  const signature = `${info.roll?.key ?? ""}|${info.roll?.remaining ?? ""}|${info.state}|${info.message}|${info.sizes?.length ?? 0}`;
  const changed = signature !== state.signature || !state.docs.length;
  state.signature = signature;
  state.printer = info;
  if (!state.docs.length) {
    const media = info.roll ?? info.sizes.find((item) => item.sku === "30252") ?? info.sizes[0];
    const doc = blankDoc(media);
    state.docs = [doc];
    state.activeId = doc.id;
  } else if (info.roll && info.roll.key !== active().mediaKey) {
    applyMedia(active(), info.roll, { keep: !state.pristine });
    if (!state.pristine) $("error").textContent = `Size is now ${info.roll.name}.`;
  }
  if (changed) render();
}

function commitCopies() {
  const doc = active();
  if (!doc) return 1;
  doc.copies = normalizeCopies($("copies").value);
  return doc.copies;
}

async function printLabel() {
  const doc = active();
  const copies = commitCopies();
  const media = state.printer?.roll ?? mediaOf(doc);
  $("error").textContent = "";
  $("print").disabled = true;
  $("print-mobile").disabled = true;
  try {
    await ensureQrs(doc);
    const canvas = paint(null, { ...doc, blocks: doc.blocks }, media.widthPt, media.heightPt, doc.turned && media.key === doc.mediaKey);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const response = await fetch("/api/print", {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-page-size": media.key,
        "x-width-pt": String(media.widthPt),
        "x-height-pt": String(media.heightPt),
        "x-copies": String(copies),
      },
      body: blob,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "The 550 did not take the label.");
    $("error").classList.remove("error");
    const sent = payload.job || "Sent to the LabelWriter 550.";
    $("error").textContent = copies > 1 ? `${sent} (${copies} copies)` : sent;
  } catch (error) {
    $("error").classList.add("error");
    $("error").textContent = error instanceof Error ? error.message : "The 550 did not take the label.";
  } finally {
    $("print").disabled = false;
    $("print-mobile").disabled = false;
  }
}

function addBlock(kind) {
  const doc = active();
  const media = mediaOf(doc);
  const safe = viewSafeRect(media, doc.turned);
  const inset = 4;
  const block = {
    id: uid(),
    kind,
    x: safe.x + inset,
    y: safe.y + inset,
    w: Math.min(Math.max(8, safe.w - inset * 2), kind === "qr" ? 48 : safe.w * 0.7),
    h: kind === "qr" ? 48 : kind === "box" ? 24 : 18,
    text: kind === "text" ? "Text" : "12345",
    size: 11,
    bold: false,
    align: "left",
    fit: false,
    src: "",
  };
  clampBlock(block, media, doc.turned);
  doc.blocks.push(block);
  state.selected = block.id;
  state.pristine = false;
  render();
  scheduleSave();
}

function bootFromStorage() {
  try {
    const raw = localStorage.getItem("label-connect");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.docs) && parsed.docs.length) {
      state.docs = parsed.docs;
      state.activeId = parsed.activeId || parsed.docs[0].id;
      state.pristine = false;
    }
  } catch {
    // A bad save should not block a new label.
  }
}

$("print").addEventListener("click", printLabel);
$("print-mobile").addEventListener("click", printLabel);
$("copies").addEventListener("input", () => {
  commitCopies();
  scheduleSave();
});
$("copies").addEventListener("change", () => {
  $("copies").value = String(commitCopies());
  scheduleSave();
});
$("name").addEventListener("input", () => {
  active().name = $("name").value;
  state.pristine = false;
  renderSaved();
  scheduleSave();
});
$("size").addEventListener("change", () => {
  if (state.printer?.roll) return;
  const media = state.printer.sizes.find((item) => item.key === $("size").value);
  if (!media) return;
  applyMedia(active(), media, { keep: false });
  render();
  scheduleSave();
});
$("turn").addEventListener("change", () => {
  const doc = active();
  doc.turned = $("turn").checked;
  const media = mediaOf(doc);
  for (const block of doc.blocks) clampBlock(block, media, doc.turned);
  state.pristine = false;
  render();
  scheduleSave();
});
$("remove").addEventListener("click", () => {
  const doc = active();
  doc.blocks = doc.blocks.filter((block) => block.id !== state.selected);
  state.selected = null;
  state.pristine = false;
  render();
  scheduleSave();
});
document.querySelectorAll("[data-add]").forEach((button) => {
  button.addEventListener("click", () => addBlock(button.dataset.add));
});
window.addEventListener("keydown", (event) => {
  if (event.key !== "Delete" && event.key !== "Backspace") return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (!state.selected) return;
  event.preventDefault();
  $("remove").click();
});
window.addEventListener("resize", () => renderLabelOnly());

bootFromStorage();
if (!state.docs.length) {
  state.printer = {
    queue: "LabelWriter550",
    sizes: FALLBACK_MEDIA,
    roll: null,
    state: "missing",
    message: "Looking for the LabelWriter 550",
    queuePresent: false,
  };
  const doc = blankDoc(FALLBACK_MEDIA[0]);
  state.docs = [doc];
  state.activeId = doc.id;
  state.pristine = true;
}
render();
refreshPrinter().catch((error) => {
  $("error").textContent = error instanceof Error ? error.message : "Could not see the printer.";
});
setInterval(() => {
  refreshPrinter().catch(() => {});
}, 2000);
