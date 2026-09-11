"use strict";

const WCASH_NETWORK = "Wcash Testnet";
const WCASH_TICKER = "TWC";
const WCASH_BRANCH_ID = "b3cfd27e";
const ZATOSHIS_PER_COIN = 100_000_000n;
const MAX_MONEY_ZAT = 21_000_000n * ZATOSHIS_PER_COIN;
const MAX_MEMO_BYTES = 512;
const TXID_PATTERN = /^[0-9a-f]{64}$/;
const RECOVERY_MESSAGE = "The signed transaction is stored. Retry this exact transaction; do not create a replacement.";

class WcashTransactionBoundaryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WcashTransactionBoundaryError";
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function utf8ByteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function parseCanonicalAmount(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{0,7}[1-9])?$/.test(value)) {
    throw new WcashTransactionBoundaryError(
      "INVALID_AMOUNT",
      "Enter a canonical TWC amount with no more than eight decimal places",
    );
  }

  const [wholeText, fractionText = ""] = value.split(".");
  const zatoshis = BigInt(wholeText) * ZATOSHIS_PER_COIN + BigInt(fractionText.padEnd(8, "0") || "0");
  if (zatoshis < 1n || zatoshis > MAX_MONEY_ZAT) {
    throw new WcashTransactionBoundaryError("INVALID_AMOUNT", "TWC amount is outside the valid monetary range");
  }

  return Object.freeze({ amount: value, amountZat: zatoshis.toString() });
}

function parseRendererSendRequest(value) {
  if (!hasExactKeys(value, ["payments"]) || !Array.isArray(value.payments) || value.payments.length !== 1) {
    throw new WcashTransactionBoundaryError("INVALID_REQUEST", "Send requires exactly one reviewed payment");
  }

  const payment = value.payments[0];
  const expectedKeys =
    payment && Object.prototype.hasOwnProperty.call(payment, "memo")
      ? ["address", "amount", "memo"]
      : ["address", "amount"];
  if (!hasExactKeys(payment, expectedKeys)) {
    throw new WcashTransactionBoundaryError("INVALID_REQUEST", "Send payment fields are invalid");
  }
  if (
    typeof payment.address !== "string" ||
    payment.address.length < 16 ||
    payment.address.length > 512 ||
    payment.address !== payment.address.trim()
  ) {
    throw new WcashTransactionBoundaryError("INVALID_RECIPIENT", "Enter a canonical Wcash Testnet recipient");
  }

  const amount = parseCanonicalAmount(payment.amount);
  const memo = payment.memo === undefined ? "" : payment.memo;
  if (typeof memo !== "string") {
    throw new WcashTransactionBoundaryError("INVALID_MEMO", "Memo must be UTF-8 text");
  }
  const memoBytes = utf8ByteLength(memo);
  if (memoBytes > MAX_MEMO_BYTES) {
    throw new WcashTransactionBoundaryError("MEMO_TOO_LONG", "Memo exceeds the 512-byte Wcash limit");
  }

  return Object.freeze({
    payments: Object.freeze([
      Object.freeze({
        address: payment.address,
        amount: amount.amount,
        ...(memo.length === 0 ? {} : { memo }),
      }),
    ]),
    amountZat: amount.amountZat,
    memo,
    memoBytes,
  });
}

function parseJsonObject(method, value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${method} returned malformed data`);
    }
  }
  if (!isRecord(parsed)) {
    throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${method} returned malformed data`);
  }
  return parsed;
}

