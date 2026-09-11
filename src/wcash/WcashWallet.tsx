import React, { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  WcashBalance,
  WcashReceivers,
  WcashWalletMetadata,
  formatTwc,
  isExactTipBalance,
  parseBalance,
  parseCreatedWallet,
  parseOpenedWallet,
  parseReceivers,
  parseStatus,
  publicErrorMessage,
  require24WordRecoveryPhrase,
} from "./api";
import "./WcashWallet.css";

type Screen =
  | "boot"
  | "onboarding"
  | "restore"
  | "backup"
  | "pending"
  | "locked"
  | "wallet"
  | "orphaned"
  | "unavailable";

const CONFIRMATION_WORDS = [3, 11, 19] as const;

const sum = (values: readonly bigint[]): bigint => values.reduce((total, value) => total + value, 0n);

const WcashHeader = () => (
  <header className="warden-header">
    <div className="warden-brand" aria-label="Wcash Warden">
      <span className="warden-mark" aria-hidden="true">
        W
      </span>
      <span>Wcash Warden</span>
    </div>
    <div className="warden-network">
      <span aria-hidden="true" /> Wcash Testnet · TWC
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

  const bootstrap = useCallback(async () => {
    setScreen("boot");
    setError(null);

    try {
      const bridge = window.wcash;
      if (
        !bridge?.config.runtimeReady ||
        bridge.config.network !== "Wcash Testnet" ||
        bridge.config.ticker !== "TWC" ||
        !bridge.config.coreRevision ||
        !/^[0-9a-f]{40}$/.test(bridge.config.coreRevision)
      ) {
        setScreen("unavailable");
        return;
      }

      const status = parseStatus(await bridge.status());
      if (status.network !== "Wcash Testnet" || status.ticker !== "TWC") {
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
    void bootstrap();
  }, [bootstrap]);

  const enterWallet = async (metadata: WcashWalletMetadata) => {
    setWallet(metadata);
    setReceivers(null);
    setBalance(null);
    setSyncNote("Checking wallet state…");
    setScreen("wallet");

    const addresses = parseReceivers(await window.wcash.receivers());
    setReceivers(addresses);

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
    try {
      await enterWallet(metadata);
    } catch (cause) {
      setError(publicErrorMessage(cause));
      setScreen("locked");
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

  const syncWallet = async () => {
    setSyncing(true);
    setBalance(null);
    setError(null);
    setSyncNote("Synchronizing Wcash Testnet…");
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

  const phraseWords = pendingPhrase?.split(" ") ?? [];

  return (
    <main className="warden-shell">
      <WcashHeader />
      <section className="warden-main">
        <div className="warden-testnet-warning" role="note">
          Testnet funds have no monetary value. This build connects only to Wcash Testnet.
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
                <p>Recover an existing Wcash Testnet wallet from its phrase and birthday.</p>
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

        {screen === "restore" ? (
          <section className="warden-panel warden-form-panel" aria-labelledby="restore-title">
            <button className="warden-back" type="button" disabled={busy} onClick={() => setScreen("onboarding")}>
              ← Back
            </button>
            <p className="warden-kicker">Wallet recovery</p>
            <h1 id="restore-title">Restore Wcash Testnet wallet</h1>
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
              This is the only time Wcash Warden displays the recovery phrase. Store it offline. Anyone with these words
              can spend the wallet.
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
              Wcash wallet data is stored in the isolated Testnet profile. Device authentication may be requested by
              your operating system.
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
                <p className="warden-kicker">Wcash Testnet wallet</p>
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
