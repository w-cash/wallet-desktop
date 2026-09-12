import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

export {};

const {
  LOCAL_REGTEST_RUNTIME_PROFILE,
  TESTNET_RUNTIME_PROFILE,
  publicRuntimeConfig,
  resolveWcashUserDataPath,
  selectWcashRuntimeProfile,
} = require("../../public/wcashRuntimeProfile");
const { nativeDependencyPinsMatch } = require("../../scripts/wcash-native-pins");

const repositoryRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string): string => readFileSync(path.join(repositoryRoot, relativePath), "utf8");
const fixtureAppData = path.resolve(repositoryRoot, "test-fixtures", "app-data");
const fixtureLocalnetData = path.resolve(repositoryRoot, "test-fixtures", "localnet-data");
const thrownMessage = (work: () => unknown): string => {
  try {
    work();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

describe("Wcash local Regtest build boundary", () => {
  it("selects localnet only for an explicit non-packaged launch", () => {
    expect(selectWcashRuntimeProfile({ isPackaged: false, localnetRequested: true })).toBe(
      LOCAL_REGTEST_RUNTIME_PROFILE,
    );
    expect(selectWcashRuntimeProfile({ isPackaged: false, localnetRequested: false })).toBe(TESTNET_RUNTIME_PROFILE);
    expect(selectWcashRuntimeProfile({ isPackaged: true, localnetRequested: true })).toBe(TESTNET_RUNTIME_PROFILE);
    expect(publicRuntimeConfig(LOCAL_REGTEST_RUNTIME_PROFILE)).toEqual({
      profile: "local-regtest",
      productName: "Wcash Warden Local Regtest",
      network: "Wcash Regtest",
      ticker: "TWC",
      endpoint: "http://127.0.0.1:48234",
      storageNamespace: "wcashregtest-v5",
      branchId: "c3a6678a",
      runtimeReady: true,
      coreRevision: "58bc22ec63bbe3eddab5f961c137836431589c95",
    });
  });

  it("isolates local wallet and credential storage and validates a main-process-only override", () => {
    expect(LOCAL_REGTEST_RUNTIME_PROFILE.appId).not.toBe(TESTNET_RUNTIME_PROFILE.appId);
    expect(LOCAL_REGTEST_RUNTIME_PROFILE.productName).not.toBe(TESTNET_RUNTIME_PROFILE.productName);
    expect(LOCAL_REGTEST_RUNTIME_PROFILE.storageNamespace).not.toBe(TESTNET_RUNTIME_PROFILE.storageNamespace);
    expect(LOCAL_REGTEST_RUNTIME_PROFILE.keytarService).not.toBe(TESTNET_RUNTIME_PROFILE.keytarService);
    expect(LOCAL_REGTEST_RUNTIME_PROFILE.keytarAccount).not.toBe(TESTNET_RUNTIME_PROFILE.keytarAccount);

    expect(
      resolveWcashUserDataPath({
        profile: LOCAL_REGTEST_RUNTIME_PROFILE,
        appDataPath: fixtureAppData,
        localnetDataDir: fixtureLocalnetData,
      }),
    ).toBe(fixtureLocalnetData);
    expect(() =>
      resolveWcashUserDataPath({
        profile: LOCAL_REGTEST_RUNTIME_PROFILE,
        appDataPath: fixtureAppData,
        localnetDataDir: "relative/localnet",
      }),
    ).toThrow("absolute path");
    expect(() =>
      resolveWcashUserDataPath({
        profile: LOCAL_REGTEST_RUNTIME_PROFILE,
        appDataPath: fixtureAppData,
        localnetDataDir: path.parse(repositoryRoot).root,
      }),
    ).toThrow("filesystem root");
  });

  it("resolves local data symlinks before enforcing root and Testnet isolation", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "wcash-localnet-path-"));
    let rootAliasError = "";
    let testnetAliasError = "";
    try {
      const appDataPath = path.join(fixtureRoot, "app-data");
      const testnetDataPath = path.join(appDataPath, TESTNET_RUNTIME_PROFILE.productName);
      const rootAlias = path.join(fixtureRoot, "root-alias");
      const testnetAlias = path.join(fixtureRoot, "testnet-alias");
      mkdirSync(testnetDataPath, { recursive: true });
      const symlinkType = process.platform === "win32" ? "junction" : "dir";
      symlinkSync(path.parse(fixtureRoot).root, rootAlias, symlinkType);
      symlinkSync(testnetDataPath, testnetAlias, symlinkType);

      rootAliasError = thrownMessage(() =>
        resolveWcashUserDataPath({
          profile: LOCAL_REGTEST_RUNTIME_PROFILE,
          appDataPath,
          localnetDataDir: rootAlias,
        }),
      );
      testnetAliasError = thrownMessage(() =>
        resolveWcashUserDataPath({
          profile: LOCAL_REGTEST_RUNTIME_PROFILE,
          appDataPath,
          localnetDataDir: testnetAlias,
        }),
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }

    expect(rootAliasError).toContain("filesystem root");
    expect(testnetAliasError).toContain("isolated from the Testnet wallet data path");
  });

  it("rejects a not-yet-created case variant of the Testnet data path", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "wcash-localnet-case-"));
    let aliasError = "";
    try {
      const appDataPath = path.join(fixtureRoot, "app-data");
      mkdirSync(appDataPath);
      aliasError = thrownMessage(() =>
        resolveWcashUserDataPath({
          profile: LOCAL_REGTEST_RUNTIME_PROFILE,
          appDataPath,
          localnetDataDir: path.join(appDataPath, TESTNET_RUNTIME_PROFILE.productName.toLowerCase()),
        }),
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }

    expect(aliasError).toContain("isolated from the Testnet wallet data path");
  });

  it("requires reviewed native pins in the production dependency table", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "wcash-native-pins-"));
    const coreRevision = "a".repeat(40);
    const wolfRevision = "b".repeat(40);
    let validDependencies = false;
    let misplacedDependencies = true;
    let commentSpoofedDependencies = true;
    let multilineSpoofedDependencies = true;
    let lockfileSpoofedDependencies = true;
    let lockfileTableSpoofedDependencies = true;
    try {
      const nativeRoot = path.join(fixtureRoot, "native");
      mkdirSync(nativeRoot);
      const coreLine = `zingolib = { git = "https://github.com/w-cash/wallet-core.git", rev = "${coreRevision}", optional = true }`;
      const wolfLine = `wcash-wallet = { git = "https://github.com/w-cash/wolf.git", rev = "${wolfRevision}" }`;
      const lockfile = [
        "[[package]]",
        'name = "zingolib"',
        'version = "0.1.0"',
        `source = "git+https://github.com/w-cash/wallet-core.git?rev=${coreRevision}#${coreRevision}"`,
        "",
        "[[package]]",
        'name = "wcash-wallet"',
        'version = "0.1.0"',
        `source = "git+https://github.com/w-cash/wolf.git?rev=${wolfRevision}#${wolfRevision}"`,
        "",
      ].join("\n");
      writeFileSync(path.join(nativeRoot, "Cargo.lock"), lockfile);
      writeFileSync(path.join(nativeRoot, "Cargo.toml"), `[dependencies]\n${coreLine}\n${wolfLine}\n`);
      validDependencies = nativeDependencyPinsMatch({ root: fixtureRoot, coreRevision, wolfRevision });
      writeFileSync(
        path.join(nativeRoot, "Cargo.toml"),
        `[dependencies]\nserde = "1"\n\n[dev-dependencies] # reviewed pins here are not runtime dependencies\n${coreLine}\n${wolfLine}\n`,
      );
      misplacedDependencies = nativeDependencyPinsMatch({ root: fixtureRoot, coreRevision, wolfRevision });
      writeFileSync(
        path.join(nativeRoot, "Cargo.toml"),
        `[dependencies]\nzingolib = { git = "https://attacker.invalid/core.git", rev = "${"c".repeat(40)}", optional = true } # ${coreLine}\nwcash-wallet = { git = "https://attacker.invalid/wolf.git", rev = "${"d".repeat(40)}" } # ${wolfLine}\n`,
      );
      commentSpoofedDependencies = nativeDependencyPinsMatch({ root: fixtureRoot, coreRevision, wolfRevision });
      writeFileSync(
        path.join(nativeRoot, "Cargo.toml"),
        `[package]\nname = "spoof"\nversion = "0.0.0"\ndescription = """\n[dependencies]\n${coreLine}\n${wolfLine}\n"""\n[dependencies]\nserde = "1"\n`,
      );
      multilineSpoofedDependencies = nativeDependencyPinsMatch({ root: fixtureRoot, coreRevision, wolfRevision });
      writeFileSync(path.join(nativeRoot, "Cargo.toml"), `[dependencies]\n${coreLine}\n${wolfLine}\n`);
      writeFileSync(
        path.join(nativeRoot, "Cargo.lock"),
        `metadata = """\n${lockfile}"""\n[[package]]\nname = "serde"\nversion = "1.0.0"\n`,
      );
      lockfileSpoofedDependencies = nativeDependencyPinsMatch({ root: fixtureRoot, coreRevision, wolfRevision });
      writeFileSync(
        path.join(nativeRoot, "Cargo.lock"),
        [
          "[[package]]",
          'name = "attacker-one"',
          'version = "0.0.0"',
          "[metadata.first] # values below are outside the package",
          'name = "zingolib"',
          `source = "git+https://github.com/w-cash/wallet-core.git?rev=${coreRevision}#${coreRevision}"`,
          "",
          "[[package]]",
          'name = "attacker-two"',
          'version = "0.0.0"',
          "  [metadata.second]",
          'name = "wcash-wallet"',
          `source = "git+https://github.com/w-cash/wolf.git?rev=${wolfRevision}#${wolfRevision}"`,
          "",
        ].join("\n"),
      );
      lockfileTableSpoofedDependencies = nativeDependencyPinsMatch({
        root: fixtureRoot,
        coreRevision,
        wolfRevision,
      });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }

    expect(validDependencies).toBe(true);
    expect(misplacedDependencies).toBe(false);
    expect(commentSpoofedDependencies).toBe(false);
    expect(multilineSpoofedDependencies).toBe(false);
    expect(lockfileSpoofedDependencies).toBe(false);
    expect(lockfileTableSpoofedDependencies).toBe(false);
  });

  it("keeps every ordinary build on the pinned Testnet dependency without the Regtest feature", () => {
    const packageJson = JSON.parse(read("package.json"));
    const manifest = read("native/Cargo.toml");
    const native = read("native/src/wcash.rs");
    const main = read("public/electron.js");

    expect(manifest).toContain('default = ["wcash-testnet"]');
    expect(manifest).toContain(
      'zingolib = { git = "https://github.com/w-cash/wallet-core.git", rev = "58bc22ec63bbe3eddab5f961c137836431589c95", optional = true }',
    );
    expect(manifest).toContain('wcash-regtest = ["dep:zingolib", "zingolib/regtest"]');
    expect(
      nativeDependencyPinsMatch({
        root: repositoryRoot,
        coreRevision: "58bc22ec63bbe3eddab5f961c137836431589c95",
        wolfRevision: "5b4e29980eb45e84ddab9024f530c923986d7e1e",
      }),
    ).toBe(true);
    expect(packageJson.scripts["neon-mac-arm64-localnet"]).toContain("--no-default-features --features wcash-regtest");

    const unsafeProductionScripts = Object.entries<string>(packageJson.scripts)
      .filter(([name]) => {
        const packagedBuildScript =
          /^(?:release:prep|build:runtime|build-(?:mac|win)(?!.*localnet)|dist:|package:unsigned-local:)/.test(name);
        const ordinaryNativeScript = /^neon(?:-|$)/.test(name) && !name.endsWith("-localnet");
        return packagedBuildScript || ordinaryNativeScript;
      })
      .filter(([, command]) => command.includes("wcash-regtest") || command.includes("WCASH_LOCALNET_DEV"))
      .map(([name]) => name);
    expect(unsafeProductionScripts).toEqual([]);

    expect(native).toContain('const WCASH_ENDPOINT: &str = "http://127.0.0.1:48234";');
    expect(native).not.toContain("WCASH_LOCALNET_ENDPOINT");
    expect(main).toContain("isPackaged: app.isPackaged");
    expect(main).toContain("WCASH_RUNTIME.localnet ? process.env.WCASH_LOCALNET_DATA_DIR : undefined");
    expect(main).toContain('mainWindow.webContents.on("page-title-updated"');
    expect(main).toContain("mainWindow.setTitle(WCASH_PRODUCT_NAME)");
    expect(main).toContain("service: WCASH_SEED_KEYTAR_SERVICE");
    expect(main).toContain("profile: WCASH_RUNTIME");
  });
});
