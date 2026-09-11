"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const EXPECTED_NETWORK = "Wcash Testnet";
const EXPECTED_TICKER = "TWC";
const EXPECTED_NAMESPACE = "wcashtestnet-v5";
const EXPECTED_SEED_SCHEME = "bip39-english-24-empty-passphrase-v1";

function parseObject(method, value) {
  if (typeof value !== "string") {
    throw new Error(`${method} returned a non-string result`);
  }

  const parsed = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${method} returned a non-object result`);
  }
  return parsed;
}

function requireStringPrefix(value, prefix, label) {
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    throw new Error(`${label} does not use the expected Wcash Testnet prefix`);
  }
}

function requireExactTip(summary, label) {
  if (
    summary.synchronized !== true ||
    !Number.isSafeInteger(summary.chain_tip_height) ||
    summary.chain_tip_height < 1 ||
    summary.fully_scanned_height !== summary.chain_tip_height
  ) {
    throw new Error(`${label} did not report an exact Wcash Testnet tip`);
  }
}

async function main() {
  const nativePath = path.join(__dirname, "..", "src", "native.node");
  if (!fs.existsSync(nativePath)) {
    throw new Error('src/native.node is missing; build it first with "yarn neon"');
  }

  const native = require(nativePath);
  for (const method of [
    "wcash_validate_recipient",
    "wcash_send_and_broadcast",
    "wcash_shield_coinbase_and_broadcast",
    "wcash_pending_transactions",
    "wcash_rebroadcast_pending",
  ]) {
    if (typeof native[method] !== "function") {
      throw new Error(`native transaction boundary is missing ${method}`);
    }
  }
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wcash-native-live-"));

  try {
    if (native.set_wallet_base_dir(temporaryRoot) !== true) {
      throw new Error("the native module refused the isolated wallet directory");
    }

    const initialStatus = parseObject("wcash_status", await native.wcash_status());
    if (
      initialStatus.network !== EXPECTED_NETWORK ||
      initialStatus.ticker !== EXPECTED_TICKER ||
      initialStatus.storage_namespace !== EXPECTED_NAMESPACE ||
      initialStatus.wallet !== null
    ) {
      throw new Error("the native module did not start with an empty Wcash Testnet identity");
    }

    let recoveryPhrase = await native.wcash_generate_mnemonic();
    const normalizedPhrase = await native.wcash_validate_mnemonic(recoveryPhrase);
    if (recoveryPhrase !== normalizedPhrase || normalizedPhrase.trim().split(/\s+/u).length !== 24) {
      throw new Error("the native module violated the 24-word recovery contract");
    }

    const created = parseObject("wcash_create", await native.wcash_create(recoveryPhrase));
    if (created.seed_scheme !== EXPECTED_SEED_SCHEME || created.wallet === null || typeof created.wallet !== "object") {
      throw new Error("wcash_create returned an invalid wallet contract");
    }
    if ((await native.wcash_verify_mnemonic(recoveryPhrase)) !== true) {
      throw new Error("the generated recovery phrase did not control the created wallet");
    }

    const sync = parseObject("wcash_sync", await native.wcash_sync());
    requireExactTip(sync, "wcash_sync");

    const receivers = parseObject("wcash_receivers", await native.wcash_receivers());
    requireStringPrefix(receivers.ironwood_address, "wutest1", "Ironwood receiver");
    requireStringPrefix(receivers.transparent_coinbase_address, "WT", "transparent receiver");

    const recipient = parseObject(
      "wcash_validate_recipient",
      native.wcash_validate_recipient(receivers.ironwood_address),
    );
    if (
      recipient.valid !== true ||
      recipient.recipient_kind !== "ironwood" ||
      recipient.canonical_address !== receivers.ironwood_address
    ) {
      throw new Error("the native recipient validator rejected its Wcash Testnet receiver");
    }

    let invalidSendRejected = false;
    try {
      await native.wcash_send_and_broadcast(
        recoveryPhrase,
        JSON.stringify({
          payments: [{ address: receivers.ironwood_address, amount: "1.0" }],
        }),
      );
    } catch (_error) {
      invalidSendRejected = true;
    }
    if (!invalidSendRejected) {
      throw new Error("the native transaction boundary accepted a noncanonical amount");
    }

    const pending = parseObject("wcash_pending_transactions", await native.wcash_pending_transactions());
    if (
      pending.schema_version !== 1 ||
      !Array.isArray(pending.transactions) ||
      pending.transactions.length !== 0 ||
      pending.next_cursor !== null ||
      JSON.stringify(pending).includes("raw_transaction")
    ) {
      throw new Error("the native pending-transaction DTO violated its empty-wallet contract");
    }

    // Do not retain or print the recovery phrase after the native spending
    // boundary has rejected the validation-only fixture.
    recoveryPhrase = undefined;

    const balance = parseObject("wcash_balance", await native.wcash_balance());
    requireExactTip(balance, "wcash_balance");

    const reopened = parseObject("wcash_open", await native.wcash_open());
    const finalStatus = parseObject("wcash_status", await native.wcash_status());
    if (
      finalStatus.wallet === null ||
      reopened.wallet === null ||
      reopened.wallet.address !== finalStatus.wallet.address ||
      reopened.wallet.transparent_coinbase_address !== finalStatus.wallet.transparent_coinbase_address
    ) {
      throw new Error("the reopened wallet identity did not match the persisted database");
    }

    console.log(
      JSON.stringify({
        ok: true,
        network: finalStatus.network,
        ticker: finalStatus.ticker,
        storageNamespace: finalStatus.storage_namespace,
        chainTipHeight: balance.chain_tip_height,
        fullyScannedHeight: balance.fully_scanned_height,
        synchronized: balance.synchronized,
        ironwoodPrefix: receivers.ironwood_address.slice(0, 7),
        transparentPrefix: receivers.transparent_coinbase_address.slice(0, 2),
        persistedWalletReopened: true,
        transactionBoundaryValidated: true,
      }),
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
