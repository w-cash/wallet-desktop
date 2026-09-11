import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import path from "path";

const repositoryRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string) => readFileSync(path.join(repositoryRoot, relativePath), "utf8");

describe("Wcash pre-core product boundary", () => {
  it("uses an isolated Testnet identity with no claimed core revision", () => {
    const packageJson = JSON.parse(read("package.json"));
    const runtime = JSON.parse(read("config/wcash-runtime.json"));

    expect(packageJson.name).toBe("wcash-warden-testnet");
    expect(packageJson.productName).toBe("Wcash Warden Testnet");
    expect(packageJson.build.appId).toBe("com.wcashwallet.warden.testnet");
    expect(runtime).toEqual({
      appId: "com.wcashwallet.warden.testnet",
      productName: "Wcash Warden Testnet",
      runtimeReady: false,
      coreRevision: null,
      network: "Wcash Testnet",
      ticker: "TWC",
    });

    const guardedScripts = Object.entries<string>(packageJson.scripts).filter(([name]) =>
      /^(?:release:prep|build:runtime|build-(?:mac|win)|dist:)/.test(name),
    );
    expect(guardedScripts.length).toBeGreaterThan(0);
    guardedScripts.forEach(([, command]) => expect(command).toMatch(/^node scripts\/assert-wcash-runtime-ready\.js/));
  });

  it("keeps inherited native, protocol, migration and service paths fail-closed", () => {
    const main = read("public/electron.js");
    const preload = read("public/preload.js");
    const root = read("src/root/Root.tsx");

    expect(main).toContain("const WCASH_RUNTIME_READY = WCASH_RUNTIME.runtimeReady;");
    expect(main).toContain("if (!WCASH_RUNTIME_READY) return null;");
    expect(main).toContain('if (WCASH_RUNTIME_READY) serverRegistry.load("main");');
    expect(main).toContain("if (WCASH_RUNTIME_READY && !isInSandbox)");
    expect(main).toContain("if (WCASH_RUNTIME_READY) {\n    await maybeRunDmgToMasMigration();");
    expect(preload).toContain("ALLOWED_INVOKE.clear()");
    expect(preload).toMatch(/invokeWhenReady\(`native:\$\{method\}`/);
    expect(root).not.toMatch(/from ["']\.\/Routes["']/);
  });

  it("rejects release packaging before an exact reviewed core pin", () => {
    const result = spawnSync(process.execPath, ["scripts/assert-wcash-runtime-ready.js"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Release packaging is blocked");
  });
});
