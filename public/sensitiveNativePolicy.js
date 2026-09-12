"use strict";

// Security policy for operations that expose spending authority or sign a
// transaction. This module is deliberately independent of Electron so the
// trusted-main boundary can be regression-tested without a renderer process.
const SENSITIVE_NATIVE_OPERATIONS = Object.freeze({
  get_seed: "Show Wcash Wallet seed phrase",
  get_ufvk: "Show Wcash Wallet viewing key",
  confirm: "Authorize Wcash transaction",
});

function createSensitiveNativeHandler({
  method,
  getRequireDeviceAuth,
  verifyDeviceAuthentication,
  invokeNative,
  consumePriorAuthorization = async () => false,
}) {
  const reason = SENSITIVE_NATIVE_OPERATIONS[method];
  if (!reason) throw new TypeError(`Unknown sensitive native operation: ${String(method)}`);
  if (
    typeof getRequireDeviceAuth !== "function" ||
    typeof verifyDeviceAuthentication !== "function" ||
    typeof invokeNative !== "function" ||
    typeof consumePriorAuthorization !== "function"
  ) {
    throw new TypeError("Sensitive native handler dependencies are required");
  }

  // IPC supplies the event and any renderer-controlled arguments. Neither is
  // consulted for authorization, and no renderer value is forwarded to the
  // parameterless native operation.
  return async function sensitiveNativeHandler(event, ..._rendererArguments) {
    if ((await getRequireDeviceAuth()) && !(await consumePriorAuthorization(event, method))) {
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

function createSensitiveAuthorizationGrantStore({ ttlMs = 15_000, now = Date.now } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || typeof now !== "function") {
    throw new TypeError("Sensitive authorization grant-store options are invalid");
  }
  const grants = new Map();

  function key(event, method) {
    const senderId = event && event.sender && event.sender.id;
    return Number.isSafeInteger(senderId) && typeof method === "string" ? `${senderId}:${method}` : null;
  }

  return Object.freeze({
    remember(event, methods) {
      if (!Array.isArray(methods)) throw new TypeError("Sensitive authorization methods must be an array");
      const expiresAt = now() + ttlMs;
      for (const method of methods) {
        const grantKey = key(event, method);
        if (grantKey) grants.set(grantKey, expiresAt);
      }
    },
    consume(event, method) {
      const grantKey = key(event, method);
      if (!grantKey) return false;
      const expiresAt = grants.get(grantKey);
      grants.delete(grantKey);
      return Number.isFinite(expiresAt) && expiresAt >= now();
    },
  });
}

module.exports = Object.freeze({
  SENSITIVE_NATIVE_OPERATIONS,
  createSensitiveAuthorizationGrantStore,
  createRequireAuthSettingHandler,
  createSensitiveNativeHandler,
});
