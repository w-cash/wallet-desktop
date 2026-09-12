import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import path from "path";

const repositoryRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string) => readFileSync(path.join(repositoryRoot, relativePath), "utf8");

describe("Wcash pinned-runtime product boundary", () => {
  it("uses an isolated Testnet identity and the exact reviewed core revision", () => {
    const packageJson = JSON.parse(read("package.json"));
    const runtime = JSON.parse(read("config/wcash-runtime.json"));

    expect(packageJson.name).toBe("wcash-warden-testnet");
    expect(packageJson.productName).toBe("Wcash Warden Testnet");
    expect(packageJson.build.appId).toBe("com.wcashwallet.warden.testnet");
    expect(runtime).toEqual({
      appId: "com.wcashwallet.warden.testnet",
      productName: "Wcash Warden Testnet",
      runtimeReady: true,
      releaseReady: false,
      coreRevision: "db28e549bda764adcc5ba48c295a3e33c033d638",
      network: "Wcash Testnet",
      ticker: "TWC",
    });

    const guardedScripts = Object.entries<string>(packageJson.scripts).filter(([name]) =>
      /^(?:release:prep|build:runtime|build-(?:mac|win)(?!.*localnet)|dist:)/.test(name),
    );
    expect(guardedScripts.length).toBeGreaterThan(0);
    guardedScripts.forEach(([, command]) => expect(command).toMatch(/^node scripts\/assert-wcash-runtime-ready\.js/));

    const releaseScripts = Object.entries<string>(packageJson.scripts).filter(([name]) =>
      /^(?:release:prep|dist:)/.test(name),
    );
    releaseScripts.forEach(([, command]) => expect(command).toContain("node scripts/assert-wcash-release-ready.js"));
    Object.entries<string>(packageJson.scripts)
      .filter(([name]) => /^(?:cargo:(?:check|test|clippy)|neon(?:-|$))/.test(name))
      .forEach(([, command]) => expect(command).toContain("--locked"));
  });

  it("keeps the inherited Zcash bridge closed while exposing only fixed Wcash paths", () => {
    const main = read("public/electron.js");
    const preload = read("public/preload.js");
    const runtime = JSON.parse(read("config/wcash-runtime.json"));

    expect(main).toContain("const WCASH_RUNTIME_READY = WCASH_RUNTIME.runtimeReady;");
    expect(main).toContain("const LEGACY_ZCASH_RUNTIME_ENABLED = false;");
    expect(main).toContain('if (LEGACY_ZCASH_RUNTIME_ENABLED) serverRegistry.load("main");');
    expect(main).toContain('requireWcashNative("set_wallet_base_dir")');
    expect(main).toContain('handleWcash("wcash:status"');
    expect(main).not.toContain('ipcMain.handle("wcash:status"');
    expect(preload).toContain("const LEGACY_ZCASH_BRIDGE_ENABLED = false;");
    expect(preload).not.toContain('require("../config/wcash-runtime.json")');
    expect(preload).toContain('productName: "Wcash Warden Testnet"');
    expect(preload).toContain(`coreRevision: "${runtime.coreRevision}"`);
    expect(preload).toContain("ALLOWED_INVOKE.clear()");
    expect(preload).toContain('contextBridge.exposeInMainWorld(\n  "wcash"');
    expect(preload).not.toContain("wcash_verify_mnemonic");
  });

  it("accepts the exact runtime pin but keeps release packaging blocked", () => {
    const runtimeResult = spawnSync(process.execPath, ["scripts/assert-wcash-runtime-ready.js"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    const releaseResult = spawnSync(process.execPath, ["scripts/assert-wcash-release-ready.js"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    expect(runtimeResult.status).toBe(0);
    expect(releaseResult.status).toBe(1);
    expect(releaseResult.stderr).toContain("Release packaging is blocked");
  });
});
