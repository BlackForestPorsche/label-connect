import { FALLBACK_MEDIA, QUEUE } from "./media.mjs";

/**
 * Windows LabelWriter / DYMO printing.
 *
 * Primary path ("native"): render the PDF with the built-in Windows.Data.Pdf
 * renderer and print the bitmap through System.Drawing (spooler -> DYMO driver).
 * Needs no PDF reader. Fallbacks: SumatraPDF `-print-to`, then the shell PrintTo
 * verb (needs a PDF handler that implements PrintTo).
 */

/** Exit code the native script uses when the WinRT PDF renderer is missing. */
export const RENDERER_UNAVAILABLE = 3;

export const WINDOWS_PRINTER_PATTERN = /LabelWriter|DYMO/i;

export function windowsPrinterOverride(env = process.env) {
  return String(env.LABELS_PRINTER || "").trim();
}

/**
 * Pick the queue to print to: exact name (LABELS_PRINTER or LabelWriter550),
 * then case-insensitive name, then the first LabelWriter/DYMO queue.
 */
export function pickWindowsPrinter(names, env = process.env) {
  const list = (Array.isArray(names) ? names : []).map((name) => String(name || "")).filter(Boolean);
  const override = windowsPrinterOverride(env);
  const wanted = override || QUEUE;
  const exact = list.find((name) => name === wanted);
  if (exact) return { name: exact, reason: "exact" };
  const loose = list.find((name) => name.toLowerCase() === wanted.toLowerCase());
  if (loose) return { name: loose, reason: "exact" };
  if (override) return { name: "", reason: "override-missing" };
  const match = list.find((name) => WINDOWS_PRINTER_PATTERN.test(name));
  if (match) return { name: match, reason: "pattern" };
  return { name: "", reason: "none" };
}

export function noWindowsPrinterMessage(pick) {
  if (pick?.reason === "override-missing") {
    return "LABELS_PRINTER does not match an installed printer. Use the exact queue name from Printers & scanners.";
  }
  return "No LabelWriter/DYMO printer is installed. Install the DYMO driver, or set LABELS_PRINTER to the exact queue name.";
}

