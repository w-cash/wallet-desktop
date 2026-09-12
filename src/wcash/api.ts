const ZATOSHIS_PER_COIN = 100_000_000n;
const MAX_MONEY_ZAT = 21_000_000n * ZATOSHIS_PER_COIN;
const WCASH_BRANCH_ID = "b3cfd27e";
const WCASH_REGTEST_BRANCH_ID = "c3a6678a";
const TXID_PATTERN = /^[0-9a-f]{64}$/;
const RECOVERY_MESSAGE = "The signed transaction is stored. Retry this exact transaction; do not create a replacement.";
const REVIEW_MESSAGE =
  "The signed transaction is stored but needs review. Refresh signed pending transactions; do not create a replacement.";
const REJECTION_MESSAGE =
  "The Wcash node rejected this signed transaction. Wait for it to expire before creating a replacement.";
const WCASH_SEED_SCHEME = "bip39-english-24-empty-passphrase-v1";

export interface WcashProductConfig {
  readonly profile: "testnet" | "local-regtest";
  readonly productName: string;
  readonly network: "Wcash Testnet" | "Wcash Regtest";
  readonly ticker: "TWC";
  readonly endpoint: "https://wallet-testnet.wcashexplorer.com:443" | "http://127.0.0.1:48234";
  readonly storageNamespace: "wcashtestnet-v5" | "wcashregtest-v5";
  readonly branchId: typeof WCASH_BRANCH_ID | typeof WCASH_REGTEST_BRANCH_ID;
  readonly runtimeReady: boolean;
  readonly coreRevision: string | null;
}

export interface WcashWalletMetadata {
  readonly accountId: string;
  readonly birthdayHeight: number;
}

interface WcashStatusBase {
  readonly profile: WcashProductConfig["profile"];
  readonly network: WcashProductConfig["network"];
  readonly ticker: "TWC";
  readonly endpoint: WcashProductConfig["endpoint"];
  readonly storageNamespace: WcashProductConfig["storageNamespace"];
  readonly branchId: WcashProductConfig["branchId"];
}

export type WcashStatus =
  | (WcashStatusBase & { readonly state: "no-database-no-secret" })
  | (WcashStatusBase & {
      readonly state: "secret-only-pending";
      readonly intent: "create" | "restore";
      readonly birthdayHeight: number;
    })
  | (WcashStatusBase & {
      readonly state: "database-and-secret-ready";
      readonly wallet: WcashWalletMetadata;
    })
  | (WcashStatusBase & {
      readonly state: "database-secret-backup-required";
      readonly wallet: WcashWalletMetadata;
    })
  | (WcashStatusBase & {
      readonly state: "database-only-fail-closed";
      readonly wallet: WcashWalletMetadata;
    });

export interface WcashReceivers {
  readonly ironwoodAddress: string;
  readonly transparentCoinbaseAddress: string;
}

export interface WcashAccountBalance {
  readonly accountId: string;
  readonly ironwoodTotalZat: bigint;
  readonly ironwoodSpendableZat: bigint;
  readonly ironwoodPendingZat: bigint;
  readonly transparentTotalZat: bigint;
  readonly transparentCoinbaseTotalZat: bigint;
  readonly transparentCoinbaseSpendableZat: bigint;
  readonly transparentCoinbasePendingZat: bigint;
}

export interface WcashBalance {
  readonly chainTipHeight: number;
  readonly fullyScannedHeight: number;
  readonly synchronized: boolean;
  readonly accounts: readonly WcashAccountBalance[];
}

export interface WcashCreatedWallet {
  readonly wallet: WcashWalletMetadata;
  readonly recoveryPhrase: string;
}

export interface WcashSendRequest {
  readonly payments: readonly [
    {
      readonly address: string;
      readonly amount: string;
      readonly memo?: string;
    },
  ];
}

