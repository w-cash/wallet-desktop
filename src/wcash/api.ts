const ZATOSHIS_PER_COIN = 100_000_000n;
const MAX_MONEY_ZAT = 21_000_000n * ZATOSHIS_PER_COIN;
const WCASH_BRANCH_ID = "b3cfd27e";
const TXID_PATTERN = /^[0-9a-f]{64}$/;
const RECOVERY_MESSAGE = "The signed transaction is stored. Retry this exact transaction; do not create a replacement.";
const WCASH_SEED_SCHEME = "bip39-english-24-empty-passphrase-v1";

export interface WcashProductConfig {
  readonly productName: string;
  readonly network: string;
  readonly ticker: string;
  readonly runtimeReady: boolean;
  readonly coreRevision: string | null;
}

export interface WcashWalletMetadata {
  readonly accountId: string;
  readonly birthdayHeight: number;
}

interface WcashStatusBase {
  readonly network?: string;
  readonly ticker?: string;
  readonly storageNamespace?: string;
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
      readonly network: "Wcash Testnet";
      readonly recipientKind: "ironwood";
      readonly canonicalAddress: string;
      readonly error: null;
    }
  | {
      readonly schemaVersion: 1;
      readonly valid: false;
      readonly network: "Wcash Testnet";
      readonly recipientKind: null;
      readonly canonicalAddress: null;
      readonly error: { readonly code: "invalid_recipient"; readonly message: string };
    };

export interface WcashPendingTransaction {
  readonly txid: string;
  readonly branchId: typeof WCASH_BRANCH_ID;
  readonly expiryHeight: number;
}

