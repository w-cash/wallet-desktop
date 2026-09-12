"use strict";

const fs = require("fs");
const path = require("path");

const CORE_REVISION = "58bc22ec63bbe3eddab5f961c137836431589c95";
const TESTNET_PACKAGED_PROFILE = "testnet";
const LOCAL_REGTEST_QA_PACKAGED_PROFILE = "local-regtest-qa";

const TESTNET_RUNTIME_PROFILE = Object.freeze({
  id: "testnet",
  appId: "com.wcashwallet.wallet.testnet",
  productName: "Wcash Wallet",
  network: "Wcash Testnet",
  ticker: "TWC",
  endpoint: "https://wallet-testnet.wcashexplorer.com:443",
  storageNamespace: "wcashtestnet-v5",
  branchId: "b3cfd27e",
  ironwoodPrefix: "wutest1",
  transparentPrefix: "WT",
  keytarService: "com.wcashwallet.wallet.testnet.wallet-seed.v1",
  keytarAccount: "wcash-testnet-primary",
  runtimeReady: true,
  coreRevision: CORE_REVISION,
  localnet: false,
});

const LOCAL_REGTEST_RUNTIME_PROFILE = Object.freeze({
  id: "local-regtest",
  appId: "com.wcashwallet.wallet.regtest",
  productName: "Wcash Wallet",
  network: "Wcash Regtest",
  ticker: "TWC",
  endpoint: "http://127.0.0.1:48234",
  storageNamespace: "wcashregtest-v5",
  branchId: "c3a6678a",
  ironwoodPrefix: "wuregtest1",
  transparentPrefix: "WR",
  keytarService: "com.wcashwallet.wallet.regtest.wallet-seed.v1",
  keytarAccount: "wcash-local-regtest-primary",
  runtimeReady: true,
  coreRevision: CORE_REVISION,
  localnet: true,
});

function requireKnownRuntimeProfile(profile) {
  if (profile !== TESTNET_RUNTIME_PROFILE && profile !== LOCAL_REGTEST_RUNTIME_PROFILE) {
    throw new TypeError("Wcash runtime profile must be one of the compiled application profiles");
  }
  return profile;
}

function selectWcashRuntimeProfile({ isPackaged, localnetRequested, packagedProfile = TESTNET_PACKAGED_PROFILE }) {
  if (
    typeof isPackaged !== "boolean" ||
    typeof localnetRequested !== "boolean" ||
    (packagedProfile !== TESTNET_PACKAGED_PROFILE && packagedProfile !== LOCAL_REGTEST_QA_PACKAGED_PROFILE)
  ) {
    throw new TypeError("Wcash runtime profile selection requires explicit boolean inputs");
  }
  if (isPackaged) {
    return packagedProfile === LOCAL_REGTEST_QA_PACKAGED_PROFILE
      ? LOCAL_REGTEST_RUNTIME_PROFILE
      : TESTNET_RUNTIME_PROFILE;
  }
  return localnetRequested ? LOCAL_REGTEST_RUNTIME_PROFILE : TESTNET_RUNTIME_PROFILE;
}

function canonicalPath(candidate) {
  let existing = path.resolve(candidate);
  const missingSegments = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new TypeError("Wcash application data path cannot be resolved");
    missingSegments.unshift(path.basename(existing));
    existing = parent;
  }
  return path.resolve(fs.realpathSync.native(existing), ...missingSegments);
}

function pathsOverlap(left, right) {
  // The standard macOS and Windows filesystems compare these ASCII profile
  // names case-insensitively. Folding everywhere safely rejects an ambiguous
  // alias even on a case-sensitive development volume.
  const relative = path.relative(left.toLowerCase(), right.toLowerCase());
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function resolveWcashUserDataPath({ profile, appDataPath, localnetDataDir }) {
  const selected = requireKnownRuntimeProfile(profile);
  if (typeof appDataPath !== "string" || !path.isAbsolute(appDataPath)) {
    throw new TypeError("Wcash application data path must be absolute");
  }
  if (!selected.localnet || localnetDataDir === undefined || localnetDataDir === "") {
    return path.join(appDataPath, selected.productName, selected.id);
  }
  if (typeof localnetDataDir !== "string" || localnetDataDir.includes("\0") || !path.isAbsolute(localnetDataDir)) {
    throw new TypeError("WCASH_LOCALNET_DATA_DIR must be an absolute path");
  }
  const resolved = canonicalPath(localnetDataDir);
  if (resolved === path.parse(resolved).root) {
    throw new TypeError("WCASH_LOCALNET_DATA_DIR cannot be the filesystem root");
  }
  const testnetDataPath = canonicalPath(
    path.join(appDataPath, TESTNET_RUNTIME_PROFILE.productName, TESTNET_RUNTIME_PROFILE.id),
  );
  if (pathsOverlap(resolved, testnetDataPath) || pathsOverlap(testnetDataPath, resolved)) {
    throw new TypeError("WCASH_LOCALNET_DATA_DIR must be isolated from the Testnet wallet data path");
  }
  return resolved;
}

function publicRuntimeConfig(profile) {
  const selected = requireKnownRuntimeProfile(profile);
  return Object.freeze({
    profile: selected.id,
    productName: selected.productName,
    network: selected.network,
    ticker: selected.ticker,
    endpoint: selected.endpoint,
    storageNamespace: selected.storageNamespace,
    branchId: selected.branchId,
    runtimeReady: selected.runtimeReady,
    coreRevision: selected.coreRevision,
  });
}

module.exports = {
  LOCAL_REGTEST_QA_PACKAGED_PROFILE,
  LOCAL_REGTEST_RUNTIME_PROFILE,
  TESTNET_PACKAGED_PROFILE,
  TESTNET_RUNTIME_PROFILE,
  publicRuntimeConfig,
  requireKnownRuntimeProfile,
  resolveWcashUserDataPath,
  selectWcashRuntimeProfile,
};
