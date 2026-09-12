"use strict";

// Security policy for operations that expose spending authority or sign a
// transaction. This module is deliberately independent of Electron so the
// trusted-main boundary can be regression-tested without a renderer process.
const SENSITIVE_NATIVE_OPERATIONS = Object.freeze({
  get_seed: "Show Wcash Wallet seed phrase",
  confirm: "Authorize Wcash transaction",
});

function createSensitiveNativeHandler({ method, getRequireDeviceAuth, verifyDeviceAuthentication, invokeNative }) {
  const reason = SENSITIVE_NATIVE_OPERATIONS[method];
  if (!reason) throw new TypeError(`Unknown sensitive native operation: ${String(method)}`);
  if (
    typeof getRequireDeviceAuth !== "function" ||
    typeof verifyDeviceAuthentication !== "function" ||
    typeof invokeNative !== "function"
  ) {
    throw new TypeError("Sensitive native handler dependencies are required");
  }

  // IPC supplies the event and any renderer-controlled arguments. Neither is
  // consulted for authorization, and no renderer value is forwarded to the
  // parameterless native operation.
  return async function sensitiveNativeHandler(_event, ..._rendererArguments) {
    if (await getRequireDeviceAuth()) {
      // Availability is decided only by the trusted main process. On systems
      // without a configured authenticator, preserve the existing explicit
      // fallback so a default-true setting cannot permanently lock the wallet.
      const result = await verifyDeviceAuthentication(reason, { requireAvailable: false });
      if (!result || result.success !== true) {
        throw new Error("Device authentication is required for this wallet operation");
      }
    }
    return invokeNative();
  };
}

function createRequireAuthSettingHandler({ getRequireDeviceAuth, verifyDeviceAuthentication, setRequireDeviceAuth }) {
  if (
    typeof getRequireDeviceAuth !== "function" ||
    typeof verifyDeviceAuthentication !== "function" ||
    typeof setRequireDeviceAuth !== "function"
  ) {
    throw new TypeError("Device-auth setting handler dependencies are required");
  }

  return async function updateRequireAuthSetting(requestedValue) {
    if (typeof requestedValue !== "boolean") throw new TypeError("requireDeviceAuth must be a boolean");
    const currentlyRequired = await getRequireDeviceAuth();
    if (currentlyRequired && !requestedValue) {
      const result = await verifyDeviceAuthentication("Disable device authentication", { requireAvailable: false });
      if (!result || result.success !== true) {
        throw new Error("Device authentication is required to disable this protection");
      }
    }
    await setRequireDeviceAuth(requestedValue);
  };
}

module.exports = Object.freeze({
  SENSITIVE_NATIVE_OPERATIONS,
  createRequireAuthSettingHandler,
  createSensitiveNativeHandler,
});
