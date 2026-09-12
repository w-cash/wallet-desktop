"use strict";

const fs = require("fs");
const path = require("path");
const asar = require("@electron/asar");
const plist = require("plist");

const runtime = require("../config/wcash-runtime.json");
const forbiddenResource = /(?:nym-proxy|zingo-pc-uri|co\.zingo\.pc\.policy|apparmor-zingo)/i;
const canonicalProjectUrl = "https://github.com/w-cash/wallet-desktop";

function assert(condition, message) {
  if (!condition) throw new Error("Unsigned local package verification failed: " + message);
}

function resourceDirectory(context) {
  if (context.electronPlatformName === "darwin") {
    return path.join(context.appOutDir, context.packager.appInfo.productFilename + ".app", "Contents", "Resources");
  }
  return path.join(context.appOutDir, "resources");
}

function verifyPackagedApplication(context) {
  const config = context.packager.config;
  const platformConfig = context.packager.platformSpecificBuildOptions;
  const resources = resourceDirectory(context);
  const archive = path.join(resources, "app.asar");
  const keytarBinding = path.join(
    resources,
    "app.asar.unpacked",
    "node_modules",
    "keytar",
    "build",
    "Release",
    "keytar.node",
  );

  assert(context.packager.appInfo.id === runtime.appId, "bundle identifier does not match Wcash Testnet");
  assert(context.packager.appInfo.productName === runtime.productName, "product name does not match Wcash Testnet");
  assert(config.forceCodeSigning === false, "code signing was forced");
  assert(config.afterSign === undefined, "an inherited signing hook was loaded");
  assert(config.afterAllArtifactBuild === undefined, "an inherited release hook was loaded");
  assert(platformConfig.protocols === undefined, "an inherited URI protocol was loaded");
  assert(fs.existsSync(archive), "app.asar is missing");
  assert(fs.existsSync(keytarBinding), "credential-store native binding is missing");
  assert(fs.statSync(keytarBinding).size > 0, "credential-store native binding is empty");

  const topLevelResources = fs.readdirSync(resources);
  assert(!topLevelResources.some((name) => forbiddenResource.test(name)), "an inherited network helper was packaged");

  const packagedMetadata = JSON.parse(asar.extractFile(archive, "package.json").toString());
  assert(packagedMetadata.name === "wcash-warden-testnet", "packaged application name is not Wcash");
  assert(packagedMetadata.productName === runtime.productName, "packaged product name is not Wcash");
  assert(packagedMetadata.main === "build/electron.js", "packaged entry point is unexpected");
  assert(packagedMetadata.homepage === canonicalProjectUrl, "packaged project URL is not canonical");
  assert(
    !asar.listPackage(archive).some((name) => forbiddenResource.test(name)),
    "app.asar contains an inherited network helper",
  );

  if (context.electronPlatformName === "darwin") {
    const contents = path.dirname(resources);
    const info = plist.parse(fs.readFileSync(path.join(contents, "Info.plist"), "utf8"));
    assert(info.CFBundleIdentifier === runtime.appId, "Info.plist bundle identifier is not Wcash");
    assert(info.CFBundleName === runtime.productName, "Info.plist bundle name is not Wcash");
    assert(info.CFBundleURLTypes === undefined, "Info.plist registers an inherited URI protocol");
  }

  console.log("Verified unsigned local " + context.electronPlatformName + " package identity at " + context.appOutDir);
}

module.exports = async (context) => verifyPackagedApplication(context);
module.exports.verifyPackagedApplication = verifyPackagedApplication;