export type WcashRecipientValidation =
  | {
      readonly schemaVersion: 1;
      readonly valid: true;
      readonly network: WcashProductConfig["network"];
      readonly recipientKind: "ironwood";
      readonly canonicalAddress: string;
      readonly error: null;
    }
  | {
      readonly schemaVersion: 1;
      readonly valid: false;
      readonly network: WcashProductConfig["network"];
      readonly recipientKind: null;
      readonly canonicalAddress: null;
      readonly error: { readonly code: "invalid_recipient"; readonly message: string };
    };

export interface WcashPendingTransaction {
  readonly txid: string;
  readonly branchId: WcashProductConfig["branchId"];
  readonly expiryHeight: number;
  readonly lifecycle: "unexpired" | "expired" | "tip_unknown";
  readonly rebroadcastAllowed: boolean;
  readonly blocksNewSigning: boolean;
}

export interface WcashPendingTransactions {
  readonly schemaVersion: 1;
  readonly exactTipHeight: number | null;
  readonly transactions: readonly WcashPendingTransaction[];
  readonly nextCursor: string | null;
}

export type WcashOperation = "send" | "shield_coinbase" | "rebroadcast_pending";

export interface WcashBroadcast {
  readonly txid: string;
  readonly disposition: "submitted" | "already_known";
  readonly status: { readonly state: "mempool" } | { readonly state: "mined"; readonly height: number };
}

export type WcashOperationResult =
  | { readonly schemaVersion: 1; readonly operation: WcashOperation; readonly outcome: "cancelled" }
  | {
      readonly schemaVersion: 1;
      readonly operation: WcashOperation;
      readonly outcome: "broadcast" | "rejected" | "recovery_required" | "expired";
      readonly txid: string;
      readonly branchId: WcashProductConfig["branchId"];
      readonly expiryHeight: number | null;
      readonly targetHeight: number | null;
      readonly feeZat: bigint | null;
      readonly internalChangeReceiverVerified: boolean | null;
      readonly exactTipHeight: number;
      readonly broadcast: WcashBroadcast | null;
      readonly recovery: {
        readonly code: "exact_transaction_rebroadcast_required" | "exact_transaction_review_required";
        readonly message: string;
        readonly txids: readonly string[];
      } | null;
      readonly rejection: {
        readonly code: "transaction_rejected";
        readonly nodeCode: number;
        readonly message: string;
      } | null;
    };

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireExactKeys = (record: UnknownRecord, expected: readonly string[], operation: string): void => {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${operation} returned malformed data`);
  }
};

export const WCASH_TESTNET_PRODUCT_CONFIG: WcashProductConfig = Object.freeze({
  profile: "testnet",
  productName: "Wcash Warden Testnet",
  network: "Wcash Testnet",
  ticker: "TWC",
  endpoint: "https://wallet-testnet.wcashexplorer.com:443",
  storageNamespace: "wcashtestnet-v5",
  branchId: WCASH_BRANCH_ID,
  runtimeReady: true,
  coreRevision: "db28e549bda764adcc5ba48c295a3e33c033d638",
});

export const WCASH_LOCAL_REGTEST_PRODUCT_CONFIG: WcashProductConfig = Object.freeze({
  profile: "local-regtest",
  productName: "Wcash Warden Local Regtest",
  network: "Wcash Regtest",
  ticker: "TWC",
  endpoint: "http://127.0.0.1:48234",
  storageNamespace: "wcashregtest-v5",
  branchId: WCASH_REGTEST_BRANCH_ID,
  runtimeReady: true,
  coreRevision: "db28e549bda764adcc5ba48c295a3e33c033d638",
});

const PRODUCT_CONFIG_KEYS = [
  "profile",
  "productName",
  "network",
  "ticker",
  "endpoint",
  "storageNamespace",
  "branchId",
  "runtimeReady",
  "coreRevision",
] as const;

export const requireWcashProductConfig = (value: unknown): WcashProductConfig => {
  if (!isRecord(value)) throw new Error("Wallet runtime profile is unavailable");
  requireExactKeys(value, PRODUCT_CONFIG_KEYS, "Wallet runtime profile");
  const expected =
    value.profile === "testnet"
      ? WCASH_TESTNET_PRODUCT_CONFIG
      : value.profile === "local-regtest"
        ? WCASH_LOCAL_REGTEST_PRODUCT_CONFIG
        : null;
  if (expected === null || PRODUCT_CONFIG_KEYS.some((key) => value[key] !== expected[key])) {
    throw new Error("Wallet runtime profile is invalid");
  }
  return expected;
};

const expectedRuntime = (config?: WcashProductConfig): WcashProductConfig =>
  requireWcashProductConfig(config ?? WCASH_TESTNET_PRODUCT_CONFIG);

const parsePayload = (payload: unknown, operation: string): unknown => {
  if (typeof payload !== "string") return payload;

  try {
    return JSON.parse(payload) as unknown;
  } catch {
    throw new Error(`${operation} returned malformed data`);
  }
};

const requireRecord = (value: unknown, operation: string): UnknownRecord => {
  const parsed = parsePayload(value, operation);
  if (!isRecord(parsed)) throw new Error(`${operation} returned malformed data`);
  return parsed;
};

const requireString = (record: UnknownRecord, key: string, operation: string): string => {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${operation} returned malformed data`);
  }
  return value;
};

