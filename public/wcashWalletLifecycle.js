"use strict";

const CREDENTIAL_VERSION = 1;
const SEED_SCHEME = "bip39-english-24-empty-passphrase-v1";
const WCASH_NETWORK = "Wcash Testnet";
const WCASH_STORAGE_NAMESPACE = "wcashtestnet-v5";
const WCASH_TICKER = "TWC";

const LIFECYCLE_STATES = Object.freeze({
  EMPTY: "no-database-no-secret",
  PENDING: "secret-only-pending",
  BACKUP_REQUIRED: "database-secret-backup-required",
  READY: "database-and-secret-ready",
  FAIL_CLOSED: "database-only-fail-closed",
});

class WcashWalletLifecycleError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "WcashWalletLifecycleError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(method, value) {
  if (typeof value !== "string") {
    throw new WcashWalletLifecycleError(
      "NATIVE_DATA_INVALID",
      `Wcash native method returned a non-JSON value: ${method}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new WcashWalletLifecycleError(
      "NATIVE_DATA_INVALID",
      `Wcash native method returned invalid JSON: ${method}`,
      cause,
    );
  }

  if (!isRecord(parsed)) {
    throw new WcashWalletLifecycleError(
      "NATIVE_DATA_INVALID",
      `Wcash native method returned an invalid object: ${method}`,
    );
  }
  return parsed;
}

function parseStatus(value) {
  const status = parseJsonObject("wcash_status", value);
  if (
    status.network !== WCASH_NETWORK ||
    status.ticker !== WCASH_TICKER ||
    status.storage_namespace !== WCASH_STORAGE_NAMESPACE
  ) {
    throw new WcashWalletLifecycleError(
      "NATIVE_STATUS_AMBIGUOUS",
      "Wcash native status returned the wrong network identity",
    );
  }
  if (!Object.prototype.hasOwnProperty.call(status, "wallet")) {
    throw new WcashWalletLifecycleError(
      "NATIVE_STATUS_AMBIGUOUS",
      "Wcash native status did not identify whether a wallet database exists",
    );
  }
  if (status.wallet !== null && !isRecord(status.wallet)) {
    throw new WcashWalletLifecycleError(
      "NATIVE_STATUS_AMBIGUOUS",
      "Wcash native status returned an invalid wallet value",
    );
  }
  return status;
}

function parseCredential(value) {
  let record;
  try {
    record = JSON.parse(value);
  } catch (cause) {
    throw new WcashWalletLifecycleError("CREDENTIAL_INVALID", "The Wcash wallet credential record is invalid", cause);
  }

  const keys = isRecord(record) ? Object.keys(record).sort() : [];
  const expectedKeys = ["backupAcknowledged", "birthdayHeight", "intent", "phrase", "scheme", "version"];
  const exactKeys = keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
  const validIntent = record && (record.intent === "create" || record.intent === "restore");
  const validBirthday =
    record &&
    Number.isSafeInteger(record.birthdayHeight) &&
    record.birthdayHeight >= 1 &&
    record.birthdayHeight <= 0xffffffff;
  const validBackupState =
    record &&
    typeof record.backupAcknowledged === "boolean" &&
    (record.intent === "create" || record.backupAcknowledged === true);

  if (
    !isRecord(record) ||
    !exactKeys ||
    record.version !== CREDENTIAL_VERSION ||
    record.scheme !== SEED_SCHEME ||
    !validIntent ||
    !validBirthday ||
    !validBackupState ||
    typeof record.phrase !== "string" ||
    record.phrase.length === 0 ||
    record.phrase.length > 512
  ) {
    throw new WcashWalletLifecycleError("CREDENTIAL_INVALID", "The Wcash wallet credential record is invalid");
  }

  return record;
}

function createCredential(intent, birthdayHeight, phrase, backupAcknowledged) {
  return {
    version: CREDENTIAL_VERSION,
    scheme: SEED_SCHEME,
    intent,
    birthdayHeight,
    backupAcknowledged,
    phrase,
  };
}

function assertFunction(owner, method, label) {
  if (!owner || typeof owner[method] !== "function") {
    throw new TypeError(`${label}.${method} must be a function`);
  }
}

function createWcashWalletLifecycle({ keytar, native, authenticate, service, account }) {
  assertFunction(keytar, "getPassword", "keytar");
  assertFunction(keytar, "setPassword", "keytar");
  assertFunction(keytar, "deletePassword", "keytar");
  assertFunction(native, "wcash_status", "native");
  assertFunction(native, "wcash_verify_mnemonic", "native");
  if (typeof authenticate !== "function") {
    throw new TypeError("authenticate must be a function");
  }
  if (typeof service !== "string" || service.length === 0) {
    throw new TypeError("service must be a non-empty string");
  }
  if (typeof account !== "string" || account.length === 0) {
    throw new TypeError("account must be a non-empty string");
  }

  let operationTail = Promise.resolve();

  function serialize(work) {
    const operation = operationTail.then(work, work);
    operationTail = operation.catch(() => undefined);
    return operation;
  }

  async function readCredential(requireAuthentication = true) {
    if (requireAuthentication) {
      const authenticated = await authenticate();
      if (authenticated !== true) {
        throw new WcashWalletLifecycleError(
          "AUTHENTICATION_FAILED",
          "Authentication is required to access the Wcash wallet credential",
        );
      }
    }
    const stored = await keytar.getPassword(service, account);
    return stored === null ? null : parseCredential(stored);
  }

  async function inspectNativeStatus() {
    return parseStatus(await native.wcash_status());
  }

  async function classifyUnsafe({ authenticateCredential = false } = {}) {
    const status = await inspectNativeStatus();
    const databaseExists = status.wallet !== null;
    // Status/open/sync remain usable when the platform has no supported
    // user-presence challenge. The phrase never leaves main. Every operation
    // that can reveal it, initialize from it, or sign opts into authentication.
    const credential = await readCredential(authenticateCredential);

    if (!databaseExists && credential === null) {
      return { state: LIFECYCLE_STATES.EMPTY, status };
    }
    if (!databaseExists) {
      return {
        state: LIFECYCLE_STATES.PENDING,
        intent: credential.intent,
        birthdayHeight: credential.birthdayHeight,
        credential,
        status,
      };
    }
    if (credential !== null) {
      try {
        if ((await native.wcash_verify_mnemonic(credential.phrase)) === true) {
          const state =
            credential.intent === "create" && !credential.backupAcknowledged
              ? LIFECYCLE_STATES.BACKUP_REQUIRED
              : LIFECYCLE_STATES.READY;
          return { state, wallet: status.wallet, credential, status };
        }
      } catch {
        // A verification failure is indistinguishable from a missing credential
        // to callers. Keep the credential stored, but never report readiness.
      }
      return { state: LIFECYCLE_STATES.FAIL_CLOSED, wallet: status.wallet, status };
    }
    return { state: LIFECYCLE_STATES.FAIL_CLOSED, wallet: status.wallet, status };
  }

  function publicIdentity(classification) {
    return {
      network: classification.status.network,
      ticker: classification.status.ticker,
      storage_namespace: classification.status.storage_namespace,
    };
  }

  function publicState(classification) {
    if (classification.state === LIFECYCLE_STATES.PENDING) {
      return {
        state: classification.state,
        ...publicIdentity(classification),
        intent: classification.intent,
        birthdayHeight: classification.birthdayHeight,
      };
    }
    if (
      classification.state === LIFECYCLE_STATES.BACKUP_REQUIRED ||
      classification.state === LIFECYCLE_STATES.READY ||
      classification.state === LIFECYCLE_STATES.FAIL_CLOSED
    ) {
      return {
        state: classification.state,
        ...publicIdentity(classification),
        wallet: classification.wallet,
      };
    }
    return { state: classification.state, ...publicIdentity(classification) };
  }

  function requireEmpty(classification) {
    if (classification.state === LIFECYCLE_STATES.FAIL_CLOSED) {
      throw new WcashWalletLifecycleError(
        "WALLET_SECRET_MISSING",
        "The Wcash wallet database exists without its matching credential",
      );
    }
    if (classification.state !== LIFECYCLE_STATES.EMPTY) {
      throw new WcashWalletLifecycleError(
        "WALLET_ALREADY_INITIALIZED",
        "A Wcash wallet credential or database already exists",
      );
    }
  }

  function requireBackupRequired(classification) {
    if (classification.state === LIFECYCLE_STATES.FAIL_CLOSED) {
      throw new WcashWalletLifecycleError(
        "WALLET_OWNERSHIP_UNVERIFIED",
        "The Wcash wallet database and credential could not be matched",
      );
    }
    if (classification.state !== LIFECYCLE_STATES.BACKUP_REQUIRED) {
      throw new WcashWalletLifecycleError(
        "WALLET_BACKUP_UNAVAILABLE",
        "No unacknowledged Wcash wallet backup is available",
      );
    }
  }

  function requireReadyCredential(classification) {
    if (classification.state === LIFECYCLE_STATES.FAIL_CLOSED) {
      throw new WcashWalletLifecycleError(
        "WALLET_OWNERSHIP_UNVERIFIED",
        "The Wcash wallet database and credential could not be matched",
      );
    }
    if (classification.state === LIFECYCLE_STATES.BACKUP_REQUIRED) {
      throw new WcashWalletLifecycleError(
        "WALLET_BACKUP_REQUIRED",
        "Confirm the Wcash recovery phrase backup before authorizing transactions",
      );
    }
    if (classification.state !== LIFECYCLE_STATES.READY) {
      throw new WcashWalletLifecycleError(
        "WALLET_NOT_READY",
        "The Wcash wallet is not ready to authorize transactions",
      );
    }
    return classification.credential;
  }

  function requireWalletDatabase(status) {
    if (status.wallet === null) {
      throw new WcashWalletLifecycleError("WALLET_NOT_READY", "The Wcash wallet database is not initialized");
    }
  }

  async function normalizeMnemonic(phrase) {
    if (typeof phrase !== "string" || phrase.length < 32 || phrase.length > 512) {
      throw new WcashWalletLifecycleError("MNEMONIC_INVALID", "Wcash recovery phrase must be a 24-word BIP39 phrase");
    }
    assertFunction(native, "wcash_validate_mnemonic", "native");
    const normalized = await native.wcash_validate_mnemonic(phrase);
    if (
      typeof normalized !== "string" ||
      normalized.length < 32 ||
      normalized.length > 512 ||
      normalized.trim().split(/\s+/u).length !== 24
    ) {
      throw new WcashWalletLifecycleError(
        "MNEMONIC_INVALID",
        "Wcash native validation returned an invalid recovery phrase",
      );
    }
    return normalized;
  }

  async function cleanupFailedInitialization(initializationError, deleteIfEmpty) {
    let status;
    try {
      status = await inspectNativeStatus();
    } catch {
      // An ambiguous inspection must retain the only recovery credential.
      throw initializationError;
    }

    if (status.wallet !== null || !deleteIfEmpty) {
      throw initializationError;
    }

    try {
      const deleted = await keytar.deletePassword(service, account);
      if (deleted === false) {
        throw new Error("the credential was not deleted");
      }
    } catch (cleanupError) {
      const aggregate = new WcashWalletLifecycleError(
        "CREDENTIAL_CLEANUP_FAILED",
        "Wcash wallet initialization failed and its credential could not be removed",
        initializationError,
      );
      aggregate.errors = [initializationError, cleanupError];
      throw aggregate;
    }
    throw initializationError;
  }

  function walletBirthdayHeight(wallet) {
    const birthdayHeight = wallet.birthday_height;
    if (!Number.isSafeInteger(birthdayHeight) || birthdayHeight < 1 || birthdayHeight > 0xffffffff) {
      throw new WcashWalletLifecycleError(
        "NATIVE_DATA_INVALID",
        "Wcash native initialization returned an invalid wallet birthday",
      );
    }
    return birthdayHeight;
  }

  async function initializeFromCredential(credential, method, validatedPhrase, deleteIfEmpty) {
    let phrase;
    let result;
    let completedBirthdayHeight;
    try {
      phrase = validatedPhrase ?? (await normalizeMnemonic(credential.phrase));
      assertFunction(native, method, "native");
      const rawResult =
        method === "wcash_create"
          ? await native[method](phrase)
          : await native[method](phrase, credential.birthdayHeight);
      result = parseJsonObject(method, rawResult);
      if (!isRecord(result.wallet) || result.seed_scheme !== SEED_SCHEME) {
        throw new WcashWalletLifecycleError(
          "NATIVE_DATA_INVALID",
          `Wcash native method returned an invalid initialization result: ${method}`,
        );
      }
      if ((await native.wcash_verify_mnemonic(phrase)) !== true) {
        throw new WcashWalletLifecycleError(
          "WALLET_OWNERSHIP_MISMATCH",
          "The stored Wcash credential does not control the initialized wallet",
        );
      }
      if (credential.intent === "create") {
        completedBirthdayHeight = walletBirthdayHeight(result.wallet);
      }
    } catch (initializationError) {
      return cleanupFailedInitialization(initializationError, deleteIfEmpty);
    }

    if (credential.intent === "create") {
      const completedCredential = createCredential("create", completedBirthdayHeight, phrase, false);
      try {
        await storeCredential(completedCredential);
      } catch (cause) {
        throw new WcashWalletLifecycleError(
          "CREDENTIAL_UPDATE_FAILED",
          "The Wcash wallet was initialized but its credential metadata could not be updated",
          cause,
        );
      }
    }

    const safeResult = { wallet: result.wallet, seed_scheme: result.seed_scheme };
    if (credential.intent === "create") safeResult.recoveryPhrase = phrase;
    return safeResult;
  }

  async function storeCredential(credential) {
    await keytar.setPassword(service, account, JSON.stringify(credential));
  }

  async function invokeSanitizedTransaction(method, invocation, message) {
    try {
      return parseJsonObject(method, await invocation());
    } catch {
      // Native/RPC errors are untrusted boundary data. In particular, never
      // forward a rejected promise's message because it could contain a seed,
      // serialized transaction, endpoint, or other process-local detail.
      throw new WcashWalletLifecycleError("NATIVE_TRANSACTION_STATUS_UNAVAILABLE", message);
    }
  }

  return Object.freeze({
    inspectState() {
      return serialize(async () => publicState(await classifyUnsafe()));
    },

    create() {
      return serialize(async () => {
        const classification = await classifyUnsafe();
        requireEmpty(classification);
        assertFunction(native, "wcash_generate_mnemonic", "native");
        const phrase = await normalizeMnemonic(await native.wcash_generate_mnemonic());
        const credential = createCredential("create", 1, phrase, false);
        await storeCredential(credential);
        return initializeFromCredential(credential, "wcash_create", phrase, true);
      });
    },

    restore(phrase, birthdayHeight) {
      return serialize(async () => {
        if (!Number.isSafeInteger(birthdayHeight) || birthdayHeight < 1 || birthdayHeight > 0xffffffff) {
          throw new RangeError("Wcash Testnet birthday must be an integer from 1 through 4294967295");
        }
        const classification = await classifyUnsafe();
        requireEmpty(classification);
        const normalized = await normalizeMnemonic(phrase);
        const credential = createCredential("restore", birthdayHeight, normalized, true);
        await storeCredential(credential);
        return initializeFromCredential(credential, "wcash_restore", normalized, true);
      });
    },

    revealBackup() {
      return serialize(async () => {
        const classification = await classifyUnsafe({ authenticateCredential: true });
        requireBackupRequired(classification);
        return {
          recoveryPhrase: classification.credential.phrase,
          seed_scheme: SEED_SCHEME,
        };
      });
    },

    acknowledgeBackup() {
      return serialize(async () => {
        const classification = await classifyUnsafe({ authenticateCredential: true });
        requireBackupRequired(classification);
        const acknowledged = createCredential(
          "create",
          walletBirthdayHeight(classification.wallet),
          classification.credential.phrase,
          true,
        );
        await storeCredential(acknowledged);
        return {
          state: LIFECYCLE_STATES.READY,
          ...publicIdentity(classification),
          wallet: classification.wallet,
        };
      });
    },

    resumePending() {
      return serialize(async () => {
        const classification = await classifyUnsafe({ authenticateCredential: true });
        if (classification.state === LIFECYCLE_STATES.FAIL_CLOSED) {
          throw new WcashWalletLifecycleError(
            "WALLET_SECRET_MISSING",
            "The Wcash wallet database exists without its matching credential",
          );
        }
        if (classification.state !== LIFECYCLE_STATES.PENDING) {
          throw new WcashWalletLifecycleError(
            "WALLET_NOT_PENDING",
            "No pending Wcash wallet initialization can be resumed",
          );
        }
        return initializeFromCredential(classification.credential, "wcash_restore", undefined, false);
      });
    },

    sendAndBroadcast(requestJson) {
      return serialize(async () => {
        if (typeof requestJson !== "string" || requestJson.length === 0 || requestJson.length > 128 * 1024) {
          throw new WcashWalletLifecycleError("TRANSACTION_REQUEST_INVALID", "Wcash transaction request is invalid");
        }
        const credential = requireReadyCredential(await classifyUnsafe({ authenticateCredential: true }));
        assertFunction(native, "wcash_send_and_broadcast", "native");
        return invokeSanitizedTransaction(
          "wcash_send_and_broadcast",
          () => native.wcash_send_and_broadcast(credential.phrase, requestJson),
          "Wcash transaction status is unavailable. Inspect signed pending transactions before trying again.",
        );
      });
    },

    shieldCoinbaseAndBroadcast() {
      return serialize(async () => {
        const credential = requireReadyCredential(await classifyUnsafe({ authenticateCredential: true }));
        assertFunction(native, "wcash_shield_coinbase_and_broadcast", "native");
        return invokeSanitizedTransaction(
          "wcash_shield_coinbase_and_broadcast",
          () => native.wcash_shield_coinbase_and_broadcast(credential.phrase),
          "Wcash shielding status is unavailable. Inspect signed pending transactions before trying again.",
        );
      });
    },

    pendingTransactions(afterCursor) {
      return serialize(async () => {
        requireWalletDatabase(await inspectNativeStatus());
        assertFunction(native, "wcash_pending_transactions", "native");
        return invokeSanitizedTransaction(
          "wcash_pending_transactions",
          () =>
            afterCursor === undefined
              ? native.wcash_pending_transactions()
              : native.wcash_pending_transactions(afterCursor),
          "Signed pending transaction metadata is temporarily unavailable.",
        );
      });
    },

    rebroadcastPending(txid) {
      return serialize(async () => {
        requireWalletDatabase(await inspectNativeStatus());
        assertFunction(native, "wcash_rebroadcast_pending", "native");
        return invokeSanitizedTransaction(
          "wcash_rebroadcast_pending",
          () => native.wcash_rebroadcast_pending(txid),
          "Rebroadcast status is unavailable. Do not create a replacement; refresh signed pending transactions.",
        );
      });
    },
  });
}

module.exports = {
  CREDENTIAL_VERSION,
  LIFECYCLE_STATES,
  SEED_SCHEME,
  WcashWalletLifecycleError,
  createWcashWalletLifecycle,
};
