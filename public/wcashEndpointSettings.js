"use strict";

const LEGACY_WCASH_MAINNET_ENDPOINT = "http://mainnet.zecwec.com:48234";

function resolveWcashEndpointSettings(stored, profile) {
  const current = stored && typeof stored === "object" ? stored : {};
  const sameChain = current.serverchain_name === undefined || current.serverchain_name === profile.chainName;
  if (!sameChain) {
    return {
      serveruri: current.serveruri,
      serverchain_name: current.serverchain_name,
      serverselection: current.serverselection,
      migrated: false,
    };
  }
  const oldOfficial = sameChain && current.serveruri === LEGACY_WCASH_MAINNET_ENDPOINT;
  const hasStoredEndpoint = typeof current.serveruri === "string" && current.serveruri.length > 0;
  const serveruri = oldOfficial ? profile.endpoint : hasStoredEndpoint ? current.serveruri : profile.endpoint;
  return {
    serveruri,
    serverchain_name: current.serverchain_name ?? profile.chainName,
    serverselection: current.serverselection ?? (hasStoredEndpoint ? "custom" : "auto"),
    migrated: oldOfficial,
  };
}

function migrateWcashWalletEndpoints(wallets, profile) {
  let migrated = false;
  const nextWallets = wallets.map((wallet) => {
    if (!wallet || typeof wallet !== "object") return wallet;
    const sameChain = wallet.chain_name === undefined || wallet.chain_name === profile.chainName;
    if (sameChain && wallet.uri === LEGACY_WCASH_MAINNET_ENDPOINT) {
      migrated = true;
      return { ...wallet, uri: profile.endpoint };
    }
    return wallet;
  });
  return { wallets: nextWallets, migrated };
}

module.exports = {
  LEGACY_WCASH_MAINNET_ENDPOINT,
  migrateWcashWalletEndpoints,
  resolveWcashEndpointSettings,
};
