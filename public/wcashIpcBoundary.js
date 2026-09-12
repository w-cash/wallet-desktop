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
  let pendingOperations = 0;
  let shuttingDown = false;

  function assertAcceptingOperations() {
    if (shuttingDown) {
      throw new Error("Wcash wallet IPC rejected an operation during shutdown");
    }
  }

  function serialize(operation) {
    pendingOperations += 1;
    const pending = operationTail.then(operation, operation).finally(() => {
      pendingOperations -= 1;
    });
    operationTail = pending.catch(() => undefined);
    return pending;
  }

  function register(ipcMain, channel, operation, { outOfBand = false, cancelOnShutdown = false } = {}) {
    if (!ipcMain || typeof ipcMain.handle !== "function") {
      throw new TypeError("ipcMain.handle must be a function");
    }
    if (typeof operation !== "function") {
      throw new TypeError("operation must be a function");
    }
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedEvent(event);
      assertAcceptingOperations();
      if (outOfBand) return operation(...args);
      return serialize(() => {
        if (cancelOnShutdown) assertAcceptingOperations();
        return operation(...args);
      });
    });
  }

  function beginShutdown() {
    shuttingDown = true;
  }

  function drain() {
    beginShutdown();
    return operationTail.then(() => undefined);
  }

  function resume() {
    if (pendingOperations !== 0) {
      throw new Error("Wcash wallet IPC cannot resume before shutdown operations drain");
    }
    shuttingDown = false;
  }

  return Object.freeze({ assertTrustedEvent, beginShutdown, drain, isTrustedUrl, register, resume });
}

module.exports = { createWcashIpcBoundary, normalizeRendererUrl };