export const LIST_PRINTERS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$rows = @(Get-CimInstance Win32_Printer | ForEach-Object {
  [pscustomobject]@{
    Name = $_.Name
    PortName = $_.PortName
    DriverName = $_.DriverName
    PrinterStatus = [int]$_.PrinterStatus
    WorkOffline = [bool]$_.WorkOffline
    Default = [bool]$_.Default
  }
})
ConvertTo-Json -InputObject $rows -Compress
`;

/** Win32_Printer JSON (object or array, possibly empty) -> array of rows. */
export function parseWindowsPrinterList(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : [];
  return rows
    .filter((row) => row && typeof row.Name === "string" && row.Name)
    .map((row) => ({
      name: row.Name,
      port: String(row.PortName || ""),
      driver: String(row.DriverName || ""),
      status: Number(row.PrinterStatus) || 0,
      offline: Boolean(row.WorkOffline),
      isDefault: Boolean(row.Default),
    }));
}

/**
 * Same vocabulary as the CUPS side (missing / paused / printing / idle).
 * Win32_Printer.PrinterStatus: 1 other, 2 unknown, 3 idle, 4 printing,
 * 5 warming up, 6 stopped printing, 7 offline.
 */
export function windowsQueueState(printer) {
  if (!printer) return "missing";
  if (printer.offline || printer.status === 6 || printer.status === 7) return "paused";
  if (printer.status === 4) return "printing";
  return "idle";
}

export function windowsQueueStatus(printer, name) {
  if (!printer) {
    return {
      present: false,
      state: "missing",
      uri: "",
      message: name
        ? `No print queue named ${name} on this computer.`
        : "No LabelWriter/DYMO printer is installed on this computer.",
    };
  }
  const state = windowsQueueState(printer);
  const message =
    state === "paused"
      ? `${printer.name} is offline or paused.`
      : printer.port
        ? `${printer.name} · ${printer.port}`
        : `${printer.name} is ready.`;
  return { present: true, state, uri: printer.port, message, name: printer.name };
}

export function mediaForPageKey(pageKey) {
  return FALLBACK_MEDIA.find((item) => item.key === pageKey) ?? null;
}

export function windowsRotateMode(env = process.env) {
  const value = String(env.LABELS_WIN_ROTATE || "cw").trim().toLowerCase();
  return value === "ccw" || value === "none" ? value : "cw";
}

export function windowsDpi(env = process.env) {
  const n = Number.parseInt(String(env.LABELS_WIN_DPI || ""), 10);
  return Number.isFinite(n) && n >= 96 && n <= 1200 ? n : 300;
}

export function windowsPrintMode(env = process.env) {
  const value = String(env.LABELS_WIN_PRINT || "auto").trim().toLowerCase();
  return ["native", "sumatra", "printto"].includes(value) ? value : "auto";
}

/**
 * Environment for the native print script. Values travel as env vars so queue
 * names and paths never need PowerShell quoting.
 */
export function nativeEnv({ pdfPath, printer, pageKey, env = process.env }) {
  const media = mediaForPageKey(pageKey);
  return {
    LABELS_PS_PDF: pdfPath,
    LABELS_PS_PRINTER: printer,
    LABELS_PS_SKU: media?.sku || "",
    LABELS_PS_WIDTH_PT: String(media?.widthPt ?? ""),
    LABELS_PS_HEIGHT_PT: String(media?.heightPt ?? ""),
    LABELS_PS_DPI: String(windowsDpi(env)),
    LABELS_PS_ROTATE: windowsRotateMode(env),
  };
}

export const NATIVE_PRINT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$pdf = $env:LABELS_PS_PDF
$printerName = $env:LABELS_PS_PRINTER
$sku = $env:LABELS_PS_SKU
$dpi = [int]$env:LABELS_PS_DPI
$script:rotate = $env:LABELS_PS_ROTATE
$widthPt = 0.0; [void][double]::TryParse($env:LABELS_PS_WIDTH_PT, [ref]$widthPt)
$heightPt = 0.0; [void][double]::TryParse($env:LABELS_PS_HEIGHT_PT, [ref]$heightPt)

try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  [void][Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
  [void][Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime]
  [void][Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
} catch {
  [Console]::Error.WriteLine("Windows PDF renderer unavailable: " + $_.Exception.Message)
  exit ${RENDERER_UNAVAILABLE}
}

$extensions = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTaskOp = $extensions | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
} | Select-Object -First 1
$asTaskAction = $extensions | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
} | Select-Object -First 1

function Wait-Op($op, [Type]$type) {
  $task = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op))
  [void]$task.Wait(-1)
  return $task.Result
}
function Wait-Action($action) {
  $task = $asTaskAction.Invoke($null, @($action))
  [void]$task.Wait(-1)
}

try {
  $full = (Resolve-Path -LiteralPath $pdf).Path
  $file = Wait-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
  $doc = Wait-Op ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  $script:bitmaps = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $doc.PageCount; $i++) {
    $page = $doc.GetPage($i)
    $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $opts.DestinationWidth = [uint32][Math]::Max(1, [Math]::Round($page.Size.Width / 96.0 * $dpi))
    $opts.DestinationHeight = [uint32][Math]::Max(1, [Math]::Round($page.Size.Height / 96.0 * $dpi))
    $ras = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    Wait-Action ($page.RenderToStreamAsync($ras, $opts))
    $reader = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($ras.GetInputStreamAt(0))
    $mem = New-Object System.IO.MemoryStream
    $reader.CopyTo($mem)
    $mem.Position = 0
    $decoded = [System.Drawing.Bitmap]::FromStream($mem)
    [void]$script:bitmaps.Add((New-Object System.Drawing.Bitmap($decoded)))
    $decoded.Dispose(); $mem.Dispose(); $reader.Dispose(); $ras.Dispose(); $page.Dispose()
  }
} catch {
  [Console]::Error.WriteLine("Windows PDF renderer failed: " + $_.Exception.Message)
  exit ${RENDERER_UNAVAILABLE}
}
if ($script:bitmaps.Count -eq 0) { throw "The label PDF had no pages." }

$pd = New-Object System.Drawing.Printing.PrintDocument
$pd.PrinterSettings.PrinterName = $printerName
if (-not $pd.PrinterSettings.IsValid) { throw "Printer not found: $printerName" }
$pd.DocumentName = 'Black Forest label'
$pd.PrintController = New-Object System.Drawing.Printing.StandardPrintController
$pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)

$paper = $null
if ($sku) {
  foreach ($candidate in $pd.PrinterSettings.PaperSizes) {
    if ($candidate.PaperName -like "*$sku*") { $paper = $candidate; break }
  }
}
if (-not $paper -and $widthPt -gt 0 -and $heightPt -gt 0) {
  $wanted = @([int][Math]::Round($widthPt / 72.0 * 100), [int][Math]::Round($heightPt / 72.0 * 100))
  foreach ($candidate in $pd.PrinterSettings.PaperSizes) {
    $pair = @($candidate.Width, $candidate.Height)
    $direct = ([Math]::Abs($pair[0] - $wanted[0]) -le 6) -and ([Math]::Abs($pair[1] - $wanted[1]) -le 6)
    $turned = ([Math]::Abs($pair[0] - $wanted[1]) -le 6) -and ([Math]::Abs($pair[1] - $wanted[0]) -le 6)
    if ($direct -or $turned) { $paper = $candidate; break }
  }
  if (-not $paper) {
    $paper = New-Object System.Drawing.Printing.PaperSize('Black Forest label', $wanted[0], $wanted[1])
  }
}
if ($paper) { $pd.DefaultPageSettings.PaperSize = $paper }

$script:pageIndex = 0
$pd.add_PrintPage({
  param($sender, $e)
  $source = $script:bitmaps[$script:pageIndex]
  $work = $source
  $pageWide = $e.PageBounds.Width -gt $e.PageBounds.Height
  $imageWide = $source.Width -gt $source.Height
  if ($script:rotate -ne 'none' -and $pageWide -ne $imageWide) {
    $work = New-Object System.Drawing.Bitmap($source)
    if ($script:rotate -eq 'ccw') {
      $work.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone)
    } else {
      $work.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone)
    }
  }
  $bw = [double]$e.PageBounds.Width
  $bh = [double]$e.PageBounds.Height
  $scale = [Math]::Min($bw / $work.Width, $bh / $work.Height)
  $dw = $work.Width * $scale
  $dh = $work.Height * $scale
  $dx = -[double]$e.PageSettings.HardMarginX + ($bw - $dw) / 2
  $dy = -[double]$e.PageSettings.HardMarginY + ($bh - $dh) / 2
  $g = $e.Graphics
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($work, (New-Object System.Drawing.RectangleF($dx, $dy, $dw, $dh)))
  if (-not [object]::ReferenceEquals($work, $source)) { $work.Dispose() }
  $script:pageIndex++
  $e.HasMorePages = ($script:pageIndex -lt $script:bitmaps.Count)
})
$pd.Print()
foreach ($bmp in $script:bitmaps) { $bmp.Dispose() }
Write-Output $printerName
`;

export const PRINTTO_SCRIPT = `
$ErrorActionPreference = 'Stop'
$pdf = $env:LABELS_PS_PDF
$printer = $env:LABELS_PS_PRINTER
Start-Process -FilePath $pdf -Verb PrintTo -ArgumentList ('"' + $printer + '"') -WindowStyle Hidden -Wait
Write-Output $printer
`;

export function sumatraCandidates(env = process.env) {
  const out = [];
  if (env.LABELS_SUMATRA) out.push(env.LABELS_SUMATRA);
  for (const base of [env.LOCALAPPDATA, env.ProgramFiles, env["ProgramFiles(x86)"]]) {
    if (base) out.push(`${base}\\SumatraPDF\\SumatraPDF.exe`);
  }
  return out;
}

export function sumatraArgs(printer, pdfPath) {
  return ["-print-to", printer, "-print-settings", "fit", "-silent", "-exit-when-done", pdfPath];
}

export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