const requireU32 = (record: UnknownRecord, key: string, operation: string): number => {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xffff_ffff) {
    throw new Error(`${operation} returned malformed data`);
  }
  return value as number;
};

const requireTxid = (record: UnknownRecord, key: string, operation: string): string => {
  const value = requireString(record, key, operation);
  if (!TXID_PATTERN.test(value)) throw new Error(`${operation} returned malformed data`);
  return value;
};

const requireZatoshis = (record: UnknownRecord, key: string, operation: string): bigint => {
  const value = record[key];
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  throw new Error(`${operation} returned malformed data`);
};

const optionalZatoshis = (record: UnknownRecord, key: string, operation: string): bigint =>
  record[key] === undefined ? 0n : requireZatoshis(record, key, operation);

const parseWalletMetadata = (value: unknown, operation: string): WcashWalletMetadata => {
  if (!isRecord(value)) throw new Error(`${operation} returned malformed data`);
  return {
    accountId: requireString(value, "account_id", operation),
    birthdayHeight: requireU32(value, "birthday_height", operation),
  };
};

export const parseStatus = (payload: unknown, config?: WcashProductConfig): WcashStatus => {
  const operation = "Wallet status";
  const expected = expectedRuntime(config);
  const record = requireRecord(payload, operation);
  const base: WcashStatusBase = {
    profile: requireString(record, "profile", operation) as WcashStatusBase["profile"],
    network: requireString(record, "network", operation) as WcashStatusBase["network"],
    ticker: requireString(record, "ticker", operation) as "TWC",
    endpoint: requireString(record, "endpoint", operation) as WcashStatusBase["endpoint"],
    storageNamespace: requireString(record, "storage_namespace", operation) as WcashStatusBase["storageNamespace"],
    branchId: requireString(record, "branch_id", operation) as WcashStatusBase["branchId"],
  };
  if (
    base.profile !== expected.profile ||
    base.network !== expected.network ||
    base.ticker !== expected.ticker ||
    base.endpoint !== expected.endpoint ||
    base.storageNamespace !== expected.storageNamespace ||
    base.branchId !== expected.branchId
  ) {
    throw new Error("Wallet status returned the wrong runtime identity");
  }
  switch (record.state) {
    case "no-database-no-secret":
      return { ...base, state: record.state };
    case "secret-only-pending": {
      const intent = record.intent;
      if (intent !== "create" && intent !== "restore") throw new Error(`${operation} returned malformed data`);
      const birthdayHeight = record.birthdayHeight;
      if (
        !Number.isInteger(birthdayHeight) ||
        (birthdayHeight as number) < 1 ||
        (birthdayHeight as number) > 0xffff_ffff
      ) {
        throw new Error(`${operation} returned malformed data`);
      }
      return { ...base, state: record.state, intent, birthdayHeight: birthdayHeight as number };
    }
    case "database-and-secret-ready":
    case "database-secret-backup-required":
    case "database-only-fail-closed":
      return { ...base, state: record.state, wallet: parseWalletMetadata(record.wallet, operation) };
    default:
      throw new Error(`${operation} returned malformed data`);
  }
};

