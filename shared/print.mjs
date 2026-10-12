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

export async function sendToQueue(png, { pageKey, widthPt, heightPt, copies }) {
  const pdf = await pngToPdf(png, widthPt, heightPt, copies);
  const dir = await mkdtemp(path.join(tmpdir(), "label-"));
  const file = path.join(dir, "label.pdf");
  try {
    await writeFile(file, pdf);
    const args = printArgs(pageKey, file);
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
