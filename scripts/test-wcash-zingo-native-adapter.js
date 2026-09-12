"use strict";

const assert = require("assert/strict");
const { createWcashZingoNativeAdapter, toCanonicalAmount } = require("../public/wcashZingoNativeAdapter");
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
  const viewingKey = `uviewregtest1${"v".repeat(120)}`;
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
  let proposalGeneration = 0;
  let nativeProposal = null;
  let confirmCalls = 0;
  let confirmBehavior = "broadcast";
  const proposalOperations = [];
  let failNativeDelete = false;
  const deleteOrder = [];
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
    wcash_export_ufvk: (value) => {
      assert.equal(value, phrase);
      return viewingKey;
    },
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
            value_zat: 100_000_000,
            fee_zat: 15_000,
            timestamp: 1_788_782_400,
            confirmations: 2,
          },
          {
            txid: "d".repeat(64),
            mined_height: 8,
            direction: "internal",
            kind: "shielding",
            amount_delta_zat: -20_000,
            value_zat: 1_249_980_000,
            fee_zat: 20_000,
            timestamp: 1_788_782_300,
            confirmations: 3,
          },
          {
            txid: "e".repeat(64),
            mined_height: 7,
            direction: "outgoing",
            kind: "transfer",
            amount_delta_zat: -42_000,
            value_zat: null,
            fee_zat: null,
            timestamp: 1_788_782_200,
            confirmations: 4,
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
    wcash_cancel_proposal: async (proposalId) => {
      proposalOperations.push(["cancel", proposalId]);
      if (!nativeProposal) return JSON.stringify({ cancelled: false });
      if (proposalId !== undefined && proposalId !== nativeProposal.id) {
        throw new Error("proposal changed before cancellation");
      }
      if (nativeProposal.state === "calculated") {
        throw new Error("calculated transaction requires review");
      }
      nativeProposal = null;
      return JSON.stringify({ cancelled: true });
    },
    wcash_propose_send: async (requestJson) => {
      proposalOperations.push(["propose_send", requestJson]);
      const request = JSON.parse(requestJson);
      const valueZat = request.payments.reduce((total, payment) => {
        const [whole, fraction = ""] = payment.amount.split(".");
        return total + Number(whole) * 100_000_000 + Number(fraction.padEnd(8, "0"));
      }, 0);
      proposalGeneration += 1;
      nativeProposal = {
        id: String(proposalGeneration),
        operation: "send",
        feeZat: request.payments.length === 1 ? 15_000 : 20_000,
        state: "staged",
      };
      return JSON.stringify({
        schema_version: 1,
        proposal_id: nativeProposal.id,
        operation: nativeProposal.operation,
        fee_zat: String(nativeProposal.feeZat),
        value_zat: String(valueZat),
      });
    },
    wcash_propose_shield_coinbase: async () => {
      proposalOperations.push(["propose_shield"]);
      proposalGeneration += 1;
      nativeProposal = {
        id: String(proposalGeneration),
        operation: "shield_coinbase",
        feeZat: 25_000,
        state: "staged",
      };
      return JSON.stringify({
        schema_version: 1,
        proposal_id: nativeProposal.id,
        operation: nativeProposal.operation,
        fee_zat: String(nativeProposal.feeZat),
        value_zat: "1249975000",
      });
    },
    wcash_confirm_proposal: async (credential, proposalId, operation) => {
      proposalOperations.push(["confirm", proposalId, operation]);
      confirmCalls += 1;
      assert.equal(credential, phrase);
      assert.deepEqual(nativeProposal && { id: nativeProposal.id, operation: nativeProposal.operation }, {
        id: proposalId,
        operation,
      });
      const proposal = nativeProposal;
      if (confirmBehavior === "pre-sign-error") {
        throw new Error("chain tip moved before calculation");
      }
      if (confirmBehavior === "signing-error") {
        nativeProposal = null;
        throw new Error("transaction construction failed");
      }
      if (confirmBehavior === "persisted-review") {
        nativeProposal = null;
        return JSON.stringify({
          schema_version: 1,
          operation,
          outcome: "recovery_required",
          txid: null,
          fee_zat: null,
          recovery: { message: "signed transaction requires review" },
        });
      }
      if (confirmBehavior === "ambiguous") {
        nativeProposal.state = "calculated";
        return JSON.stringify({
          schema_version: 1,
          operation,
          outcome: "recovery_required",
          txid: "f".repeat(64),
          fee_zat: String(proposal.feeZat),
          raw_transaction_hex: "must-never-cross-the-adapter-boundary",
          recovery: { message: "broadcast outcome is ambiguous" },
        });
      }
      if (confirmBehavior === "fee-mismatch") {
        nativeProposal.state = "calculated";
        return JSON.stringify({
          schema_version: 1,
          operation,
          outcome: "recovery_required",
          txid: "f".repeat(64),
          fee_zat: String(proposal.feeZat + 1),
          recovery: { message: "fee mismatch" },
        });
      }
      nativeProposal = null;
      const txid = operation === "send" ? "b".repeat(64) : "c".repeat(64);
      return JSON.stringify({
        schema_version: 1,
        operation,
        outcome: "broadcast",
        txid,
        fee_zat: String(proposal.feeZat),
        raw_transaction_hex: "must-never-cross-the-adapter-boundary",
      });
    },
    wcash_delete: async () => {
      deleteOrder.push("native");
      if (failNativeDelete) throw new Error("database busy");
      const deleted = database !== null;
      database = null;
      return JSON.stringify({ deleted });
    },
  };

  const credentials = new Map();
  const keytar = {
    getPassword: async (service, account) => credentials.get(`${service}:${account}`) ?? null,
    setPassword: async (service, account, value) => {
      credentials.set(`${service}:${account}`, value);
    },
    deletePassword: async (service, account) => {
      deleteOrder.push("credential");
      return credentials.delete(`${service}:${account}`);
    },
  };
  const adapter = createWcashZingoNativeAdapter({ native, keytar, profile, endpointProbe: async () => true });

  assert.equal(await adapter.invoke("wallet_exists", profile.endpoint, "regtest", "high", 1, "wallet.dat"), false);
  assert.equal(await adapter.invoke("wallet_exists", profile.endpoint, "test", "high", 1, "wallet.dat"), false);

  const created = JSON.parse(await adapter.invoke("init_new", profile.endpoint, "regtest", "high", 1, "wallet.dat"));
  assert.equal(created.seed_phrase, phrase);
  assert.equal(created.birthday, 1);
  assert.equal(await adapter.invoke("wallet_exists", profile.endpoint, "regtest", "high", 1, "wallet.dat"), true);
  assert.deepEqual(
    JSON.parse(await adapter.invoke("init_from_b64", profile.endpoint, "regtest", "high", 1, "wallet.dat")),
    { birthday: 1 },
  );
  assert.deepEqual(JSON.parse(await adapter.invoke("get_ufvk")), { ufvk: viewingKey });

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
  assert.equal(history.value_transfers[0].value, 100_000_000);
  assert.equal(history.value_transfers[1].kind, "shield");
  assert.equal(history.value_transfers[1].value, 1_249_980_000);
  assert.deepEqual(history.value_transfers[1].pools_sent_from, ["Transparent"]);
  assert.deepEqual(history.value_transfers[1].pools_received, ["Ironwood"]);
  assert.equal(history.value_transfers[2].kind, "");
  assert.equal(history.value_transfers[2].value, 0);
  assert.deepEqual(history.value_transfers[2].pools_sent_from, []);
  assert.deepEqual(history.value_transfers[2].pools_received, []);

  const zeroAmountPreview = JSON.parse(
    await adapter.invoke("send", JSON.stringify([{ address: ironwoodAddress, amount: 0 }])),
  );
  const multipleRecipientPreview = JSON.parse(
    await adapter.invoke(
      "send",
      JSON.stringify([
        { address: ironwoodAddress, amount: 1 },
        { address: ironwoodAddress, amount: 1 },
      ]),
    ),
  );
  assert.equal(multipleRecipientPreview.fee, 20_000);
  assert.equal(multipleRecipientPreview.amount, 2);
  assert.match(zeroAmountPreview.error, /outside the accepted range/);
  assert.equal(
    JSON.parse(await adapter.invoke("get_spendable_balance_with_address", ironwoodAddress, "false")).spendable_balance,
    300_000_000,
  );

  const proposal = JSON.parse(
    await adapter.invoke("send", JSON.stringify([{ address: ironwoodAddress, amount: 100_000_000, memo: "hello" }])),
  );
  assert.equal(proposal.fee, 15_000, "renderer preview must use the exact fee returned by the staged core proposal");
  assert.equal(proposal.amount, 100_000_000);
  assert.equal(confirmCalls, 0, "proposal must not calculate, sign, or broadcast");
  assert.deepEqual(
    proposalOperations.slice(-2).map(([operation, id]) => [operation, id]),
    [
      ["cancel", "1"],
      ["propose_send", JSON.stringify({ payments: [{ address: ironwoodAddress, amount: "1", memo: "hello" }] })],
    ],
    "replacement must cancel the prior proposal by its opaque identifier before staging another",
  );
  const operationsBeforeIdenticalSend = proposalOperations.length;
  const repeatedProposal = JSON.parse(
    await adapter.invoke("send", JSON.stringify([{ memo: "hello", amount: 100_000_000, address: ironwoodAddress }])),
  );
  assert.deepEqual(repeatedProposal, proposal, "a canonically identical send must keep the reviewed exact fee");
  assert.equal(
    proposalOperations.length,
    operationsBeforeIdenticalSend,
    "a canonically identical send must reuse its staged proposal without cancellation or replacement",
  );
  assert.deepEqual(JSON.parse(await adapter.invoke("confirm")), { txids: ["b".repeat(64)] });
  assert.equal(confirmCalls, 1);
  assert.deepEqual(proposalOperations.at(-1), ["confirm", "2", "send"]);
  assert.deepEqual(JSON.parse(await adapter.invoke("confirm")), { error: "No Wcash transaction proposal is pending" });

  const shieldProposal = JSON.parse(await adapter.invoke("shield"));
  assert.equal(shieldProposal.fee, 25_000, "shield preview must not assume the one-output send fee");
  assert.equal(confirmCalls, 1, "shield preview must not calculate, sign, or broadcast");
  const operationsBeforeIdenticalShield = proposalOperations.length;
  assert.deepEqual(JSON.parse(await adapter.invoke("shield")), shieldProposal);
  assert.equal(
    proposalOperations.length,
    operationsBeforeIdenticalShield,
    "a repeated shield must reuse the exact staged proposal displayed by the renderer",
  );
  assert.deepEqual(JSON.parse(await adapter.invoke("confirm")), { txids: ["c".repeat(64)] });
  assert.equal(confirmCalls, 2);
  assert.deepEqual(proposalOperations.at(-1), ["confirm", "3", "shield_coinbase"]);

  const ambiguousPreview = JSON.parse(
    await adapter.invoke("send", JSON.stringify([{ address: ironwoodAddress, amount: 50_000_000 }])),
  );
  assert.equal(ambiguousPreview.fee, 15_000);
  confirmBehavior = "fee-mismatch";
  await assert.rejects(
    () => adapter.invoke("confirm"),
    /confirmation did not match the reviewed proposal/,
    "confirmation must fail closed if the returned fee differs from the fee reviewed by the renderer",
  );
  assert.deepEqual(proposalOperations.at(-1), ["confirm", "4", "send"]);
  confirmBehavior = "ambiguous";
  assert.deepEqual(JSON.parse(await adapter.invoke("confirm")), { error: "broadcast outcome is ambiguous" });
  assert.deepEqual(proposalOperations.at(-1), ["confirm", "4", "send"]);
  confirmBehavior = "broadcast";
  const retried = JSON.parse(await adapter.invoke("confirm"));
  assert.deepEqual(retried, { txids: ["b".repeat(64)] });
  assert.equal(
    JSON.stringify(retried).includes("must-never-cross"),
    false,
    "signed transaction bytes must never cross the trusted-main adapter boundary",
  );
  assert.deepEqual(proposalOperations.at(-1), ["confirm", "4", "send"]);

  await adapter.invoke("send", JSON.stringify([{ address: ironwoodAddress, amount: 40_000_000 }]));
  confirmBehavior = "pre-sign-error";
  await assert.rejects(() => adapter.invoke("confirm"), /chain tip moved before calculation/);
  assert.deepEqual(proposalOperations.at(-1), ["cancel", "5"]);
  assert.deepEqual(JSON.parse(await adapter.invoke("confirm")), { error: "No Wcash transaction proposal is pending" });

  await adapter.invoke("send", JSON.stringify([{ address: ironwoodAddress, amount: 30_000_000 }]));
  confirmBehavior = "signing-error";
  await assert.rejects(() => adapter.invoke("confirm"), /transaction construction failed/);
  assert.deepEqual(proposalOperations.at(-1), ["cancel", "6"]);
  assert.deepEqual(JSON.parse(await adapter.invoke("confirm")), { error: "No Wcash transaction proposal is pending" });

  await adapter.invoke("send", JSON.stringify([{ address: ironwoodAddress, amount: 20_000_000 }]));
  confirmBehavior = "persisted-review";
  assert.deepEqual(JSON.parse(await adapter.invoke("confirm")), { error: "signed transaction requires review" });
  assert.deepEqual(JSON.parse(await adapter.invoke("confirm")), { error: "No Wcash transaction proposal is pending" });

  confirmBehavior = "broadcast";
  await adapter.invoke("shield");
  assert.deepEqual(JSON.parse(await adapter.invoke("cancel_transaction_proposal")), { cancelled: true });
  assert.deepEqual(proposalOperations.at(-1), ["cancel", "8"]);
  assert.deepEqual(JSON.parse(await adapter.invoke("confirm")), { error: "No Wcash transaction proposal is pending" });

  await adapter.invoke("shield");
  assert.equal(await adapter.invoke("deinitialize"), "Wcash adapter state cleared.");
  assert.deepEqual(proposalOperations.at(-1), ["cancel", "9"]);
  assert.deepEqual(JSON.parse(await adapter.invoke("confirm")), { error: "No Wcash transaction proposal is pending" });

  assert.equal(await adapter.invoke("get_developer_donation_address"), "");
  assert.deepEqual(JSON.parse(await adapter.invoke("zec_price_over_mixnet")), { price: null });

  const credentialKey = `${profile.keytarService}:${profile.keytarAccount}`;
  failNativeDelete = true;
  await assert.rejects(
    adapter.invoke("delete_wallet", profile.endpoint, "regtest", "high", 1, "wallet.dat"),
    /database busy/,
  );
  assert.equal(credentials.has(credentialKey), true, "native deletion failure must preserve the recovery credential");
  assert.deepEqual(deleteOrder, ["native"]);

  failNativeDelete = false;
  assert.deepEqual(
    JSON.parse(await adapter.invoke("delete_wallet", profile.endpoint, "regtest", "high", 1, "wallet.dat")),
    { deleted: true },
  );
  assert.equal(credentials.has(credentialKey), false);
  assert.deepEqual(deleteOrder, ["native", "native", "credential"]);
  assert.equal(await adapter.invoke("wallet_exists", profile.endpoint, "regtest", "high", 1, "wallet.dat"), false);

  console.log("Wcash exact-Zingo native adapter tests passed");
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
