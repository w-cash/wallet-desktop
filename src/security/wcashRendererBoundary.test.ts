import { readFileSync } from "fs";
import path from "path";

const repositoryRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string) => readFileSync(path.join(repositoryRoot, relativePath), "utf8");

describe("Wcash renderer privilege boundary", () => {
  it("mounts only the dedicated Wcash flow", () => {
    const root = read("src/root/Root.tsx");

    expect(root).toContain('from "../wcash/WcashWallet"');
    expect(root).not.toMatch(/from ["']\.\/Routes["']/);
  });

  it("does not use inherited IPC, filesystem, storage, or logging paths", () => {
    const wallet = read("src/wcash/WcashWallet.tsx");

    expect(wallet).toContain("window.wcash");
    expect(wallet).not.toContain("window.electronAPI");
    expect(wallet).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/);
    expect(wallet).not.toMatch(/\bconsole\.(?:log|debug|info|warn|error|trace)\b/);
  });

  it("uses only semantic transaction methods and never exposes generic signing or raw broadcast", () => {
    const wallet = read("src/wcash/WcashWallet.tsx");
    const bridgeTypes = read("src/electron-api.d.ts");
    const wcashBridgeTypes = bridgeTypes.slice(bridgeTypes.indexOf("wcash: {"), bridgeTypes.indexOf("wcashShell: {"));

    expect(wcashBridgeTypes).toMatch(/^\s+send:/m);
    expect(wcashBridgeTypes).toMatch(/^\s+shieldCoinbase:/m);
    expect(wcashBridgeTypes).toMatch(/^\s+rebroadcastPending:/m);
    expect(wcashBridgeTypes).not.toMatch(/^\s+(?:sign|broadcast|rawTransaction):/m);
    expect(wcashBridgeTypes).not.toMatch(/(?:check|verify)DeviceAuth/);
  });

  it("routes transaction IPC through the independently tested main-process controller", () => {
    const main = read("public/electron.js");
    const controller = read("public/wcashTransactionBoundary.js");

    expect(main).toContain("createWcashTransactionController");
    expect(main).toContain('handleWcash("wcash:send", (request) => wcashTransactionController.send(request))');
    expect(main).toContain("dialog.showMessageBox(owner, options)");
    expect(controller.indexOf("confirmSend")).toBeLessThan(controller.indexOf("sendAndBroadcast(JSON.stringify"));
    expect(controller.indexOf("confirmShield")).toBeLessThan(controller.indexOf("shieldCoinbaseAndBroadcast()"));
  });

  it("registers every transaction channel through the serialized boundary", () => {
    const main = read("public/electron.js");
    const registrations = [...main.matchAll(/handleWcash\("([^"]+)"/g)].map((match) => match[1]);

    expect(registrations).toEqual([
      "wcash:status",
      "wcash:create",
      "wcash:restore",
      "wcash:resume-pending",
      "wcash:reveal-backup",
      "wcash:acknowledge-backup",
      "wcash:open",
      "wcash:sync",
      "wcash:stop-sync",
      "wcash:balance",
      "wcash:receivers",
      "wcash:validate-recipient",
      "wcash:send",
      "wcash:shield-coinbase",
      "wcash:pending-transactions",
      "wcash:rebroadcast-pending",
    ]);
    expect(main.match(/\{ outOfBand: true \}/g)).toHaveLength(1);
    expect(main).toContain(
      'handleWcash("wcash:stop-sync", () => requireWcashNative("wcash_stop_sync").wcash_stop_sync(), {',
    );
    expect(main).toContain(
      'handleWcash("wcash:sync", () => invokeWcashJson("wcash_sync"), { cancelOnShutdown: true });',
    );
  });

  it("stops sync and drains accepted Wcash operations before shutdown", () => {
    const main = read("public/electron.js");
    const wcashCloseStart = main.indexOf("if (!LEGACY_ZCASH_RUNTIME_ENABLED) {", main.indexOf('mainWindow.on("close"'));
    const legacyCloseStart = main.indexOf("// If we are clear to close", wcashCloseStart);
    const wcashClosePath = main.slice(wcashCloseStart, legacyCloseStart);

    expect(main).toContain("wcashIpcBoundary.beginShutdown();");
    expect(main).toContain("return wcashIpcBoundary.drain();");
    expect(main).toContain("wcashIpcBoundary.resume();");
    expect(main).toContain('typeof native.wcash_stop_sync !== "function"');
    expect(main).toContain('mainWindow.webContents.once("render-process-gone"');
    expect(wcashClosePath).toContain("event.preventDefault();");
    expect(wcashClosePath).toContain("startWcashWindowDrain()");
    expect(main).toContain("wcashWindowCloseDrain = drainWcashOperations();");
    expect(wcashClosePath).not.toContain("setTimeout");
    expect(main).toContain('mainWindow.webContents.send("appquitting")');
  });

  it("keeps hard-exit IPC legacy-only and covers graceful and forced OS shutdown signals", () => {
    const main = read("public/electron.js");
    const legacyHardExitStart = main.indexOf('if (LEGACY_ZCASH_RUNTIME_ENABLED) {\n  ipcMain.on("apprestart"');
    const createWindowStart = main.indexOf("function createWindow()", legacyHardExitStart);
    const hardExitHandlers = main.slice(legacyHardExitStart, createWindowStart);
    const sessionEndStart = main.indexOf("function prepareWcashForSessionEnd()");
    const beforeQuitStart = main.indexOf('app.on("before-quit"', sessionEndStart);
    const sessionEnd = main.slice(sessionEndStart, beforeQuitStart);

    expect(legacyHardExitStart).toBeGreaterThan(-1);
    expect(hardExitHandlers).toContain('ipcMain.on("apprestart"');
    expect(hardExitHandlers).toContain('ipcMain.on("appquitdone"');
    expect(hardExitHandlers).toContain("app.exit(0)");
    expect(sessionEnd).toContain("wcashIpcBoundary.beginShutdown();");
    expect(sessionEnd).toContain("requestWcashSyncStop();");
    expect(main).toContain('mainWindow.on("query-session-end", requestWcashSyncStop)');
    expect(main).toContain('mainWindow.on("session-end", prepareWcashForSessionEnd)');
    expect(main).toContain('process.on("SIGINT", () => app.quit())');
    expect(main).toContain('process.on("SIGTERM", () => app.quit())');
  });

  it("preserves macOS activation while the current window drains", () => {
    const main = read("public/electron.js");

    expect(main).toContain("wcashWindowDrainState.beginDrain();");
    expect(main).toContain("const shouldReopen = wcashWindowDrainState.finishClose();");
    expect(main).toContain("wcashWindowDrainState.requestReopenOnActivation();");
    expect(main).toContain("shouldReopen && !wcashQuitAllowed && wcashQuitDrain === null");
  });
});