function parseNativeRecipientValidation(value) {
  const operation = "Recipient validation";
  const record = parseJsonObject(operation, value);
  if (!hasExactKeys(record, ["schema_version", "valid", "network", "recipient_kind", "canonical_address", "error"])) {
    throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${operation} returned malformed data`);
  }
  if (record.schema_version !== 1 || record.network !== WCASH_NETWORK || typeof record.valid !== "boolean") {
    throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${operation} returned malformed data`);
  }

  if (record.valid) {
    if (
      record.recipient_kind !== "ironwood" ||
      typeof record.canonical_address !== "string" ||
      record.canonical_address.length < 16 ||
      record.error !== null
    ) {
      throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${operation} returned malformed data`);
    }
  } else if (
    record.recipient_kind !== null ||
    record.canonical_address !== null ||
    !hasExactKeys(record.error, ["code", "message"]) ||
    record.error.code !== "invalid_recipient" ||
    typeof record.error.message !== "string" ||
    record.error.message.length === 0
  ) {
    throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${operation} returned malformed data`);
  }

  return Object.freeze({
    schema_version: 1,
    valid: record.valid,
    network: WCASH_NETWORK,
    recipient_kind: record.valid ? "ironwood" : null,
    canonical_address: record.valid ? record.canonical_address : null,
    error: record.valid ? null : Object.freeze({ code: "invalid_recipient", message: record.error.message }),
  });
}

function requireTxid(value, operation) {
  if (typeof value !== "string" || !TXID_PATTERN.test(value)) {
    throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${operation} returned malformed data`);
  }
  return value;
}

function requireU32(value, operation) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${operation} returned malformed data`);
  }
  return value;
}

function parseBroadcast(value, expectedTxid, operation) {
  if (!hasExactKeys(value, ["txid", "disposition", "status"])) {
    throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${operation} returned malformed data`);
  }
  if (value.txid !== expectedTxid || (value.disposition !== "submitted" && value.disposition !== "already_known")) {
    throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${operation} returned malformed data`);
  }
  if (!isRecord(value.status) || typeof value.status.state !== "string") {
    throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${operation} returned malformed data`);
  }
  if (value.status.state === "mempool") {
    if (!hasExactKeys(value.status, ["state"])) {
      throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${operation} returned malformed data`);
    }
    return Object.freeze({
      txid: expectedTxid,
      disposition: value.disposition,
      status: Object.freeze({ state: "mempool" }),
    });
  }
  if (value.status.state === "mined") {
    if (!hasExactKeys(value.status, ["state", "height"])) {
      throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${operation} returned malformed data`);
    }
    return Object.freeze({
      txid: expectedTxid,
      disposition: value.disposition,
      status: Object.freeze({ state: "mined", height: requireU32(value.status.height, operation) }),
    });
  }
  throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${operation} returned malformed data`);
}

function parseNativeOperationEnvelope(value, expectedOperation) {
  const operation = "Transaction operation";
  const record = parseJsonObject(operation, value);
  if (
    !hasExactKeys(record, [
      "schema_version",
      "operation",
      "outcome",
      "txid",
      "branch_id",
      "expiry_height",
      "target_height",
      "fee_zat",
      "internal_change_receiver_verified",
      "broadcast",
      "recovery",
    ]) ||
    record.schema_version !== 1 ||
    record.operation !== expectedOperation ||
    (record.outcome !== "broadcast" && record.outcome !== "recovery_required")
  ) {
    throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${operation} returned malformed data`);
  }
  const txid = requireTxid(record.txid, operation);
  if (record.branch_id !== WCASH_BRANCH_ID) {
    throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${operation} returned the wrong branch identity`);
  }
  const expiryHeight = requireU32(record.expiry_height, operation);
  const targetHeight = record.target_height === null ? null : requireU32(record.target_height, operation);
  const feeZat = record.fee_zat;
  if (feeZat !== null && (typeof feeZat !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(feeZat))) {
    throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${operation} returned malformed data`);
  }
  if (
    record.internal_change_receiver_verified !== null &&
    typeof record.internal_change_receiver_verified !== "boolean"
  ) {
    throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${operation} returned malformed data`);
  }
  if (
    (feeZat !== null && BigInt(feeZat) > MAX_MONEY_ZAT) ||
    (expectedOperation === "rebroadcast_pending" &&
      (targetHeight !== null || feeZat !== null || record.internal_change_receiver_verified !== null)) ||
    (expectedOperation !== "rebroadcast_pending" &&
      (targetHeight === null || feeZat === null || record.internal_change_receiver_verified !== true))
  ) {
    throw new WcashTransactionBoundaryError(
      "NATIVE_DATA_INVALID",
      `${operation} returned invalid operation-specific metadata`,
    );
  }

  let broadcast = null;
  let recovery = null;
  if (record.outcome === "broadcast") {
    if (record.recovery !== null) {
      throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${operation} returned malformed data`);
    }
    broadcast = parseBroadcast(record.broadcast, txid, operation);
  } else {
    if (
      record.broadcast !== null ||
      !hasExactKeys(record.recovery, ["code", "message"]) ||
      record.recovery.code !== "exact_transaction_rebroadcast_required" ||
      typeof record.recovery.message !== "string" ||
      record.recovery.message.length === 0 ||
      record.recovery.message.length > 2048
    ) {
      throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${operation} returned malformed data`);
    }
    recovery = Object.freeze({ code: record.recovery.code, message: RECOVERY_MESSAGE });
  }

  return Object.freeze({
    schema_version: 1,
    operation: expectedOperation,
    outcome: record.outcome,
    txid,
    branch_id: WCASH_BRANCH_ID,
    expiry_height: expiryHeight,
    target_height: targetHeight,
    fee_zat: feeZat,
    internal_change_receiver_verified: record.internal_change_receiver_verified,
    broadcast,
    recovery,
  });
}