export const parseCreatedWallet = (payload: unknown): WcashCreatedWallet => {
  const operation = "Wallet creation";
  const record = requireRecord(payload, operation);
  const wallet = parseWalletMetadata(record.wallet, operation);
  const recoveryPhrase = parseRecoveryPhrase(record, operation);
  return { wallet, recoveryPhrase };
};

export const parseRecoveryPhrase = (payload: unknown, operation = "Wallet backup"): string => {
  const record = requireRecord(payload, operation);
  if (requireString(record, "seed_scheme", operation) !== WCASH_SEED_SCHEME) {
    throw new Error(`${operation} returned an unsupported seed scheme`);
  }
  const recoveryPhrase = requireString(record, "recoveryPhrase", operation).trim();
  if (recoveryPhrase.split(/\s+/).length !== 24) throw new Error(`${operation} returned malformed data`);
  return recoveryPhrase;
};

export const parseOpenedWallet = (payload: unknown, operation = "Wallet open"): WcashWalletMetadata => {
  const record = requireRecord(payload, operation);
  return parseWalletMetadata(record.wallet, operation);
};

export const parseReceivers = (payload: unknown, config?: WcashProductConfig): WcashReceivers => {
  const operation = "Receiving addresses";
  const expected = expectedRuntime(config);
  const record = requireRecord(payload, operation);
  const ironwoodAddress = requireString(record, "ironwood_address", operation);
  const transparentCoinbaseAddress = requireString(record, "transparent_coinbase_address", operation);
  const ironwoodPrefix = expected.profile === "local-regtest" ? "wuregtest1" : "wutest1";
  const transparentPrefix = expected.profile === "local-regtest" ? "WR" : "WT";

  if (!ironwoodAddress.startsWith(ironwoodPrefix) || !transparentCoinbaseAddress.startsWith(transparentPrefix)) {
    throw new Error("Wallet core returned addresses for a different network");
  }
  return { ironwoodAddress, transparentCoinbaseAddress };
};

export const parseBalance = (payload: unknown): WcashBalance => {
  const operation = "Wallet balance";
  const record = requireRecord(payload, operation);
  const accounts = record.accounts;
  if (!Array.isArray(accounts)) throw new Error(`${operation} returned malformed data`);

  return {
    chainTipHeight: requireU32(record, "chain_tip_height", operation),
    fullyScannedHeight: requireU32(record, "fully_scanned_height", operation),
    synchronized: record.synchronized === true,
    accounts: accounts.map((account) => {
      if (!isRecord(account)) throw new Error(`${operation} returned malformed data`);
      return {
        accountId: requireString(account, "account_id", operation),
        ironwoodTotalZat: requireZatoshis(account, "ironwood_total_zat", operation),
        ironwoodSpendableZat: requireZatoshis(account, "ironwood_spendable_zat", operation),
        ironwoodPendingZat:
          optionalZatoshis(account, "ironwood_locked_zat", operation) +
          optionalZatoshis(account, "ironwood_pending_change_zat", operation) +
          optionalZatoshis(account, "ironwood_pending_spendability_zat", operation),
        transparentTotalZat: requireZatoshis(account, "transparent_total_zat", operation),
        transparentCoinbaseTotalZat: requireZatoshis(account, "transparent_coinbase_total_zat", operation),
        transparentCoinbaseSpendableZat: requireZatoshis(account, "transparent_coinbase_spendable_zat", operation),
        transparentCoinbasePendingZat: requireZatoshis(account, "transparent_coinbase_pending_zat", operation),
      };
    }),
  };
};

