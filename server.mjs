import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { describePrinter } from "./shared/detect.mjs";
import { sendPdfToQueue, sendToQueue } from "./shared/print.mjs";
import { safePageKey } from "./shared/media.mjs";
import { createRoPrintStore } from "./shared/ro-idempotency.mjs";
import { normalizeRoPayload, planRoPrint, renderRoLabelPdf, roLabelLines } from "./shared/ro-label.mjs";
import {
  applyDeskExtensionUpdate,
  isLocalClient,
  readDeskVersion,
  resolveLabelConnectRoot,
} from "./shared/desk-update.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const labelsFile = path.join(dataDir, "labels.json");
const roPrintsFile = path.join(dataDir, "ro-prints.json");
const roPrintStore = createRoPrintStore(roPrintsFile);
const port = Number(process.env.PORT || 8080);
const host = "0.0.0.0";

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function readLabels() {
  try {
    const text = await readFile(labelsFile, "utf8");
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.docs) ? parsed : { docs: [], activeId: "" };
  } catch {
    return { docs: [], activeId: "" };
  }
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, {
    "content-type": type,
    "content-length": payload.length,
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readBody(req, limit = 8_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("That label is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const underShared = rel.startsWith("/shared/");
  const base = underShared ? path.join(root, "shared") : publicDir;
  const filePath = path.normalize(path.join(base, underShared ? path.basename(rel) : rel));
  if (!filePath.startsWith(base)) {
    send(res, 404, { error: "Missing" });
    return;
  }
  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    send(res, 200, body, types[ext] || "application/octet-stream");
  } catch {
    send(res, 404, { error: "Missing" });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/qr") {
      const text = (url.searchParams.get("text") || " ").slice(0, 80);
      const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
      const size = qr.modules.size;
      const cells = [];
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) cells.push(qr.modules.get(y, x) ? 1 : 0);
      }
      send(res, 200, { size, cells });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/printer") {
      const info = await exclusive(() => describePrinter());
      send(res, 200, info);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/labels") {
      send(res, 200, await readLabels());
      return;
    }
    if (req.method === "PUT" && url.pathname === "/api/labels") {
      const raw = await readBody(req, 2_000_000);
      const parsed = JSON.parse(raw.toString("utf8"));
      const docs = Array.isArray(parsed.docs) ? parsed.docs.slice(0, 40) : [];
      await mkdir(dataDir, { recursive: true });
      await writeFile(labelsFile, JSON.stringify({ docs, activeId: String(parsed.activeId || "") }));
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/print") {
      const pageKey = safePageKey(req.headers["x-page-size"]);
      const widthPt = Number(req.headers["x-width-pt"]);
      const heightPt = Number(req.headers["x-height-pt"]);
      const copies = Number(req.headers["x-copies"] || 1);
      if (!pageKey) {
        send(res, 400, { error: "That label size is not on the 550." });
        return;
      }
      const png = await readBody(req);
      if (png.length < 32) {
        send(res, 400, { error: "Nothing to print." });
        return;
      }
      const result = await exclusive(() => sendToQueue(png, { pageKey, widthPt, heightPt, copies }));
      send(res, 200, result);
      return;
    }
    // Desk extension one-click update (localhost only — never expose shell to LAN).
    if (req.method === "GET" && url.pathname === "/api/desk-extension") {
      if (!isLocalClient(req)) {
        send(res, 403, { error: "localhost_only", message: "Desk updates are only available from this machine." });
        return;
      }
      const connectRoot = await resolveLabelConnectRoot(root);
      const version = await readDeskVersion(connectRoot);
      send(res, 200, {
        ok: true,
        version,
        root: connectRoot,
        updateEndpoint: "/api/update-desk-extension",
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/update-desk-extension") {
      if (!isLocalClient(req)) {
        send(res, 403, { error: "localhost_only", message: "Desk updates are only available from this machine." });
        return;
      }
      const result = await exclusive(() => applyDeskExtensionUpdate(root));
      let status = 500;
      if (result.ok) status = 200;
      else if (result.mode === "hub_upload" || result.error === "hub_signed_kept") status = 409;
      send(res, status, result);
      return;
    }
    // AllData Create RO → real LabelWriter print (last name + model only).
    if (req.method === "POST" && url.pathname === "/api/print-ro") {
      const raw = await readBody(req, 64_000);
      let parsed;
      try {
        parsed = JSON.parse(raw.toString("utf8") || "{}");
      } catch {
        send(res, 400, { error: "JSON body required." });
        return;
      }
      const dryRunQuery = url.searchParams.get("dryRun") === "1" || url.searchParams.get("dryRun") === "true";
      const body = { ...parsed, dryRun: dryRunQuery || parsed.dryRun === true || parsed.dryRun === "1" };
      const normalized = normalizeRoPayload(body);
      if (!normalized.ok) {
        send(res, 400, { error: normalized.error });
        return;
      }
      const { fields } = normalized;
      const plan = planRoPrint(fields);
      if (!plan.ok) {
        send(res, 400, { error: plan.error });
        return;
      }

      // Idempotency is by concrete RO id only — never by customer/person/name.
      // Extension omits open/baseline RO# so a new Create for the same person always prints.
      if (fields.roNumber && (await roPrintStore.has(fields.roNumber))) {
        send(res, 200, {
          ok: true,
          skipped: true,
          printed: false,
          dryRun: Boolean(fields.dryRun),
          message: `Already printed RO ${fields.roNumber} within 24h.`,
          fields,
          lines: roLabelLines(fields),
          doc: plan.doc,
        });
        return;
      }

      if (fields.dryRun) {
        send(res, 200, {
          ok: true,
          dryRun: true,
          printed: false,
          skipped: false,
          message: plan.message,
          fields,
          lines: plan.lines,
          doc: plan.doc,
        });
        return;
      }

      const { pdf, media } = await renderRoLabelPdf(fields);
      const result = await exclusive(() => sendPdfToQueue(pdf, { pageKey: media.key }));
      if (fields.roNumber) {
        await roPrintStore.mark(fields.roNumber, { lastName: fields.lastName, model: fields.model });
      }
      send(res, 200, {
        ok: true,
        dryRun: false,
        printed: true,
        skipped: false,
        job: result.job || "",
        fields,
        lines: plan.lines,
        doc: plan.doc,
      });
      return;
    }
    if (req.method === "GET") {
      await serveStatic(res, decodeURIComponent(url.pathname));
      return;
    }
    send(res, 405, { error: "No" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not finish that.";
    send(res, 500, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(`Labels listening on ${host}:${port}`);
});