export interface WcashPendingTransactions {
  readonly schemaVersion: 1;
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
      readonly outcome: "broadcast" | "recovery_required";
      readonly txid: string;
      readonly branchId: typeof WCASH_BRANCH_ID;
      readonly expiryHeight: number;
      readonly targetHeight: number | null;
      readonly feeZat: bigint | null;
      readonly internalChangeReceiverVerified: boolean | null;
      readonly broadcast: WcashBroadcast | null;
      readonly recovery: { readonly code: "exact_transaction_rebroadcast_required"; readonly message: string } | null;
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

export const parseStatus = (payload: unknown): WcashStatus => {
  const operation = "Wallet status";
  const record = requireRecord(payload, operation);
  const base: WcashStatusBase = {
    ...(record.network === undefined ? {} : { network: requireString(record, "network", operation) }),
    ...(record.ticker === undefined ? {} : { ticker: requireString(record, "ticker", operation) }),
    ...(record.storage_namespace === undefined
      ? {}
      : { storageNamespace: requireString(record, "storage_namespace", operation) }),
  };
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

export const parseReceivers = (payload: unknown): WcashReceivers => {
  const operation = "Receiving addresses";
  const record = requireRecord(payload, operation);
  const ironwoodAddress = requireString(record, "ironwood_address", operation);
  const transparentCoinbaseAddress = requireString(record, "transparent_coinbase_address", operation);

  if (!ironwoodAddress.startsWith("wutest1") || !transparentCoinbaseAddress.startsWith("WT")) {
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

export const createSendRequest = (addressInput: string, amountInput: string, memo: string): WcashSendRequest => {
  const address = addressInput.trim();
  if (address.length < 16 || address.length > 512) throw new Error("Enter a Wcash Testnet Ironwood recipient.");
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

export const parseRecipientValidation = (payload: unknown): WcashRecipientValidation => {
  const operation = "Recipient validation";
  const record = requireRecord(payload, operation);
  requireExactKeys(
    record,
    ["schema_version", "valid", "network", "recipient_kind", "canonical_address", "error"],
    operation,
  );
  if (record.schema_version !== 1 || record.network !== "Wcash Testnet" || typeof record.valid !== "boolean") {
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
      network: "Wcash Testnet",
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
    network: "Wcash Testnet",
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

export const parseOperationResult = (payload: unknown, expectedOperation: WcashOperation): WcashOperationResult => {
  const operation = "Transaction operation";
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
      "broadcast",
      "recovery",
    ],
    operation,
  );
  if (
    record.schema_version !== 1 ||
    record.operation !== expectedOperation ||
    (record.outcome !== "broadcast" && record.outcome !== "recovery_required") ||
    record.branch_id !== WCASH_BRANCH_ID
  ) {
    throw new Error(`${operation} returned malformed data`);
  }
  const txid = requireTxid(record, "txid", operation);
  const expiryHeight = requireU32(record, "expiry_height", operation);
  const targetHeight = record.target_height === null ? null : requireU32(record, "target_height", operation);
  const feeZat = record.fee_zat === null ? null : requireZatoshis(record, "fee_zat", operation);
  if (
    record.internal_change_receiver_verified !== null &&
    typeof record.internal_change_receiver_verified !== "boolean"
  ) {
    throw new Error(`${operation} returned malformed data`);
  }
  if (
    (feeZat !== null && feeZat > MAX_MONEY_ZAT) ||
    (expectedOperation === "rebroadcast_pending" &&
      (targetHeight !== null || feeZat !== null || record.internal_change_receiver_verified !== null)) ||
    (expectedOperation !== "rebroadcast_pending" &&
      (targetHeight === null || feeZat === null || record.internal_change_receiver_verified !== true))
  ) {
    throw new Error(`${operation} returned malformed data`);
  }

  if (record.outcome === "broadcast") {
    if (record.recovery !== null) throw new Error(`${operation} returned malformed data`);
    return {
      schemaVersion: 1,
      operation: expectedOperation,
      outcome: "broadcast",
      txid,
      branchId: WCASH_BRANCH_ID,
      expiryHeight,
      targetHeight,
      feeZat,
      internalChangeReceiverVerified: record.internal_change_receiver_verified,
      broadcast: parseBroadcast(record.broadcast, txid, operation),
      recovery: null,
    };
  }

  if (!isRecord(record.recovery)) throw new Error(`${operation} returned malformed data`);
  requireExactKeys(record.recovery, ["code", "message"], operation);
  if (
    record.broadcast !== null ||
    record.recovery.code !== "exact_transaction_rebroadcast_required" ||
    typeof record.recovery.message !== "string" ||
    record.recovery.message.length === 0 ||
    record.recovery.message.length > 2048
  ) {
    throw new Error(`${operation} returned malformed data`);
  }
  return {
    schemaVersion: 1,
    operation: expectedOperation,
    outcome: "recovery_required",
    txid,
    branchId: WCASH_BRANCH_ID,
    expiryHeight,
    targetHeight,
    feeZat,
    internalChangeReceiverVerified: record.internal_change_receiver_verified,
    broadcast: null,
    recovery: { code: "exact_transaction_rebroadcast_required", message: RECOVERY_MESSAGE },
  };
};

export const parsePendingTransactions = (payload: unknown): WcashPendingTransactions => {
  const operation = "Pending transactions";
  const record = requireRecord(payload, operation);
  requireExactKeys(record, ["schema_version", "transactions", "next_cursor"], operation);
  if (
    record.schema_version !== 1 ||
    !Array.isArray(record.transactions) ||
    record.transactions.length > 25 ||
    (record.next_cursor !== null &&
      (typeof record.next_cursor !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(record.next_cursor)))
  ) {
    throw new Error(`${operation} returned malformed data`);
  }
  const transactions = record.transactions.map((value): WcashPendingTransaction => {
    if (!isRecord(value)) throw new Error(`${operation} returned malformed data`);
    requireExactKeys(value, ["txid", "branch_id", "expiry_height"], operation);
    if (value.branch_id !== WCASH_BRANCH_ID) throw new Error(`${operation} returned malformed data`);
    return {
      txid: requireTxid(value, "txid", operation),
      branchId: WCASH_BRANCH_ID,
      expiryHeight: requireU32(value, "expiry_height", operation),
    };
  });
  return { schemaVersion: 1, transactions, nextCursor: record.next_cursor as string | null };
};

export const normalizeRecoveryPhrase = (phrase: string): string => phrase.trim().toLowerCase().split(/\s+/).join(" ");

export const require24WordRecoveryPhrase = (phrase: string): string => {
  const normalized = normalizeRecoveryPhrase(phrase);
  if (normalized.split(" ").length !== 24) throw new Error("Enter the complete 24-word recovery phrase.");
  return normalized;
};

export const publicErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message && !/abandon|seed|mnemonic/i.test(error.message)) return error.message;
  return "The wallet operation failed. No wallet data was changed by this screen.";
};
