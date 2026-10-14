import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

export const DESK_ADDON_ID = "black-forest-desk@blackforestautomotive.com";
export const DESK_UPDATES_JSON_URL =
  "https://github.com/BlackForestPorsche/label-connect/releases/download/desk-extension/updates.json";

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

function parseVersionParts(v) {
  return String(v || "0")
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function isNewerVersion(remote, local) {
  const a = parseVersionParts(remote);
  const b = parseVersionParts(local);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/**
 * Read the live desk-extension updates.json feed (signed XPI link + hash).
 */
export async function fetchDeskUpdateFeed(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") return null;
  const response = await fetchImpl(`${DESK_UPDATES_JSON_URL}?t=${Date.now()}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`updates.json ${response.status}`);
  const data = await response.json();
  const updates = data?.addons?.[DESK_ADDON_ID]?.updates;
  if (!Array.isArray(updates) || !updates.length) return null;
  let best = updates[0];
  for (const entry of updates) {
    if (entry?.version && isNewerVersion(entry.version, best.version)) best = entry;
  }
  const version = String(best.version || "");
  const updateLink = String(best.update_link || "");
  if (!version || !updateLink) return null;
  return {
    version,
    updateLink,
    updateHash: best.update_hash ? String(best.update_hash) : null,
  };
}

function xpiLooksMozillaSigned(buf) {
  // ZIP local headers + string scan for META-INF/mozilla.rsa (good enough for stage gate).
  const text = Buffer.isBuffer(buf) ? buf.toString("binary") : String(buf);
  return text.includes("META-INF/mozilla.rsa") || text.includes("META-INF/cose.sig");
}

/**
 * Download the signed feed XPI to ~/Desktop for Install Add-on From File.
 * Prefers Mozilla-signed bytes; verifies update_hash when present.
 */
export async function stageSignedXpiFromFeed(feed, { fetchImpl = globalThis.fetch } = {}) {
  if (!feed?.updateLink || !feed?.version) return null;
  if (typeof fetchImpl !== "function") return null;

  const response = await fetchImpl(feed.updateLink, { redirect: "follow" });
  if (!response.ok) throw new Error(`signed xpi ${response.status}`);
  const buf = Buffer.from(await response.arrayBuffer());
  if (feed.updateHash) {
    const want = String(feed.updateHash).replace(/^sha256:/i, "").toLowerCase();
    const got = createHash("sha256").update(buf).digest("hex");
    if (want && got !== want) {
      throw new Error(`signed xpi hash mismatch (got ${got.slice(0, 12)}…)`);
    }
  }
  if (!xpiLooksMozillaSigned(buf)) {
    // Still stage — Hub may need to re-sign — but mark unsigned.
    const desktop = path.join(homedir(), "Desktop");
    await mkdir(desktop, { recursive: true });
    const dest = path.join(desktop, `Black.Forest.Desk-${feed.version}-hub-upload.zip`);
    await writeFile(dest, buf);
    return {
      path: dest,
      version: feed.version,
      signed: false,
      hubUploadPath: dest,
    };
  }

  const desktop = path.join(homedir(), "Desktop");
  await mkdir(desktop, { recursive: true });
  const dest = path.join(desktop, `Black.Forest.Desk-${feed.version}.xpi`);
  await writeFile(dest, buf);
  // Also drop hub-upload.zip twin for Hub “On your own” if still needed once.
  const hubDest = path.join(desktop, `Black.Forest.Desk-${feed.version}-hub-upload.zip`);
  await writeFile(hubDest, buf);
  return {
    path: dest,
    version: feed.version,
    signed: true,
    hubUploadPath: hubDest,
    signedXpiPath: dest,
  };
}

function signedStagedResult({ version, root, staged, detail }) {
  const pathHint = staged?.signedXpiPath || staged?.path || staged?.hubUploadPath;
  const ver = version || staged?.version || "?";
  return {
    ok: true,
    error: null,
    mode: "signed_staged",
    version: ver,
    root: root || null,
    signedXpiPath: staged?.signedXpiPath || (staged?.signed ? staged.path : null),
    hubUploadPath: staged?.hubUploadPath || null,
    staged: true,
    applied: false,
    restartRequired: false,
    message: pathHint
      ? `Signed Desk ${ver} ready on Desktop (${pathHint}). about:addons → gear → Install Add-on From File… (or wait for Firefox auto-update).${detail ? ` ${detail}` : ""}`
      : `Signed Desk ${ver} feed staged. about:addons → Install Add-on From File, or Check for Updates.${detail ? ` ${detail}` : ""}`,
  };
}

/**
 * Pull latest (ff-only when possible) and refresh Desk.
 * Hub-signed Firefox installs are never overwritten with an unsigned sideload.
 * When signed is kept (or script fails): download signed XPI from updates.json
 * to Desktop and return ok:true mode signed_staged — never a false “failed”.
 */
export async function applyDeskExtensionUpdate(serverRoot, { pull = true, fetchImpl = globalThis.fetch } = {}) {
  const root = await resolveLabelConnectRoot(serverRoot);
  if (!root) {
    // Still try feed stage without a checkout — Update should not hard-fail.
    try {
      const feed = await fetchDeskUpdateFeed(fetchImpl);
      const staged = feed ? await stageSignedXpiFromFeed(feed, { fetchImpl }) : null;
      if (staged) {
        return signedStagedResult({
          version: staged.version,
          staged,
          detail: "(label-connect checkout missing; used release feed)",
        });
      }
    } catch {
      // fall through
    }
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

  async function stageFromFeed(detail) {
    try {
      const feed = await fetchDeskUpdateFeed(fetchImpl);
      if (!feed) return null;
      const staged = await stageSignedXpiFromFeed(feed, { fetchImpl });
      if (!staged) return null;
      return signedStagedResult({
        version: feed.version || version,
        root,
        staged,
        detail,
      });
    } catch {
      return null;
    }
  }

  if (result.code !== 0) {
    const stagedOk = await stageFromFeed("Sideload script failed; staged signed feed instead.");
    if (stagedOk) return stagedOk;
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

  // Mozilla-signed Hub/AMO install kept — stage signed feed XPI (success UX).
  if (mode === "signed_skipped") {
    const stagedOk = await stageFromFeed("Unsigned sideload skipped (Hub/AMO signed install kept).");
    if (stagedOk) return stagedOk;
    const hubUploadPath = await stageHubUploadZip(root, version);
    return {
      ok: true,
      error: null,
      mode: "signed_staged",
      version,
      root,
      hubUploadPath,
      staged: true,
      applied: false,
      restartRequired: false,
      message: hubUploadPath
        ? `Hub-signed Desk kept. Pack on Desktop: ${hubUploadPath} — about:addons → Install Add-on From File (or Hub On your own if unsigned).`
        : "Hub-signed Desk kept. Prefer about:addons → Check for Updates, or Install Add-on From File from the desk-extension release.",
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
      message: `Desk ${version} sideloaded (unsigned) — restart Firefox. Prefer Hub/AMO-signed Install from File for durable installs.`,
    };
  }

  // Unknown install outcome after exit 0 — prefer signed feed stage.
  const stagedOk = await stageFromFeed("Could not confirm sideload; staged signed feed.");
  if (stagedOk) return stagedOk;
  const hubUploadPath = await stageHubUploadZip(root, version);
  return {
    ok: true,
    error: null,
    mode: "signed_staged",
    version,
    root,
    hubUploadPath,
    staged: true,
    applied: false,
    restartRequired: false,
    message: hubUploadPath
      ? `Pack saved to ${hubUploadPath} — about:addons → Install Add-on From File.`
      : "Prefer about:addons → Check for Updates or Install Add-on From File.",
  };
}
