"use strict";

const fs = require("fs");
const path = require("path");
const { nativeDependencyPinsMatch } = require("./wcash-native-pins");
const {
  LOCAL_REGTEST_RUNTIME_PROFILE,
  TESTNET_RUNTIME_PROFILE,
  publicRuntimeConfig,
  selectWcashRuntimeProfile,
} = require("../public/wcashRuntimeProfile");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const packageJson = JSON.parse(read("package.json"));
const packagedRuntime = JSON.parse(read("config/wcash-runtime.json"));
const manifest = read("native/Cargo.toml");
const reviewedWolfRevision = "b44571035074900570ef13f4fa96787886674ada";

function fail(message) {
  console.error("Wcash local Regtest build is blocked: " + message);
  process.exit(1);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  fail("this development command requires macOS arm64");
}

const local = publicRuntimeConfig(selectWcashRuntimeProfile({ isPackaged: false, localnetRequested: true }));
const packaged = publicRuntimeConfig(selectWcashRuntimeProfile({ isPackaged: true, localnetRequested: true }));

requireCondition(local.profile === "local-regtest", "the development selector did not choose Regtest");
requireCondition(local.endpoint === "http://127.0.0.1:48234", "the endpoint is not the fixed IPv4 loopback service");
requireCondition(local.network === "Wcash Regtest", "the local consensus profile is not Regtest");
requireCondition(local.storageNamespace === "wcashregtest-v5", "the local wallet namespace is not isolated");
requireCondition(local.branchId === "c3a6678a", "the local transaction branch is not isolated");
requireCondition(
  LOCAL_REGTEST_RUNTIME_PROFILE.appId !== TESTNET_RUNTIME_PROFILE.appId &&
    LOCAL_REGTEST_RUNTIME_PROFILE.productName !== TESTNET_RUNTIME_PROFILE.productName &&
    LOCAL_REGTEST_RUNTIME_PROFILE.keytarService !== TESTNET_RUNTIME_PROFILE.keytarService &&
    LOCAL_REGTEST_RUNTIME_PROFILE.keytarAccount !== TESTNET_RUNTIME_PROFILE.keytarAccount,
  "local application or credential identity overlaps Testnet",
);
requireCondition(packaged.profile === "testnet", "a packaged application can select the local profile");
requireCondition(
  packagedRuntime.appId === TESTNET_RUNTIME_PROFILE.appId &&
    packagedRuntime.productName === packaged.productName &&
    packagedRuntime.network === packaged.network,
  "packaged metadata no longer selects the Testnet profile",
);
requireCondition(
  manifest.includes('default = ["wcash-testnet"]') &&
    manifest.includes('wcash-regtest = ["dep:zingolib", "zingolib/regtest"]') &&
    !manifest.includes("zingolib-regtest"),
  "native Regtest feature wiring is incomplete",
);
requireCondition(
  local.coreRevision === packagedRuntime.coreRevision &&
    nativeDependencyPinsMatch({
      root,
      coreRevision: local.coreRevision,
      wolfRevision: reviewedWolfRevision,
    }),
  "the native manifest or lockfile diverges from the reviewed wallet-core/Wolf revisions",
);

for (const [name, command] of Object.entries(packageJson.scripts)) {
  const packagedBuildScript =
    /^(?:release:prep|build:runtime|build-(?:mac|win)(?!.*localnet)|dist:|package:unsigned-local:)/.test(name);
  const ordinaryNativeScript = /^neon(?:-|$)/.test(name) && !name.endsWith("-localnet");
  if (packagedBuildScript || ordinaryNativeScript) {
    requireCondition(!command.includes("wcash-regtest"), name + " compiles the Regtest feature");
    requireCondition(!command.includes("WCASH_LOCALNET_DEV"), name + " can select the local profile");
  }
}

const localBuild = packageJson.scripts["build-mac-arm64-localnet"];
const localStart = packageJson.scripts["start:mac-arm64-localnet"];
const localNative = packageJson.scripts["neon-mac-arm64-localnet"];
requireCondition(
  localBuild.startsWith("node scripts/assert-wcash-localnet-development.js"),
  "local build skips its guard",
);
requireCondition(
  localStart.startsWith("node scripts/assert-wcash-localnet-development.js"),
  "local start skips its guard",
);
requireCondition(
  localNative.includes("--no-default-features --features wcash-regtest"),
  "local native build does not select only the Regtest feature",
);

console.log("Wcash local Regtest development profile is isolated from packaged Testnet builds.");
