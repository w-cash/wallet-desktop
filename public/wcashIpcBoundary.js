"use strict";

function normalizeRendererUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function createWcashIpcBoundary({ trustedUrl, getTrustedWebContents }) {
  const normalizedTrustedUrl = normalizeRendererUrl(trustedUrl);
  if (normalizedTrustedUrl === null) {
    throw new TypeError("trustedUrl must be an absolute URL");
  }
  if (typeof getTrustedWebContents !== "function") {
    throw new TypeError("getTrustedWebContents must be a function");
  }

  function isTrustedUrl(value) {
    return normalizeRendererUrl(value) === normalizedTrustedUrl;
  }

  function assertTrustedEvent(event) {
    const trustedWebContents = getTrustedWebContents();
    const frame = event?.senderFrame;
    if (
      !trustedWebContents ||
      event?.sender !== trustedWebContents ||
      frame !== event.sender.mainFrame ||
      !isTrustedUrl(frame?.url)
    ) {
      throw new Error("Wcash wallet IPC rejected an untrusted renderer");
    }
  }

  let operationTail = Promise.resolve();
  function serialize(operation) {
    const pending = operationTail.then(operation, operation);
    operationTail = pending.catch(() => undefined);
    return pending;
  }

  function register(ipcMain, channel, operation, { outOfBand = false } = {}) {
    if (!ipcMain || typeof ipcMain.handle !== "function") {
      throw new TypeError("ipcMain.handle must be a function");
    }
    if (typeof operation !== "function") {
      throw new TypeError("operation must be a function");
    }
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedEvent(event);
      return outOfBand ? operation(...args) : serialize(() => operation(...args));
    });
  }

  return Object.freeze({ assertTrustedEvent, isTrustedUrl, register });
}

module.exports = { createWcashIpcBoundary, normalizeRendererUrl };
