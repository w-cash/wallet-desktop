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
const yarnLock = read("yarn.lock");
const qaConfig = readJson("config/electron-builder.local-regtest-qa.json");
const qaSerialized = JSON.stringify(qaConfig);
const nativeManifest = read("native/Cargo.toml");
const nativeLock = read("native/Cargo.lock");
const main = read("public/electron.js");
const preload = read("public/preload.js");
const sensitivePolicy = read("public/sensitiveNativePolicy.js");
const wcashAdapter = read("public/wcashZingoNativeAdapter.js");
const commonStyles = read("src/components/common/Common.module.css");
const scrollPane = read("src/components/scrollPane/ScrollPane.tsx");
const sendScreen = read("src/components/send/Send.tsx");
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
requireCondition(
  qaConfig.copyright === "Copyright © 2026 Wcash Wallet contributors",
  "the packaged application copyright is not attributed to Wcash Wallet contributors",
);
requireCondition(qaConfig.forceCodeSigning === false, "code signing must remain disabled");
requireCondition(qaConfig.npmRebuild === false, "native rebuilding must stay in the explicit build step");
requireCondition(qaConfig.afterSign === undefined, "the QA package must not run a signing hook");
requireCondition(qaConfig.afterAllArtifactBuild === undefined, "the QA package must not run a release hook");
requireCondition(
  qaConfig.mas === undefined && qaConfig.win === undefined && qaConfig.linux === undefined,
  "the QA config must be macOS-only",
);
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
requireCondition(
  Array.isArray(qaConfig.extraResources) &&
    qaConfig.extraResources.some((resource) => resource.from === "LICENSE") &&
    qaConfig.extraResources.some((resource) => resource.from === "THIRD_PARTY_NOTICES.md"),
  "upstream license or third-party notices are missing from the package",
);
requireCondition(
  packageJson.author?.name === "Wcash Wallet contributors" &&
    packageJson.author?.url === "https://github.com/w-cash/wallet-desktop" &&
    packageJson.author?.email === undefined,
  "the exposed application author metadata is inherited from upstream",
);
if (!policyOnly) {
  const modulesPath = path.join(root, "node_modules");
  requireCondition(
    fs.existsSync(modulesPath) && !fs.lstatSync(modulesPath).isSymbolicLink(),
    "node_modules must be installed in this worktree; a shared symlink produces an incomplete packaged dependency graph",
  );
}

