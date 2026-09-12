"use strict";

const assert = require("assert/strict");
const {
  SEND_FEE_ZAT,
  createWcashZingoNativeAdapter,
  toCanonicalAmount,
} = require("../public/wcashZingoNativeAdapter");
const { LOCAL_REGTEST_RUNTIME_PROFILE } = require("../public/wcashRuntimeProfile");

const phrase = `${"abandon ".repeat(23)}art`;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function main() {
  assert.deepEqual(toCanonicalAmount(1), { zatoshis: 1, decimal: "0.00000001" });
  assert.deepEqual(toCanonicalAmount(100_000_000), { zatoshis: 100_000_000, decimal: "1" });
  assert.throws(() => toCanonicalAmount(1.5), /outside the accepted range/);

  const profile = LOCAL_REGTEST_RUNTIME_PROFILE;
  const ironwoodAddress = `${profile.ironwoodPrefix}${"q".repeat(90)}`;
  const transparentAddress = "WRSJjaJAZ75QkqbJoa244F21QmkPHEqhYu8";
  const wallet = {
    account_id: "account-0",
    birthday_height: 1,
    address: ironwoodAddress,
    transparent_coinbase_address: transparentAddress,
  };
  const balance = {
    chain_tip_height: 10,
    fully_scanned_height: 10,
    synchronized: true,
    accounts: [
      {
        account_id: "account-0",
        ironwood_total_zat: 300_000_000,
        ironwood_spendable_zat: 300_000_000,
        transparent_total_zat: 0,
      },
    ],
  };
  let database = null;
  let sendCalls = 0;
  let sync = deferred();

  const native = {
    wcash_status: async () =>
      JSON.stringify({
        profile: profile.id,
        network: profile.network,
        ticker: profile.ticker,
        endpoint: profile.endpoint,
        storage_namespace: profile.storageNamespace,
        branch_id: profile.branchId,
        wallet: database,
      }),
    wcash_generate_mnemonic: () => phrase,
    wcash_validate_mnemonic: (value) => value,
    wcash_verify_mnemonic: (value) => value === phrase,
    wcash_create: async () => {
      database = wallet;
      return JSON.stringify({ wallet, seed_scheme: "bip39-english-24-empty-passphrase-v1" });
    },
    wcash_restore: async () => {
      database = wallet;
      return JSON.stringify({ wallet, seed_scheme: "bip39-english-24-empty-passphrase-v1" });
    },
    wcash_open: async () => JSON.stringify({ wallet }),
    wcash_sync: () => sync.promise,
    wcash_stop_sync: () => true,
    wcash_balance: async () => JSON.stringify(balance),
    wcash_receivers: async () =>
      JSON.stringify({ ironwood_address: ironwoodAddress, transparent_coinbase_address: transparentAddress }),
    wcash_confirmed_transactions: async () =>
      JSON.stringify({
        exact_tip: { height: 10, hash: Array(32).fill(1) },
        transactions: [
          {
            txid: "a".repeat(64),
            mined_height: 9,
            direction: "outgoing",
            kind: "transfer",
            amount_delta_zat: -100_015_000,
            fee_zat: 15_000,
            timestamp: 1_788_782_400,
            confirmations: 2,
          },
        ],
      }),
    wcash_validate_recipient: (address) =>
      JSON.stringify({
        schema_version: 1,
        valid: address === ironwoodAddress,
        network: profile.network,
        recipient_kind: address === ironwoodAddress ? "ironwood" : null,
        canonical_address: address === ironwoodAddress ? address : null,
        error: address === ironwoodAddress ? null : { code: "invalid_recipient", message: "invalid" },
      }),
    wcash_send_and_broadcast: async (_credential, requestJson) => {
      sendCalls += 1;
      assert.deepEqual(JSON.parse(requestJson), {
        payments: [{ address: ironwoodAddress, amount: "1", memo: "hello" }],
      });
      return JSON.stringify({ outcome: "broadcast", txid: "b".repeat(64) });
    },
    wcash_shield_coinbase_and_broadcast: async () =>
      JSON.stringify({ outcome: "broadcast", txid: "c".repeat(64) }),
  };

  const credentials = new Map();
  const keytar = {
    getPassword: async (service, account) => credentials.get(`${service}:${account}`) ?? null,
    setPassword: async (service, account, value) => {
      credentials.set(`${service}:${account}`, value);
    },
    deletePassword: async (service, account) => credentials.delete(`${service}:${account}`),
  };
  const adapter = createWcashZingoNativeAdapter({ native, keytar, profile, endpointProbe: async () => true });

  assert.equal(await adapter.invoke("wallet_exists", profile.endpoint, "regtest", "high", 1, "wallet.dat"), false);
  assert.equal(await adapter.invoke("wallet_exists", profile.endpoint, "test", "high", 1, "wallet.dat"), false);

  const created = JSON.parse(
    await adapter.invoke("init_new", profile.endpoint, "regtest", "high", 1, "wallet.dat"),
  );
  assert.equal(created.seed_phrase, phrase);
  assert.equal(created.birthday, 1);
  assert.equal(await adapter.invoke("wallet_exists", profile.endpoint, "regtest", "high", 1, "wallet.dat"), true);
  assert.deepEqual(
    JSON.parse(await adapter.invoke("init_from_b64", profile.endpoint, "regtest", "high", 1, "wallet.dat")),
    { birthday: 1 },
  );

  assert.equal(await adapter.invoke("run_sync"), "Sync task launched.");
  assert.equal(await adapter.invoke("poll_sync"), "Sync task is not complete.");
  sync.resolve(JSON.stringify(balance));
  await sync.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(await adapter.invoke("poll_sync")), balance);
  assert.equal(await adapter.invoke("poll_sync"), "Sync task has not been launched.");
  assert.equal(JSON.parse(await adapter.invoke("status_sync")).percentage_total_blocks_scanned, 100);
  assert.equal(JSON.parse(await adapter.invoke("get_wallet_version")).read_version, 32);

  sync = deferred();
  assert.equal(await adapter.invoke("run_sync"), "Sync task launched.");
  sync.reject(new Error("StaleChain: chain tip moved during sync"));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => adapter.invoke("poll_sync"), /StaleChain/);
  assert.equal(await adapter.invoke("poll_sync"), "Sync task has not been launched.");

  const zingoBalance = JSON.parse(await adapter.invoke("get_balance"));
  assert.equal(zingoBalance.total_ironwood_balance, 300_000_000);
  assert.equal(zingoBalance.confirmed_ironwood_balance, 300_000_000);
  assert.equal(zingoBalance.total_orchard_balance, 0);
  assert.deepEqual(JSON.parse(await adapter.invoke("get_unified_addresses"))[0], {
    account: 0,
    address_index: 0,
    encoded_address: ironwoodAddress,
    has_orchard: true,
    has_sapling: false,
    has_transparent: false,
  });
  assert.equal(JSON.parse(await adapter.invoke("get_transparent_addresses"))[0].encoded_address, transparentAddress);

  const parsed = JSON.parse(await adapter.invoke("parse_address", ironwoodAddress));
  assert.deepEqual(parsed, {
    status: "success",
    chain_name: "regtest",
    address_kind: "unified",
    receivers_available: ["orchard"],
  });
  const history = JSON.parse(await adapter.invoke("get_value_transfers"));
  assert.equal(history.value_transfers[0].kind, "sent");
  assert.equal(history.value_transfers[0].value, 100_015_000);

  const zeroAmountPreview = JSON.parse(
    await adapter.invoke("send", JSON.stringify([{ address: ironwoodAddress, amount: 0 }])),
  );
  assert.match(zeroAmountPreview.error, /outside the accepted range/);
  assert.equal(
    JSON.parse(await adapter.invoke("get_spendable_balance_with_address", ironwoodAddress, "false"))
      .spendable_balance,
    300_000_000,
  );

  const proposal = JSON.parse(
    await adapter.invoke(
      "send",
      JSON.stringify([{ address: ironwoodAddress, amount: 100_000_000, memo: "hello" }]),
    ),
  );
  assert.equal(proposal.fee, SEND_FEE_ZAT);
  assert.equal(proposal.amount, 100_000_000);
  assert.equal(sendCalls, 0, "proposal must not sign or broadcast");
  assert.deepEqual(JSON.parse(await adapter.invoke("confirm")), { txids: ["b".repeat(64)] });
  assert.equal(sendCalls, 1);
  assert.deepEqual(JSON.parse(await adapter.invoke("confirm")), { error: "No Wcash transaction proposal is pending" });

  assert.equal(await adapter.invoke("get_developer_donation_address"), "");
  assert.deepEqual(JSON.parse(await adapter.invoke("zec_price_over_mixnet")), { price: null });

  console.log("Wcash exact-Zingo native adapter tests passed");
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
