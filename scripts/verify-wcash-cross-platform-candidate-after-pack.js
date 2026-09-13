"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const asar = require("@electron/asar");
const { peArch } = require("./pe-arch");

const EXPECTED_APP_ID = "com.wcashwallet.wallet.local-regtest-qa";
const EXPECTED_PRODUCT = "Wcash Wallet";
const EXPECTED_MARKER = "local-regtest-qa";
const NATIVE_ATTESTATION_FILENAME = "WCASH-NATIVE-LOCAL-REGTEST-QA-ATTESTATION.json";
const FORBIDDEN_STAGED_NAME = /(?:zingo|zcash|nym|azure|provision)/i;
const REQUIRED_NATIVE_METHODS = [
  "set_wallet_base_dir",
  "wcash_balance",
  "wcash_cancel_proposal",
  "wcash_confirm_proposal",
  "wcash_confirmed_transactions",
  "wcash_create",
  "wcash_delete",
  "wcash_export_ufvk",
  "wcash_generate_mnemonic",
  "wcash_open",
  "wcash_pending_transactions",
  "wcash_propose_send",
  "wcash_propose_shield_coinbase",
  "wcash_rebroadcast_pending",
  "wcash_receivers",
  "wcash_restore",
  "wcash_status",
  "wcash_stop_sync",
  "wcash_sync",
  "wcash_validate_mnemonic",
  "wcash_validate_recipient",
  "wcash_verify_mnemonic",
];
const PLATFORM_NATIVE_METHODS = {
  darwin: ["checkMacAuth", "verifyMacUser"],
  linux: [],
  win32: ["checkWindowsHello", "verifyWindowsUser"],
};
const EXPECTED_NATIVE_STATUS = {
  profile: "local-regtest",
  network: "Wcash Regtest",
  ticker: "TWC",
  endpoint: "http://127.0.0.1:48234",
  storage_namespace: "wcashregtest-v5",
  branch_id: "c3a6678a",
  wallet: null,
};

function assert(condition, message) {
  if (!condition) throw new Error(`Cross-platform Local Regtest QA verification failed: ${message}`);
}

function walkNames(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    output.push(path.relative(directory, absolute));
    if (entry.isDirectory() && entry.name !== "app.asar.unpacked") {
      for (const child of walkNames(absolute)) output.push(path.join(entry.name, child));
    }
  }
  return output;
}

function elfArch(file) {
  const header = fs.readFileSync(file).subarray(0, 20);
  assert(
    header.length === 20 && header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
    `${file} is not ELF`,
  );
  assert(header[4] === 2 && header[5] === 1, `${file} is not 64-bit little-endian ELF`);
  const machine = header.readUInt16LE(18);
  if (machine === 62) return "x64";
  if (machine === 183) return "arm64";
  return `elf-machine-${machine}`;
}

function assertRegtestNative(nativeBinding) {
  assert(fs.existsSync(nativeBinding) && fs.statSync(nativeBinding).size > 0, "native wallet binding is missing");
  const nativeBytes = fs.readFileSync(nativeBinding);
  const contains = (value) => nativeBytes.indexOf(Buffer.from(value, "utf8")) !== -1;
  assert(contains("http://127.0.0.1:48234"), "native binding is not fixed to the loopback endpoint");
  assert(contains("wcashregtest-v5"), "native binding does not contain the Regtest namespace");
  assert(!contains("https://wallet-testnet.wcashexplorer.com:443"), "native binding contains the Testnet endpoint");
  assert(!contains("wcashtestnet-v5"), "native binding contains the Testnet namespace");
}

function expectedNativeMethods(platform) {
  assert(Object.hasOwn(PLATFORM_NATIVE_METHODS, platform), `unsupported native probe platform ${platform}`);
  return [...REQUIRED_NATIVE_METHODS, ...PLATFORM_NATIVE_METHODS[platform]].sort();
}

