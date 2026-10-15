import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { corsAllowed } from "../shared/cors.mjs";
import { windowsQueue } from "../shared/detect.mjs";
import { sendPdfWindows } from "../shared/print.mjs";
import {
  LIST_PRINTERS_SCRIPT,
  NATIVE_PRINT_SCRIPT,
  PRINTTO_SCRIPT,
  RENDERER_UNAVAILABLE,
  nativeEnv,
  parseWindowsPrinterList,
  pickWindowsPrinter,
  sumatraArgs,
  sumatraCandidates,
  windowsDpi,
  windowsPrintMode,
  windowsQueueState,
  windowsRotateMode,
} from "../shared/winprint.mjs";

const LISTING = JSON.stringify([
  { Name: "Microsoft Print to PDF", PortName: "PORTPROMPT:", DriverName: "x", PrinterStatus: 3, WorkOffline: false, Default: true },
  { Name: "DYMO LabelWriter 550", PortName: "USB001", DriverName: "DYMO LabelWriter 550", PrinterStatus: 3, WorkOffline: false, Default: false },
]);

test("printer list handles an array, a single object and junk", () => {
  assert.equal(parseWindowsPrinterList(LISTING).length, 2);
  const single = parseWindowsPrinterList(JSON.stringify({ Name: "LabelWriter550", PortName: "USB001", PrinterStatus: 4 }));
  assert.equal(single.length, 1);
  assert.equal(single[0].status, 4);
  assert.deepEqual(parseWindowsPrinterList(""), []);
  assert.deepEqual(parseWindowsPrinterList("[]"), []);
  assert.deepEqual(parseWindowsPrinterList("not json"), []);
});

test("queue pick prefers the exact name, then any LabelWriter/DYMO queue", () => {
  assert.equal(pickWindowsPrinter(["HP", "labelwriter550", "DYMO LabelWriter 550"], {}).name, "labelwriter550");
  const pattern = pickWindowsPrinter(["HP", "DYMO LabelWriter 550"], {});
  assert.equal(pattern.name, "DYMO LabelWriter 550");
  assert.equal(pattern.reason, "pattern");
  assert.equal(pickWindowsPrinter(["HP"], {}).name, "");
  assert.equal(pickWindowsPrinter(["HP", "DYMO LabelWriter 550"], { LABELS_PRINTER: "HP" }).name, "HP");
  const missing = pickWindowsPrinter(["DYMO LabelWriter 550"], { LABELS_PRINTER: "Front desk" });
  assert.equal(missing.name, "");
  assert.equal(missing.reason, "override-missing");
});

test("queue state uses the CUPS vocabulary", () => {
  assert.equal(windowsQueueState(null), "missing");
  assert.equal(windowsQueueState({ status: 3, offline: false }), "idle");
  assert.equal(windowsQueueState({ status: 4, offline: false }), "printing");
  assert.equal(windowsQueueState({ status: 7, offline: false }), "paused");
  assert.equal(windowsQueueState({ status: 3, offline: true }), "paused");
});

test("windowsQueue reports the installed DYMO queue", async () => {
  const calls = [];
  const info = await windowsQueue(
    async (cmd, args) => {
      calls.push([cmd, args]);
      return { code: 0, stdout: LISTING, stderr: "" };
    },
    {},
  );
  assert.equal(calls[0][0], "powershell.exe");
  assert.equal(info.present, true);
  assert.equal(info.name, "DYMO LabelWriter 550");
  assert.equal(info.state, "idle");
  assert.match(info.message, /USB001/);

  const none = await windowsQueue(async () => ({ code: 0, stdout: "[]", stderr: "" }), {});
  assert.equal(none.present, false);
  assert.equal(none.state, "missing");
});

