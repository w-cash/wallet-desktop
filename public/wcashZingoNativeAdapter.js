"use strict";

// Compatibility boundary between the unchanged Zingo renderer contract and the
// fixed-network Wcash Neon facade. This module runs only in Electron's trusted
// main process; the renderer never receives the facade or keychain handles.

const net = require("net");

const CREDENTIAL_VERSION = 1;
const SEED_SCHEME = "bip39-english-24-empty-passphrase-v1";
const MAX_MONEY_ZAT = 2_100_000_000_000_000;
const MAX_TRANSFER_RECIPIENTS = 100;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(method, value) {
  if (typeof value !== "string") throw new TypeError(`${method} returned non-JSON data`);
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new Error(`${method} returned invalid JSON`, { cause });
  }
  if (!isRecord(parsed)) throw new TypeError(`${method} returned a non-object JSON value`);
  return parsed;
}

function safeInteger(value, field, { signed = false } = {}) {
  const number = typeof value === "string" && /^-?[0-9]+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || (!signed && number < 0)) {
    throw new TypeError(`Wcash core returned invalid ${field}`);
  }
  return number;
}

function toCanonicalAmount(amount) {
  // The exact upstream Zingo renderer sends integer zatoshis here. Convert
  // that existing boundary shape to the canonical decimal WEC string required
  // by the Wcash facade without applying the base-unit multiplier twice.
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_MONEY_ZAT) {
    throw new RangeError("Wcash payment amount is outside the accepted range");
  }
  const zatoshis = amount;
  const whole = Math.floor(zatoshis / 100_000_000);
  const fraction = String(zatoshis % 100_000_000)
    .padStart(8, "0")
    .replace(/0+$/, "");
  return { zatoshis, decimal: fraction ? `${whole}.${fraction}` : String(whole) };
}

