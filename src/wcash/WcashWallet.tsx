import React, { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  WcashBalance,
  WcashOperationResult,
  WcashPendingTransaction,
  WcashReceivers,
  WcashSendRequest,
  WcashWalletMetadata,
  createSendRequest,
  formatTwc,
  isExactTipBalance,
  memoUtf8Bytes,
  parseBalance,
  parseCreatedWallet,
  parseOpenedWallet,
  parseOperationResult,
  parsePendingTransactions,
  parseRecipientValidation,
  parseRecoveryPhrase,
  parseReceivers,
  parseStatus,
  parseCanonicalTwcAmount,
  publicErrorMessage,
  requireWcashProductConfig,
  require24WordRecoveryPhrase,
} from "./api";
import "./WcashWallet.css";

type Screen =
  | "boot"
  | "onboarding"
  | "restore"
  | "backup"
  | "backupRequired"
  | "pending"
  | "locked"
  | "wallet"
  | "orphaned"
  | "unavailable";

type PendingLoadState = "idle" | "loading" | "loaded" | "error";

const CONFIRMATION_WORDS = [3, 11, 19] as const;

const sum = (values: readonly bigint[]): bigint => values.reduce((total, value) => total + value, 0n);

const isSameWallet = (left: WcashWalletMetadata, right: WcashWalletMetadata): boolean =>
  left.accountId === right.accountId && left.birthdayHeight === right.birthdayHeight;

interface SendReview {
  readonly request: WcashSendRequest;
  readonly amountZat: bigint;
  readonly memoBytes: number;
}

const WcashHeader = ({ network, ticker }: { network: string; ticker: string }) => (
  <header className="warden-header">
    <div className="warden-brand" aria-label="Wcash Warden">
      <span className="warden-mark" aria-hidden="true">
        W
      </span>
      <span>Wcash Warden</span>
    </div>
    <div className="warden-network">
      <span aria-hidden="true" /> {network} · {ticker}
    </div>
  </header>
);

const BusyLine = ({ children }: React.PropsWithChildren) => (
  <div className="warden-busy" role="status">
    <span aria-hidden="true" />
    {children}
  </div>
);

const ErrorNotice = ({ message, onDismiss }: { message: string; onDismiss?: () => void }) => (
  <div className="warden-error" role="alert">
    <div>
      <strong>Wallet action could not be completed</strong>
      <p>{message}</p>
    </div>
    {onDismiss ? (
      <button type="button" onClick={onDismiss} aria-label="Dismiss error">
        Dismiss
      </button>
    ) : null}
  </div>
);

