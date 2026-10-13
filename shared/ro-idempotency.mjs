/**
 * Remember RO numbers that already auto-printed so Create retries
 * do not burn a second LabelWriter label.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export function createRoPrintStore(filePath, { ttlMs = DEFAULT_TTL_MS } = {}) {
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      const text = await readFile(filePath, "utf8");
      const parsed = JSON.parse(text);
      cache = parsed && typeof parsed === "object" && parsed.prints && typeof parsed.prints === "object"
        ? parsed
        : { prints: {} };
    } catch {
      cache = { prints: {} };
    }
    return cache;
  }

  async function save() {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(cache ?? { prints: {} }, null, 2));
  }

  function prune(now = Date.now()) {
    if (!cache?.prints) return;
    for (const [key, entry] of Object.entries(cache.prints)) {
      const at = Date.parse(entry?.at || "");
      if (!Number.isFinite(at) || now - at > ttlMs) delete cache.prints[key];
    }
  }

  return {
    async has(roNumber) {
      const key = String(roNumber || "").trim();
      if (!key) return false;
      await load();
      prune();
      return Boolean(cache.prints[key]);
    },

    async get(roNumber) {
      const key = String(roNumber || "").trim();
      if (!key) return null;
      await load();
      prune();
      return cache.prints[key] ?? null;
    },

    async mark(roNumber, meta = {}) {
      const key = String(roNumber || "").trim();
      if (!key) return;
      await load();
      prune();
      cache.prints[key] = {
        at: new Date().toISOString(),
        lastName: String(meta.lastName || "").slice(0, 40),
        model: String(meta.model || "").slice(0, 32),
      };
      await save();
    },
  };
}
