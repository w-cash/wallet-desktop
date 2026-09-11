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

  it("has no send or signing UI before those reviewed bridge methods exist", () => {
    const wallet = read("src/wcash/WcashWallet.tsx");
    const bridgeTypes = read("src/electron-api.d.ts");
    const wcashBridgeTypes = bridgeTypes.slice(bridgeTypes.indexOf("wcash: {"), bridgeTypes.indexOf("wcashShell: {"));

    expect(wallet).not.toMatch(/window\.wcash\.(?:send|sign|broadcast)/);
    expect(wcashBridgeTypes).not.toMatch(/^\s+(?:send|sign|broadcast):/m);
    expect(wcashBridgeTypes).not.toMatch(/(?:check|verify)DeviceAuth/);
  });
});
