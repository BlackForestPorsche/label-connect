import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { QUEUE, safePageKey } from "./media.mjs";
import { listWindowsPrinters, run } from "./detect.mjs";
import {
  NATIVE_PRINT_SCRIPT,
  POWERSHELL_ARGS,
  PRINTTO_SCRIPT,
  RENDERER_UNAVAILABLE,
  nativeEnv,
  noWindowsPrinterMessage,
  pickWindowsPrinter,
  sumatraArgs,
  sumatraCandidates,
  windowsPrintMode,
} from "./winprint.mjs";

export function printArgs(pageKey, pdfPath) {
  const key = safePageKey(pageKey);
  if (!key) throw new Error("That label size is not on the 550.");
  return ["-d", QUEUE, "-o", `PageSize=${key}`, "-o", "PrintQuality=Graphics", "-n", "1", pdfPath];
}

export async function pngToPdf(png, widthPt, heightPt, copies) {
  const count = Math.min(20, Math.max(1, Math.round(Number(copies) || 1)));
  const width = Number(widthPt);
  const height = Number(heightPt);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 18 || height < 18 || width > 800 || height > 8000) {
    throw new Error("That label size is off.");
  }
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(png);
  for (let i = 0; i < count; i += 1) {
    const page = doc.addPage([width, height]);
    page.drawImage(image, { x: 0, y: 0, width, height });
  }
  return doc.save();
}

const defaultWindowsDeps = {
  run,
  exists: existsSync,
  env: process.env,
};

async function runPowerShell(deps, dir, name, script, extraEnv, timeoutMs) {
  const scriptPath = path.join(dir, name);
  await writeFile(scriptPath, `\ufeff${script}`, "utf8");
  return deps.run(
    "powershell.exe",
    [...POWERSHELL_ARGS, "-File", scriptPath],
    timeoutMs,
    { env: extraEnv },
  );
}

function failure(result, fallback) {
  const detail = (result.stderr || result.stdout || fallback).trim();
  return new Error(detail.split(/\r?\n/).find((line) => line.trim()) || fallback);
}

/**
 * Windows: print a PDF to the LabelWriter/DYMO queue. `auto` tries the native
 * renderer first and only falls through to SumatraPDF / PrintTo when Windows
 * cannot render PDFs (a real print failure is never retried, to avoid doubles).
 */
export async function sendPdfWindows(pdfPath, { pageKey, deps = {} } = {}) {
  const d = { ...defaultWindowsDeps, ...deps };
  const env = d.env;
  const dir = path.dirname(pdfPath);
  const printers = await listWindowsPrinters(d.run);
  const pick = pickWindowsPrinter(
    printers.map((printer) => printer.name),
    env,
  );
  if (!pick.name) throw new Error(noWindowsPrinterMessage(pick));

  const mode = windowsPrintMode(env);
  const psEnv = nativeEnv({ pdfPath, printer: pick.name, pageKey, env });

  if (mode === "auto" || mode === "native") {
    const result = await runPowerShell(d, dir, "print-native.ps1", NATIVE_PRINT_SCRIPT, psEnv, 90000);
    if (result.code === 0) return { job: (result.stdout || "").trim().split(/\r?\n/).pop() || pick.name };
    if (result.code !== RENDERER_UNAVAILABLE || mode === "native") throw failure(result, "Windows print failed.");
  }

  if (mode === "auto" || mode === "sumatra") {
    const sumatra = sumatraCandidates(env).find((candidate) => d.exists(candidate));
    if (sumatra) {
      const result = await d.run(sumatra, sumatraArgs(pick.name, pdfPath), 60000);
      if (result.code === 0) return { job: pick.name };
      if (mode === "sumatra") throw failure(result, "SumatraPDF could not print the label.");
    } else if (mode === "sumatra") {
      throw new Error("SumatraPDF was not found. Set LABELS_SUMATRA to SumatraPDF.exe.");
    }
  }

  const result = await runPowerShell(d, dir, "print-to.ps1", PRINTTO_SCRIPT, psEnv, 60000);
  if (result.code !== 0) throw failure(result, "PrintTo failed. Install a PDF app that supports printing.");
  return { job: (result.stdout || "").trim() || pick.name };
}

async function sendPdfLinux(pdfPath, pageKey) {
  const args = printArgs(pageKey, pdfPath);
  let result = await run("lp", args, 20000);
  if (result.code !== 0 && /PrintQuality/i.test(`${result.stderr}\n${result.stdout}`)) {
    const cleaned = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "-o" && args[i + 1] === "PrintQuality=Graphics") {
        i += 1;
        continue;
      }
      cleaned.push(args[i]);
    }
    result = await run("lp", cleaned, 20000);
  }
  if (result.code === 127) throw new Error(`This computer cannot reach ${QUEUE}.`);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || "The printer did not take the label.").trim();
    throw new Error(detail.split("\n")[0]);
  }
  return { job: (result.stdout || "").trim() };
}

/** Send an already-rendered PDF to the LabelWriter queue (Linux CUPS or Windows PrintTo). */
export async function sendPdfToQueue(pdfBytes, { pageKey }) {
  const key = safePageKey(pageKey);
  if (!key) throw new Error("That label size is not on the 550.");
  const dir = await mkdtemp(path.join(tmpdir(), "label-ro-"));
  const file = path.join(dir, "label.pdf");
  try {
    await writeFile(file, pdfBytes);
    if (process.platform === "win32") {
      return await sendPdfWindows(file, { pageKey: key });
    }
    return await sendPdfLinux(file, key);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function sendToQueue(png, { pageKey, widthPt, heightPt, copies }) {
  const pdf = await pngToPdf(png, widthPt, heightPt, copies);
  return sendPdfToQueue(pdf, { pageKey });
}
