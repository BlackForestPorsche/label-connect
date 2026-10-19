import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
const firefox = read("extension/firefox/manifest.json");
const chromium = read("extension/chromium/manifest.json");

test("Chromium and Firefox manifests share one version with version.json and package.json", () => {
  assert.equal(chromium.version, firefox.version);
  assert.equal(read("extension/version.json").version, firefox.version);
  assert.equal(read("package.json").version, firefox.version);
});

test("Chromium and Firefox request the same permissions and hosts", () => {
  assert.deepEqual([...chromium.permissions].sort(), [...firefox.permissions].sort());
  assert.deepEqual([...chromium.host_permissions].sort(), [...firefox.host_permissions].sort());
});

test("Chromium and Firefox inject identical content scripts", () => {
  assert.deepEqual(chromium.content_scripts, firefox.content_scripts);
});

test("Chromium runs the shared background as a service worker, Firefox as scripts", () => {
  assert.equal(chromium.background.service_worker, "background.js");
  assert.equal(chromium.background.scripts, undefined);
  assert.deepEqual(firefox.background.scripts, ["config.js", "lot-names.js", "background.js"]);
  assert.equal(firefox.background.service_worker, undefined);
  assert.ok(firefox.browser_specific_settings?.gecko?.id);
});

test("Chromium manifest declares its icons and they exist", () => {
  const files = [...Object.values(chromium.icons), ...Object.values(chromium.action.default_icon)];
  assert.ok(files.length >= 4);
  for (const rel of files) {
    assert.ok(fs.existsSync(path.join(root, "extension/chromium", rel)), rel);
  }
});

test("every file a manifest references exists in its package dir", () => {
  for (const [dir, manifest] of [["chromium", chromium], ["firefox", firefox]]) {
    const refs = [
      manifest.action.default_popup,
      manifest.background.service_worker,
      ...(manifest.background.scripts || []),
      ...manifest.content_scripts.flatMap((c) => c.js),
    ].filter(Boolean);
    for (const rel of refs) {
      assert.ok(fs.existsSync(path.join(root, "extension", dir, rel)), `${dir}/${rel}`);
    }
  }
});

test("synced package files match extension/shared", () => {
  for (const dir of ["chromium", "firefox"]) {
    for (const name of fs.readdirSync(path.join(root, "extension/shared"))) {
      assert.equal(
        fs.readFileSync(path.join(root, "extension", dir, name), "utf8"),
        fs.readFileSync(path.join(root, "extension/shared", name), "utf8"),
        `${dir}/${name} differs — run npm run sync-extension`,
      );
    }
  }
});

test("Firefox: desktop min 140, Android min 142 (data_collection_permissions needs 142 on Android)", () => {
  const gecko = firefox.browser_specific_settings.gecko;
  assert.equal(gecko.strict_min_version, "140.0");
  assert.deepEqual(gecko.data_collection_permissions, { required: ["none"] });
  assert.equal(firefox.browser_specific_settings.gecko_android.strict_min_version, "142.0");
});
