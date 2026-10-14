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
  assert.equal(isLocalClient(fakeReq({ remoteAddress: "10.0.0.8", host: "labels.local" })), false;
});