function validateNativeAttestation(attestation, platform) {
  assert(attestation?.schemaVersion === 1, "native runtime attestation schema is unexpected");
  assert(attestation?.marker === "wcash-native-local-regtest-qa", "native runtime attestation marker is missing");
  assert(attestation?.platform === platform, "native runtime attestation platform is wrong");
  assert(
    JSON.stringify(attestation?.apiMethods) === JSON.stringify(expectedNativeMethods(platform)),
    "native module API is not the fixed-profile Wcash boundary",
  );
  for (const [name, expected] of Object.entries(EXPECTED_NATIVE_STATUS)) {
    assert(attestation?.status?.[name] === expected, `native runtime status ${name} is wrong`);
  }
}

function nativeProbeSource() {
  return `
const fs = require("fs");
const os = require("os");
const path = require("path");

(async () => {
  const nativeBinding = process.argv[1];
  const platform = process.argv[2];
  const expectedMethods = JSON.parse(process.argv[3]);
  const expectedStatus = JSON.parse(process.argv[4]);
  const native = require(nativeBinding);
  const apiMethods = Object.keys(native).sort();
  if (JSON.stringify(apiMethods) !== JSON.stringify(expectedMethods)) {
    throw new Error(\`native API mismatch: \${JSON.stringify(apiMethods)}\`);
  }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "wcash-native-attestation-"));
  try {
    if (native.set_wallet_base_dir(base) !== true) {
      throw new Error("native wallet base directory was not accepted");
    }
    const status = JSON.parse(await native.wcash_status());
    for (const [name, expected] of Object.entries(expectedStatus)) {
      if (status[name] !== expected) {
        throw new Error(\`native status \${name} mismatch: \${JSON.stringify(status[name])}\`);
      }
    }
    const attestation = {
      schemaVersion: 1,
      marker: "wcash-native-local-regtest-qa",
      platform,
      apiMethods,
      status: Object.fromEntries(Object.keys(expectedStatus).map((name) => [name, status[name]])),
    };
    process.stdout.write(\`WCASH_NATIVE_ATTESTATION=\${JSON.stringify(attestation)}\\n\`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
`;
}

function probePackagedNative(executable, nativeBinding, platform) {
  assert(fs.existsSync(executable), `packaged Electron executable is missing: ${executable}`);
  assertRegtestNative(nativeBinding);
  const probe = spawnSync(
    executable,
    [
      "-e",
      nativeProbeSource(),
      nativeBinding,
      platform,
      JSON.stringify(expectedNativeMethods(platform)),
      JSON.stringify(EXPECTED_NATIVE_STATUS),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    },
  );
  const detail = (probe.stderr || probe.stdout || probe.error?.message || "no diagnostic output").trim();
  assert(probe.status === 0, `packaged native binding cannot load or attest its Wcash profile: ${detail}`);
  const markerLine = probe.stdout.split(/\r?\n/).find((line) => line.startsWith("WCASH_NATIVE_ATTESTATION="));
  assert(markerLine, "packaged native runtime did not emit an attestation");
  let attestation;
  try {
    attestation = JSON.parse(markerLine.slice("WCASH_NATIVE_ATTESTATION=".length));
  } catch (error) {
    throw new Error(`Cross-platform Local Regtest QA verification failed: invalid native attestation JSON: ${error}`);
  }
  validateNativeAttestation(attestation, platform);
  return attestation;
}

