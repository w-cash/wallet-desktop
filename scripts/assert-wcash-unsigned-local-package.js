"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const readJson = (relativePath) => JSON.parse(read(relativePath));

function assert(condition, message) {
  if (!condition) {
    console.error("Unsigned local package is blocked: " + message);
    process.exit(1);
  }
}

function resourceSources(platform) {
  return (platform.extraResources || []).map((entry) => (typeof entry === "string" ? entry : entry.from));
}

const packageJson = readJson("package.json");
const runtime = readJson("config/wcash-runtime.json");
const localConfig = readJson("config/electron-builder.unsigned-local.json");
const serializedLocalConfig = JSON.stringify(localConfig);
const platforms = [packageJson.build.mac, packageJson.build.win, packageJson.build.linux];
const localScripts = Object.entries(packageJson.scripts).filter(([name]) => name.startsWith("package:unsigned-local:"));

assert(
  packageJson.author && packageJson.author.name === "Wcash" && packageJson.author.email === "placex.com@gmail.com",
  "Linux package maintainer metadata is incomplete",
);
assert(runtime.runtimeReady === true, "the reviewed Wcash runtime is not enabled");
assert(runtime.releaseReady === false, "this target must never enable public release readiness");
assert(packageJson.build.mas === undefined, "an inherited Mac App Store identity remains configured");
assert(packageJson.build.appx === undefined, "an inherited Microsoft Store identity remains configured");
assert(packageJson.build.afterSign === undefined, "an inherited signing hook remains configured");
assert(packageJson.build.afterAllArtifactBuild === undefined, "an inherited release hook remains configured");
assert(packageJson.build.win.azureSignOptions === undefined, "an inherited Windows signer remains configured");
assert(packageJson.build.win.signExts === undefined, "an inherited Windows signing extension list remains configured");
assert(localConfig.extends === undefined, "the local config must not inherit release packaging metadata");
assert(localConfig.appId === runtime.appId, "appId must match the isolated Wcash Testnet runtime");
assert(localConfig.productName === runtime.productName, "productName must match the Wcash Testnet runtime");
assert(localConfig.forceCodeSigning === false, "forceCodeSigning must remain disabled");
assert(localConfig.npmRebuild === false, "native dependency rebuilding must stay in the explicit build step");
assert(
  localConfig.extraMetadata && localConfig.extraMetadata.homepage === "https://github.com/w-cash/wallet-desktop",
  "package metadata must use the canonical Wcash desktop project URL",
);
assert(
  packageJson.build.extraMetadata &&
    packageJson.build.extraMetadata.homepage === "https://github.com/w-cash/wallet-desktop",
  "release package metadata must use the canonical Wcash desktop project URL",
);
assert(localConfig.mac && localConfig.mac.identity === null, "macOS signing identity must be explicitly null");
assert(
  localConfig.win && localConfig.win.signAndEditExecutable === false,
  "Windows signing and executable editing must be explicitly disabled",
);
assert(
  localConfig.mas === undefined && localConfig.appx === undefined,
  "local packages must not inherit store identities",
);
assert(localConfig.afterSign === undefined, "local packages must not run inherited signing hooks");
assert(localConfig.afterAllArtifactBuild === undefined, "local packages must not run inherited release hooks");
assert(
  localConfig.afterPack === "./scripts/verify-wcash-unsigned-local-after-pack.js",
  "local packages must verify their staged application before archiving",
);
assert(!/(?:zingo|zcash|nym)/i.test(serializedLocalConfig), "local config contains an inherited product identity");
assert(!serializedLocalConfig.includes("protocols"), "local config must not register a URI protocol");
assert(serializedLocalConfig.includes("UNSIGNED-LOCAL"), "artifact names must visibly identify unsigned local builds");

assert(localScripts.length === 5, "all five desktop architecture targets must have explicit local package commands");
for (const [name, command] of localScripts) {
  assert(command.startsWith("node scripts/assert-wcash-unsigned-local-package.js"), name + " skips the package guard");
  assert(command.includes("CSC_IDENTITY_AUTO_DISCOVERY=false"), name + " permits certificate auto-discovery");
  assert(command.includes("config/electron-builder.unsigned-local.json"), name + " does not use the isolated config");
  assert(
    command.includes("node scripts/stage-keytar-native.js"),
    name + " does not stage the credential-store binding",
  );
  assert(command.includes("--publish never"), name + " could publish an unsigned artifact");
  assert(!command.includes("assert-wcash-release-ready.js"), name + " is coupled to public release packaging");
}

for (const platform of platforms) {
  assert(platform && platform.protocols === undefined, "a Wcash platform package still registers a URI protocol");
  assert(
    !resourceSources(platform).some((source) => /nym-proxy|zingo-pc-uri/i.test(source)),
    "a Wcash platform package still bundles an inherited network helper",
  );
}
assert(packageJson.build.linux.mimeTypes === undefined, "Linux still registers an inherited URI MIME type");
assert(
  packageJson.build.linux.executableName === "wcash-warden-testnet",
  "Linux executable name is not isolated from the upstream package",
);

const requiredLinuxFiles = [
  "resources/linux/com.wcashwallet.warden.testnet.policy",
  "resources/linux/apparmor/wcash-warden-testnet",
  "scripts/postinstall.sh",
  "scripts/postremove.sh",
];
for (const relativePath of requiredLinuxFiles) {
  assert(fs.existsSync(path.join(root, relativePath)), relativePath + " is missing");
  assert(!/(?:zingo|co\.zingo)/i.test(read(relativePath)), relativePath + " can touch the upstream installation");
}
for (const relativePath of [
  "resources/linux/co.zingo.pc.policy",
  "resources/linux/zingo-pc-uri.sh",
  "resources/linux/apparmor/zingo-pc",
]) {
  assert(!fs.existsSync(path.join(root, relativePath)), relativePath + " must not remain in the Wcash package tree");
}

for (const relativePath of [
  "afterMasSign.js",
  "afterSignHook.js",
  "configs/entitlements.mas.plist",
  "configs/entitlements.mas.inherit.plist",
  "scripts/sign-nym-proxy.ps1",
  "scripts/stage-nym-proxy.js",
]) {
  assert(!fs.existsSync(path.join(root, relativePath)), relativePath + " carries an inherited release identity");
}

const iconSource = read("resources/wcash-mark.svg");
assert(iconSource.includes("#7CFF6B") && iconSource.includes("#08210D"), "the canonical Wcash mark is missing");
assert(!/(?:zingo|zcash)/i.test(iconSource), "the canonical icon contains an inherited product identity");
assert(
  fs
    .readFileSync(path.join(root, "resources/icon.png"))
    .equals(fs.readFileSync(path.join(root, "resources/icons/512x512.png"))),
  "Linux and canonical Wcash icons have diverged",
);
assert(
  read("resources/linux/com.wcashwallet.warden.testnet.policy").includes(
    '<action id="com.wcashwallet.warden.testnet.authenticate">',
  ),
  "polkit action does not match the runtime authentication request",
);

const mainProcess = read("public/electron.js");
for (const registrationMechanism of [
  "setAsDefaultProtocolClient",
  'app.on("open-url"',
  "ZINGO_PC_URI",
  "pendingZcashUri",
  "handleZcashUri",
]) {
  assert(!mainProcess.includes(registrationMechanism), "main process still contains " + registrationMechanism);
}

console.log("Unsigned local Wcash Testnet package identity is isolated and public release remains blocked.");