export const isExactTipBalance = (balance: WcashBalance): boolean =>
  balance.synchronized && balance.fullyScannedHeight === balance.chainTipHeight;

export const formatTwc = (value: bigint): string => {
  const whole = value / ZATOSHIS_PER_COIN;
  const fraction = (value % ZATOSHIS_PER_COIN).toString().padStart(8, "0");
  return `${whole}.${fraction}`;
};

export const parseCanonicalTwcAmount = (value: string): { readonly amount: string; readonly amountZat: bigint } => {
  if (value.length > 17 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{0,7}[1-9])?$/.test(value)) {
    throw new Error("Enter a TWC amount with no more than eight decimal places and no trailing zeroes.");
  }
  const [wholeText, fractionText = ""] = value.split(".");
  const amountZat = BigInt(wholeText) * ZATOSHIS_PER_COIN + BigInt(fractionText.padEnd(8, "0") || "0");
  if (amountZat < 1n || amountZat > MAX_MONEY_ZAT) {
    throw new Error("TWC amount must be at least 0.00000001 and no more than 21,000,000.");
  }
  return { amount: value, amountZat };
};

export const memoUtf8Bytes = (memo: string): number => new TextEncoder().encode(memo).byteLength;

export const createSendRequest = (
  addressInput: string,
  amountInput: string,
  memo: string,
  config?: WcashProductConfig,
): WcashSendRequest => {
  const expected = expectedRuntime(config);
  const address = addressInput.trim();
  if (address.length < 16 || address.length > 512) {
    throw new Error(`Enter a ${expected.network} Ironwood recipient.`);
  }
  const { amount } = parseCanonicalTwcAmount(amountInput.trim());
  if (memo.length > 512 || memoUtf8Bytes(memo) > 512) {
    throw new Error("Memo is longer than the 512-byte Wcash limit.");
  }
  const payment = Object.freeze({
    address,
    amount,
    ...(memo.length === 0 ? {} : { memo }),
  });
  return Object.freeze({ payments: Object.freeze([payment]) }) as WcashSendRequest;
};

export const parseRecipientValidation = (payload: unknown, config?: WcashProductConfig): WcashRecipientValidation => {
  const operation = "Recipient validation";
  const expected = expectedRuntime(config);
  const record = requireRecord(payload, operation);
  requireExactKeys(
    record,
    ["schema_version", "valid", "network", "recipient_kind", "canonical_address", "error"],
    operation,
  );
  if (record.schema_version !== 1 || record.network !== expected.network || typeof record.valid !== "boolean") {
    throw new Error(`${operation} returned malformed data`);
  }
  if (record.valid) {
    if (
      record.recipient_kind !== "ironwood" ||
      typeof record.canonical_address !== "string" ||
      record.canonical_address.length < 16 ||
      record.error !== null
    ) {
      throw new Error(`${operation} returned malformed data`);
    }
    return {
      schemaVersion: 1,
      valid: true,
      network: expected.network,
      recipientKind: "ironwood",
      canonicalAddress: record.canonical_address,
      error: null,
    };
  }
  if (!isRecord(record.error)) throw new Error(`${operation} returned malformed data`);
  requireExactKeys(record.error, ["code", "message"], operation);
  if (
    record.recipient_kind !== null ||
    record.canonical_address !== null ||
    record.error.code !== "invalid_recipient" ||
    typeof record.error.message !== "string" ||
    record.error.message.length === 0
  ) {
    throw new Error(`${operation} returned malformed data`);
  }
  return {
    schemaVersion: 1,
    valid: false,
    network: expected.network,
    recipientKind: null,
    canonicalAddress: null,
    error: { code: "invalid_recipient", message: record.error.message },
  };
};