function writeNativeAttestation(outputPath, attestation) {
  validateNativeAttestation(attestation, attestation.platform);
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(attestation, null, 2)}\n`, { mode: 0o644 });
  return absolute;
}

function verifyMetadata(archive) {
  assert(fs.existsSync(archive), "app.asar is missing");
  const packagedMetadata = JSON.parse(asar.extractFile(archive, "package.json").toString());
  assert(
    packagedMetadata.name === "wcash-wallet-local-regtest-qa",
    "package name is not dedicated to Local Regtest QA",
  );
  assert(packagedMetadata.productName === EXPECTED_PRODUCT, "packaged product name is not exact");
  assert(packagedMetadata.wcashPackagedProfile === EXPECTED_MARKER, "immutable Local Regtest QA marker is missing");
  assert(packagedMetadata.main === "build/electron.js", "packaged entry point is unexpected");
  const packagedBuild = JSON.stringify(packagedMetadata.build || {});
  assert(
    !/(?:co\.zingo\.pc|Juan\s*Carlos|zingo-pc-signing|ZingoPC|Zingo-PC|nym-proxy)/i.test(packagedBuild),
    "packaged source metadata contains inherited platform or signing identity",
  );
  assert(
    packagedMetadata.build?.mas === undefined && packagedMetadata.build?.appx === undefined,
    "packaged source metadata contains a store package configuration",
  );
  assert(
    packagedMetadata.author?.name === "Wcash Wallet contributors" &&
      packagedMetadata.author?.url === "https://github.com/w-cash/wallet-desktop" &&
      packagedMetadata.author?.email === undefined,
    "packaged author metadata is inherited",
  );
}

function verifyPackagedApplication(context) {
  const platform = context.electronPlatformName;
  assert(platform === "linux" || platform === "win32", "this verifier only accepts Linux or Windows candidates");

  const config = context.packager.config;
  const platformConfig = context.packager.platformSpecificBuildOptions;
  const output = String(config.directories?.output || "");
  const expectedArch = output.includes("arm64") ? "arm64" : "x64";
  const resources = path.join(context.appOutDir, "resources");
  const archive = path.join(resources, "app.asar");
  const nativeBinding = path.join(resources, "app.asar.unpacked", "build", "native.node");
  const keytarBinding = path.join(
    resources,
    "app.asar.unpacked",
    "node_modules",
    "keytar",
    "build",
    "Release",
    "keytar.node",
  );

  assert(context.packager.appInfo.id === EXPECTED_APP_ID, "application ID is not dedicated to Local Regtest QA");
  assert(context.packager.appInfo.productName === EXPECTED_PRODUCT, "visible product name is not Wcash Wallet");
  assert(config.forceCodeSigning === false, "code signing was forced");
  assert(config.afterSign === undefined, "a signing hook was loaded");
  assert(config.afterAllArtifactBuild === undefined, "a publishing hook was loaded");
  assert(config.publish === undefined, "a publishing provider was loaded");
  assert(platformConfig.protocols === undefined, "the local candidate registers a payment protocol");
  assert(config.mas === undefined && config.appx === undefined, "a store package identity was loaded");
  assert(config.artifactName.includes("LOCAL-REGTEST-QA"), "artifact name lacks the Local Regtest warning");
  assert(config.artifactName.includes("UNSIGNED"), "artifact name lacks the unsigned warning");
  assert(
    !/(?:zingo|zcash|nym|azure|provision)/i.test(JSON.stringify(config)),
    "config contains inherited platform wiring",
  );

  assert(fs.existsSync(keytarBinding) && fs.statSync(keytarBinding).size > 0, "credential-store binding is missing");
  verifyMetadata(archive);

  const license = path.join(resources, "LICENSE");
  const notices = path.join(resources, "THIRD_PARTY_NOTICES.md");
  assert(
    fs.existsSync(license) && fs.readFileSync(license, "utf8").includes("ZingoLabs"),
    "upstream MIT attribution is missing",
  );
  assert(
    fs.existsSync(notices) && fs.readFileSync(notices, "utf8").includes("zingo-pc-2.0.25-180"),
    "upstream source attribution is missing",
  );
  assert(
    !walkNames(resources).some((name) => FORBIDDEN_STAGED_NAME.test(name)),
    "an inherited network, identity, or signing resource was staged",
  );

  if (platform === "linux") {
    assert(expectedArch === "x64", "the Linux candidate must be x64");
    const executable = path.join(context.appOutDir, "wcash-wallet");
    assert(fs.existsSync(executable), "Wcash Linux executable is missing");
    assert(elfArch(executable) === expectedArch, "Linux executable architecture is wrong");
    assert(elfArch(nativeBinding) === expectedArch, "Linux native binding architecture is wrong");
    assert(elfArch(keytarBinding) === expectedArch, "Linux credential-store binding architecture is wrong");
    const policy = path.join(resources, "com.wcashwallet.wallet.policy");
    const appArmor = path.join(resources, "apparmor-wcash-wallet");
    assert(
      fs.existsSync(policy) && fs.readFileSync(policy, "utf8").includes("com.wcashwallet.wallet.authenticate"),
      "Wcash polkit action is missing",
    );
    assert(
      fs.existsSync(appArmor) && fs.readFileSync(appArmor, "utf8").includes("/opt/Wcash Wallet/wcash-wallet"),
      "Wcash AppArmor install path is missing",
    );
  } else {
    assert(platformConfig.signAndEditExecutable === false, "Windows executable signing is enabled");
    assert(platformConfig.azureSignOptions === undefined, "inherited Azure signing is configured");
    assert(platformConfig.certificateSubjectName === undefined, "a Windows certificate owner is configured");
    assert(platformConfig.certificateSha1 === undefined, "a Windows certificate thumbprint is configured");
    const executable = path.join(context.appOutDir, "wcash-wallet.exe");
    assert(fs.existsSync(executable), "Wcash Windows executable is missing");
    assert(peArch(executable) === expectedArch, "Windows executable architecture is wrong");
    assert(peArch(nativeBinding) === expectedArch, "Windows native binding architecture is wrong");
    assert(peArch(keytarBinding) === expectedArch, "Windows credential-store binding architecture is wrong");
    const runtime = path.join(context.appOutDir, "vcruntime140.dll");
    assert(fs.existsSync(runtime) && peArch(runtime) === expectedArch, "matching Visual C++ runtime is missing");
  }

  const executable = path.join(context.appOutDir, platform === "linux" ? "wcash-wallet" : "wcash-wallet.exe");
  const attestation = probePackagedNative(executable, nativeBinding, platform);
  const attestationPath = writeNativeAttestation(
    path.join(String(config.directories.output), NATIVE_ATTESTATION_FILENAME),
    attestation,
  );
  const dependencyProbe = spawnSync(
    executable,
    [
      "-e",
      'const Module=require("module");const load=Module._load;Module._load=function(request){if(request==="electron")return{app:{getPath:()=>process.env.TEMP||"/tmp"}};return load.apply(this,arguments)};for(const candidate of process.argv.slice(1))require(candidate);',
      path.join(archive, "node_modules", "electron-settings"),
      path.join(archive, "node_modules", "electron-json-storage"),
    ],
    { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
  );
  assert(
    dependencyProbe.status === 0,
    `packaged settings/storage dependencies cannot load: ${(dependencyProbe.stderr || dependencyProbe.stdout).trim()}`,
  );

  console.log(
    `Verified unsigned ${platform} ${expectedArch} Wcash Wallet Local Regtest QA staging at ${context.appOutDir}; ` +
      `native profile ${attestation.status.profile} (${attestation.status.branch_id}) loaded`,
  );
  console.log(`Wrote native runtime attestation to ${attestationPath}`);
}

module.exports = async (context) => verifyPackagedApplication(context);
module.exports.verifyPackagedApplication = verifyPackagedApplication;
module.exports.assertRegtestNative = assertRegtestNative;
module.exports.elfArch = elfArch;
module.exports.expectedNativeMethods = expectedNativeMethods;
module.exports.validateNativeAttestation = validateNativeAttestation;
module.exports.probePackagedNative = probePackagedNative;
module.exports.writeNativeAttestation = writeNativeAttestation;
module.exports.NATIVE_ATTESTATION_FILENAME = NATIVE_ATTESTATION_FILENAME;

if (require.main === module) {
  const [command, platform, executable, nativeBinding, outputPath] = process.argv.slice(2);
  if (
    command !== "probe-native" ||
    !platform ||
    !executable ||
    !nativeBinding ||
    process.argv.length < 6 ||
    process.argv.length > 7
  ) {
    console.error(
      "Usage: node scripts/verify-wcash-cross-platform-candidate-after-pack.js " +
        "probe-native <darwin|linux|win32> <electron-executable> <native-binding> [attestation-output]",
    );
    process.exit(2);
  }
  const attestation = probePackagedNative(path.resolve(executable), path.resolve(nativeBinding), platform);
  if (outputPath) writeNativeAttestation(outputPath, attestation);
  console.log(
    `Verified packaged ${platform} Wcash native API and ${attestation.status.network} runtime profile ` +
      `${attestation.status.branch_id}`,
  );
}
