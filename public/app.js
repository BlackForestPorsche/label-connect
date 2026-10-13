import { code128 } from "/shared/code128.mjs";
import { prefersTurn, viewSize, formatInches, FALLBACK_MEDIA, viewSafeRect, DEFAULT_SAFE_PT } from "/shared/media.mjs";
import { fitTextLayout, LINE_HEIGHT } from "/shared/text-fit.mjs";

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
  const view = viewSize(media, turned);
  const doc = {
    id: uid(),
    name: media.name,
    mediaKey: media.key,
    turned,
    copies: 1,
    blocks: addressBlocks(view, media),
  };
  return doc;
}

function textBlock(id, text, x, y, w, h, size, bold) {
  return { id, kind: "text", x, y, w, h, text, size, bold, align: "left", fit: false, src: "" };
}

function addressBlocks(view, media) {
  const turned = Boolean(media && view.widthPt === media.heightPt && view.heightPt === media.widthPt);
  const safe = viewSafeRect(media || { widthPt: view.widthPt, heightPt: view.heightPt }, turned);
  const edge = Math.max(safe.x, safe.y, view.widthPt - safe.x - safe.w, view.heightPt - safe.y - safe.h, DEFAULT_SAFE_PT);
  const pad = Math.max(edge, Math.min(view.widthPt, view.heightPt) * 0.06);
  const wide = view.widthPt > view.heightPt * 1.4;
  if (media?.sku === "30323" || media?.sku === "30256") {
    return [
      textBlock("from", "Black Forest Automotive", pad, pad, view.widthPt - pad * 2, 18, 8, true),
      textBlock("to", "Ship to", pad, view.heightPt * 0.22, view.widthPt - pad * 2, 14, 8, false),
      textBlock("name", "Name", pad, view.heightPt * 0.32, view.widthPt - pad * 2, 22, 13, true),
      textBlock("street", "Street", pad, view.heightPt * 0.46, view.widthPt - pad * 2, 16, 10, false),
      textBlock("city", "City, ST", pad, view.heightPt * 0.56, view.widthPt - pad * 2, 16, 10, false),
      { id: "code", kind: "barcode", x: pad, y: view.heightPt * 0.7, w: view.widthPt - pad * 2, h: view.heightPt * 0.22, text: "9400111899", size: 8, bold: false, align: "left", src: "" },
    ];
  }
  if (wide) {
    return [
      textBlock("name", "Name", pad, view.heightPt * 0.1, view.widthPt * 0.78, view.heightPt * 0.28, 12, true),
      textBlock("street", "Street", pad, view.heightPt * 0.4, view.widthPt * 0.84, view.heightPt * 0.22, 9, false),
      textBlock("city", "City, ST  ZIP", pad, view.heightPt * 0.64, view.widthPt * 0.84, view.heightPt * 0.22, 9, false),
    ];
  }
  return [
    textBlock("title", media?.name || "Label", pad, pad, view.widthPt - pad * 2, Math.min(28, view.heightPt * 0.22), 14, true),
    textBlock("line", "Line two", pad, view.heightPt * 0.34, view.widthPt - pad * 2, 20, 11, false),
  ];
}

function active() {
  return state.docs.find((doc) => doc.id === state.activeId) ?? state.docs[0];
}

function mediaOf(doc) {
  const sizes = state.printer?.sizes ?? [];
  const found =
    sizes.find((item) => item.key === doc?.mediaKey) ??
    sizes[0] ??
    FALLBACK_MEDIA.find((item) => item.key === "w79h252") ??
    FALLBACK_MEDIA[0];
  if (!found) return found;
  if (found.imageable) return found;
  const fallback = FALLBACK_MEDIA.find((item) => item.key === found.key);
  return fallback?.imageable ? { ...found, imageable: fallback.imageable } : found;
}

function clampBlock(block, view, safe) {
  const area = safe && safe.w > 0 && safe.h > 0 ? safe : { x: 0, y: 0, w: view.widthPt, h: view.heightPt };
  const maxW = Math.max(8, area.w);
  const maxH = Math.max(6, area.h);
  block.w = Math.max(8, Math.min(block.w, maxW));
  block.h = Math.max(6, Math.min(block.h, maxH));
  block.x = Math.max(area.x, Math.min(block.x, area.x + area.w - block.w));
  block.y = Math.max(area.y, Math.min(block.y, area.y + area.h - block.h));
}

function applyMedia(doc, media, { keep }) {
  const turned = keep ? doc.turned : prefersTurn(media);
  const view = viewSize(media, turned);
  doc.mediaKey = media.key;
  doc.turned = turned;
  if (!keep) {
    doc.name = media.name;
    doc.blocks = addressBlocks(view, media);
    state.pristine = true;
    state.selected = null;
    return;
  }
  const safe = viewSafeRect(media, turned);
  for (const block of doc.blocks) clampBlock(block, view, safe);
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
  const guide = document.createElement("div");
  guide.className = "safe-zone";
  guide.title = "Safe print area — keep text and graphics inside this dashed box";
  guide.style.left = `${safe.x * pxPerPt}px`;
  guide.style.top = `${safe.y * pxPerPt}px`;
  guide.style.width = `${safe.w * pxPerPt}px`;
  guide.style.height = `${safe.h * pxPerPt}px`;
  label.append(guide);
  for (const block of doc.blocks) {
    clampBlock(block, view, safe);
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
    el.addEventListener("pointerdown", (event) => startDrag(event, block, pxPerPt, view, safe));
    label.append(el);
  }
  label.onpointerdown = (event) => {
    if (event.target === label) {
      state.selected = null;
      render();
    }
  };
}

function startDrag(event, block, pxPerPt, view, safe) {
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
    clampBlock(block, view, safe);
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