const parseBroadcast = (value: unknown, txid: string, operation: string): WcashBroadcast => {
  if (!isRecord(value)) throw new Error(`${operation} returned malformed data`);
  requireExactKeys(value, ["txid", "disposition", "status"], operation);
  if (
    requireTxid(value, "txid", operation) !== txid ||
    (value.disposition !== "submitted" && value.disposition !== "already_known") ||
    !isRecord(value.status)
  ) {
    throw new Error(`${operation} returned malformed data`);
  }
  if (value.status.state === "mempool") {
    requireExactKeys(value.status, ["state"], operation);
    return { txid, disposition: value.disposition, status: { state: "mempool" } };
  }
  if (value.status.state === "mined") {
    requireExactKeys(value.status, ["state", "height"], operation);
    return {
      txid,
      disposition: value.disposition,
      status: { state: "mined", height: requireU32(value.status, "height", operation) },
    };
  }
  throw new Error(`${operation} returned malformed data`);
};

const parseRecoveryTxids = (
  value: unknown,
  expectedTxid: string,
  allowMultiple: boolean,
  operation: string,
): readonly string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 25) {
    throw new Error(`${operation} returned malformed data`);
  }
  const txids = value.map((entry) => {
    if (typeof entry !== "string" || !TXID_PATTERN.test(entry)) {
      throw new Error(`${operation} returned malformed data`);
    }
    return entry;
  });
  if (txids[0] !== expectedTxid || new Set(txids).size !== txids.length || (!allowMultiple && txids.length !== 1)) {
    throw new Error(`${operation} returned malformed data`);
  }
  return Object.freeze(txids);
};

