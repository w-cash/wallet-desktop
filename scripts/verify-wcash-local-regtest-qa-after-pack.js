"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const asar = require("@electron/asar");
const plist = require("plist");

const EXPECTED_APP_ID = "com.wcashwallet.wallet.local-regtest-qa";
const EXPECTED_PRODUCT = "Wcash Wallet";
const EXPECTED_MARKER = "local-regtest-qa";
const forbiddenResource = /(?:nym-proxy|zingo-pc-uri|co\.zingo\.pc\.policy|apparmor-zingo)/i;

function assert(condition, message) {
  if (!condition) throw new Error(`Local Regtest QA package verification failed: ${message}`);
}

function architectures(file) {
  const result = spawnSync("/usr/bin/lipo", ["-archs", file], { encoding: "utf8" });
  assert(result.status === 0, `lipo could not inspect ${path.basename(file)}`);
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}

function verifyPackagedApplication(context) {
  assert(context.electronPlatformName === "darwin", "the package target is not macOS");

  const config = context.packager.config;
  const platformConfig = context.packager.platformSpecificBuildOptions;
  const productFilename = context.packager.appInfo.productFilename;
  const appBundle = path.join(context.appOutDir, `${productFilename}.app`);
  const contents = path.join(appBundle, "Contents");
  const resources = path.join(contents, "Resources");
  const archive = path.join(resources, "app.asar");
  const executable = path.join(contents, "MacOS", productFilename);
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

  assert(context.packager.appInfo.id === EXPECTED_APP_ID, "bundle identifier is not dedicated to Local Regtest QA");
  assert(context.packager.appInfo.productName === EXPECTED_PRODUCT, "visible product name is not Wcash Wallet");
  assert(config.forceCodeSigning === false, "code signing was forced");
  assert(platformConfig.identity === null, "the signing identity is not explicitly null");
  assert(config.afterSign === undefined, "an inherited signing hook was loaded");
  assert(config.afterAllArtifactBuild === undefined, "an inherited release hook was loaded");
  assert(platformConfig.protocols === undefined, "an inherited URI protocol was loaded");
  assert(config.artifactName.includes("LOCAL-REGTEST-QA"), "artifact name is not labeled LOCAL-REGTEST-QA");
  assert(config.artifactName.includes("UNSIGNED"), "artifact name is not labeled UNSIGNED");
  assert(fs.existsSync(archive), "app.asar is missing");
  assert(fs.existsSync(executable), "main executable is missing");
  assert(fs.existsSync(nativeBinding) && fs.statSync(nativeBinding).size > 0, "native wallet binding is missing");
  assert(fs.existsSync(keytarBinding) && fs.statSync(keytarBinding).size > 0, "Keychain binding is missing");
  assert(architectures(executable).join(" ") === "arm64", "main executable is not arm64-only");
  assert(architectures(nativeBinding).join(" ") === "arm64", "native wallet binding is not arm64-only");
  assert(architectures(keytarBinding).join(" ") === "arm64", "Keychain binding is not arm64-only");

  const nativeBytes = fs.readFileSync(nativeBinding);
  const containsNativeText = (value) => nativeBytes.indexOf(Buffer.from(value, "utf8")) !== -1;
  assert(containsNativeText("http://127.0.0.1:48234"), "native wallet was not compiled for the loopback endpoint");
  assert(containsNativeText("wcashregtest-v5"), "native wallet was not compiled for the Regtest namespace");
  assert(!containsNativeText("https://wallet-testnet.wcashexplorer.com:443"), "native wallet contains the Testnet endpoint");
  assert(!containsNativeText("wcashtestnet-v5"), "native wallet contains the Testnet namespace");

  assert(!fs.readdirSync(resources).some((name) => forbiddenResource.test(name)), "an inherited network helper was staged");
  assert(!asar.listPackage(archive).some((name) => forbiddenResource.test(name)), "app.asar contains an inherited network helper");

  const packagedMetadata = JSON.parse(asar.extractFile(archive, "package.json").toString());
  assert(packagedMetadata.name === "wcash-wallet-local-regtest-qa", "package name is not dedicated to Local Regtest QA");
  assert(packagedMetadata.productName === EXPECTED_PRODUCT, "packaged product name is not exact");
  assert(
    packagedMetadata.author?.name === "Wcash Wallet contributors" &&
      packagedMetadata.author?.url === "https://github.com/w-cash/wallet-desktop" &&
      packagedMetadata.author?.email === undefined,
    "packaged author metadata is inherited from upstream",
  );
  assert(packagedMetadata.wcashPackagedProfile === EXPECTED_MARKER, "the immutable Local Regtest QA marker is missing");
  assert(packagedMetadata.main === "build/electron.js", "packaged entry point is unexpected");

  // Exercise the actual ASAR dependency resolver with the packaged Electron
  // runtime. A shared/symlinked development node_modules can look complete to
  // the compiler while electron-builder silently omits hoisted transitives.
  const dependencyProbe = spawnSync(
    executable,
    [
      "-e",
      'const Module=require("module");const load=Module._load;Module._load=function(request){if(request==="electron")return{app:{getPath:()=>"/tmp"}};return load.apply(this,arguments)};for(const candidate of process.argv.slice(1))require(candidate);',
      path.join(archive, "node_modules", "electron-settings"),
      path.join(archive, "node_modules", "electron-json-storage"),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  assert(
    dependencyProbe.status === 0,
    `packaged settings/storage dependencies cannot load: ${(dependencyProbe.stderr || dependencyProbe.stdout).trim()}`,
  );

  const packagedProfile = asar.extractFile(archive, "build/wcashRuntimeProfile.js").toString();
  const packagedMain = asar.extractFile(archive, "build/electron.js").toString();
  assert(packagedProfile.includes('endpoint: "http://127.0.0.1:48234"'), "packaged profile is not loopback-only");
  assert(packagedProfile.includes('ironwoodPrefix: "w' + 'u' + 'regtest1"'), "packaged Wcash Regtest private prefix is missing");
  assert(packagedMain.includes("wcashPackagedProfile"), "main ignores the packaged QA marker");
  assert(packagedMain.includes("Wcash Wallet"), "main does not set the exact product name");
  assert(packagedMain.includes('phase: wcashProfile.runtimeReady ? "switched_off" : "unattached"'), "main can start inherited Nym transport");

  const info = plist.parse(fs.readFileSync(path.join(contents, "Info.plist"), "utf8"));
  assert(info.CFBundleIdentifier === EXPECTED_APP_ID, "Info.plist bundle identifier is wrong");
  assert(info.CFBundleName === EXPECTED_PRODUCT, "Info.plist bundle name is wrong");
  assert(
    info.NSHumanReadableCopyright === "Copyright © 2026 Wcash Wallet contributors",
    "Info.plist copyright is inherited from upstream",
  );
  assert(info.CFBundleURLTypes === undefined, "Info.plist registers an inherited URI protocol");

  // Apple Silicon Electron's executable arrives linker-signed ad hoc even
  // when electron-builder performs no application signing. Accept only that
  // certificate-free marker, and reject Developer ID, team, or authority data.
  const signature = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", appBundle], { encoding: "utf8" });
  const signatureText = `${signature.stdout || ""}\n${signature.stderr || ""}`;
  assert(signature.status === 0, "the Electron executable has no Apple Silicon linker signature");
  assert(/Signature=adhoc/.test(signatureText), "the executable is not ad hoc signed");
  assert(/TeamIdentifier=not set/.test(signatureText), "a signing team was attached");
  assert(!/^Authority=/m.test(signatureText), "a signing certificate authority was attached");

  console.log(`Verified unsigned macOS arm64 Wcash Wallet Local Regtest QA package at ${appBundle}`);
}

module.exports = async (context) => verifyPackagedApplication(context);
module.exports.verifyPackagedApplication = verifyPackagedApplication;
