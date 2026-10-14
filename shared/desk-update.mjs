import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

/** True when the HTTP client is loopback (Labels binds 0.0.0.0). */
export function isLocalClient(req) {
  const remote = String(req?.socket?.remoteAddress || "")
    .replace(/^::ffff:/i, "")
    .toLowerCase();
  if (remote === "127.0.0.1" || remote === "::1" || remote === "localhost") return true;
  // Unix-domain / missing remote (tests) — treat as local only when Host is loopback.
  const hostHeader = String(req?.headers?.host || "")
    .split(":")[0]
    .toLowerCase();
  if (!remote && LOCAL_HOSTS.has(hostHeader)) return true;
  return LOCAL_HOSTS.has(remote) && (LOCAL_HOSTS.has(hostHeader) || !hostHeader);
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prefer the Labels checkout (server root), then ~/label-connect, then LABEL_CONNECT_ROOT.
 * Vendored copies under shop-desktop/labels may not ship the desk scripts.
 */
export async function resolveLabelConnectRoot(serverRoot) {
  const candidates = [];
  const envRoot = process.env.LABEL_CONNECT_ROOT;
  if (envRoot) candidates.push(path.resolve(envRoot));
  if (serverRoot) candidates.push(path.resolve(serverRoot));
  candidates.push(path.join(homedir(), "label-connect"));

  for (const root of candidates) {
    const script = path.join(root, "scripts", "update-desk-extension.sh");
    if (await pathExists(script)) return root;
  }
  return null;
}

export async function readDeskVersion(root) {
  if (!root) return null;
  try {
    const raw = await readFile(path.join(root, "extension", "version.json"), "utf8");
    const parsed = JSON.parse(raw);
    return String(parsed.version || "") || null;
  } catch {
    return null;
  }
}

function runCommand(command, args, { cwd, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PATH: process.env.PATH || "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ code: 124, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Stage self-dist pack (keeps gecko.update_url) on the Desktop for Hub
 * “On your own” re-upload. Never claims this applied the Firefox install.
 */
export async function stageHubUploadZip(root, version) {
  if (!root || !version) return null;
  const candidates = [
    path.join(root, "extension", "dist", `Black.Forest.Desk-${version}.xpi`),
    path.join(root, "extension", "dist", "Black.Forest.Desk.xpi"),
    path.join(root, "extension", "dist", "black-forest-desk@blackforestautomotive.com.xpi"),
  ];
  let src = null;
  for (const file of candidates) {
    if (await pathExists(file)) {
      src = file;
      break;
    }
  }
  if (!src) return null;

  const desktop = path.join(homedir(), "Desktop");
  await mkdir(desktop, { recursive: true });
  const dest = path.join(desktop, `Black.Forest.Desk-${version}-hub-upload.zip`);
  await copyFile(src, dest);
  return dest;
}

function parseInstallMode(combinedOutput) {
  const text = String(combinedOutput || "");
  if (/^skipped=signed-amo/m.test(text)) return "signed_skipped";
  if (/^mode=unsigned-sideload/m.test(text)) return "unsigned_sideload";
  return "unknown";
}

/**
 * Pull latest (ff-only when possible) and refresh Desk.
 * Hub-signed Firefox installs are never overwritten with an unsigned sideload.
 * When signed is kept: stage Desktop hub-upload.zip and return ok:false (actionable).
 */
export async function applyDeskExtensionUpdate(serverRoot, { pull = true } = {}) {
  const root = await resolveLabelConnectRoot(serverRoot);
  if (!root) {
    return {
      ok: false,
      error: "label_connect_missing",
      message: "Could not find label-connect with scripts/update-desk-extension.sh on this desk.",
    };
  }

  const applyScript = path.join(root, "scripts", "apply-desk-extension-update.sh");
  const updateScript = path.join(root, "scripts", "update-desk-extension.sh");
  const script = (await pathExists(applyScript)) ? applyScript : updateScript;
  const args = ["--quiet"];
  if (script === applyScript && !pull) args.push("--no-pull");

  const result = await runCommand("bash", [script, ...args], { cwd: root });
  const version = (await readDeskVersion(root)) || "?";
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  const mode = parseInstallMode(combined);

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || "Update script failed.").trim().slice(0, 400);
    return {
      ok: false,
      error: "update_failed",
      message: detail || "Desk update failed.",
      version,
      root,
      code: result.code,
      mode,
    };
  }

  // Mozilla-signed Hub/AMO install kept — never report sideload success.
  if (mode === "signed_skipped") {
    const hubUploadPath = await stageHubUploadZip(root, version);
    return {
      ok: false,
      error: "hub_signed_kept",
      mode: "hub_upload",
      version,
      root,
      hubUploadPath,
      restartRequired: false,
      applied: false,
      message: hubUploadPath
        ? `Hub-signed Desk kept (unsigned sideload skipped). Pack saved to ${hubUploadPath} — Hub On your own → Upload New Version, then about:addons → Install Add-on From File (Hub-signed XPI).`
        : "Hub-signed Desk kept (unsigned sideload skipped). Upload the self-dist XPI via Hub On your own, then about:addons → Install Add-on From File.",
    };
  }

  if (mode === "unsigned_sideload") {
    return {
      ok: true,
      version,
      root,
      mode: "unsigned_sideload",
      restartRequired: true,
      applied: true,
      message: `Desk ${version} sideloaded (unsigned) — restart Firefox. Prefer Hub-signed Install from File for durable installs.`,
    };
  }

  // Unknown install outcome after exit 0 — stage Hub pack and do not claim success.
  const hubUploadPath = await stageHubUploadZip(root, version);
  return {
    ok: false,
    error: "update_outcome_unclear",
    mode: "hub_upload",
    version,
    root,
    hubUploadPath,
    restartRequired: false,
    applied: false,
    message: hubUploadPath
      ? `Could not confirm Firefox apply. Pack saved to ${hubUploadPath} — Hub On your own → Upload, then Install Add-on From File.`
      : "Could not confirm Firefox apply. Prefer Hub On your own → Install from File.",
  };
}
