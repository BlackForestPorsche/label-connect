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
  assert.exact(/onUpdateAvailable/.test(background), true);