test("native print env carries the paper and never needs quoting", () => {
  const env = nativeEnv({
    pdfPath: "C:\\Users\\Shop Desk\\AppData\\Local\\Temp\\label-ro-1\\label.pdf",
    printer: 'DYMO "550" LabelWriter',
    pageKey: "w79h252",
    env: { LABELS_WIN_DPI: "600", LABELS_WIN_ROTATE: "ccw" },
  });
  assert.equal(env.LABELS_PS_SKU, "30252");
  assert.equal(env.LABELS_PS_WIDTH_PT, "79");
  assert.equal(env.LABELS_PS_HEIGHT_PT, "252");
  assert.equal(env.LABELS_PS_DPI, "600");
  assert.equal(env.LABELS_PS_ROTATE, "ccw");
  assert.equal(env.LABELS_PS_PRINTER, 'DYMO "550" LabelWriter');
});

test("windows knobs fall back to safe defaults", () => {
  assert.equal(windowsDpi({}), 300);
  assert.equal(windowsDpi({ LABELS_WIN_DPI: "nope" }), 300);
  assert.equal(windowsRotateMode({}), "cw");
  assert.equal(windowsRotateMode({ LABELS_WIN_ROTATE: "NONE" }), "none");
  assert.equal(windowsPrintMode({}), "auto");
  assert.equal(windowsPrintMode({ LABELS_WIN_PRINT: "Sumatra" }), "sumatra");
  assert.equal(windowsPrintMode({ LABELS_WIN_PRINT: "weird" }), "auto");
});

test("sumatra is found from override and standard folders", () => {
  const list = sumatraCandidates({
    LABELS_SUMATRA: "D:\\tools\\SumatraPDF.exe",
    LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
  });
  assert.equal(list[0], "D:\\tools\\SumatraPDF.exe");
  assert.ok(list.includes("C:\\Program Files\\SumatraPDF\\SumatraPDF.exe"));
  assert.deepEqual(sumatraArgs("DYMO", "x.pdf").slice(0, 2), ["-print-to", "DYMO"]);
  assert.equal(sumatraArgs("DYMO", "x.pdf").at(-1), "x.pdf");
});

