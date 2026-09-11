import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";

const repositoryRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string) => readFileSync(path.join(repositoryRoot, relativePath), "utf8");
const readJson = (relativePath: string) => JSON.parse(read(relativePath));

describe("unsigned local Wcash Testnet packaging", () => {
  it("passes its identity guard while the public release gate stays closed", () => {
    const localResult = spawnSync(process.execPath, ["scripts/assert-wcash-unsigned-local-package.js"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    const releaseResult = spawnSync(process.execPath, ["scripts/assert-wcash-release-ready.js"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    expect(localResult.status).toBe(0);
    expect(localResult.stdout).toContain("identity is isolated");
    expect(releaseResult.status).toBe(1);
    expect(releaseResult.stderr).toContain("Release packaging is blocked");
  });

  it("uses Wcash-only unsigned identities on every desktop platform", () => {
    const localConfig = readJson("config/electron-builder.unsigned-local.json");
    const serialized = JSON.stringify(localConfig);

    expect(localConfig).toMatchObject({
      appId: "com.wcashwallet.warden.testnet",
      productName: "Wcash Warden Testnet",
      forceCodeSigning: false,
      npmRebuild: false,
      afterPack: "./scripts/verify-wcash-unsigned-local-after-pack.js",
      mac: { identity: null },
      win: { signAndEditExecutable: false },
      linux: { executableName: "wcash-warden-testnet" },
    });
    expect(localConfig).not.toHaveProperty("extends");
    expect(localConfig).not.toHaveProperty("mas");
    expect(localConfig).not.toHaveProperty("appx");
    expect(localConfig).not.toHaveProperty("afterSign");
    expect(localConfig).not.toHaveProperty("afterAllArtifactBuild");
    expect(serialized).not.toMatch(/zingo|zcash|nym/i);
    expect(serialized).not.toContain("protocols");
  });

  it("installs and removes only Wcash-owned Linux resources", () => {
    const postinstall = read("scripts/postinstall.sh");
    const postremove = read("scripts/postremove.sh");
    const policy = read("resources/linux/com.wcashwallet.warden.testnet.policy");
    const apparmor = read("resources/linux/apparmor/wcash-warden-testnet");

    for (const source of [postinstall, postremove, policy, apparmor]) {
      expect(source).not.toMatch(/zingo|co\.zingo/i);
    }
    expect(policy).toContain('<action id="com.wcashwallet.warden.testnet.authenticate">');
    expect(postinstall).toContain("APP_DIR='/opt/Wcash Warden Testnet'");
    expect(postremove).toContain("INSTALLED_EXECUTABLE='/opt/Wcash Warden Testnet/wcash-warden-testnet'");
    expect(apparmor).toContain('profile wcash-warden-testnet "/opt/Wcash Warden Testnet/wcash-warden-testnet"');
    expect(existsSync(path.join(repositoryRoot, "resources/linux/co.zingo.pc.policy"))).toBe(false);
    expect(existsSync(path.join(repositoryRoot, "resources/linux/zingo-pc-uri.sh"))).toBe(false);
  });
});
