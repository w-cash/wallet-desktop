"use strict";

const fs = require("fs");
const path = require("path");
const { nativeDependencyPinsMatch } = require("./wcash-native-pins");
const {
  LOCAL_REGTEST_QA_PACKAGED_PROFILE,
  LOCAL_REGTEST_RUNTIME_PROFILE,
  TESTNET_RUNTIME_PROFILE,
  publicRuntimeConfig,
  selectWcashRuntimeProfile,
} = require("../public/wcashRuntimeProfile");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const readJson = (relativePath) => JSON.parse(read(relativePath));
const policyOnly = process.argv.includes("--policy-only");

function fail(message) {
  console.error("Wcash Local Regtest QA package is blocked: " + message);
  process.exit(1);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

if (!policyOnly && (process.platform !== "darwin" || process.arch !== "arm64")) {
  fail("this package can only be built on macOS arm64");
}

const packageJson = readJson("package.json");
const testnetRuntime = readJson("config/wcash-runtime.json");
const qaConfig = readJson("config/electron-builder.local-regtest-qa.json");
const unsignedTestnetConfig = readJson("config/electron-builder.unsigned-local.json");
const qaSerialized = JSON.stringify(qaConfig);
const local = publicRuntimeConfig(
  selectWcashRuntimeProfile({
    isPackaged: true,
    localnetRequested: false,
    packagedProfile: LOCAL_REGTEST_QA_PACKAGED_PROFILE,
  }),
);

requireCondition(local.profile === "local-regtest", "the packaged marker did not select Regtest");
requireCondition(local.productName === "Wcash Warden Local Regtest", "the existing Local Regtest identity changed");
requireCondition(local.network === "Wcash Regtest", "the selected consensus network is not Regtest");
requireCondition(local.endpoint === "http://127.0.0.1:48234", "the endpoint is not fixed IPv4 loopback port 48234");
requireCondition(new URL(local.endpoint).hostname === "127.0.0.1", "the endpoint can leave the local machine");
requireCondition(local.storageNamespace === "wcashregtest-v5", "the Regtest wallet namespace is unexpected");
requireCondition(local.branchId === "c3a6678a", "the Regtest transaction branch is unexpected");
requireCondition(
  LOCAL_REGTEST_RUNTIME_PROFILE.appId === "com.wcashwallet.warden.local-regtest" &&
    LOCAL_REGTEST_RUNTIME_PROFILE.appId !== TESTNET_RUNTIME_PROFILE.appId &&
    LOCAL_REGTEST_RUNTIME_PROFILE.productName !== TESTNET_RUNTIME_PROFILE.productName &&
    LOCAL_REGTEST_RUNTIME_PROFILE.storageNamespace !== TESTNET_RUNTIME_PROFILE.storageNamespace &&
    LOCAL_REGTEST_RUNTIME_PROFILE.keytarService !== TESTNET_RUNTIME_PROFILE.keytarService &&
    LOCAL_REGTEST_RUNTIME_PROFILE.keytarAccount !== TESTNET_RUNTIME_PROFILE.keytarAccount,
  "the QA application, wallet, or credential identity overlaps Testnet",
);

requireCondition(testnetRuntime.appId === TESTNET_RUNTIME_PROFILE.appId, "the canonical runtime config is not Testnet");
requireCondition(testnetRuntime.network === TESTNET_RUNTIME_PROFILE.network, "the canonical network is not Testnet");
requireCondition(testnetRuntime.releaseReady === false, "public release readiness must remain disabled");
requireCondition(
  nativeDependencyPinsMatch({
    root,
    coreRevision: testnetRuntime.coreRevision,
    wolfRevision: "5b4e29980eb45e84ddab9024f530c923986d7e1e",
  }),
  "the native manifest or lockfile diverges from the reviewed wallet-core/Wolf revisions",
);

requireCondition(qaConfig.extends === undefined, "the QA config must not inherit release metadata");
requireCondition(qaConfig.appId === LOCAL_REGTEST_RUNTIME_PROFILE.appId, "the QA bundle identifier is wrong");
requireCondition(qaConfig.productName === local.productName, "the QA product name is wrong");
requireCondition(qaConfig.forceCodeSigning === false, "code signing must remain disabled");
requireCondition(qaConfig.npmRebuild === false, "native rebuilding must stay in the explicit build step");
requireCondition(qaConfig.afterSign === undefined, "the QA package must not run a signing hook");
requireCondition(qaConfig.afterAllArtifactBuild === undefined, "the QA package must not run a release hook");
requireCondition(
  qaConfig.mas === undefined && qaConfig.appx === undefined,
  "the QA package must not use a store target",
);
requireCondition(qaConfig.win === undefined && qaConfig.linux === undefined, "the QA config must be macOS-only");
requireCondition(qaConfig.mac?.identity === null, "the macOS signing identity must be explicitly null");
requireCondition(
  Array.isArray(qaConfig.mac?.target) && qaConfig.mac.target.length === 1 && qaConfig.mac.target[0] === "zip",
  "the QA config must produce only a ZIP",
);
requireCondition(
  qaConfig.extraMetadata?.name === "wcash-warden-local-regtest-qa" &&
    qaConfig.extraMetadata?.productName === local.productName &&
    qaConfig.extraMetadata?.wcashPackagedProfile === LOCAL_REGTEST_QA_PACKAGED_PROFILE,
  "the immutable packaged profile marker or package identity is missing",
);
requireCondition(
  qaConfig.afterPack === "./scripts/verify-wcash-local-regtest-qa-after-pack.js",
  "the staged application verification hook is missing",
);
requireCondition(qaConfig.directories?.output === "dist/local-regtest-qa", "the QA output directory is not isolated");
requireCondition(
  qaConfig.artifactName.includes("LOCAL-REGTEST-QA") && qaConfig.artifactName.includes("UNSIGNED"),
  "the artifact name does not visibly say LOCAL-REGTEST-QA and UNSIGNED",
);
requireCondition(!/(?:zingo|zcash|nym)/i.test(qaSerialized), "the QA config contains an inherited product identity");
requireCondition(!qaSerialized.includes("protocols"), "the QA package must not register a URI protocol");

const qaPackageCommand = packageJson.scripts["package:local-regtest-qa:mac-arm64"];
requireCondition(
  typeof qaPackageCommand === "string" &&
    qaPackageCommand.startsWith("node scripts/assert-wcash-local-regtest-qa-package.js"),
  "the package command skips this guard",
);
for (const required of [
  "rimraf dist/local-regtest-qa",
  "yarn build-mac-arm64-localnet",
  "node scripts/stage-keytar-native.js --platform darwin --arch arm64",
  "CSC_IDENTITY_AUTO_DISCOVERY=false",
  "config/electron-builder.local-regtest-qa.json",
  "--mac zip --arm64",
  "--publish never",
]) {
  requireCondition(qaPackageCommand.includes(required), "the package command is missing " + required);
}

const ordinaryScripts = Object.entries(packageJson.scripts).filter(([name]) =>
  /^(?:release:prep|build:runtime|build-(?:mac|win)(?!.*localnet)|dist:|package:unsigned-local:)/.test(name),
);
for (const [name, command] of ordinaryScripts) {
  requireCondition(!command.includes("wcash-regtest"), name + " compiles the Regtest feature");
  requireCondition(!command.includes("WCASH_LOCALNET_DEV"), name + " can select the developer local profile");
  requireCondition(!command.includes("electron-builder.local-regtest-qa.json"), name + " uses the QA package config");
}
requireCondition(
  packageJson.build.extraMetadata?.wcashPackagedProfile === undefined &&
    unsignedTestnetConfig.extraMetadata?.wcashPackagedProfile === undefined,
  "an ordinary package config can select the Local Regtest QA marker",
);

const main = read("public/electron.js");
const native = read("native/src/wcash.rs");
requireCondition(main.includes("WCASH_PACKAGE_METADATA.wcashPackagedProfile"), "main does not read the shipped marker");
requireCondition(
  main.includes("WCASH_RUNTIME.localnet && !app.isPackaged"),
  "packaged QA data can use an ambient path",
);
requireCondition(native.includes('const WCASH_ENDPOINT: &str = "http://127.0.0.1:48234";'), "native endpoint changed");
requireCondition(!native.includes("WCASH_LOCALNET_ENDPOINT"), "native endpoint became configurable");

console.log("Unsigned macOS arm64 Wcash Local Regtest QA package policy is isolated from ordinary Testnet builds.");