async function withPdf(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "label-win-test-"));
  const pdf = path.join(dir, "label.pdf");
  await writeFile(pdf, "%PDF-1.4\n");
  try {
    return await fn(pdf, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeRun(handlers) {
  const calls = [];
  const run = async (cmd, args, timeout, opts) => {
    calls.push({ cmd, args, opts });
    const script = args.includes("-File") ? path.basename(args[args.indexOf("-File") + 1]) : "";
    if (args.includes("-Command")) return { code: 0, stdout: LISTING, stderr: "" };
    const handler = handlers[script] ?? handlers[cmd];
    return handler ? handler(args, opts) : { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { run, calls };
}

test("auto mode prints through the native renderer", async () => {
  await withPdf(async (pdf) => {
    const { run, calls } = fakeRun({
      "print-native.ps1": () => ({ code: 0, stdout: "DYMO LabelWriter 550\r\n", stderr: "" }),
    });
    const result = await sendPdfWindows(pdf, { pageKey: "w79h252", deps: { run, exists: () => false, env: {} } });
    assert.equal(result.job, "DYMO LabelWriter 550");
    const print = calls.find((call) => call.args.includes("-File"));
    assert.equal(print.opts.env.LABELS_PS_PRINTER, "DYMO LabelWriter 550");
    assert.equal(print.opts.env.LABELS_PS_PDF, pdf);
    assert.ok(print.args.includes("Bypass"));
  });
});

test("native print writes the script to disk with a BOM for PowerShell 5.1", async () => {
  await withPdf(async (pdf, dir) => {
    const { run } = fakeRun({
      "print-native.ps1": async (args) => {
        const bytes = await readFile(args[args.indexOf("-File") + 1]);
        assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    });
    await sendPdfWindows(pdf, { pageKey: "w79h252", deps: { run, exists: () => false, env: {} } });
    assert.ok(dir);
  });
});

test("auto mode falls through to Sumatra only when the renderer is missing", async () => {
  await withPdf(async (pdf) => {
    const { run, calls } = fakeRun({
      "print-native.ps1": () => ({ code: RENDERER_UNAVAILABLE, stdout: "", stderr: "no renderer" }),
      "C:\\Sumatra\\SumatraPDF.exe": () => ({ code: 0, stdout: "", stderr: "" }),
    });
    const result = await sendPdfWindows(pdf, {
      pageKey: "w79h252",
      deps: { run, exists: (file) => file === "C:\\Sumatra\\SumatraPDF.exe", env: { LABELS_SUMATRA: "C:\\Sumatra\\SumatraPDF.exe" } },
    });
    assert.equal(result.job, "DYMO LabelWriter 550");
    const sumatra = calls.find((call) => call.cmd.endsWith("SumatraPDF.exe"));
    assert.deepEqual(sumatra.args.slice(0, 2), ["-print-to", "DYMO LabelWriter 550"]);
  });
});

test("auto mode ends on PrintTo when nothing else can render", async () => {
  await withPdf(async (pdf) => {
    const { run, calls } = fakeRun({
      "print-native.ps1": () => ({ code: RENDERER_UNAVAILABLE, stdout: "", stderr: "" }),
      "print-to.ps1": () => ({ code: 0, stdout: "DYMO LabelWriter 550", stderr: "" }),
    });
    const result = await sendPdfWindows(pdf, { pageKey: "w79h252", deps: { run, exists: () => false, env: {} } });
    assert.equal(result.job, "DYMO LabelWriter 550");
    assert.ok(calls.some((call) => call.args.some((arg) => String(arg).endsWith("print-to.ps1"))));
  });
});

test("a real printer failure is surfaced and never retried on another path", async () => {
  await withPdf(async (pdf) => {
    const { run, calls } = fakeRun({
      "print-native.ps1": () => ({ code: 1, stdout: "", stderr: "Printer not found: DYMO\nat line 1" }),
    });
    await assert.rejects(
      sendPdfWindows(pdf, { pageKey: "w79h252", deps: { run, exists: () => true, env: {} } }),
      /Printer not found: DYMO/,
    );
    assert.equal(calls.filter((call) => call.args.includes("-File")).length, 1);
  });
});

test("no LabelWriter installed gives a plain message", async () => {
  await withPdf(async (pdf) => {
    const run = async () => ({ code: 0, stdout: "[]", stderr: "" });
    await assert.rejects(
      sendPdfWindows(pdf, { pageKey: "w79h252", deps: { run, exists: () => false, env: {} } }),
      /No LabelWriter\/DYMO printer is installed/,
    );
  });
});

test("shop origin may read status and dry-run only", () => {
  const shop = "https://shop.blackforestautomotive.com";
  const q = (s = "") => new URLSearchParams(s);
  assert.equal(corsAllowed(shop, "GET", "/api/printer", q()), true);
  assert.equal(corsAllowed(shop, "OPTIONS", "/api/print-ro", q("dryRun=1")), true);
  assert.equal(corsAllowed(shop, "POST", "/api/print-ro", q("dryRun=1")), true);
  assert.equal(corsAllowed(shop, "POST", "/api/print-ro", q()), false);
  assert.equal(corsAllowed(shop, "POST", "/api/print", q()), false);
  assert.equal(corsAllowed(shop, "PUT", "/api/labels", q()), false);
  assert.equal(corsAllowed("https://evil.example", "GET", "/api/printer", q()), false);
  assert.equal(corsAllowed(shop, "GET", "/v1/widget-session", q()), false);
});

const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "1"], { encoding: "utf8" });
test("PowerShell scripts parse cleanly", { skip: pwsh.status !== 0 && "pwsh not installed" }, async () => {
  for (const [name, script] of Object.entries({ NATIVE_PRINT_SCRIPT, PRINTTO_SCRIPT, LIST_PRINTERS_SCRIPT })) {
    const result = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-Command",
        "$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:PS_UNDER_TEST, [ref]$t, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }",
      ],
      { encoding: "utf8", env: { ...process.env, PS_UNDER_TEST: script } },
    );
    assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
  }
});