function defaultEndpointProbe(endpoint, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    const url = new URL(endpoint);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const socket = net.createConnection({ host: url.hostname, port });
    const finish = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function createWcashZingoNativeAdapter({ native, keytar, profile, endpointProbe = defaultEndpointProbe }) {
  if (!native || !keytar || !profile) throw new TypeError("Wcash adapter dependencies are required");
  const chainName = profile.localnet ? "regtest" : "test";
  let lastBalance = null;
  let syncState = { phase: "idle", result: null, error: null, promise: null };
  let pendingProposal = null;
  let proposalOperations = Promise.resolve();

  function requireNative(method) {
    if (typeof native[method] !== "function") throw new Error(`Wcash native method is unavailable: ${method}`);
    return native[method].bind(native);
  }

  async function nativeJson(method, ...args) {
    return parseJson(method, await requireNative(method)(...args));
  }

  function serializeProposalOperation(work) {
    const result = proposalOperations.then(work, work);
    proposalOperations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function proposalPreview(result, operation, expectedValueZat) {
    const keys = Object.keys(result).sort();
    const expectedKeys = ["fee_zat", "operation", "proposal_id", "schema_version", "value_zat"].sort();
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index]) ||
      result.schema_version !== 1 ||
      result.operation !== operation ||
      typeof result.proposal_id !== "string" ||
      !/^[1-9][0-9]*$/.test(result.proposal_id)
    ) {
      throw new TypeError("Wcash core returned an invalid transaction proposal");
    }
    const feeZat = safeInteger(result.fee_zat, "proposal fee");
    const valueZat = safeInteger(result.value_zat, "proposal value");
    if (feeZat < 1 || valueZat < 1 || (expectedValueZat !== undefined && valueZat !== expectedValueZat)) {
      throw new TypeError("Wcash core returned inconsistent transaction proposal values");
    }
    return { id: result.proposal_id, operation, feeZat, valueZat };
  }

  async function discardPendingProposalUnlocked() {
    const proposal = pendingProposal;
    const result = proposal
      ? await nativeJson("wcash_cancel_proposal", proposal.id)
      : await nativeJson("wcash_cancel_proposal");
    if (typeof result.cancelled !== "boolean" || (proposal && result.cancelled !== true)) {
      pendingProposal = null;
      throw new Error("Wcash native proposal state did not match the trusted main process");
    }
    pendingProposal = null;
  }

  function assertRuntime(status) {
    if (
      status.profile !== profile.id ||
      status.network !== profile.network ||
      status.ticker !== profile.ticker ||
      status.endpoint !== profile.endpoint ||
      status.storage_namespace !== profile.storageNamespace ||
      status.branch_id !== profile.branchId
    ) {
      throw new Error("Wcash native runtime identity does not match the selected profile");
    }
    return status;
  }

  async function status() {
    return assertRuntime(await nativeJson("wcash_status"));
  }

  function profileMatches(uri, chainHint) {
    return chainHint === chainName && (uri === "" || uri === profile.endpoint);
  }

  function requireProfile(uri, chainHint) {
    if (!profileMatches(uri, chainHint)) {
      throw new Error(`This build supports only ${profile.network} at ${profile.endpoint}`);
    }
  }

  function parseCredential(value) {
    if (value === null) return null;
    let credential;
    try {
      credential = JSON.parse(value);
    } catch (cause) {
      throw new Error("Wcash wallet credential is invalid", { cause });
    }
    if (
      !isRecord(credential) ||
      credential.version !== CREDENTIAL_VERSION ||
      credential.profile !== profile.id ||
      credential.scheme !== SEED_SCHEME ||
      typeof credential.phrase !== "string" ||
      credential.phrase.trim().split(/\s+/u).length !== 24 ||
      !Number.isSafeInteger(credential.birthday) ||
      credential.birthday < 1 ||
      typeof credential.walletName !== "string"
    ) {
      throw new Error("Wcash wallet credential is invalid");
    }
    return credential;
  }

  const readCredential = async () =>
    parseCredential(await keytar.getPassword(profile.keytarService, profile.keytarAccount));
  const storeCredential = (credential) =>
    keytar.setPassword(profile.keytarService, profile.keytarAccount, JSON.stringify(credential));
  const deleteCredential = () => keytar.deletePassword(profile.keytarService, profile.keytarAccount);

  async function walletExists(uri, chainHint, _performance, _confirmations, walletName) {
    if (!profileMatches(uri, chainHint)) return false;
    const current = await status();
    if (current.wallet === null) return false;
    if (!walletName) return true;
    const credential = await readCredential();
    return credential === null || credential.walletName === walletName;
  }

  async function initNew(uri, chainHint, _performance, _confirmations, walletName) {
    requireProfile(uri, chainHint);
    if ((await status()).wallet !== null) throw new Error(`${profile.network} wallet already exists`);
    if ((await readCredential()) !== null) throw new Error(`${profile.network} wallet credential already exists`);
    const phrase = await requireNative("wcash_generate_mnemonic")();
    const normalized = await requireNative("wcash_validate_mnemonic")(phrase);
    const pending = {
      version: CREDENTIAL_VERSION,
      profile: profile.id,
      scheme: SEED_SCHEME,
      phrase: normalized,
      birthday: 1,
      walletName,
    };
    await storeCredential(pending);
    try {
      const created = await nativeJson("wcash_create", normalized);
      const birthday = safeInteger(created.wallet && created.wallet.birthday_height, "wallet birthday");
      await storeCredential({ ...pending, birthday });
      return JSON.stringify({ seed_phrase: normalized, birthday });
    } catch (error) {
      if ((await status()).wallet === null) await deleteCredential();
      throw error;
    }
  }

  async function initFromSeed(seed, birthday, uri, chainHint, _performance, _confirmations, walletName) {
    requireProfile(uri, chainHint);
    if ((await status()).wallet !== null) throw new Error(`${profile.network} wallet already exists`);
    if (!Number.isSafeInteger(birthday) || birthday < 1) throw new RangeError("Wallet birthday is invalid");
    const normalized = await requireNative("wcash_validate_mnemonic")(seed);
    const credential = {
      version: CREDENTIAL_VERSION,
      profile: profile.id,
      scheme: SEED_SCHEME,
      phrase: normalized,
      birthday,
      walletName,
    };
    await storeCredential(credential);
    try {
      const restored = await nativeJson("wcash_restore", normalized, birthday);
      const actualBirthday = safeInteger(restored.wallet && restored.wallet.birthday_height, "wallet birthday");
      await storeCredential({ ...credential, birthday: actualBirthday });
      return JSON.stringify({ seed_phrase: normalized, birthday: actualBirthday });
    } catch (error) {
      if ((await status()).wallet === null) await deleteCredential();
      throw error;
    }
  }

  async function initFromB64(uri, chainHint, _performance, _confirmations, walletName) {
    requireProfile(uri, chainHint);
    const current = await status();
    if (current.wallet === null) throw new Error(`${profile.network} wallet does not exist`);
    const credential = await readCredential();
    if (walletName && credential && credential.walletName && credential.walletName !== walletName) {
      throw new Error("The selected wallet name does not match the Wcash wallet database");
    }
    const opened = await nativeJson("wcash_open");
    const birthday = safeInteger(opened.wallet && opened.wallet.birthday_height, "wallet birthday");
    return JSON.stringify({ birthday });
  }

  async function deleteWallet(uri, chainHint, _performance, _confirmations, walletName) {
    requireProfile(uri, chainHint);
    const credential = await readCredential();
    if (walletName && credential && credential.walletName && credential.walletName !== walletName) {
      throw new Error("The selected wallet name does not match the Wcash wallet database");
    }

    await serializeProposalOperation(discardPendingProposalUnlocked);

    // Native closes the fixed-profile runtime and removes only its compiled
    // SQLite path. Keep the recovery credential until that succeeds so a failed
    // delete cannot strand an undeletable wallet without its seed.
    const result = await nativeJson("wcash_delete");
    const current = await status();
    if (current.wallet !== null) throw new Error("Wcash wallet deletion did not remove the database");

    const removed = await deleteCredential();
    if (!removed && (await readCredential()) !== null) {
      throw new Error("Wcash wallet database was deleted, but its recovery credential could not be removed");
    }
    syncState = { phase: "idle", result: null, error: null, promise: null };
    lastBalance = null;
    return JSON.stringify({ deleted: result.deleted === true });
  }

  async function runSync() {
    if (syncState.phase === "running") return "Sync task is already running.";
    syncState = { phase: "running", result: null, error: null, promise: null };
    let nativeSync;
    try {
      // Invoke immediately: the Neon boundary reserves its cancellation token
      // synchronously before returning the promise.
      nativeSync = requireNative("wcash_sync")();
    } catch (error) {
      syncState = { phase: "failed", result: null, error, promise: null };
      throw error;
    }
    const promise = Promise.resolve(nativeSync)
      .then((value) => {
        const result = parseJson("wcash_sync", value);
        lastBalance = result;
        syncState = { phase: "complete", result, error: null, promise: null };
      })
      .catch((error) => {
        syncState = { phase: "failed", result: null, error, promise: null };
      });
    syncState.promise = promise;
    return "Sync task launched.";
  }

  async function currentBalance() {
    if (syncState.phase === "running" && lastBalance) return lastBalance;
    const balance = await nativeJson("wcash_balance");
    lastBalance = balance;
    return balance;
  }

  function syncStatus() {
    const balance = syncState.result || lastBalance;
    const scanned = balance ? safeInteger(balance.fully_scanned_height, "fully scanned height") : 0;
    const tip = balance ? safeInteger(balance.chain_tip_height, "chain tip height") : scanned;
    const complete = !!balance && balance.synchronized === true && scanned === tip;
    const percentage = complete ? 100 : tip > 0 ? Math.min(99.99, (scanned * 100) / tip) : 0;
    return {
      sync_start_height: 1,
      session_blocks_scanned: scanned,
      total_blocks_scanned: scanned,
      percentage_session_blocks_scanned: percentage,
      percentage_total_blocks_scanned: percentage,
      session_sapling_outputs_scanned: 0,
      total_sapling_outputs_scanned: 0,
      session_orchard_outputs_scanned: 0,
      total_orchard_outputs_scanned: 0,
      percentage_session_outputs_scanned: percentage,
      percentage_total_outputs_scanned: percentage,
    };
  }

  async function getBalance() {
    const balance = await currentBalance();
    const totals = {
      ironwood: 0,
      ironwoodSpendable: 0,
      transparent: 0,
    };
    if (!Array.isArray(balance.accounts)) throw new TypeError("Wcash core returned invalid accounts");
    for (const account of balance.accounts) {
      totals.ironwood += safeInteger(account.ironwood_total_zat, "Ironwood balance");
      totals.ironwoodSpendable += safeInteger(account.ironwood_spendable_zat, "Ironwood spendable balance");
      totals.transparent += safeInteger(account.transparent_total_zat, "transparent balance");
    }
    return {
      total_orchard_balance: 0,
      total_ironwood_balance: totals.ironwood,
      total_sapling_balance: 0,
      total_transparent_balance: totals.transparent,
      confirmed_orchard_balance: 0,
      confirmed_ironwood_balance: totals.ironwood,
      confirmed_sapling_balance: 0,
      confirmed_transparent_balance: totals.transparent,
      spendable_balance: totals.ironwoodSpendable,
    };
  }

  async function getReceivers() {
    const receivers = await nativeJson("wcash_receivers");
    if (
      typeof receivers.ironwood_address !== "string" ||
      !receivers.ironwood_address.startsWith(profile.ironwoodPrefix) ||
      typeof receivers.transparent_coinbase_address !== "string" ||
      !receivers.transparent_coinbase_address.startsWith(profile.transparentPrefix)
    ) {
      throw new Error("Wcash core returned receivers for the wrong network");
    }
    return receivers;
  }

  async function parseAddress(address) {
    const result = parseJson("wcash_validate_recipient", await requireNative("wcash_validate_recipient")(address));
    if (result.network !== profile.network) throw new Error("Wcash recipient validator returned the wrong network");
    return result.valid === true
      ? JSON.stringify({
          status: "success",
          chain_name: chainName,
          address_kind: "unified",
          receivers_available: ["orchard"],
        })
      : JSON.stringify({ status: "error", error: result.error && result.error.message });
  }

  async function getHistory() {
    const history = await nativeJson("wcash_confirmed_transactions");
    if (!isRecord(history.exact_tip) || !Array.isArray(history.transactions)) {
      throw new TypeError("Wcash core returned invalid confirmed history");
    }
    return history.transactions.map((tx) => {
      const direction = tx.direction;
      const valueKnown = tx.value_zat !== null && tx.value_zat !== undefined;
      const kind = valueKnown
        ? tx.kind === "shielding"
          ? "shield"
          : tx.kind === "migration"
            ? "migration"
            : direction === "incoming"
              ? "received"
              : direction === "internal"
                ? "send-to-self"
                : "sent"
        : "";
      const pool = tx.kind === "coinbase" ? "Transparent" : "Ironwood";
      const poolsSentFrom = !valueKnown
        ? []
        : tx.kind === "shielding"
          ? ["Transparent"]
          : direction === "incoming"
            ? []
            : [pool];
      return {
        txid: tx.txid,
        datetime: tx.timestamp === null ? 0 : safeInteger(tx.timestamp, "transaction timestamp"),
        kind,
        transaction_fee: tx.fee_zat === null ? 0 : safeInteger(tx.fee_zat, "transaction fee"),
        status: "confirmed",
        blockheight: safeInteger(tx.mined_height, "transaction height"),
        value: valueKnown ? safeInteger(tx.value_zat, "transaction value") : 0,
        pools_sent_from: poolsSentFrom,
        pools_received: !valueKnown || direction === "outgoing" ? [] : [pool],
      };
    });
  }

  async function stageSendUnlocked(sendJson) {
    await discardPendingProposalUnlocked();
    let transfers;
    try {
      transfers = JSON.parse(sendJson);
    } catch (cause) {
      throw new Error("Wcash send request is invalid", { cause });
    }
    if (!Array.isArray(transfers) || transfers.length < 1 || transfers.length > MAX_TRANSFER_RECIPIENTS) {
      return JSON.stringify({
        error: `Wcash payment list must contain 1 through ${MAX_TRANSFER_RECIPIENTS} recipients`,
      });
    }
    let totalZat = 0;
    const payments = [];
    for (const transfer of transfers) {
      if (!isRecord(transfer) || typeof transfer.address !== "string") {
        return JSON.stringify({ error: "Wcash payment is invalid" });
      }
      const validation = parseJson(
        "wcash_validate_recipient",
        await requireNative("wcash_validate_recipient")(transfer.address),
      );
      if (validation.valid !== true || validation.network !== profile.network) {
        return JSON.stringify({ error: "Recipient is not a valid address for this Wcash network" });
      }
      let amount;
      try {
        amount = toCanonicalAmount(transfer.amount);
      } catch (error) {
        return JSON.stringify({
          error: error instanceof Error ? error.message : "Wcash payment amount is invalid",
        });
      }
      totalZat += amount.zatoshis;
      if (!Number.isSafeInteger(totalZat) || totalZat > MAX_MONEY_ZAT) {
        return JSON.stringify({ error: "Wcash payment total is outside the accepted range" });
      }
      if (
        transfer.memo !== undefined &&
        (typeof transfer.memo !== "string" || Buffer.byteLength(transfer.memo) > 512)
      ) {
        return JSON.stringify({ error: "Memo is longer than the 512-byte Wcash limit" });
      }
      payments.push({
        address: transfer.address,
        amount: amount.decimal,
        ...(transfer.memo ? { memo: transfer.memo } : {}),
      });
    }
    try {
      const preview = proposalPreview(
        await nativeJson("wcash_propose_send", JSON.stringify({ payments })),
        "send",
        totalZat,
      );
      pendingProposal = preview;
      return JSON.stringify({ fee: preview.feeZat, amount: totalZat });
    } catch (error) {
      try {
        await discardPendingProposalUnlocked();
      } catch (_cancellationError) {
        // A later proposal or deinitialization will retry the native cleanup.
      }
      return JSON.stringify({
        error: error instanceof Error ? error.message : "Wcash transaction proposal failed",
      });
    }
  }

  function stageSend(sendJson) {
    return serializeProposalOperation(() => stageSendUnlocked(sendJson));
  }

  async function stageShieldUnlocked() {
    await discardPendingProposalUnlocked();
    try {
      const preview = proposalPreview(
        await nativeJson("wcash_propose_shield_coinbase"),
        "shield_coinbase",
      );
      pendingProposal = preview;
      return JSON.stringify({ fee: preview.feeZat });
    } catch (error) {
      try {
        await discardPendingProposalUnlocked();
      } catch (_cancellationError) {
        // A later proposal or deinitialization will retry the native cleanup.
      }
      return JSON.stringify({
        error: error instanceof Error ? error.message : "Wcash coinbase shielding proposal failed",
      });
    }
  }

  function operationError(result) {
    if (result.rejection && typeof result.rejection.message === "string") return result.rejection.message;
    if (result.recovery && typeof result.recovery.message === "string") return result.recovery.message;
    return `Wcash transaction did not broadcast (${String(result.outcome || "unknown")})`;
  }

  async function confirmUnlocked() {
    const proposal = pendingProposal;
    if (!proposal) return JSON.stringify({ error: "No Wcash transaction proposal is pending" });
    const credential = await readCredential();
    if (!credential || (await requireNative("wcash_verify_mnemonic")(credential.phrase)) !== true) {
      await discardPendingProposalUnlocked();
      return JSON.stringify({ error: "The Wcash wallet credential does not control this wallet" });
    }
    let result;
    try {
      result = await nativeJson(
        "wcash_confirm_proposal",
        credential.phrase,
        proposal.id,
        proposal.operation,
      );
    } catch (error) {
      try {
        // Pre-signing failures leave a cancellable staged proposal. A signing
        // failure is already unlocked and removed by native, which reports
        // `cancelled: false`. Either response lets trusted main discard its
        // preview. If cancellation itself fails, native may be retaining a
        // calculated transaction and the exact proposal must remain retryable.
        const cancellation = await nativeJson("wcash_cancel_proposal", proposal.id);
        if (typeof cancellation.cancelled !== "boolean") {
          throw new TypeError("Wcash core returned invalid proposal cancellation state");
        }
        pendingProposal = null;
      } catch (_cancellationError) {
        // Keep the opaque proposal binding for an exact confirmation retry.
      }
      throw error;
    }
    if (result.operation !== proposal.operation) {
      throw new Error("Wcash confirmation did not match the reviewed proposal");
    }
    if (result.fee_zat === null && result.outcome === "recovery_required") {
      // Calculation persisted signed bytes but could not return their exact
      // public metadata. Native has intentionally discarded the replaceable
      // preview; the durable pending-transaction recovery path is authoritative.
      pendingProposal = null;
      return JSON.stringify({ error: operationError(result) });
    }
    if (safeInteger(result.fee_zat, "confirmed proposal fee") !== proposal.feeZat) {
      throw new Error("Wcash confirmation did not match the reviewed proposal");
    }
    if (result.outcome === "broadcast" && typeof result.txid === "string" && /^[0-9a-f]{64}$/.test(result.txid)) {
      pendingProposal = null;
      return JSON.stringify({ txids: [result.txid] });
    }
    if (result.outcome === "rejected") pendingProposal = null;
    return JSON.stringify({ error: operationError(result) });
  }

  function confirm() {
    return serializeProposalOperation(confirmUnlocked);
  }

  async function invoke(method, ...args) {
    switch (method) {
      case "wallet_exists":
        return walletExists(...args);
      case "init_new":
        return initNew(...args);
      case "init_from_seed":
        return initFromSeed(...args);
      case "init_from_b64":
        return initFromB64(...args);
      case "delete_wallet":
        return deleteWallet(...args);
      case "get_seed": {
        const credential = await readCredential();
        if (!credential) throw new Error("Wcash recovery phrase is unavailable");
        return JSON.stringify({ seed_phrase: credential.phrase });
      }
      case "get_ufvk": {
        const credential = await readCredential();
        if (!credential) throw new Error("Wcash viewing key is unavailable");
        if ((await requireNative("wcash_verify_mnemonic")(credential.phrase)) !== true) {
          throw new Error("The Wcash wallet credential does not control this wallet");
        }
        const ufvk = await requireNative("wcash_export_ufvk")(credential.phrase);
        if (typeof ufvk !== "string" || ufvk.length === 0) {
          throw new Error("Wcash core returned an invalid viewing key");
        }
        return JSON.stringify({ ufvk });
      }
      case "wallet_kind": {
        const credential = await readCredential();
        const spending = !!credential && (await requireNative("wcash_verify_mnemonic")(credential.phrase)) === true;
        return JSON.stringify({
          kind: spending ? "Loaded from seed or mnemonic phrase)" : "No keys found",
          transparent: spending,
          sapling: false,
          orchard: spending,
        });
      }
      case "run_sync":
        return runSync();
      case "poll_sync":
        if (syncState.phase === "running") return "Sync task is not complete.";
        if (syncState.phase === "failed") {
          const error = syncState.error;
          // A poll consumes the finished native task whether it succeeded or
          // failed. The next upstream poll can then launch a fresh sync after
          // transient failures such as a tip moving during local mining.
          syncState = { phase: "idle", result: null, error: null, promise: null };
          throw error;
        }
        if (syncState.phase === "complete") {
          const result = syncState.result;
          // Upstream treats a completed poll as consuming the task. Its next
          // five-second poll then sees "not launched" and starts a fresh sync,
          // which is how newly mined/received blocks are discovered.
          syncState = { phase: "idle", result: null, error: null, promise: null };
          return JSON.stringify(result);
        }
        return "Sync task has not been launched.";
      case "status_sync":
        return JSON.stringify(syncStatus());
      case "stop_sync": {
        const stopped = requireNative("wcash_stop_sync")();
        return stopped ? "Sync stop requested." : "Sync task is not running.";
      }
      case "get_balance":
        return JSON.stringify(await getBalance());
      case "get_spendable_balance_total": {
        const balance = await getBalance();
        return JSON.stringify({ spendable_balance: balance.spendable_balance });
      }
      case "get_spendable_balance_with_address": {
        const parsed = JSON.parse(await parseAddress(args[0]));
        if (parsed.status !== "success") throw new Error("Invalid Wcash recipient");
        const balance = await getBalance();
        return JSON.stringify({ spendable_balance: balance.spendable_balance });
      }
      case "get_unified_addresses": {
        const receivers = await getReceivers();
        return JSON.stringify([
          {
            account: 0,
            address_index: 0,
            encoded_address: receivers.ironwood_address,
            has_orchard: true,
            has_sapling: false,
            has_transparent: false,
          },
        ]);
      }
      case "get_transparent_addresses": {
        const receivers = await getReceivers();
        return JSON.stringify([
          { account: 0, address_index: 0, scope: "external", encoded_address: receivers.transparent_coinbase_address },
        ]);
      }
      case "get_value_transfers":
        return JSON.stringify({ value_transfers: await getHistory() });
      case "get_messages":
        return JSON.stringify({ value_transfers: [] });
      case "parse_address":
        return parseAddress(args[0]);
      case "send":
        return stageSend(args[0]);
      case "shield":
        return serializeProposalOperation(stageShieldUnlocked);
      case "confirm":
        return confirm();
      case "get_latest_block_wallet": {
        const balance = await currentBalance();
        return JSON.stringify({ height: safeInteger(balance.fully_scanned_height, "fully scanned height") });
      }
      case "get_latest_block_server": {
        requireProfile(args[0], chainName);
        if (lastBalance) return String(safeInteger(lastBalance.chain_tip_height, "chain tip height"));
        if (!(await endpointProbe(profile.endpoint))) throw new Error(`${profile.network} endpoint is unavailable`);
        return "1";
      }
      case "info_server": {
        const balance = await currentBalance();
        return JSON.stringify({
          version: "1",
          git_commit: profile.coreRevision,
          server_uri: profile.endpoint,
          vendor: "Wcash",
          currency_name: profile.ticker,
          taddr_support: true,
          chain_name: chainName,
          sapling_activation_height: 1,
          consensus_branch_id: profile.branchId,
          latest_block_height: safeInteger(balance.chain_tip_height, "chain tip height"),
        });
      }
      case "get_version":
        return profile.coreRevision;
      case "get_wallet_version":
        // Upstream uses this as a UI migration gate (< 32), not as the Wcash
        // SQLite schema version. Opening succeeded above, so report the
        // compatible UI level and avoid a false migration prompt.
        return JSON.stringify({ read_version: 32 });
      case "get_wallet_save_required":
        return JSON.stringify({ save_required: false });
      case "save_wallet_file":
      case "check_save_error":
        return "Wallet database is current.";
      case "set_option_wallet":
      case "set_crypto_default_provider_to_ring":
        return "ok";
      case "get_ironwood_activation_height":
        return "1";
      case "drain_status":
      case "execute_due_parts_status":
        return JSON.stringify({ idle: true });
      case "plan_orchard_drain":
        return JSON.stringify({ migrated: 0, stranded: 0, fee: 0 });
      case "migration_status":
        return JSON.stringify({
          in_progress: false,
          orchard_confirmed_spendable: 0,
          phase: null,
          parts_total: 0,
          parts_confirmed: 0,
          value_total: 0,
          value_migrated: 0,
          per_bucket: null,
          bucket_modulus: 0,
          batches: [],
          next_wakes: [],
        });
      case "reconcile_migration":
        return JSON.stringify({ actions: [] });
      case "broadcast_due_parts":
      case "auto_broadcast_if_due":
      case "catch_up_migration":
      case "execute_due_parts":
        return JSON.stringify({ txids: [] });
      case "migrate_to_ironwood":
      case "drain_orchard_to_ironwood":
        return JSON.stringify({ split_txids: [], part_txids: [], txids: [], stranded: 0 });
      case "cancel_ironwood_migration":
      case "start_ironwood_migration":
      case "reschedule_parts":
        return "ok";
      case "plan_ironwood_migration":
      case "continue_note_splitting":
        throw new Error("Wcash is Ironwood-only; no Orchard migration is available");
      case "get_total_memobytes_to_address":
      case "get_total_value_to_address":
      case "get_total_spends_to_address":
        return JSON.stringify({});
      case "zec_price_over_mixnet":
        return JSON.stringify({ price: null });
      case "deinitialize":
        await serializeProposalOperation(discardPendingProposalUnlocked);
        syncState = { phase: "idle", result: null, error: null, promise: null };
        lastBalance = null;
        return "Wcash adapter state cleared.";
      case "pause_sync":
      case "run_rescan":
      case "parse_ufvk":
      case "init_from_ufvk":
      case "remove_transaction":
      case "create_new_unified_address":
      case "create_new_transparent_address":
        throw new Error(`Wcash core does not yet implement ${method}`);
      case "get_developer_donation_address":
      case "get_zennies_for_zingo_donation_address":
        return "";
      case "set_config_wallet_to_test":
      case "set_config_wallet_to_prod":
      case "get_config_wallet_performance":
      case "change_server":
        throw new Error(`${profile.network} and endpoint are fixed in this build`);
      default:
        throw new Error(`Unsupported Wcash compatibility method: ${method}`);
    }
  }

  return Object.freeze({ invoke });
}

module.exports = {
  CREDENTIAL_VERSION,
  SEED_SCHEME,
  createWcashZingoNativeAdapter,
  defaultEndpointProbe,
  toCanonicalAmount,
};
