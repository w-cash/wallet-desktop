"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const asar = require("@electron/asar");
const plist = require("plist");
const {
  LOCAL_REGTEST_QA_PACKAGED_PROFILE,
  LOCAL_REGTEST_RUNTIME_PROFILE,
  TESTNET_RUNTIME_PROFILE,
} = require("../public/wcashRuntimeProfile");

const reviewedRuntime = require("../config/wcash-runtime.json");
const canonicalProjectUrl = "https://github.com/w-cash/wallet-desktop";
const forbiddenResource = /(?:nym-proxy|zingo-pc-uri|co\.zingo\.pc\.policy|apparmor-zingo)/i;

function assert(condition, message) {
  if (!condition) throw new Error("Local Regtest QA package verification failed: " + message);
}

function architectures(file) {
  const result = spawnSync("/usr/bin/lipo", ["-archs", file], { encoding: "utf8" });
  assert(result.status === 0, "lipo could not inspect " + path.basename(file));
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}

function verifyPackagedApplication(context) {
  assert(context.electronPlatformName === "darwin", "the package target is not macOS");

  const config = context.packager.config;
  const platformConfig = context.packager.platformSpecificBuildOptions;
  const productFilename = context.packager.appInfo.productFilename;
  const appBundle = path.join(context.appOutDir, productFilename + ".app");
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

  assert(context.packager.appInfo.id === LOCAL_REGTEST_RUNTIME_PROFILE.appId, "bundle identifier is not Local Regtest");
  assert(
    context.packager.appInfo.productName === LOCAL_REGTEST_RUNTIME_PROFILE.productName,
    "product name is not Local Regtest",
  );
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
  const nativeBytes = fs.readFileSync(nativeBinding);
  const containsNativeText = (value) => nativeBytes.indexOf(Buffer.from(value, "utf8")) !== -1;
  assert(containsNativeText("http://127.0.0.1:48234"), "native wallet was not compiled for the loopback endpoint");
  assert(containsNativeText("wcashregtest-v5"), "native wallet was not compiled for the Regtest namespace");
  assert(
    !containsNativeText("https://wallet-testnet.wcashexplorer.com:443"),
    "native wallet contains the compiled Testnet endpoint",
  );
  assert(!containsNativeText("wcashtestnet-v5"), "native wallet contains the compiled Testnet namespace");

  const topLevelResources = fs.readdirSync(resources);
  assert(!topLevelResources.some((name) => forbiddenResource.test(name)), "an inherited network helper was packaged");
  assert(!asar.listPackage(archive).some((name) => forbiddenResource.test(name)), "app.asar contains a network helper");

  const packagedMetadata = JSON.parse(asar.extractFile(archive, "package.json").toString());
  assert(packagedMetadata.name === "wcash-warden-local-regtest-qa", "package name is not dedicated to Regtest QA");
  assert(
    packagedMetadata.productName === LOCAL_REGTEST_RUNTIME_PROFILE.productName,
    "packaged product name changed the existing Local Regtest identity",
  );
  assert(
    packagedMetadata.wcashPackagedProfile === LOCAL_REGTEST_QA_PACKAGED_PROFILE,
    "the immutable Local Regtest QA profile marker is missing",
  );
  assert(packagedMetadata.main === "build/electron.js", "packaged entry point is unexpected");
  assert(packagedMetadata.homepage === canonicalProjectUrl, "packaged project URL is not canonical");

  const packagedReviewedRuntime = JSON.parse(asar.extractFile(archive, "config/wcash-runtime.json").toString());
  assert(packagedReviewedRuntime.appId === TESTNET_RUNTIME_PROFILE.appId, "ordinary reviewed runtime identity changed");
  assert(packagedReviewedRuntime.network === TESTNET_RUNTIME_PROFILE.network, "reviewed runtime is not Testnet");
  assert(packagedReviewedRuntime.releaseReady === false, "public release readiness was enabled");
  assert(
    packagedReviewedRuntime.coreRevision === reviewedRuntime.coreRevision,
    "packaged reviewed core revision is unexpected",
  );

  const packagedMain = asar.extractFile(archive, "build/electron.js").toString();
  const packagedPreload = asar.extractFile(archive, "build/preload.js").toString();
  assert(packagedMain.includes("WCASH_PACKAGE_METADATA.wcashPackagedProfile"), "main ignores the packaged QA marker");
  assert(packagedMain.includes("WCASH_RUNTIME.localnet && !app.isPackaged"), "packaged data path is ambiently mutable");
  assert(packagedPreload.includes('endpoint: "http://127.0.0.1:48234"'), "preload endpoint is not loopback-only");

  const info = plist.parse(fs.readFileSync(path.join(contents, "Info.plist"), "utf8"));
  assert(info.CFBundleIdentifier === LOCAL_REGTEST_RUNTIME_PROFILE.appId, "Info.plist bundle identifier is wrong");
  assert(info.CFBundleName === LOCAL_REGTEST_RUNTIME_PROFILE.productName, "Info.plist bundle name is wrong");
  assert(info.CFBundleURLTypes === undefined, "Info.plist registers an inherited URI protocol");

  console.log("Verified unsigned macOS arm64 Local Regtest QA package at " + context.appOutDir);
}

module.exports = async (context) => verifyPackagedApplication(context);
module.exports.verifyPackagedApplication = verifyPackagedApplication;
