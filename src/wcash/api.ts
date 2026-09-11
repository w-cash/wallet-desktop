const ZATOSHIS_PER_COIN = 100_000_000n;

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
  readonly network: string;
  readonly ticker: string;
  readonly storageNamespace: string;
}

export type WcashStatus =
  | (WcashStatusBase & { readonly state: "no-database-no-secret" })
  | (WcashStatusBase & {
      readonly state: "secret-only-pending";
      readonly intent: "create" | "restore";
      readonly birthdayHeight: number | null;
    })
  | (WcashStatusBase & {
      readonly state: "database-and-secret-ready";
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

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
  const base = {
    network: requireString(record, "network", operation),
    ticker: requireString(record, "ticker", operation),
    storageNamespace: requireString(record, "storage_namespace", operation),
  };
  switch (record.state) {
    case "no-database-no-secret":
      return { ...base, state: record.state };
    case "secret-only-pending": {
      const intent = record.intent;
      if (intent !== "create" && intent !== "restore") throw new Error(`${operation} returned malformed data`);
      const birthdayHeight = record.birthdayHeight;
      if (intent === "create" && birthdayHeight !== null) throw new Error(`${operation} returned malformed data`);
      if (intent === "restore") {
        if (
          !Number.isInteger(birthdayHeight) ||
          (birthdayHeight as number) < 1 ||
          (birthdayHeight as number) > 0xffff_ffff
        ) {
          throw new Error(`${operation} returned malformed data`);
        }
      }
      return { ...base, state: record.state, intent, birthdayHeight: birthdayHeight as number | null };
    }
    case "database-and-secret-ready":
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
  const recoveryPhrase = requireString(record, "recoveryPhrase", operation).trim();
  if (recoveryPhrase.split(/\s+/).length !== 24) throw new Error(`${operation} returned malformed data`);
  return { wallet, recoveryPhrase };
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
