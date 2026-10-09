"use strict";

const assert = require("assert/strict");
const {
  LEGACY_WCASH_MAINNET_ENDPOINT,
  migrateWcashWalletEndpoints,
  resolveWcashEndpointSettings,
} = require("../public/wcashEndpointSettings");
const { MAINNET_RUNTIME_PROFILE } = require("../public/wcashRuntimeProfile");

const migrated = resolveWcashEndpointSettings(
  {
    serveruri: LEGACY_WCASH_MAINNET_ENDPOINT,
    serverchain_name: "main",
    serverselection: "custom",
  },
  MAINNET_RUNTIME_PROFILE,
);
assert.equal(migrated.serveruri, "https://mainnet.zecwec.com:443");
assert.equal(migrated.migrated, true);
assert.deepEqual(resolveWcashEndpointSettings(migrated, MAINNET_RUNTIME_PROFILE), { ...migrated, migrated: false });

const custom = {
  serveruri: "https://wallet.example:443",
  serverchain_name: "main",
  serverselection: "custom",
};
assert.deepEqual(resolveWcashEndpointSettings(custom, MAINNET_RUNTIME_PROFILE), {
  ...custom,
  migrated: false,
});

for (const serverselection of ["list", "auto", undefined]) {
  const alternate = {
    serveruri: "https://alternate.example:443",
    serverchain_name: "main",
    ...(serverselection === undefined ? {} : { serverselection }),
  };
  const resolved = resolveWcashEndpointSettings(alternate, MAINNET_RUNTIME_PROFILE);
  assert.equal(resolved.serveruri, alternate.serveruri);
  assert.equal(resolved.serverselection, serverselection ?? "custom");
  assert.equal(resolved.migrated, false);
}

const testnet = {
  serveruri: "https://testnet.example:443",
  serverchain_name: "test",
  serverselection: "list",
};
assert.deepEqual(resolveWcashEndpointSettings(testnet, MAINNET_RUNTIME_PROFILE), {
  ...testnet,
  migrated: false,
});

const walletRecords = [
  {
    id: 1,
    uri: LEGACY_WCASH_MAINNET_ENDPOINT,
    chain_name: "main",
    selection: "custom",
    alias: "Main Wallet",
  },
  {
    id: 2,
    uri: "https://wallet.example:443",
    chain_name: "main",
    selection: "custom",
  },
  {
    id: 3,
    uri: "http://127.0.0.1:48234",
    chain_name: "regtest",
    selection: "custom",
  },
];
const migratedWallets = migrateWcashWalletEndpoints(walletRecords, MAINNET_RUNTIME_PROFILE);
assert.equal(migratedWallets.migrated, true);
assert.deepEqual(migratedWallets.wallets[0], {
  ...walletRecords[0],
  uri: "https://mainnet.zecwec.com:443",
});
assert.strictEqual(migratedWallets.wallets[1], walletRecords[1]);
assert.strictEqual(migratedWallets.wallets[2], walletRecords[2]);

const alreadyCurrent = migrateWcashWalletEndpoints(migratedWallets.wallets, MAINNET_RUNTIME_PROFILE);
assert.equal(alreadyCurrent.migrated, false);
assert.deepEqual(alreadyCurrent.wallets, migratedWallets.wallets);

console.log("Wcash endpoint settings migration tests passed");
