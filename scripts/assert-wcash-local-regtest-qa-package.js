"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
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
  console.error(`Wcash Wallet Local Regtest QA package is blocked: ${message}`);
  process.exit(1);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

if (!policyOnly && (process.platform !== "darwin" || process.arch !== "arm64")) {
  fail("this package can only be built on macOS arm64");
}

const packageJson = readJson("package.json");
const qaConfig = readJson("config/electron-builder.local-regtest-qa.json");
const qaSerialized = JSON.stringify(qaConfig);
const nativeManifest = read("native/Cargo.toml");
const main = read("public/electron.js");
const local = publicRuntimeConfig(
  selectWcashRuntimeProfile({
    isPackaged: true,
    localnetRequested: false,
    packagedProfile: LOCAL_REGTEST_QA_PACKAGED_PROFILE,
  }),
);

requireCondition(local.profile === "local-regtest", "the packaged marker did not select Regtest");
requireCondition(local.productName === "Wcash Wallet", "the visible product name is not exact");
requireCondition(local.network === "Wcash Regtest", "the selected consensus network is not Regtest");
requireCondition(local.ticker === "TWC", "the Regtest ticker is unexpected");
requireCondition(local.endpoint === "http://127.0.0.1:48234", "the endpoint is not fixed loopback port 48234");
requireCondition(new URL(local.endpoint).hostname === "127.0.0.1", "the endpoint can leave the local machine");
requireCondition(local.storageNamespace === "wcashregtest-v5", "the Regtest wallet namespace is unexpected");
requireCondition(local.branchId === "c3a6678a", "the Regtest transaction branch is unexpected");
requireCondition(
  LOCAL_REGTEST_RUNTIME_PROFILE.appId !== TESTNET_RUNTIME_PROFILE.appId &&
    LOCAL_REGTEST_RUNTIME_PROFILE.storageNamespace !== TESTNET_RUNTIME_PROFILE.storageNamespace &&
    LOCAL_REGTEST_RUNTIME_PROFILE.keytarService !== TESTNET_RUNTIME_PROFILE.keytarService &&
    LOCAL_REGTEST_RUNTIME_PROFILE.keytarAccount !== TESTNET_RUNTIME_PROFILE.keytarAccount,
  "the Regtest wallet or credential identity overlaps Testnet",
);

requireCondition(qaConfig.extends === undefined, "the QA config must not inherit release metadata");
requireCondition(qaConfig.appId === "com.wcashwallet.wallet.local-regtest-qa", "the QA bundle identifier is wrong");
requireCondition(qaConfig.productName === "Wcash Wallet", "the QA product name is wrong");
requireCondition(qaConfig.forceCodeSigning === false, "code signing must remain disabled");
requireCondition(qaConfig.npmRebuild === false, "native rebuilding must stay in the explicit build step");
requireCondition(qaConfig.afterSign === undefined, "the QA package must not run a signing hook");
requireCondition(qaConfig.afterAllArtifactBuild === undefined, "the QA package must not run a release hook");
requireCondition(qaConfig.mas === undefined && qaConfig.win === undefined && qaConfig.linux === undefined, "the QA config must be macOS-only");
requireCondition(qaConfig.mac?.identity === null, "the macOS signing identity must be explicitly null");
requireCondition(
  Array.isArray(qaConfig.mac?.target) && qaConfig.mac.target.length === 1 && qaConfig.mac.target[0] === "zip",
  "the QA config must produce only a ZIP",
);
requireCondition(
  qaConfig.extraMetadata?.name === "wcash-wallet-local-regtest-qa" &&
    qaConfig.extraMetadata?.productName === "Wcash Wallet" &&
    qaConfig.extraMetadata?.wcashPackagedProfile === LOCAL_REGTEST_QA_PACKAGED_PROFILE,
  "the packaged profile marker or product identity is missing",
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
requireCondition(!/(?:zingo|zcash|nym)/i.test(qaSerialized), "the QA config contains inherited network/product wiring");
requireCondition(!qaSerialized.includes("protocols"), "the QA package must not register a URI protocol");

const nativeCommand = packageJson.scripts["neon:wcash-regtest:mac-arm64"];
for (const required of [
  "--target aarch64-apple-darwin",
  "--locked",
  "--release",
  "--no-default-features",
  "--features wcash-regtest",
]) {
  requireCondition(typeof nativeCommand === "string" && nativeCommand.includes(required), `native build is missing ${required}`);
}
const packageCommand = packageJson.scripts["package:local-regtest-qa:mac-arm64"];
for (const required of [
  "node scripts/assert-wcash-local-regtest-qa-package.js",
  "rimraf dist/local-regtest-qa",
  "yarn build:local-regtest-qa:mac-arm64",
  "CSC_IDENTITY_AUTO_DISCOVERY=false",
  "config/electron-builder.local-regtest-qa.json",
  "--mac zip --arm64",
  "--publish never",
]) {
  requireCondition(typeof packageCommand === "string" && packageCommand.includes(required), `package command is missing ${required}`);
}
requireCondition(
  nativeManifest.includes('default = ["wcash-testnet"]') &&
    nativeManifest.includes('wcash-regtest = ["dep:zingolib", "zingolib/regtest"]'),
  "native feature isolation changed",
);
requireCondition(
  main.includes('intent: wcashProfile.runtimeReady ? "off" : "on"') &&
    main.includes('phase: wcashProfile.runtimeReady ? "switched_off" : "unattached"'),
  "a Wcash build can start inherited Nym transport",
);

const parity = spawnSync(process.execPath, [path.join(root, "scripts", "assert-upstream-ui-parity.js")], {
  cwd: root,
  encoding: "utf8",
});
requireCondition(parity.status === 0, (parity.stderr || parity.stdout || "upstream UI parity failed").trim());

console.log("Wcash Wallet unsigned macOS arm64 Local Regtest QA package policy passed.");
