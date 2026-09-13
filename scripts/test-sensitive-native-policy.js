"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const {
  createRequireAuthSettingHandler,
  createSensitiveAuthorizationGrantStore,
  createSensitiveNativeHandler,
} = require("../public/sensitiveNativePolicy");

async function verifySensitiveOperation(method) {
  let nativeCalls = 0;
  let verifyCalls = 0;
  const denied = createSensitiveNativeHandler({
    method,
    getRequireDeviceAuth: async () => true,
    verifyDeviceAuthentication: async (reason, options) => {
      verifyCalls += 1;
      assert.match(reason, /Wcash|transaction/);
      assert.deepEqual(options, { requireAvailable: false });
      return { success: false };
    },
    invokeNative: async () => {
      nativeCalls += 1;
      return "secret";
    },
  });

  // Values controlled by a compromised renderer must not be authorization.
  await assert.rejects(
    denied({ sender: "forged" }, { authenticated: true }, true, "bypass"),
    /Device authentication is required/,
  );
  assert.equal(verifyCalls, 1);
  assert.equal(nativeCalls, 0);

  const unavailable = createSensitiveNativeHandler({
    method,
    getRequireDeviceAuth: async () => true,
    verifyDeviceAuthentication: async (_reason, options) => {
      assert.deepEqual(options, { requireAvailable: false });
      return { success: true, unavailable: true };
    },
    invokeNative: async () => {
      nativeCalls += 1;
    },
  });
  await unavailable({}, { authenticated: true });
  assert.equal(nativeCalls, 1, "an unavailable authenticator must not deadlock a default-true wallet");

  const explicitlyDisabled = createSensitiveNativeHandler({
    method,
    getRequireDeviceAuth: async () => false,
    verifyDeviceAuthentication: async () => {
      throw new Error("verification must not run when the user explicitly disabled it");
    },
    invokeNative: async () => {
      nativeCalls += 1;
      return `${method}-ok`;
    },
  });
  assert.equal(await explicitlyDisabled({}, { authenticated: false }), `${method}-ok`);
  assert.equal(nativeCalls, 2);

  let priorAuthorizationConsumed = 0;
  const alreadyAuthorized = createSensitiveNativeHandler({
    method,
    getRequireDeviceAuth: async () => true,
    consumePriorAuthorization: async (event, operation) => {
      assert.deepEqual(event, { sender: { id: 7 } });
      assert.equal(operation, method);
      priorAuthorizationConsumed += 1;
      return true;
    },
    verifyDeviceAuthentication: async () => {
      throw new Error("a valid one-shot renderer authorization must not prompt twice");
    },
    invokeNative: async () => {
      nativeCalls += 1;
      return `${method}-prior-auth-ok`;
    },
  });
  assert.equal(await alreadyAuthorized({ sender: { id: 7 } }), `${method}-prior-auth-ok`);
  assert.equal(priorAuthorizationConsumed, 1);
  assert.equal(nativeCalls, 3);
}

async function main() {
  const electronMain = fs.readFileSync(path.join(__dirname, "../public/electron.js"), "utf8");
  assert.match(
    electronMain,
    /native\.verifyWindowsUser\(win\.getNativeWindowHandle\(\), String\(reason\)\)/,
    "Windows Hello verification must pass the owning native window handle",
  );

  await verifySensitiveOperation("get_seed");
  await verifySensitiveOperation("get_ufvk");
  await verifySensitiveOperation("confirm");

  let clock = 1_000;
  const grants = createSensitiveAuthorizationGrantStore({ ttlMs: 15_000, now: () => clock });
  const authorizedRenderer = { sender: { id: 7 } };
  const otherRenderer = { sender: { id: 8 } };
  grants.remember(authorizedRenderer, ["get_seed", "get_ufvk"]);
  assert.equal(grants.consume(otherRenderer, "get_seed"), false, "a grant must stay bound to its renderer");
  assert.equal(grants.consume(authorizedRenderer, "get_seed"), true);
  assert.equal(grants.consume(authorizedRenderer, "get_seed"), false, "each operation grant must be one-use");
  assert.equal(
    grants.consume(authorizedRenderer, "get_ufvk"),
    true,
    "one upstream seed/viewing-key prompt must authorize both exports exactly once",
  );
  grants.remember(authorizedRenderer, ["get_ufvk"]);
  clock += 15_001;
  assert.equal(grants.consume(authorizedRenderer, "get_ufvk"), false, "expired grants must fail closed");

  let stored = true;
  let setCalls = 0;
  const denyDisable = createRequireAuthSettingHandler({
    getRequireDeviceAuth: async () => stored,
    verifyDeviceAuthentication: async (_reason, options) => {
      assert.deepEqual(options, { requireAvailable: false });
      return { success: false };
    },
    setRequireDeviceAuth: async (value) => {
      setCalls += 1;
      stored = value;
    },
  });
  await assert.rejects(denyDisable(false, { authenticated: true }), /required to disable/);
  assert.equal(stored, true);
  assert.equal(setCalls, 0, "a renderer cannot disable protection without trusted-main authentication");

  const allowDisable = createRequireAuthSettingHandler({
    getRequireDeviceAuth: async () => stored,
    verifyDeviceAuthentication: async () => ({ success: true }),
    setRequireDeviceAuth: async (value) => {
      setCalls += 1;
      stored = value;
    },
  });
  await allowDisable(false);
  assert.equal(stored, false);
  assert.equal(setCalls, 1);

  console.log("Trusted-main sensitive native policy tests passed");
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
