import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

function windowsPrinterName() {
  const override = String(process.env.LABELS_PRINTER || "").trim();
  if (override) return override;
  return QUEUE;
}

/**
 * Windows: PrintTo the LabelWriter/DYMO queue (or LABELS_PRINTER).
 * Resolves a matching installed printer when the default name is missing.
 */
async function sendPdfWindows(pdfPath) {
  const wanted = windowsPrinterName();
  const script = `
$ErrorActionPreference = 'Stop'
$wanted = ${JSON.stringify(wanted)}
$pdf = ${JSON.stringify(pdfPath)}
function Resolve-LabelPrinter([string]$name) {
  $printers = @(Get-CimInstance Win32_Printer | Select-Object -ExpandProperty Name)
  if ($printers -contains $name) { return $name }
  $match = $printers | Where-Object { $_ -match 'LabelWriter|DYMO' } | Select-Object -First 1
  if ($match) { return $match }
  throw "No LabelWriter/DYMO printer found. Set LABELS_PRINTER to the exact queue name."
}
$printer = Resolve-LabelPrinter $wanted
Start-Process -FilePath $pdf -Verb PrintTo -ArgumentList $printer -WindowStyle Hidden -Wait
Write-Output $printer
`;
  const result = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    60000,
  );
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || "PrintTo failed.").trim();
    throw new Error(detail.split("\n")[0]);
  }
  return { job: (result.stdout || "").trim() || wanted };
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
      return await sendPdfWindows(file);
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