const WcashWallet = () => {
  const runtimeConfig = window.wcash?.config;
  const networkLabel = runtimeConfig?.network ?? "Wcash";
  const ticker = runtimeConfig?.ticker ?? "TWC";
  const localRegtest = runtimeConfig?.profile === "local-regtest";
  const recipientPlaceholder = localRegtest ? "wuregtest1…" : "wutest1…";
  const [screen, setScreen] = useState<Screen>("boot");
  const [wallet, setWallet] = useState<WcashWalletMetadata | null>(null);
  const [receivers, setReceivers] = useState<WcashReceivers | null>(null);
  const [balance, setBalance] = useState<WcashBalance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState("Sync to read an exact-tip balance.");
  const [restorePhrase, setRestorePhrase] = useState("");
  const [restoreBirthday, setRestoreBirthday] = useState("1");
  const [pendingPhrase, setPendingPhrase] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Record<number, string>>({});
  const [pendingIntent, setPendingIntent] = useState<"create" | "restore" | null>(null);
  const [pendingBirthday, setPendingBirthday] = useState<number | null>(null);
  const [sendAddress, setSendAddress] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sendMemo, setSendMemo] = useState("");
  const [sendReview, setSendReview] = useState<SendReview | null>(null);
  const [shieldReview, setShieldReview] = useState(false);
  const [pendingTransactions, setPendingTransactions] = useState<readonly WcashPendingTransaction[]>([]);
  const [pendingExactTipHeight, setPendingExactTipHeight] = useState<number | null>(null);
  const [pendingLoadState, setPendingLoadState] = useState<PendingLoadState>("idle");
  const [recoveryHoldTxids, setRecoveryHoldTxids] = useState<readonly string[]>([]);
  const [transactionStatusUnknown, setTransactionStatusUnknown] = useState(false);
  const [transactionNote, setTransactionNote] = useState<string | null>(null);

  const refreshPendingTransactions = useCallback(async () => {
    setPendingLoadState("loading");
    try {
      const transactions: WcashPendingTransaction[] = [];
      const seenCursors = new Set<string>();
      const seenTxids = new Set<string>();
      let cursor: string | undefined;
      let snapshotTip: number | null | undefined;

      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const page = parsePendingTransactions(await window.wcash.pendingTransactions(cursor), window.wcash.config);
        if (snapshotTip === undefined) snapshotTip = page.exactTipHeight;
        if (snapshotTip !== page.exactTipHeight) {
          throw new Error("The Wcash tip changed while signed pending transactions were being read");
        }
        for (const transaction of page.transactions) {
          if (seenTxids.has(transaction.txid)) {
            throw new Error("Signed pending transaction metadata contained a duplicate transaction");
          }
          seenTxids.add(transaction.txid);
          transactions.push(transaction);
        }
        if (page.nextCursor === null) {
          setPendingTransactions(Object.freeze(transactions));
          setPendingExactTipHeight(snapshotTip ?? null);
          setPendingLoadState("loaded");
          setRecoveryHoldTxids((current) =>
            current.length > 0 && current.every((txid) => seenTxids.has(txid)) ? [] : current,
          );
          return;
        }
        if (seenCursors.has(page.nextCursor) || (cursor !== undefined && BigInt(page.nextCursor) <= BigInt(cursor))) {
          throw new Error("Pending transaction pagination did not advance");
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      throw new Error("Pending transaction list exceeded its safety limit");
    } catch (cause) {
      setPendingExactTipHeight(null);
      setPendingLoadState("error");
      throw cause;
    }
  }, []);

  const bootstrap = useCallback(async () => {
    setScreen("boot");
    setError(null);

    try {
      const bridge = window.wcash;
      if (!bridge) {
        setScreen("unavailable");
        return;
      }
      const runtimeConfig = requireWcashProductConfig(bridge.config);

      const status = parseStatus(await bridge.status(), runtimeConfig);
      if (
        status.profile !== runtimeConfig.profile ||
        status.network !== runtimeConfig.network ||
        status.ticker !== runtimeConfig.ticker ||
        status.endpoint !== runtimeConfig.endpoint ||
        status.storageNamespace !== runtimeConfig.storageNamespace ||
        status.branchId !== runtimeConfig.branchId
      ) {
        throw new Error("Wallet runtime reported an unexpected network identity");
      }
      switch (status.state) {
        case "no-database-no-secret":
          setWallet(null);
          setPendingIntent(null);
          setPendingBirthday(null);
          setScreen("onboarding");
          break;
        case "secret-only-pending":
          setWallet(null);
          setPendingIntent(status.intent);
          setPendingBirthday(status.birthdayHeight);
          setScreen("pending");
          break;
        case "database-and-secret-ready":
          setWallet(status.wallet);
          setPendingIntent(null);
          setPendingBirthday(null);
          setScreen("locked");
          break;
        case "database-secret-backup-required":
          setWallet(status.wallet);
          setPendingIntent(null);
          setPendingBirthday(null);
          setScreen("backupRequired");
          break;
        case "database-only-fail-closed":
          setWallet(status.wallet);
          setPendingIntent(null);
          setPendingBirthday(null);
          setScreen("orphaned");
          break;
      }
    } catch (cause) {
      setError(publicErrorMessage(cause));
      setScreen("unavailable");
    }
  }, []);

  useEffect(() => {
    document.title = runtimeConfig?.productName ?? "Wcash Warden";
  }, [runtimeConfig?.productName]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const enterWallet = async (metadata: WcashWalletMetadata) => {
    setReceivers(null);
    setBalance(null);
    setPendingTransactions([]);
    setPendingExactTipHeight(null);
    setPendingLoadState("idle");
    setSyncNote("Checking wallet state…");

    const addresses = parseReceivers(await window.wcash.receivers(), window.wcash.config);
    setWallet(metadata);
    setReceivers(addresses);
    setScreen("wallet");

    try {
      const current = parseBalance(await window.wcash.balance());
      if (isExactTipBalance(current)) {
        setBalance(current);
        setSyncNote(`Verified at block ${current.chainTipHeight.toLocaleString()}.`);
      } else {
        setSyncNote("Balance withheld because the wallet is not synchronized to its known chain tip.");
      }
    } catch {
      setSyncNote("Balance withheld until a complete exact-tip synchronization succeeds.");
    }

    try {
      await refreshPendingTransactions();
    } catch (cause) {
      setError(publicErrorMessage(cause));
    }
  };

  const createWallet = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = parseCreatedWallet(await window.wcash.create());
      setWallet(created.wallet);
      setPendingPhrase(created.recoveryPhrase);
      setConfirmation({});
      setScreen("backup");
    } catch (cause) {
      setError(publicErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const confirmBackup = async (event: FormEvent) => {
    event.preventDefault();
    if (!pendingPhrase) return;

    const words = pendingPhrase.split(" ");
    const matches = CONFIRMATION_WORDS.every(
      (index) => confirmation[index]?.trim().toLowerCase() === words[index]?.toLowerCase(),
    );
    if (!matches) {
      setError("The confirmation words do not match. Check the numbered recovery phrase and try again.");
      return;
    }

    const metadata = wallet;
    setPendingPhrase(null);
    setConfirmation({});
    if (!metadata) {
      setError("Wallet metadata is unavailable. Restart Wcash Warden and open the stored wallet.");
      setScreen("unavailable");
      return;
    }

    setBusy(true);
    setError(null);
    setScreen("backupRequired");
    try {
      const acknowledged = parseStatus(await window.wcash.acknowledgeBackup(), window.wcash.config);
      if (acknowledged.state !== "database-and-secret-ready" || !isSameWallet(acknowledged.wallet, metadata)) {
        throw new Error("Wallet backup acknowledgement did not reach a durable ready state");
      }
      const opened = parseOpenedWallet(await window.wcash.open());
      if (!isSameWallet(opened, metadata)) throw new Error("Opened wallet identity changed after backup confirmation");
      await enterWallet(opened);
    } catch (cause) {
      setError(publicErrorMessage(cause));
      setWallet(metadata);
      setScreen("backupRequired");
    } finally {
      setBusy(false);
    }
  };

  const restoreWallet = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    let phrase: string;
    try {
      phrase = require24WordRecoveryPhrase(restorePhrase);
    } catch (cause) {
      setError(publicErrorMessage(cause));
      return;
    }

    const birthday = Number(restoreBirthday);
    if (!Number.isInteger(birthday) || birthday < 1 || birthday > 0xffff_ffff) {
      setError("Birthday height must be a whole number from 1 through 4,294,967,295.");
      return;
    }

    setRestorePhrase("");
    setBusy(true);
    try {
      const metadata = parseOpenedWallet(await window.wcash.restore(phrase, birthday), "Wallet restore");
      await enterWallet(metadata);
    } catch (cause) {
      setError(publicErrorMessage(cause));
    } finally {
      phrase = "";
      setBusy(false);
    }
  };

  const openWallet = async () => {
    setBusy(true);
    setError(null);
    try {
      const metadata = parseOpenedWallet(await window.wcash.open());
      await enterWallet(metadata);
    } catch (cause) {
      setError(publicErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const resumePending = async () => {
    if (!pendingIntent) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.wcash.resumePending();
      if (pendingIntent === "create") {
        const created = parseCreatedWallet(result);
        setWallet(created.wallet);
        setPendingPhrase(created.recoveryPhrase);
        setConfirmation({});
        setScreen("backup");
      } else {
        const metadata = parseOpenedWallet(result, "Pending wallet restore");
        await enterWallet(metadata);
      }
    } catch (cause) {
      setError(publicErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const revealRequiredBackup = async () => {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    try {
      const phrase = parseRecoveryPhrase(await window.wcash.revealBackup());
      setPendingPhrase(phrase);
      setConfirmation({});
      setScreen("backup");
    } catch (cause) {
      setError(publicErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const syncWallet = async () => {
    setSyncing(true);
    setBalance(null);
    setError(null);
    setSyncNote(`Synchronizing ${networkLabel}…`);
    try {
      const result = parseBalance(await window.wcash.sync());
      if (!isExactTipBalance(result)) {
        setSyncNote("Synchronization stopped before the known chain tip. Balance remains hidden.");
        return;
      }

      const current = parseBalance(await window.wcash.balance());
      if (!isExactTipBalance(current)) {
        setSyncNote("The chain tip moved. Synchronize again before reading the balance.");
        return;
      }
      setBalance(current);
      setSyncNote(`Verified at block ${current.chainTipHeight.toLocaleString()}.`);
      await refreshPendingTransactions();
    } catch (cause) {
      setBalance(null);
      setSyncNote("Balance remains hidden because synchronization did not complete.");
      setError(publicErrorMessage(cause));
    } finally {
      setSyncing(false);
    }
  };

  const cancelSync = async () => {
    setSyncNote("Requesting a safe synchronization stop…");
    try {
      await window.wcash.stopSync();
    } catch (cause) {
      setError(publicErrorMessage(cause));
    }
  };

  const refreshAfterTransaction = async () => {
    try {
      await refreshPendingTransactions();
    } catch (cause) {
      setError(publicErrorMessage(cause));
    }
    try {
      const current = parseBalance(await window.wcash.balance());
      if (isExactTipBalance(current)) {
        setBalance(current);
        setSyncNote(`Verified at block ${current.chainTipHeight.toLocaleString()}.`);
      } else {
        setBalance(null);
        setSyncNote("The chain tip moved. Synchronize again before authorizing another transaction.");
      }
    } catch {
      setBalance(null);
      setSyncNote("Balance withheld until a complete exact-tip synchronization succeeds.");
    }
  };

  const describeOperation = (result: Exclude<WcashOperationResult, { outcome: "cancelled" }>): string => {
    if (result.outcome === "recovery_required") {
      if (result.recovery?.code === "exact_transaction_rebroadcast_required") {
        return `Transaction ${result.txid} is signed and stored, but broadcast could not be confirmed. Retry this exact transaction below; do not create a replacement.`;
      }
      const count = result.recovery?.txids.length ?? 0;
      return `${count === 1 ? "One signed transaction needs" : `${count} signed transactions need`} review. Refresh the signed pending list and do not create a replacement.`;
    }
    if (result.outcome === "rejected") {
      return `Transaction ${result.txid} was definitively rejected by the Wcash node (code ${result.rejection?.nodeCode ?? "unknown"}). It remains locked until expiry; do not create a replacement.`;
    }
    if (result.outcome === "expired") {
      return `Transaction ${result.txid} expired and was not submitted. Refresh the exact-tip wallet state before creating a new transaction.`;
    }
    const state = result.broadcast?.status.state === "mined" ? "already mined" : "accepted for broadcast";
    const fee = result.feeZat === null ? "" : ` Fee: ${formatTwc(result.feeZat)} TWC.`;
    return `Transaction ${result.txid} was ${state}.${fee}`;
  };

  const retainOperationSafetyState = (result: Exclude<WcashOperationResult, { outcome: "cancelled" }>) => {
    setTransactionStatusUnknown(false);
    const txids =
      result.outcome === "recovery_required"
        ? (result.recovery?.txids ?? [result.txid])
        : result.outcome === "rejected"
          ? [result.txid]
          : [];
    if (txids.length > 0) {
      setRecoveryHoldTxids((current) => Object.freeze([...new Set([...current, ...txids])]));
    }
  };

  const reviewSend = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !balance ||
      !isExactTipBalance(balance) ||
      pendingLoadState !== "loaded" ||
      pendingExactTipHeight !== balance.chainTipHeight ||
      pendingTransactions.some((transaction) => transaction.blocksNewSigning) ||
      recoveryHoldTxids.length > 0 ||
      transactionStatusUnknown ||
      syncing ||
      busy
    ) {
      setError(`Synchronize and verify signed pending transactions at the exact ${networkLabel} tip first.`);
      return;
    }

    setBusy(true);
    setError(null);
    setTransactionNote(null);
    try {
      const request = createSendRequest(sendAddress, sendAmount, sendMemo, window.wcash.config);
      const validation = parseRecipientValidation(
        await window.wcash.validateRecipient(request.payments[0].address),
        window.wcash.config,
      );
      if (!validation.valid) throw new Error(validation.error.message);
      const canonicalRequest = createSendRequest(
        validation.canonicalAddress,
        request.payments[0].amount,
        request.payments[0].memo ?? "",
        window.wcash.config,
      );
      const { amountZat } = parseCanonicalTwcAmount(canonicalRequest.payments[0].amount);
      const spendable = sum(balance.accounts.map((account) => account.ironwoodSpendableZat));
      if (amountZat > spendable) throw new Error("Payment amount exceeds the exact-tip private spendable balance.");
      setSendReview(
        Object.freeze({
          request: canonicalRequest,
          amountZat,
          memoBytes: memoUtf8Bytes(canonicalRequest.payments[0].memo ?? ""),
        }),
      );
    } catch (cause) {
      setError(publicErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const confirmReviewedSend = async () => {
    const reviewed = sendReview;
    if (!reviewed || busy || syncing) return;
    if (
      !balance ||
      !isExactTipBalance(balance) ||
      pendingLoadState !== "loaded" ||
      pendingExactTipHeight !== balance.chainTipHeight ||
      pendingTransactions.some((transaction) => transaction.blocksNewSigning) ||
      recoveryHoldTxids.length > 0 ||
      transactionStatusUnknown
    ) {
      setSendReview(null);
      setError("Wallet or signed pending state changed. Synchronize and review the payment again.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = parseOperationResult(await window.wcash.send(reviewed.request), "send", window.wcash.config);
      if (result.outcome === "cancelled") {
        setTransactionNote("Payment cancelled before signing. No transaction was created.");
        return;
      }
      retainOperationSafetyState(result);
      setTransactionNote(describeOperation(result));
      setSendReview(null);
      setSendAddress("");
      setSendAmount("");
      setSendMemo("");
      await refreshAfterTransaction();
    } catch {
      setTransactionStatusUnknown(true);
      await refreshAfterTransaction();
      setSendReview(null);
      setSendAddress("");
      setSendAmount("");
      setSendMemo("");
      setError("Transaction status is unknown. Refresh signed pending transactions and do not create a replacement.");
    } finally {
      setBusy(false);
    }
  };

  const confirmShieldCoinbase = async () => {
    if (!shieldReview || busy || syncing) return;
    if (
      !balance ||
      !isExactTipBalance(balance) ||
      pendingLoadState !== "loaded" ||
      pendingExactTipHeight !== balance.chainTipHeight ||
      pendingTransactions.some((transaction) => transaction.blocksNewSigning) ||
      recoveryHoldTxids.length > 0 ||
      transactionStatusUnknown
    ) {
      setShieldReview(false);
      setError("Wallet or signed pending state changed. Synchronize and review shielding again.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = parseOperationResult(await window.wcash.shieldCoinbase(), "shield_coinbase", window.wcash.config);
      if (result.outcome === "cancelled") {
        setTransactionNote("Shielding cancelled before signing. No transaction was created.");
        return;
      }
      retainOperationSafetyState(result);
      setTransactionNote(describeOperation(result));
      setShieldReview(false);
      await refreshAfterTransaction();
    } catch {
      setTransactionStatusUnknown(true);
      await refreshAfterTransaction();
      setShieldReview(false);
      setError("Shielding status is unknown. Refresh signed pending transactions and do not create a replacement.");
    } finally {
      setBusy(false);
    }
  };

  const retryPendingTransaction = async (transaction: WcashPendingTransaction) => {
    if (
      !balance ||
      !isExactTipBalance(balance) ||
      pendingLoadState !== "loaded" ||
      pendingExactTipHeight === null ||
      pendingExactTipHeight !== balance.chainTipHeight ||
      !transaction.rebroadcastAllowed
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = parseOperationResult(
        await window.wcash.rebroadcastPending(transaction.txid),
        "rebroadcast_pending",
        window.wcash.config,
      );
      if (result.outcome === "cancelled") throw new Error("Pending transaction retry was unexpectedly cancelled.");
      retainOperationSafetyState(result);
      setTransactionNote(describeOperation(result));
      await refreshAfterTransaction();
    } catch {
      setTransactionStatusUnknown(true);
      await refreshAfterTransaction();
      setError("Rebroadcast status is unknown. Refresh signed pending transactions and do not create a replacement.");
    } finally {
      setBusy(false);
    }
  };

  const totals = useMemo(() => {
    if (!balance) return null;
    return {
      privateTotal: sum(balance.accounts.map((account) => account.ironwoodTotalZat)),
      privateSpendable: sum(balance.accounts.map((account) => account.ironwoodSpendableZat)),
      privatePending: sum(balance.accounts.map((account) => account.ironwoodPendingZat)),
      coinbaseTotal: sum(balance.accounts.map((account) => account.transparentCoinbaseTotalZat)),
      coinbaseSpendable: sum(balance.accounts.map((account) => account.transparentCoinbaseSpendableZat)),
      coinbasePending: sum(balance.accounts.map((account) => account.transparentCoinbasePendingZat)),
    };
  }, [balance]);

  const exactTipReady = balance !== null && isExactTipBalance(balance);
  const transactionsBusy = busy || syncing;
  const pendingSnapshotReady =
    exactTipReady &&
    pendingLoadState === "loaded" &&
    pendingExactTipHeight !== null &&
    pendingExactTipHeight === balance.chainTipHeight;
  const hasBlockingPendingTransaction = pendingTransactions.some((transaction) => transaction.blocksNewSigning);
  const hasTransactionSafetyHold = recoveryHoldTxids.length > 0 || transactionStatusUnknown;
  const canReviewSend =
    pendingSnapshotReady &&
    !transactionsBusy &&
    !hasBlockingPendingTransaction &&
    !hasTransactionSafetyHold &&
    (totals?.privateSpendable ?? 0n) > 0n;
  const canReviewShield =
    pendingSnapshotReady &&
    !transactionsBusy &&
    !hasBlockingPendingTransaction &&
    !hasTransactionSafetyHold &&
    (totals?.coinbaseSpendable ?? 0n) > 0n;

  const phraseWords = pendingPhrase?.split(" ") ?? [];

  return (
    <main className="warden-shell">
      <WcashHeader network={networkLabel} ticker={ticker} />
      <section className="warden-main">
        <div className="warden-testnet-warning" role="note">
          {localRegtest ? (
            <>
              Local Regtest funds have no monetary value. Fixed endpoint: <code>{runtimeConfig?.endpoint}</code>.
            </>
          ) : (
            <>Testnet funds have no monetary value. This build connects only to Wcash Testnet.</>
          )}
        </div>

        {error ? <ErrorNotice message={error} onDismiss={() => setError(null)} /> : null}

        {screen === "boot" ? (
          <section className="warden-centered" aria-live="polite">
            <BusyLine>Checking the local Wcash wallet…</BusyLine>
          </section>
        ) : null}

        {screen === "unavailable" ? (
          <section className="warden-centered">
            <p className="warden-kicker">Runtime unavailable</p>
            <h1>Wcash wallet core did not pass startup checks.</h1>
            <p>Wallet actions remain locked. No Zcash runtime or legacy wallet path will be used as a fallback.</p>
            <button className="warden-button warden-button--secondary" type="button" onClick={() => void bootstrap()}>
              Check again
            </button>
          </section>
        ) : null}

        {screen === "onboarding" ? (
          <section className="warden-onboarding">
            <div className="warden-intro">
              <p className="warden-kicker">Desktop wallet</p>
              <h1>Private Wcash, without legacy pool baggage.</h1>
              <p>
                Receive normally into Ironwood. A separate transparent address is available only for pool and solo
                mining coinbase rewards.
              </p>
            </div>
            <div className="warden-actions">
              <article>
                <span className="warden-step">01</span>
                <h2>Create a wallet</h2>
                <p>Generate a 24-word recovery phrase and confirm your offline backup.</p>
                <button className="warden-button" type="button" disabled={busy} onClick={() => void createWallet()}>
                  {busy ? "Creating…" : "Create new wallet"}
                </button>
              </article>
              <article>
                <span className="warden-step">02</span>
                <h2>Restore a wallet</h2>
                <p>Recover an existing {networkLabel} wallet from its phrase and birthday.</p>
                <button
                  className="warden-button warden-button--secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => setScreen("restore")}
                >
                  Restore wallet
                </button>
              </article>
            </div>
          </section>
        ) : null}

        {screen === "pending" ? (
          <section className="warden-centered">
            <p className="warden-kicker">Interrupted setup detected</p>
            <h1>Finish the pending wallet setup</h1>
            <p>
              Wcash Warden securely stored the recovery secret before the wallet database was created. Resume the same{" "}
              {pendingIntent === "create" ? "creation" : "restore"} operation to complete it safely.
            </p>
            {pendingIntent === "restore" && pendingBirthday ? (
              <p className="warden-meta">Restore birthday block {pendingBirthday.toLocaleString()}</p>
            ) : null}
            <button className="warden-button" type="button" disabled={busy} onClick={() => void resumePending()}>
              {busy ? "Resuming…" : "Resume setup"}
            </button>
          </section>
        ) : null}

        {screen === "backupRequired" ? (
          <section className="warden-centered">
            <p className="warden-kicker">Backup not confirmed</p>
            <h1>Finish the recovery phrase backup</h1>
            <p>
              The wallet stays locked until the 24 recovery words are verified and the acknowledgement is stored
              durably. Operating-system authentication is required before the phrase can be revealed.
            </p>
            <button className="warden-button" type="button" disabled={busy} onClick={() => void revealRequiredBackup()}>
              {busy ? "Opening backup…" : "Continue backup"}
            </button>
          </section>
        ) : null}

        {screen === "restore" ? (
          <section className="warden-panel warden-form-panel" aria-labelledby="restore-title">
            <button className="warden-back" type="button" disabled={busy} onClick={() => setScreen("onboarding")}>
              ← Back
            </button>
            <p className="warden-kicker">Wallet recovery</p>
            <h1 id="restore-title">Restore {networkLabel} wallet</h1>
            <p className="warden-help">
              The birthday is the earliest block that may contain wallet activity. Use 1 if you are unsure; scanning
              will take longer.
            </p>
            <form onSubmit={(event) => void restoreWallet(event)}>
              <label htmlFor="recovery-phrase">24-word recovery phrase</label>
              <textarea
                id="recovery-phrase"
                value={restorePhrase}
                onChange={(event) => setRestorePhrase(event.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                rows={5}
                disabled={busy}
                data-sensitive="recovery-phrase"
              />
              <label htmlFor="birthday-height">Birthday height</label>
              <input
                id="birthday-height"
                type="number"
                min="1"
                max="4294967295"
                step="1"
                inputMode="numeric"
                value={restoreBirthday}
                onChange={(event) => setRestoreBirthday(event.target.value)}
                disabled={busy}
              />
              <p className="warden-security-note">The recovery phrase is sent only to the local wallet process.</p>
              <button className="warden-button" type="submit" disabled={busy}>
                {busy ? "Restoring…" : "Restore wallet"}
              </button>
            </form>
          </section>
        ) : null}

        {screen === "backup" && pendingPhrase ? (
          <section className="warden-panel warden-backup" aria-labelledby="backup-title">
            <p className="warden-kicker">Required backup</p>
            <h1 id="backup-title">Write down these 24 words</h1>
            <p>
              Store this phrase offline. Until you confirm it, Wcash Warden can reveal it again through the secured
              operating-system keychain. After confirmation, it is never exposed by the app again. Anyone with these
              words can spend the wallet.
            </p>
            <ol className="warden-words" aria-label="Recovery phrase">
              {phraseWords.map((word, index) => (
                <li key={`${index}-${word}`}>
                  <span>{index + 1}</span>
                  <strong>{word}</strong>
                </li>
              ))}
            </ol>
            <form className="warden-confirm" onSubmit={(event) => void confirmBackup(event)}>
              <h2>Confirm your backup</h2>
              <div className="warden-confirm-grid">
                {CONFIRMATION_WORDS.map((index) => (
                  <label key={index}>
                    Word {index + 1}
                    <input
                      type="text"
                      value={confirmation[index] ?? ""}
                      onChange={(event) => setConfirmation({ ...confirmation, [index]: event.target.value })}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      data-sensitive="recovery-confirmation"
                    />
                  </label>
                ))}
              </div>
              <button className="warden-button" type="submit" disabled={busy}>
                Confirm offline backup
              </button>
            </form>
          </section>
        ) : null}

        {screen === "locked" ? (
          <section className="warden-centered">
            <p className="warden-kicker">Local wallet found</p>
            <h1>Open Wcash Warden</h1>
            <p>
              Wcash wallet data is stored in the isolated {networkLabel} profile. Device authentication may be requested
              by your operating system.
            </p>
            {wallet ? <p className="warden-meta">Birthday block {wallet.birthdayHeight.toLocaleString()}</p> : null}
            <button className="warden-button" type="button" disabled={busy} onClick={() => void openWallet()}>
              {busy ? "Opening…" : "Open wallet"}
            </button>
          </section>
        ) : null}

        {screen === "orphaned" ? (
          <section className="warden-centered">
            <p className="warden-kicker">Recovery required</p>
            <h1>Wallet secret is missing from the operating-system keychain.</h1>
            <p>
              The database will not be opened without its matching recovery authority. Keep it unchanged and recover
              from the 24-word offline backup through a reviewed recovery procedure.
            </p>
            {wallet ? (
              <p className="warden-meta">Wallet birthday block {wallet.birthdayHeight.toLocaleString()}</p>
            ) : null}
            <button className="warden-button warden-button--secondary" type="button" onClick={() => void bootstrap()}>
              Check keychain again
            </button>
          </section>
        ) : null}

        {screen === "wallet" ? (
          <section className="warden-wallet" aria-labelledby="wallet-title">
            <div className="warden-wallet-title">
              <div>
                <p className="warden-kicker">{networkLabel} wallet</p>
                <h1 id="wallet-title">Overview</h1>
              </div>
              {syncing ? (
                <button className="warden-button warden-button--danger" type="button" onClick={() => void cancelSync()}>
                  Stop sync
                </button>
              ) : (
                <button className="warden-button" type="button" onClick={() => void syncWallet()}>
                  Synchronize
                </button>
              )}
            </div>

            <div className="warden-sync" data-exact-tip={balance ? "true" : "false"}>
              <span aria-hidden="true" />
              <div>
                <strong>
                  {syncing ? "Synchronization in progress" : balance ? "Exact-tip balance" : "Balance locked"}
                </strong>
                <p>{syncNote}</p>
              </div>
            </div>

            {totals ? (
              <div className="warden-balances" aria-label="Exact-tip balances">
                <article className="warden-balance-primary">
                  <span>Private balance</span>
                  <strong>{formatTwc(totals.privateTotal)} TWC</strong>
                  <small>{formatTwc(totals.privateSpendable)} available</small>
                </article>
                <article>
                  <span>Private pending</span>
                  <strong>{formatTwc(totals.privatePending)} TWC</strong>
                </article>
                <article>
                  <span>Mining coinbase</span>
                  <strong>{formatTwc(totals.coinbaseTotal)} TWC</strong>
                  <small>
                    {formatTwc(totals.coinbaseSpendable)} mature · {formatTwc(totals.coinbasePending)} pending
                  </small>
                </article>
              </div>
            ) : (
              <div className="warden-balance-placeholder" aria-label="Balance unavailable">
                Amounts are not displayed from stale or partially scanned wallet state.
              </div>
            )}

            {transactionNote ? (
              <div className="warden-transaction-note" role="status">
                <strong>Transaction status</strong>
                <p>{transactionNote}</p>
              </div>
            ) : null}

            <section className="warden-transactions" aria-labelledby="send-title">
              <div className="warden-section-heading">
                <div>
                  <p className="warden-kicker">Private transfer</p>
                  <h2 id="send-title">Send TWC</h2>
                </div>
                <span>Ironwood only</span>
              </div>
              <form className="warden-send-form" onSubmit={(event) => void reviewSend(event)}>
                <label htmlFor="send-address">{networkLabel} recipient</label>
                <input
                  id="send-address"
                  type="text"
                  value={sendAddress}
                  onChange={(event) => setSendAddress(event.target.value)}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={transactionsBusy}
                  placeholder={recipientPlaceholder}
                />
                <div className="warden-send-row">
                  <label>
                    Amount (TWC)
                    <input
                      type="text"
                      inputMode="decimal"
                      value={sendAmount}
                      onChange={(event) => setSendAmount(event.target.value)}
                      autoComplete="off"
                      disabled={transactionsBusy}
                      placeholder="0.00000001"
                    />
                  </label>
                  <label>
                    Private memo (optional)
                    <textarea
                      value={sendMemo}
                      onChange={(event) => setSendMemo(event.target.value)}
                      autoComplete="off"
                      rows={3}
                      disabled={transactionsBusy}
                    />
                    <small data-over-limit={memoUtf8Bytes(sendMemo) > 512 ? "true" : "false"}>
                      {memoUtf8Bytes(sendMemo)} / 512 UTF-8 bytes
                    </small>
                  </label>
                </div>
                <p className="warden-help">
                  The exact ZIP-317 fee is calculated during signing. Review does not sign or reserve funds.
                </p>
                {hasTransactionSafetyHold ? (
                  <p className="warden-help">
                    Transaction status requires recovery review. Do not create a replacement transaction. If every
                    pending row has settled but this session remains locked, restart Wcash Warden to re-attest the
                    wallet database.
                  </p>
                ) : hasBlockingPendingTransaction ? (
                  <p className="warden-help">
                    Resolve the signed pending transaction below before creating another transaction.
                  </p>
                ) : pendingLoadState !== "loaded" || !pendingSnapshotReady ? (
                  <p className="warden-help">
                    Transaction signing stays locked until signed pending status is verified at the same exact tip.
                  </p>
                ) : null}
                <button className="warden-button" type="submit" disabled={!canReviewSend}>
                  {busy ? "Checking…" : "Review payment"}
                </button>
              </form>

              {sendReview ? (
                <div className="warden-review" role="dialog" aria-modal="true" aria-labelledby="payment-review-title">
                  <p className="warden-kicker">{networkLabel} · final app review</p>
                  <h3 id="payment-review-title">Check every payment detail</h3>
                  <dl>
                    <div>
                      <dt>Recipient</dt>
                      <dd>
                        <code>{sendReview.request.payments[0].address}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Amount</dt>
                      <dd>
                        {sendReview.request.payments[0].amount} TWC · {sendReview.amountZat.toString()} zatoshis
                      </dd>
                    </div>
                    <div>
                      <dt>Memo · {sendReview.memoBytes} UTF-8 bytes</dt>
                      <dd className="warden-review-memo">{sendReview.request.payments[0].memo || "No memo"}</dd>
                    </div>
                  </dl>
                  <p>
                    Continue only if the full address and amount are correct. The operating system will show a second,
                    independent confirmation before device authentication and signing.
                  </p>
                  <div className="warden-review-actions">
                    <button
                      className="warden-button warden-button--secondary"
                      type="button"
                      disabled={transactionsBusy}
                      onClick={() => setSendReview(null)}
                    >
                      Go back
                    </button>
                    <button
                      className="warden-button"
                      type="button"
                      disabled={transactionsBusy}
                      onClick={() => void confirmReviewedSend()}
                    >
                      {busy ? "Authorizing…" : "Continue to system confirmation"}
                    </button>
                  </div>
                </div>
              ) : null}
            </section>

            <section className="warden-transactions" aria-labelledby="shield-title">
              <div className="warden-section-heading">
                <div>
                  <p className="warden-kicker">Mining rewards</p>
                  <h2 id="shield-title">Shield coinbase</h2>
                </div>
                <span>{totals ? `${formatTwc(totals.coinbaseSpendable)} TWC mature` : "Exact tip required"}</span>
              </div>
              <p>
                Move mature transparent mining rewards into this wallet&apos;s private Ironwood receiver before normal
                spending. Up to 100 mature inputs are selected; the network fee is deducted from the shielded value.
              </p>
              {(totals?.coinbasePending ?? 0n) > 0n ? (
                <p className="warden-help">
                  {formatTwc(totals?.coinbasePending ?? 0n)} TWC is immature or pending and cannot be shielded yet.
                </p>
              ) : null}
              <button
                className="warden-button warden-button--secondary"
                type="button"
                disabled={!canReviewShield}
                onClick={() => setShieldReview(true)}
              >
                Review shielding
              </button>
              {shieldReview ? (
                <div className="warden-review" role="dialog" aria-modal="true" aria-labelledby="shield-review-title">
                  <p className="warden-kicker">{networkLabel} · mining privacy</p>
                  <h3 id="shield-review-title">Shield up to {formatTwc(totals?.coinbaseSpendable ?? 0n)} TWC</h3>
                  <p>
                    Destination: this wallet&apos;s own private Ironwood receiver. The exact selected amount and ZIP-317
                    fee are calculated during signing. This creates and broadcasts a real {networkLabel} transaction.
                  </p>
                  <div className="warden-review-actions">
                    <button
                      className="warden-button warden-button--secondary"
                      type="button"
                      disabled={transactionsBusy}
                      onClick={() => setShieldReview(false)}
                    >
                      Go back
                    </button>
                    <button
                      className="warden-button"
                      type="button"
                      disabled={transactionsBusy}
                      onClick={() => void confirmShieldCoinbase()}
                    >
                      {busy ? "Authorizing…" : "Continue to system confirmation"}
                    </button>
                  </div>
                </div>
              ) : null}
            </section>

            <section className="warden-transactions" aria-labelledby="pending-title">
              <div className="warden-section-heading">
                <div>
                  <p className="warden-kicker">Recovery</p>
                  <h2 id="pending-title">Signed, not yet mined</h2>
                </div>
                <span>{pendingTransactions.length}</span>
              </div>
              {pendingLoadState === "loading" ? (
                <BusyLine>Reading signed pending transactions…</BusyLine>
              ) : pendingLoadState === "error" ? (
                <p role="alert">
                  Signed pending status is unavailable. New signing and exact-transaction retry remain locked.
                </p>
              ) : pendingLoadState === "loaded" && pendingTransactions.length === 0 ? (
                <p>No durable pending transactions.</p>
              ) : pendingLoadState === "loaded" ? (
                <ul className="warden-pending-list">
                  {pendingTransactions.map((transaction) => (
                    <li key={transaction.txid}>
                      <div>
                        <code>{transaction.txid}</code>
                        <span>
                          {transaction.expiryHeight === 0
                            ? "No expiry height"
                            : `Expires at block ${transaction.expiryHeight.toLocaleString()}`}{" "}
                          ·{" "}
                          {transaction.lifecycle === "expired"
                            ? "expired; no rebroadcast"
                            : transaction.lifecycle === "tip_unknown"
                              ? "exact tip unknown; signing locked"
                              : "active; blocks replacement signing"}
                        </span>
                      </div>
                      <button
                        className="warden-button warden-button--secondary"
                        type="button"
                        disabled={transactionsBusy || !pendingSnapshotReady || !transaction.rebroadcastAllowed}
                        onClick={() => void retryPendingTransaction(transaction)}
                      >
                        Retry exact transaction
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>Signed pending status has not been verified.</p>
              )}
              <p className="warden-help">
                Retry reuses the exact stored signed bytes. Wcash Warden never creates a replacement automatically and
                does not promise cancellation.
              </p>
            </section>

            <section className="warden-addresses" aria-labelledby="receive-title">
              <h2 id="receive-title">Receive</h2>
              {receivers ? (
                <>
                  <article className="warden-address warden-address--primary">
                    <div>
                      <span className="warden-address-label">Primary · private Ironwood</span>
                      <strong>Use for normal payments</strong>
                    </div>
                    <code>{receivers.ironwoodAddress}</code>
                  </article>
                  <article className="warden-address">
                    <div>
                      <span className="warden-address-label">Secondary · transparent coinbase</span>
                      <strong>Mining payouts only</strong>
                    </div>
                    <code>{receivers.transparentCoinbaseAddress}</code>
                    <p>Public on-chain. Mature mining rewards should be shielded into Ironwood before normal use.</p>
                  </article>
                </>
              ) : (
                <BusyLine>Reading Wcash receiving addresses…</BusyLine>
              )}
            </section>
          </section>
        ) : null}
      </section>
    </main>
  );
};

export default WcashWallet;
