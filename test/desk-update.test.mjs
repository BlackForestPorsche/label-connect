import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isLocalClient,
  isNewerVersion,
  readDeskVersion,
  resolveLabelConnectRoot,
  stageHubUploadZip,
  fetchDeskUpdateFeed,
  stageSignedXpiFromFeed,
} from "../shared/desk-update.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fakeReq({ remoteAddress, host }) {
  return {
    socket: { remoteAddress },
    headers: host ? { host } : {},
  };
}

test("isLocalClient accepts loopback IPv4/IPv6", () => {
  assert.equal(isLocalClient(fakeReq({ remoteAddress: "127.0.0.1", host: "127.0.0.1:8080" })), true);
  assert.equal(isLocalClient(fakeReq({ remoteAddress: "::1", host: "localhost:8080" })), true);
  assert.equal(isLocalClient(fakeReq({ remoteAddress: "::ffff:127.0.0.1", host: "127.0.0.1" })), true);
});

test("isLocalClient rejects LAN clients", () => {
  assert.equal(isLocalClient(fakeReq({ remoteAddress: "192.168.1.50", host: "192.168.1.50:8080" })), false);
  assert.equal(isLocalClient(fakeReq({ remoteAddress: "10.0.0.8", host: "labels.local" })), false);
});

test("resolveLabelConnectRoot finds this checkout", async () => {
  const found = await resolveLabelConnectRoot(root);
  assert.equal(found, root);
  const version = await readDeskVersion(found);
  assert.match(String(version), /^\d+\.\d+\.\d+/);
});

test("popup and background no longer tell users to run bash update script", async () => {
  const { readFile } = await import("node:fs/promises");
  const popup = await readFile(path.join(root, "extension/shared/popup.js"), "utf8");
  const background = await readFile(path.join(root, "extension/shared/background.js"), "utf8");
  assert.equal(/update-desk-extension\.sh/.test(popup), false);
  assert.equal(/on the desk run/.test(popup), false);
  assert.equal(/bash ~\/label-connect/.test(popup), false);
  assert.equal(/apply-update/.test(background), true);
  assert.equal(/\/api\/update-desk-extension/.test(background), true);
  assert.equal(/run update-desk-extension\.sh/.test(background), false);
  assert.equal(/hub_signed_kept/.test(background), true);
  assert.equal(/signed_staged/.test(background), true);
  assert.equal(/requestUpdateCheck/.test(background), true);
  assert.equal(/onUpdateAvailable/.test(background), true);
  assert.equal(/startToolsBridgeWatch/.test(background), true);
  assert.equal(/NOT applied/.test(background), true);
  assert.equal(/NOT applied/.test(popup), true);
  assert.equal(/startToolsBridgeWatch/.test(await readFile(path.join(root, "extension/shared/lot-names.js"), "utf8")), true);
  assert.equal(/updates\.json/.test(background), true);
  assert.equal(/signed_staged/.test(popup), true);
  assert.equal(/Desk update failed/.test(popup), false);
  assert.equal(/mode !== "hub_upload"/.test(popup) || /mode === "hub_upload"/.test(popup) || /signed_staged/.test(popup), true);
});

test("isNewerVersion compares semver-ish strings", () => {
  assert.equal(isNewerVersion("0.1.18", "0.1.17"), true);
  assert.equal(isNewerVersion("0.1.17", "0.1.17"), false);
  assert.equal(isNewerVersion("0.1.16", "0.1.17"), false);
});

test("fetchDeskUpdateFeed + stageSignedXpiFromFeed write Desktop XPI", async () => {
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const fakeHome = await mkdtemp(path.join(tmpdir(), "desk-feed-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  const payload = Buffer.from("PK\x03\x04fakeMETA-INF/mozilla.rsa\x00signed-bytes");
  const hash = (await import("node:crypto")).createHash("sha256").update(payload).digest("hex");
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("updates.json")) {
      return {
        ok: true,
        async json() {
          return {
            addons: {
              "black-forest-desk@blackforestautomotive.com": {
                updates: [
                  {
                    version: "9.9.8",
                    update_link: "https://example.test/Black.Forest.Desk-9.9.8.xpi",
                    update_hash: `sha256:${hash}`,
                  },
                ],
              },
            },
          };
        },
      };
    }
    return {
      ok: true,
      async arrayBuffer() {
        return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
      },
    };
  };
  try {
    const feed = await fetchDeskUpdateFeed(fetchImpl);
    assert.equal(feed.version, "9.9.8");
    const staged = await stageSignedXpiFromFeed(feed, { fetchImpl });
    assert.equal(staged.signed, true);
    assert.equal(staged.path, path.join(fakeHome, "Desktop", "Black.Forest.Desk-9.9.8.xpi"));
    const copied = await readFile(staged.path);
    assert.equal(Buffer.compare(copied, payload), 0);
  } finally {
    process.env.HOME = prevHome;
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("stageHubUploadZip copies self-dist pack to Desktop", async () => {
  const { mkdtemp, rm, mkdir, writeFile, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { homedir } = await import("node:os");
  const fakeRoot = await mkdtemp(path.join(tmpdir(), "desk-hub-"));
  const dist = path.join(fakeRoot, "extension", "dist");
  await mkdir(dist, { recursive: true });
  const payload = Buffer.from("fake-xpi-bytes");
  await writeFile(path.join(dist, "Black.Forest.Desk-9.9.9.xpi"), payload);
  const prevHome = process.env.HOME;
  const fakeHome = await mkdtemp(path.join(tmpdir(), "desk-home-"));
  process.env.HOME = fakeHome;
  try {
    const dest = await stageHubUploadZip(fakeRoot, "9.9.9");
    assert.equal(dest, path.join(fakeHome, "Desktop", "Black.Forest.Desk-9.9.9-hub-upload.zip"));
    const copied = await readFile(dest);
    assert.equal(Buffer.compare(copied, payload), 0);
  } finally {
    process.env.HOME = prevHome;
    await rm(fakeRoot, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
  // silence unused import warning if bundlers care
  assert.equal(typeof homedir, "function");
});
