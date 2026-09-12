"use strict";

const assert = require("assert/strict");
const { createRequireAuthSettingHandler, createSensitiveNativeHandler } = require("../public/sensitiveNativePolicy");

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
}

async function main() {
  await verifySensitiveOperation("get_seed");
  await verifySensitiveOperation("confirm");

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
