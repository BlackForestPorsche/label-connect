import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { platform } from "node:os";
import { PDFDocument } from "pdf-lib";
import { QUEUE, safePageKey } from "./media.mjs";
import { run } from "./detect.mjs";

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

async function sendPdfViaCups(pdfPath, pageKey) {
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
  return { job: (result.stdout || "").trim(), via: "cups" };
}

/**
 * Windows: print the PDF to a LabelWriter / DYMO queue via PrintTo.
 * Printer name from LABELS_PRINTER, else first match for LabelWriter|DYMO.
 */
async function sendPdfViaWindows(pdfPath) {
  const preferred = String(process.env.LABELS_PRINTER || QUEUE).replace(/'/g, "''");
  const file = String(pdfPath).replace(/'/g, "''");
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `$file = '${file}'`,
    `$preferred = '${preferred}'`,
    `$printer = Get-Printer -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $preferred } | Select-Object -First 1`,
    `if (-not $printer) { $printer = Get-Printer -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'LabelWriter|DYMO' } | Select-Object -First 1 }`,
    `if (-not $printer) { throw 'No LabelWriter / DYMO printer is installed on this Windows PC.' }`,
    `Start-Process -FilePath $file -Verb PrintTo -ArgumentList $printer.Name -Wait`,
    `Write-Output ("job printed to " + $printer.Name)`,
  ].join("; ");
  const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 60000);
  if (result.code === 127) throw new Error("PowerShell is not available to print on Windows.");
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || "Windows would not print the label.").trim();
    throw new Error(detail.split("\n")[0]);
  }
  return { job: (result.stdout || "").trim(), via: "windows" };
}

/** Send an already-built PDF buffer to the LabelWriter (CUPS or Windows). */
export async function sendPdfToQueue(pdfBytes, { pageKey }) {
  const key = safePageKey(pageKey);
  if (!key) throw new Error("That label size is not on the 550.");
  const dir = await mkdtemp(path.join(tmpdir(), "label-"));
  const file = path.join(dir, "label.pdf");
  try {
    await writeFile(file, Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes));
    if (platform() === "win32") {
      return sendPdfViaWindows(file);
    }
    return sendPdfViaCups(file, key);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function sendToQueue(png, { pageKey, widthPt, heightPt, copies }) {
  const pdf = await pngToPdf(png, widthPt, heightPt, copies);
  return sendPdfToQueue(pdf, { pageKey });
}