function parseNativePendingTransactions(value) {
  const operation = "Pending transactions";
  const record = parseJsonObject(operation, value);
  if (
    !hasExactKeys(record, ["schema_version", "transactions", "next_cursor"]) ||
    record.schema_version !== 1 ||
    !Array.isArray(record.transactions) ||
    record.transactions.length > 25 ||
    (record.next_cursor !== null &&
      (typeof record.next_cursor !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(record.next_cursor)))
  ) {
    throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${operation} returned malformed data`);
  }
  const transactions = record.transactions.map((transaction) => {
    if (
      !hasExactKeys(transaction, ["txid", "branch_id", "expiry_height"]) ||
      transaction.branch_id !== WCASH_BRANCH_ID
    ) {
      throw new WcashTransactionBoundaryError("NATIVE_DATA_INVALID", `${operation} returned malformed data`);
    }
    return Object.freeze({
      txid: requireTxid(transaction.txid, operation),
      branch_id: WCASH_BRANCH_ID,
      expiry_height: requireU32(transaction.expiry_height, operation),
    });
  });
  return Object.freeze({
    schema_version: 1,
    transactions: Object.freeze(transactions),
    next_cursor: record.next_cursor,
  });
}

function requireCanonicalTxid(value) {
  if (typeof value !== "string" || !TXID_PATTERN.test(value)) {
    throw new WcashTransactionBoundaryError(
      "INVALID_TXID",
      "Pending transaction ID must be 64 lowercase hex characters",
    );
  }
  return value;
}

function requirePendingCursor(value) {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/.test(value) ||
    value.length > 20 ||
    BigInt(value) > 0xffff_ffff_ffff_ffffn
  ) {
    throw new WcashTransactionBoundaryError("INVALID_CURSOR", "Pending transaction cursor is invalid");
  }
  return value;
}

function visibleText(value) {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
    (character) => `\\u{${character.codePointAt(0).toString(16).toUpperCase()}}`,
  );
}

function buildSendConfirmation(request, canonicalAddress) {
  const payment = request.payments[0];
  const memoDisplay = request.memo.length === 0 ? "(none)" : visibleText(request.memo);
  return Object.freeze({
    type: "warning",
    title: `Confirm ${WCASH_NETWORK} payment`,
    message: `Send ${payment.amount} ${WCASH_TICKER} on ${WCASH_NETWORK}?`,
    detail: [
      `Recipient:\n${canonicalAddress}`,
      `Amount: ${payment.amount} ${WCASH_TICKER}`,
      `Amount in zatoshis: ${request.amountZat}`,
      `Memo (${request.memoBytes} UTF-8 bytes):\n${memoDisplay}`,
      "The exact ZIP-317 network fee will be calculated during signing and added to this payment.",
      "This action signs and broadcasts a real Wcash Testnet transaction.",
    ].join("\n\n"),
    buttons: ["Sign and broadcast", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
}

function buildShieldConfirmation() {
  return Object.freeze({
    type: "warning",
    title: `Confirm ${WCASH_NETWORK} shielding`,
    message: `Shield mature mining rewards on ${WCASH_NETWORK}?`,
    detail: [
      "Destination: this wallet's own private Ironwood receiver.",
      "Up to 100 mature transparent coinbase inputs will be selected.",
      "The exact ZIP-317 network fee will be calculated during signing and deducted from the shielded value.",
      "This action signs and broadcasts a real Wcash Testnet transaction.",
    ].join("\n\n"),
    buttons: ["Shield and broadcast", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
}

function cancelledOperation(operation) {
  return Object.freeze({ schema_version: 1, operation, outcome: "cancelled" });
}

function requireFunction(owner, method) {
  if (!owner || typeof owner[method] !== "function") {
    throw new TypeError(`${method} must be a function`);
  }
}

function createWcashTransactionController(dependencies) {
  [
    "validateRecipientNative",
    "sendAndBroadcast",
    "shieldCoinbaseAndBroadcast",
    "pendingTransactionsNative",
    "rebroadcastPendingNative",
    "confirmSend",
    "confirmShield",
  ].forEach((method) => requireFunction(dependencies, method));

  async function validateRecipient(address) {
    if (typeof address !== "string" || address.length < 16 || address.length > 512 || address !== address.trim()) {
      throw new WcashTransactionBoundaryError("INVALID_RECIPIENT", "Enter a canonical Wcash Testnet recipient");
    }
    return parseNativeRecipientValidation(await dependencies.validateRecipientNative(address));
  }

  async function send(value) {
    const request = parseRendererSendRequest(value);
    const validation = await validateRecipient(request.payments[0].address);
    if (!validation.valid) {
      throw new WcashTransactionBoundaryError("INVALID_RECIPIENT", validation.error.message);
    }
    const payment = Object.freeze({
      address: validation.canonical_address,
      amount: request.payments[0].amount,
      ...(request.memo.length === 0 ? {} : { memo: request.memo }),
    });
    const nativeRequest = Object.freeze({ payments: Object.freeze([payment]) });
    const confirmed = await dependencies.confirmSend(buildSendConfirmation(request, validation.canonical_address));
    if (confirmed !== true) return cancelledOperation("send");

    return parseNativeOperationEnvelope(await dependencies.sendAndBroadcast(JSON.stringify(nativeRequest)), "send");
  }

  async function shieldCoinbase() {
    const confirmed = await dependencies.confirmShield(buildShieldConfirmation());
    if (confirmed !== true) return cancelledOperation("shield_coinbase");
    return parseNativeOperationEnvelope(await dependencies.shieldCoinbaseAndBroadcast(), "shield_coinbase");
  }

  async function pendingTransactions(afterCursor) {
    const cursor = requirePendingCursor(afterCursor);
    return parseNativePendingTransactions(await dependencies.pendingTransactionsNative(cursor));
  }

  async function rebroadcastPending(txid) {
    const canonicalTxid = requireCanonicalTxid(txid);
    return parseNativeOperationEnvelope(
      await dependencies.rebroadcastPendingNative(canonicalTxid),
      "rebroadcast_pending",
    );
  }

  return Object.freeze({ validateRecipient, send, shieldCoinbase, pendingTransactions, rebroadcastPending });
}

module.exports = {
  MAX_MEMO_BYTES,
  MAX_MONEY_ZAT,
  RECOVERY_MESSAGE,
  WCASH_BRANCH_ID,
  WCASH_NETWORK,
  WCASH_TICKER,
  WcashTransactionBoundaryError,
  buildSendConfirmation,
  buildShieldConfirmation,
  cancelledOperation,
  createWcashTransactionController,
  parseCanonicalAmount,
  parseNativeOperationEnvelope,
  parseNativePendingTransactions,
  parseNativeRecipientValidation,
  parseRendererSendRequest,
  requireCanonicalTxid,
  requirePendingCursor,
  utf8ByteLength,
  visibleText,
};