export const parseOperationResult = (
  payload: unknown,
  expectedOperation: WcashOperation,
  config?: WcashProductConfig,
): WcashOperationResult => {
  const operation = "Transaction operation";
  const expected = expectedRuntime(config);
  const record = requireRecord(payload, operation);
  if (record.outcome === "cancelled") {
    requireExactKeys(record, ["schema_version", "operation", "outcome"], operation);
    if (record.schema_version !== 1 || record.operation !== expectedOperation) {
      throw new Error(`${operation} returned malformed data`);
    }
    return { schemaVersion: 1, operation: expectedOperation, outcome: "cancelled" };
  }

  requireExactKeys(
    record,
    [
      "schema_version",
      "operation",
      "outcome",
      "txid",
      "branch_id",
      "expiry_height",
      "target_height",
      "fee_zat",
      "internal_change_receiver_verified",
      "exact_tip_height",
      "broadcast",
      "recovery",
      "rejection",
    ],
    operation,
  );
  if (
    record.schema_version !== 1 ||
    record.operation !== expectedOperation ||
    (record.outcome !== "broadcast" &&
      record.outcome !== "rejected" &&
      record.outcome !== "recovery_required" &&
      record.outcome !== "expired") ||
    record.branch_id !== expected.branchId
  ) {
    throw new Error(`${operation} returned malformed data`);
  }
  const txid = requireTxid(record, "txid", operation);
  const exactTipHeight = requireU32(record, "exact_tip_height", operation);
  const expiryHeight = record.expiry_height === null ? null : requireU32(record, "expiry_height", operation);
  const targetHeight = record.target_height === null ? null : requireU32(record, "target_height", operation);
  const feeZat = (() => {
    if (record.fee_zat === null) return null;
    if (
      typeof record.fee_zat !== "string" ||
      record.fee_zat.length > 16 ||
      !/^(?:0|[1-9][0-9]*)$/.test(record.fee_zat)
    ) {
      throw new Error(`${operation} returned malformed data`);
    }
    const value = BigInt(record.fee_zat);
    if (value > MAX_MONEY_ZAT) throw new Error(`${operation} returned malformed data`);
    return value;
  })();
  if (
    record.internal_change_receiver_verified !== null &&
    typeof record.internal_change_receiver_verified !== "boolean"
  ) {
    throw new Error(`${operation} returned malformed data`);
  }

  let broadcast: WcashBroadcast | null = null;
  let recovery: Exclude<WcashOperationResult, { outcome: "cancelled" }>["recovery"] = null;
  let rejection: Exclude<WcashOperationResult, { outcome: "cancelled" }>["rejection"] = null;
  let persistedReview = false;

  if (record.outcome === "broadcast") {
    if (record.recovery !== null || record.rejection !== null || record.broadcast === null) {
      throw new Error(`${operation} returned malformed data`);
    }
    broadcast = parseBroadcast(record.broadcast, txid, operation);
  } else if (record.outcome === "recovery_required") {
    if (!isRecord(record.recovery)) throw new Error(`${operation} returned malformed data`);
    requireExactKeys(record.recovery, ["code", "message", "txids"], operation);
    if (
      record.broadcast !== null ||
      record.rejection !== null ||
      (record.recovery.code !== "exact_transaction_rebroadcast_required" &&
        record.recovery.code !== "exact_transaction_review_required") ||
      typeof record.recovery.message !== "string" ||
      record.recovery.message.length === 0 ||
      record.recovery.message.length > 4096 ||
      new TextEncoder().encode(record.recovery.message).byteLength > 4096
    ) {
      throw new Error(`${operation} returned malformed data`);
    }
    const expectedMessage =
      record.recovery.code === "exact_transaction_rebroadcast_required" ? RECOVERY_MESSAGE : REVIEW_MESSAGE;
    if (record.recovery.message !== expectedMessage) throw new Error(`${operation} returned malformed data`);
    persistedReview =
      record.recovery.code === "exact_transaction_review_required" &&
      expectedOperation !== "rebroadcast_pending" &&
      expiryHeight === null &&
      targetHeight === null &&
      feeZat === null &&
      record.internal_change_receiver_verified === null;
    recovery = {
      code: record.recovery.code,
      message: expectedMessage,
      txids: parseRecoveryTxids(record.recovery.txids, txid, persistedReview, operation),
    };
  } else if (record.outcome === "rejected") {
    if (!isRecord(record.rejection)) throw new Error(`${operation} returned malformed data`);
    requireExactKeys(record.rejection, ["code", "node_code", "message"], operation);
    if (
      record.broadcast !== null ||
      record.recovery !== null ||
      record.rejection.code !== "transaction_rejected" ||
      !Number.isInteger(record.rejection.node_code) ||
      record.rejection.node_code === 0 ||
      (record.rejection.node_code as number) < -0x8000_0000 ||
      (record.rejection.node_code as number) > 0x7fff_ffff ||
      record.rejection.message !== REJECTION_MESSAGE
    ) {
      throw new Error(`${operation} returned malformed data`);
    }
    rejection = {
      code: "transaction_rejected",
      nodeCode: record.rejection.node_code as number,
      message: REJECTION_MESSAGE,
    };
  } else if (
    expectedOperation !== "rebroadcast_pending" ||
    record.broadcast !== null ||
    record.recovery !== null ||
    record.rejection !== null
  ) {
    throw new Error(`${operation} returned malformed data`);
  }

  const rebroadcastMetadata =
    expiryHeight !== null &&
    targetHeight === null &&
    feeZat === null &&
    record.internal_change_receiver_verified === null;
  const signedMetadata =
    expiryHeight !== null &&
    targetHeight !== null &&
    feeZat !== null &&
    record.internal_change_receiver_verified === true;
  if (
    (!persistedReview && expectedOperation === "rebroadcast_pending" && !rebroadcastMetadata) ||
    (!persistedReview && expectedOperation !== "rebroadcast_pending" && !signedMetadata) ||
    (persistedReview && recovery === null) ||
    (!persistedReview &&
      expectedOperation !== "rebroadcast_pending" &&
      (expiryHeight === null || expiryHeight === 0 || exactTipHeight >= expiryHeight)) ||
    (record.outcome === "expired" && (expiryHeight === null || expiryHeight === 0 || exactTipHeight < expiryHeight)) ||
    (expectedOperation === "rebroadcast_pending" &&
      record.outcome !== "expired" &&
      expiryHeight !== null &&
      expiryHeight !== 0 &&
      exactTipHeight >= expiryHeight)
  ) {
    throw new Error(`${operation} returned malformed data`);
  }

  return {
    schemaVersion: 1,
    operation: expectedOperation,
    outcome: record.outcome,
    txid,
    branchId: expected.branchId,
    expiryHeight,
    targetHeight,
    feeZat,
    internalChangeReceiverVerified: record.internal_change_receiver_verified,
    exactTipHeight,
    broadcast,
    recovery,
    rejection,
  };
};