const nativeCommand = packageJson.scripts["neon:wcash-regtest:mac-arm64"];
for (const required of [
  "--target aarch64-apple-darwin",
  "--locked",
  "--release",
  "--no-default-features",
  "--features wcash-regtest",
]) {
  requireCondition(
    typeof nativeCommand === "string" && nativeCommand.includes(required),
    `native build is missing ${required}`,
  );
}
const packageCommand = packageJson.scripts["package:local-regtest-qa:mac-arm64"];
const keytarCommand = packageJson.scripts["rebuild:keytar:local-regtest-qa:mac-arm64"];
requireCondition(
  keytarCommand === "electron-rebuild --version 40.10.0 --arch arm64 --force --only keytar" &&
    yarnLock.includes('electron@^40.0.0:\n  version "40.10.0"'),
  "the Keychain binding is not deterministically rebuilt for the packaged Electron arm64 ABI",
);
for (const required of [
  "yarn verify:wcash-candidate-policy",
  "node scripts/assert-wcash-local-regtest-qa-package.js",
  "rimraf dist/local-regtest-qa",
  "yarn rebuild:keytar:local-regtest-qa:mac-arm64",
  "yarn build:local-regtest-qa:mac-arm64",
  "CSC_IDENTITY_AUTO_DISCOVERY=false",
  "config/electron-builder.local-regtest-qa.json",
  "--mac zip --arm64",
  "--publish never",
]) {
  requireCondition(
    typeof packageCommand === "string" && packageCommand.includes(required),
    `package command is missing ${required}`,
  );
}
requireCondition(
  nativeManifest.includes('default = ["wcash-testnet"]') &&
    nativeManifest.includes('wcash-regtest = ["dep:zingolib", "zingolib/regtest"]'),
  "native feature isolation changed",
);
requireCondition(
  nativeManifest.includes('authors = ["Wcash Wallet contributors"]'),
  "the native package author metadata is inherited from upstream",
);
for (const [repository, revision] of [
  ["https://github.com/w-cash/wallet-core.git", "d10113e19c712a403c1b68947c2186e97f61f854"],
  ["https://github.com/w-cash/wolf.git", "168b59310056964a6347ed993ace8f8d1385cde1"],
  ["https://github.com/w-cash/wolf.git", "9a9c0668784117f116d5b69bdb3a090765092343"],
]) {
  requireCondition(
    nativeManifest.includes(`git = "${repository}", rev = "${revision}"`) &&
      nativeLock.includes(`git+${repository}?rev=${revision}#${revision}`),
    `the reviewed Wcash core pin ${repository}@${revision} is missing from the manifest or lockfile`,
  );
}
const desktopCandidatePolicy = spawnSync(
  process.execPath,
  [path.join(root, "scripts", "assert-wcash-desktop-candidate-packages.js")],
  { cwd: root, encoding: "utf8" },
);
requireCondition(
  desktopCandidatePolicy.status === 0,
  (desktopCandidatePolicy.stderr || desktopCandidatePolicy.stdout || "desktop candidate policy failed").trim(),
);
requireCondition(
  main.includes('intent: wcashProfile.runtimeReady ? "off" : "on"') &&
    main.includes('phase: wcashProfile.runtimeReady ? "switched_off" : "unattached"'),
  "a Wcash build can start inherited Nym transport",
);
const noParamMethods = main.match(/const _NATIVE_NO_PARAM_METHODS = \[([\s\S]*?)\];/)?.[1] || "";
requireCondition(
  noParamMethods.includes('"cancel_transaction_proposal"') &&
    preload.includes('"cancel_transaction_proposal"') &&
    wcashAdapter.includes('case "cancel_transaction_proposal"') &&
    main.includes("async function releasePendingProposalBeforeExit()") &&
    main.includes('await releasePendingProposalBeforeExit();'),
  "the renderer cannot release an abandoned Wcash transaction proposal",
);
requireCondition(!noParamMethods.includes('"get_seed"'), "seed export is exposed through the generic native IPC loop");
requireCondition(!noParamMethods.includes('"get_ufvk"'), "viewing-key export is exposed through the generic native IPC loop");
requireCondition(
  !noParamMethods.includes('"confirm"'),
  "transaction signing is exposed through the generic native IPC loop",
);
requireCondition(
  main.includes('for (const method of ["get_seed", "get_ufvk", "confirm"])') &&
    main.includes("createSensitiveNativeHandler") &&
    sensitivePolicy.includes("verifyDeviceAuthentication"),
  "trusted-main authentication is not wired for seed/viewing-key export and transaction signing",
);
const securityTest = spawnSync(process.execPath, [path.join(root, "scripts", "test-sensitive-native-policy.js")], {
  cwd: root,
  encoding: "utf8",
});
requireCondition(
  securityTest.status === 0,
  (securityTest.stderr || securityTest.stdout || "trusted-main security policy tests failed").trim(),
);
requireCondition(
  main.includes("if (wcashProfile.localnet)") &&
    main.includes("wcash protocol registration skipped for local-Regtest QA profile"),
  "the local QA application can call LaunchServices protocol registration before opening its window",
);
requireCondition(
  main.includes('appendStartupLog("app ready; configuring Wcash native wallet directory")') &&
    main.includes('appendStartupLog("BrowserWindow created")') &&
    main.includes("appendStartupLog(`app startup failed: ${message}`)"),
  "pre-window packaged startup diagnostics are missing",
);

const sidebarRule = commonStyles.match(/\.sidebarcontainer\s*\{([^}]*)\}/)?.[1] || "";
requireCondition(
  /height:\s*calc\(100vh\s*-\s*16px\)/.test(sidebarRule) &&
    /overflow-y:\s*auto/.test(sidebarRule) &&
    /overflow-x:\s*hidden/.test(sidebarRule),
  "the sidebar cannot scroll at the minimum supported Mac window height",
);
const contentRule = commonStyles.match(/\.contentcontainer\s*\{([^}]*)\}/)?.[1] || "";
requireCondition(
  /height:\s*calc\(100vh\s*-\s*16px\)/.test(contentRule) &&
    /overflow-y:\s*auto/.test(contentRule) &&
    /overflow-x:\s*hidden/.test(contentRule),
  "screen actions cannot be reached by scrolling at the minimum supported Mac window height",
);
requireCondition(main.includes("minHeight: 600"), "the supported minimum window height changed");
requireCondition(
  scrollPane.includes("window.innerHeight - offsetHeight") && scrollPane.includes('overflowY: "auto"'),
  "the exact screen content panes no longer scroll within the minimum window",
);
requireCondition(
  sendScreen.includes("<ScrollPaneTop offsetHeight={280}>") &&
    sendScreen.includes("className={cstyles.verticalbuttons}"),
  "the Send actions do not fit the minimum 600px framed Mac window",
);

const parity = spawnSync(process.execPath, [path.join(root, "scripts", "assert-upstream-ui-parity.js")], {
  cwd: root,
  encoding: "utf8",
});
requireCondition(parity.status === 0, (parity.stderr || parity.stdout || "upstream UI parity failed").trim());

console.log("Wcash Wallet unsigned macOS arm64 Local Regtest QA package policy passed.");
