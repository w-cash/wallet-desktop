"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const asar = require("@electron/asar");
const { peArch } = require("./pe-arch");

const EXPECTED_APP_ID = "com.wcashwallet.wallet.local-regtest-qa";
const EXPECTED_PRODUCT = "Wcash Wallet";
const EXPECTED_MARKER = "local-regtest-qa";
const FORBIDDEN_STAGED_NAME = /(?:zingo|zcash|nym|azure|provision)/i;

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

  assertRegtestNative(nativeBinding);
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
    `Verified unsigned ${platform} ${expectedArch} Wcash Wallet Local Regtest QA staging at ${context.appOutDir}`,
  );
}

module.exports = async (context) => verifyPackagedApplication(context);
module.exports.verifyPackagedApplication = verifyPackagedApplication;
module.exports.assertRegtestNative = assertRegtestNative;
module.exports.elfArch = elfArch;