export const parsePendingTransactions = (payload: unknown, config?: WcashProductConfig): WcashPendingTransactions => {
  const operation = "Pending transactions";
  const expected = expectedRuntime(config);
  const record = requireRecord(payload, operation);
  requireExactKeys(record, ["schema_version", "exact_tip_height", "transactions", "next_cursor"], operation);
  if (
    record.schema_version !== 1 ||
    !Array.isArray(record.transactions) ||
    record.transactions.length > 25 ||
    (record.exact_tip_height !== null &&
      (!Number.isInteger(record.exact_tip_height) ||
        (record.exact_tip_height as number) < 0 ||
        (record.exact_tip_height as number) > 0xffff_ffff)) ||
    (record.next_cursor !== null &&
      (typeof record.next_cursor !== "string" ||
        record.next_cursor.length > 20 ||
        !/^(?:0|[1-9][0-9]*)$/.test(record.next_cursor) ||
        BigInt(record.next_cursor) > 0xffff_ffff_ffff_ffffn))
  ) {
    throw new Error(`${operation} returned malformed data`);
  }
  const exactTipHeight = record.exact_tip_height as number | null;
  const seenTxids = new Set<string>();
  const transactions = record.transactions.map((value): WcashPendingTransaction => {
    if (!isRecord(value)) throw new Error(`${operation} returned malformed data`);
    requireExactKeys(
      value,
      ["txid", "branch_id", "expiry_height", "lifecycle", "rebroadcast_allowed", "blocks_new_signing"],
      operation,
    );
    if (value.branch_id !== expected.branchId) throw new Error(`${operation} returned malformed data`);
    const transactionId = requireTxid(value, "txid", operation);
    if (seenTxids.has(transactionId)) throw new Error(`${operation} returned malformed data`);
    seenTxids.add(transactionId);
    const expiryHeight = requireU32(value, "expiry_height", operation);
    const lifecycle =
      exactTipHeight === null
        ? "tip_unknown"
        : expiryHeight !== 0 && exactTipHeight >= expiryHeight
          ? "expired"
          : "unexpired";
    const rebroadcastAllowed = lifecycle === "unexpired";
    const blocksNewSigning = lifecycle !== "expired";
    if (
      value.lifecycle !== lifecycle ||
      value.rebroadcast_allowed !== rebroadcastAllowed ||
      value.blocks_new_signing !== blocksNewSigning
    ) {
      throw new Error(`${operation} returned malformed data`);
    }
    return {
      txid: transactionId,
      branchId: expected.branchId,
      expiryHeight,
      lifecycle,
      rebroadcastAllowed,
      blocksNewSigning,
    };
  });
  return {
    schemaVersion: 1,
    exactTipHeight,
    transactions,
    nextCursor: record.next_cursor as string | null,
  };
};

export const normalizeRecoveryPhrase = (phrase: string): string => phrase.trim().toLowerCase().split(/\s+/).join(" ");

export const require24WordRecoveryPhrase = (phrase: string): string => {
  const normalized = normalizeRecoveryPhrase(phrase);
  if (normalized.split(" ").length !== 24) throw new Error("Enter the complete 24-word recovery phrase.");
  return normalized;
};

export const publicErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message && !/abandon|seed|mnemonic/i.test(error.message)) return error.message;
  return "The wallet operation failed. Verify the current wallet state before trying again.";
};
