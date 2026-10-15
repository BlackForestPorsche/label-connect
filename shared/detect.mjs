import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { open, readdir, readFile } from "node:fs/promises";
import { QUEUE, FALLBACK_MEDIA, mediaBySku, parsePpd } from "./media.mjs";
import { parseSkuDump, parseStatus } from "./status.mjs";
import {
  LIST_PRINTERS_SCRIPT,
  POWERSHELL_ARGS,
  parseWindowsPrinterList,
  pickWindowsPrinter,
  windowsQueueStatus,
} from "./winprint.mjs";

const PPD_CANDIDATES = [
  `/etc/cups/ppd/${QUEUE}.ppd`,
  `/etc/cups/ppd/${QUEUE.toLowerCase()}.ppd`,
  // Readable copy when the queue PPD is root:cups mode 640.
  "/usr/share/cups/model/dymo/lw550.ppd",
];

function run(cmd, args, timeoutMs = 4000, { env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function loadMedia() {
  for (const path of PPD_CANDIDATES) {
    try {
      const text = await readFile(path, "utf8");
      const parsed = parsePpd(text);
      if (parsed.length) return { media: parsed, ppd: path };
    } catch {
      // Queue PPD is only on the shop PC.
    }
  }
  return { media: FALLBACK_MEDIA, ppd: null };
}

export async function listWindowsPrinters(runFn = run) {
  const result = await runFn("powershell.exe", [...POWERSHELL_ARGS, "-Command", LIST_PRINTERS_SCRIPT], 15000);
  if (result.code !== 0) return [];
  return parseWindowsPrinterList(result.stdout);
}

export async function windowsQueue(runFn = run, env = process.env) {
  const printers = await listWindowsPrinters(runFn);
  const pick = pickWindowsPrinter(
    printers.map((printer) => printer.name),
    env,
  );
  const found = printers.find((printer) => printer.name === pick.name) ?? null;
  return { ...windowsQueueStatus(found, String(env.LABELS_PRINTER || "").trim() || QUEUE), name: pick.name };
}

export async function queueStatus() {
  if (process.platform === "win32") return windowsQueue();
  const listed = await run("lpstat", ["-p", QUEUE, "-l"]);
  const uri = await run("lpstat", ["-v", QUEUE]);
  if (listed.code !== 0) {
    return {
      present: false,
      state: "missing",
      uri: "",
      message: `No print queue named ${QUEUE} on this computer.`,
    };
  }
  const text = `${listed.stdout}\n${uri.stdout}`;
  const device = /device for\s+\S+:\s*(\S+)/i.exec(uri.stdout)?.[1] ?? "";
  let state = "idle";
  if (/disabled/i.test(listed.stdout)) state = "paused";
  else if (/is idle/i.test(listed.stdout)) state = "idle";
  else if (/now printing/i.test(listed.stdout) || /processing/i.test(listed.stdout)) state = "printing";
  const message =
    state === "paused"
      ? `${QUEUE} is paused.`
      : device
        ? `${QUEUE} · ${device}`
        : `${QUEUE} is ready.`;
  return { present: true, state, uri: device, message, raw: text };
}

async function lpNodes() {
  try {
    const names = await readdir("/dev/usb");
    return names.filter((name) => /^lp\d+$/.test(name)).map((name) => `/dev/usb/${name}`);
  } catch {
    return [];
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readReply(fh, size) {
  const buf = Buffer.alloc(size);
  const started = Date.now();
  let filled = 0;
  while (filled < size && Date.now() - started < 700) {
    try {
      const { bytesRead } = await fh.read(buf, filled, size - filled, null);
      if (bytesRead > 0) filled += bytesRead;
      else await sleep(40);
    } catch (error) {
      if (error?.code === "EAGAIN" || error?.code === "EWOULDBLOCK") {
        await sleep(40);
        continue;
      }
      throw error;
    }
  }
  return filled ? buf.subarray(0, filled) : null;
}

async function probeNode(path) {
  const fh = await open(path, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
  try {
    await fh.write(Buffer.from([0x1b, 0x41, 0x00]));
    const statusRaw = await readReply(fh, 32);
    const status = statusRaw ? parseStatus(statusRaw) : null;
    let dump = null;
    if (status?.sku) {
      await fh.write(Buffer.from([0x1b, 0x55]));
      const dumpRaw = await readReply(fh, 64);
      dump = dumpRaw ? parseSkuDump(dumpRaw) : null;
    }
    return { status, dump };
  } finally {
    await fh.close();
  }
}

export async function readRoll() {
  const nodes = await lpNodes();
  for (const path of nodes) {
    try {
      const found = await probeNode(path);
      if (found.status) return { ...found, device: path };
    } catch (error) {
      if (error?.code === "EBUSY" || error?.code === "EACCES" || error?.code === "EPERM") {
        return { status: null, dump: null, device: path, error: error.code };
      }
    }
  }
  return { status: null, dump: null, device: nodes[0] ?? "", error: nodes.length ? null : "nodevice" };
}

export async function describePrinter() {
  const [{ media, ppd }, queue, roll] = await Promise.all([loadMedia(), queueStatus(), readRoll()]);
  const queueName = queue.name || QUEUE;
  const sku = roll.status?.sku || roll.dump?.sku || "";
  const matched = mediaBySku(media, sku);
  let rollInfo = null;
  if (matched && roll.status && roll.status.bay !== 2 && roll.status.bay !== 5) {
    rollInfo = {
      sku: matched.sku || sku,
      key: matched.key,
      name: matched.name,
      widthPt: matched.widthPt,
      heightPt: matched.heightPt,
      imageable: matched.imageable ?? null,
      remaining: roll.status.remaining || null,
      bay: roll.status.bay,
      bayLabel: roll.status.bayLabel,
      source: "printer",
    };
  }
  return {
    queue: queueName,
    ppd,
    queuePresent: queue.present,
    state: queue.state,
    uri: queue.uri,
    message: rollInfo
      ? `${rollInfo.name}${rollInfo.remaining ? ` · ${rollInfo.remaining} left` : ""}`
      : roll.status
        ? roll.status.bayLabel
        : queue.message,
    roll: rollInfo,
    usb: roll.device || "",
    usbError: roll.error || "",
    sizes: media.map((item) => ({
      key: item.key,
      sku: item.sku,
      name: item.name,
      widthPt: item.widthPt,
      heightPt: item.heightPt,
      imageable: item.imageable ?? null,
    })),
  };
}

export { run };
