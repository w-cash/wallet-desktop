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
});
