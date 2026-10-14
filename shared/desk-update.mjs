import { access, readFile } from "node:fs/promises";
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
 * Pull latest (ff-only when possible) and sideload Desk via update-desk-extension.sh.
 * Idempotent when already current.
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

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || "Update script failed.").trim().slice(0, 400);
    return {
      ok: false,
      error: "update_failed",
      message: detail || "Desk update failed.",
      version,
      root,
      code: result.code,
    };
  }

  return {
    ok: true,
    version,
    root,
    restartRequired: true,
    message: `Desk ${version} applied — restart Firefox to finish.`,
  };
}
