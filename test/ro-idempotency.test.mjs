import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRoPrintStore } from "../shared/ro-idempotency.mjs";

test("ro print store is idempotent by roNumber", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ro-idemp-"));
  const file = path.join(dir, "ro-prints.json");
  try {
    const store = createRoPrintStore(file, { ttlMs: 60_000 });
    assert.equal(await store.has("J001094"), false);
    await store.mark("J001094", { lastName: "Owner", model: "Macan" });
    assert.equal(await store.has("J001094"), true);
    const entry = await store.get("J001094");
    assert.equal(entry.lastName, "Owner");
    assert.equal(entry.model, "Macan");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
