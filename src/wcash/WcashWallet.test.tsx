import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WcashWallet from "./WcashWallet";

const wallet = {
  account_id: "account-1",
  birthday_height: 1,
  address: "wutest1private",
  transparent_coinbase_address: "WTmining",
  created: true,
};

const receivers = {
  ironwood_address: "wutest1private",
  transparent_coinbase_address: "WTmining",
};

const ironwoodRecipient = `wutest1${"q".repeat(80)}`;
const txid = "a".repeat(64);

const broadcastResult = (operation: "send" | "shield_coinbase" | "rebroadcast_pending" = "send") => {
  const rebroadcast = operation === "rebroadcast_pending";
  return {
    schema_version: 1,
    operation,
    outcome: "broadcast",
    txid,
    branch_id: "b3cfd27e",
    expiry_height: 140,
    target_height: rebroadcast ? null : 100,
    fee_zat: rebroadcast ? null : "15000",
    internal_change_receiver_verified: rebroadcast ? null : true,
    exact_tip_height: 100,
    broadcast: { txid, disposition: "submitted", status: { state: "mempool" } },
    recovery: null,
    rejection: null,
  };
};

const balanceAccount = {
  account_id: "account-1",
  ironwood_total_zat: 625_000_000,
  ironwood_spendable_zat: 625_000_000,
  ironwood_locked_zat: 0,
  ironwood_pending_change_zat: 0,
  ironwood_pending_spendability_zat: 0,
  sapling_total_zat: 0,
  orchard_total_zat: 0,
  transparent_total_zat: 625_000_000,
  transparent_coinbase_total_zat: 625_000_000,
  transparent_coinbase_spendable_zat: 0,
  transparent_coinbase_pending_zat: 625_000_000,
};

const balance = (tip: number, scanned = tip) => ({
  chain_tip_height: tip,
  fully_scanned_height: scanned,
  synchronized: tip === scanned,
  accounts: [balanceAccount],
});

type Bridge = Window["wcash"];

const testnetConfig: Bridge["config"] = {
  profile: "testnet",
  productName: "Wcash Warden Testnet",
  network: "Wcash Testnet",
  ticker: "TWC",
  endpoint: "https://wallet-testnet.wcashexplorer.com:443",
  storageNamespace: "wcashtestnet-v5",
  branchId: "b3cfd27e",
  runtimeReady: true,
  coreRevision: "db28e549bda764adcc5ba48c295a3e33c033d638",
};

const localRegtestConfig: Bridge["config"] = {
  profile: "local-regtest",
  productName: "Wcash Warden Local Regtest",
  network: "Wcash Regtest",
  ticker: "TWC",
  endpoint: "http://127.0.0.1:48234",
  storageNamespace: "wcashregtest-v5",
  branchId: "c3a6678a",
  runtimeReady: true,
  coreRevision: "db28e549bda764adcc5ba48c295a3e33c033d638",
};

const installBridge = (overrides: Partial<Bridge> = {}): Bridge => {
  const bridge: Bridge = {
    config: testnetConfig,
    status: jest.fn().mockResolvedValue({ state: "no-database-no-secret" }),
    create: jest.fn(),
    restore: jest.fn(),
    resumePending: jest.fn(),
    revealBackup: jest.fn(),
    acknowledgeBackup: jest.fn().mockResolvedValue({ state: "database-and-secret-ready", wallet }),
    open: jest.fn().mockResolvedValue({ wallet }),
    sync: jest.fn(),
    stopSync: jest.fn().mockResolvedValue(true),
    balance: jest.fn(),
    receivers: jest.fn().mockResolvedValue(receivers),
    validateRecipient: jest.fn().mockImplementation((address: string) =>
      Promise.resolve({
        schema_version: 1,
        valid: true,
        network: "Wcash Testnet",
        recipient_kind: "ironwood",
        canonical_address: address,
        error: null,
      }),
    ),
    send: jest.fn().mockResolvedValue(broadcastResult()),
    shieldCoinbase: jest.fn().mockResolvedValue(broadcastResult("shield_coinbase")),
    pendingTransactions: jest
      .fn()
      .mockResolvedValue({ schema_version: 1, exact_tip_height: 100, transactions: [], next_cursor: null }),
    rebroadcastPending: jest.fn().mockResolvedValue(broadcastResult("rebroadcast_pending")),
    ...overrides,
  };
  const statusIdentity = {
    profile: bridge.config.profile,
    network: bridge.config.network,
    ticker: bridge.config.ticker,
    endpoint: bridge.config.endpoint,
    storage_namespace: bridge.config.storageNamespace,
    branch_id: bridge.config.branchId,
  };
  const rawStatus = bridge.status;
  bridge.status = jest.fn(async (...args: Parameters<Bridge["status"]>) => ({
    ...statusIdentity,
    ...((await rawStatus(...args)) as object),
  }));
  const rawAcknowledgeBackup = bridge.acknowledgeBackup;
  bridge.acknowledgeBackup = jest.fn(async (...args: Parameters<Bridge["acknowledgeBackup"]>) => ({
    ...statusIdentity,
    ...((await rawAcknowledgeBackup(...args)) as object),
  }));
  Object.defineProperty(window, "wcash", { configurable: true, value: bridge });
  return bridge;
};

describe("Wcash Testnet desktop wallet", () => {
  afterEach(() => {
    delete (window as Partial<Window>).wcash;
  });

  it("visibly identifies the fixed local Regtest endpoint", async () => {
    installBridge({
      config: localRegtestConfig,
      status: jest.fn().mockResolvedValue({ state: "database-and-secret-ready", wallet }),
    });
    render(<WcashWallet />);

    expect(await screen.findByText(/Local Regtest funds have no monetary value/i)).toBeInTheDocument();
    expect(screen.getByText("http://127.0.0.1:48234")).toBeInTheDocument();
    expect(screen.getByText(/Wcash Regtest · TWC/i)).toBeInTheDocument();
    expect(await screen.findByText(/isolated Wcash Regtest profile/i)).toBeInTheDocument();
    expect(document.title).toBe("Wcash Warden Local Regtest");
  });

  it("fails closed when the reviewed runtime is unavailable", async () => {
    const bridge = installBridge({
      config: {
        ...testnetConfig,
        runtimeReady: false,
        coreRevision: null,
      },
    });

    render(<WcashWallet />);

    expect(await screen.findByText("Wcash wallet core did not pass startup checks.")).toBeInTheDocument();
    expect(bridge.status).not.toHaveBeenCalled();
    expect(screen.queryByText(/swap/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Zcash runtime or legacy wallet path/i)).toBeInTheDocument();
  });

  it("creates a wallet only after explicit 24-word backup confirmation", async () => {
    const user = userEvent.setup();
    const words = Array.from({ length: 24 }, (_, index) => `word${index + 1}`);
    const bridge = installBridge({
      create: jest.fn().mockResolvedValue({
        wallet,
        recoveryPhrase: words.join(" "),
        seed_scheme: "bip39-english-24-empty-passphrase-v1",
      }),
      balance: jest.fn().mockResolvedValue(balance(90)),
    });
    render(<WcashWallet />);

    await user.click(await screen.findByRole("button", { name: "Create new wallet" }));
    expect(await screen.findByRole("heading", { name: "Write down these 24 words" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(24);
    expect(screen.getByText("word24")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Word 4"), "word4");
    await user.type(screen.getByLabelText("Word 12"), "word12");
    await user.type(screen.getByLabelText("Word 20"), "wrong");
    await user.click(screen.getByRole("button", { name: "Confirm offline backup" }));
    expect(await screen.findByText(/confirmation words do not match/i)).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Word 20"));
    await user.type(screen.getByLabelText("Word 20"), "word20");
    await user.click(screen.getByRole("button", { name: "Confirm offline backup" }));

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Recovery phrase" })).not.toBeInTheDocument();
    expect(screen.queryByText("word24")).not.toBeInTheDocument();
    expect(screen.getByText("wutest1private")).toBeInTheDocument();
    expect(bridge.create).toHaveBeenCalledWith();
    expect(bridge.acknowledgeBackup).toHaveBeenCalledWith();
  });

  it("restores with an explicit birthday and clears the phrase from the form before completion", async () => {
    const user = userEvent.setup();
    const phrase = Array.from({ length: 24 }, (_, index) => `word${index + 1}`).join(" ");
    let releaseRestore: ((value: unknown) => void) | undefined;
    const bridge = installBridge({
      restore: jest.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseRestore = resolve;
          }),
      ),
      balance: jest.fn().mockResolvedValue(balance(90)),
    });
    render(<WcashWallet />);

    await user.click(await screen.findByRole("button", { name: "Restore wallet" }));
    const phraseField = screen.getByLabelText("24-word recovery phrase");
    await user.type(phraseField, phrase.toUpperCase());
    await user.clear(screen.getByLabelText("Birthday height"));
    await user.type(screen.getByLabelText("Birthday height"), "17");
    await user.click(screen.getByRole("button", { name: "Restore wallet" }));

    await waitFor(() => expect(bridge.restore).toHaveBeenCalledWith(phrase, 17));
    expect(phraseField).toHaveValue("");
    releaseRestore?.({ wallet });
    expect(await screen.findByText("wutest1private")).toBeInTheDocument();
  });

  it("opens an existing wallet and withholds stale balances until exact-tip sync", async () => {
    const user = userEvent.setup();
    const bridge = installBridge({
      status: jest.fn().mockResolvedValue({
        network: "Wcash Testnet",
        ticker: "TWC",
        storage_namespace: "wcashtestnet-v5",
        state: "database-and-secret-ready",
        wallet,
      }),
      open: jest.fn().mockResolvedValue({ wallet }),
      balance: jest.fn().mockResolvedValueOnce(balance(91, 90)).mockResolvedValueOnce(balance(92)),
      sync: jest.fn().mockResolvedValue(balance(92)),
    });
    render(<WcashWallet />);

    await user.click(await screen.findByRole("button", { name: "Open wallet" }));
    expect(await screen.findByText(/balance withheld because/i)).toBeInTheDocument();
    expect(screen.getByText(/not synchronized to its known chain tip/i)).toBeInTheDocument();
    expect(screen.queryByText("6.25000000")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Synchronize" }));
    expect(await screen.findAllByText(/6\.25000000/)).not.toHaveLength(0);
    expect(screen.getByText("Verified at block 92.")).toBeInTheDocument();
    expect(bridge.sync).toHaveBeenCalledTimes(1);
  });

  it("rejects non-Wcash receiving addresses instead of rendering them", async () => {
    const user = userEvent.setup();
    installBridge({
      status: jest.fn().mockResolvedValue({
        network: "Wcash Testnet",
        ticker: "TWC",
        storage_namespace: "wcashtestnet-v5",
        state: "database-and-secret-ready",
        wallet,
      }),
      open: jest.fn().mockResolvedValue({ wallet }),
      receivers: jest.fn().mockResolvedValue({
        ironwood_address: "utest1zcash",
        transparent_coinbase_address: "tmZcash",
      }),
    });
    render(<WcashWallet />);

    await user.click(await screen.findByRole("button", { name: "Open wallet" }));

    expect(await screen.findByText(/different network/i)).toBeInTheDocument();
    expect(screen.queryByText("utest1zcash")).not.toBeInTheDocument();
    expect(screen.queryByText("tmZcash")).not.toBeInTheDocument();
  });

  it("requests cancellation without exposing a stale balance", async () => {
    const user = userEvent.setup();
    let rejectSync: ((error: Error) => void) | undefined;
    const bridge = installBridge({
      status: jest.fn().mockResolvedValue({
        network: "Wcash Testnet",
        ticker: "TWC",
        storage_namespace: "wcashtestnet-v5",
        state: "database-and-secret-ready",
        wallet,
      }),
      open: jest.fn().mockResolvedValue({ wallet }),
      balance: jest.fn().mockRejectedValue(new Error("not synchronized")),
      sync: jest.fn().mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectSync = reject;
          }),
      ),
    });
    render(<WcashWallet />);

    await user.click(await screen.findByRole("button", { name: "Open wallet" }));
    await user.click(await screen.findByRole("button", { name: "Synchronize" }));
    await user.click(await screen.findByRole("button", { name: "Stop sync" }));
    expect(bridge.stopSync).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/6\.25000000/)).not.toBeInTheDocument();

    rejectSync?.(new Error("Synchronization cancelled"));
    expect(await screen.findByRole("button", { name: "Synchronize" })).toBeInTheDocument();
  });

  it("resumes an interrupted create and still requires backup confirmation", async () => {
    const user = userEvent.setup();
    const words = Array.from({ length: 24 }, (_, index) => `resume${index + 1}`);
    const bridge = installBridge({
      status: jest.fn().mockResolvedValue({
        network: "Wcash Testnet",
        ticker: "TWC",
        storage_namespace: "wcashtestnet-v5",
        state: "secret-only-pending",
        intent: "create",
        birthdayHeight: 1,
      }),
      resumePending: jest.fn().mockResolvedValue({
        wallet,
        recoveryPhrase: words.join(" "),
        seed_scheme: "bip39-english-24-empty-passphrase-v1",
      }),
    });
    render(<WcashWallet />);

    expect(await screen.findByRole("heading", { name: "Finish the pending wallet setup" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resume setup" }));

    expect(await screen.findByRole("heading", { name: "Write down these 24 words" })).toBeInTheDocument();
    expect(screen.getByText("resume24")).toBeInTheDocument();
    expect(bridge.resumePending).toHaveBeenCalledWith();
  });

  it("fails closed when a wallet database has lost its keychain secret", async () => {
    const bridge = installBridge({
      status: jest.fn().mockResolvedValue({
        network: "Wcash Testnet",
        ticker: "TWC",
        storage_namespace: "wcashtestnet-v5",
        state: "database-only-fail-closed",
        wallet,
      }),
    });
    render(<WcashWallet />);

    expect(
      await screen.findByRole("heading", { name: "Wallet secret is missing from the operating-system keychain." }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open wallet" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore wallet" })).not.toBeInTheDocument();
    expect(bridge.open).not.toHaveBeenCalled();
  });

  it("continues an unacknowledged backup after restart before opening the wallet", async () => {
    const user = userEvent.setup();
    const words = Array.from({ length: 24 }, (_, index) => `backup${index + 1}`);
    let releaseAcknowledgement: ((value: unknown) => void) | undefined;
    const bridge = installBridge({
      status: jest.fn().mockResolvedValue({ state: "database-secret-backup-required", wallet }),
      revealBackup: jest.fn().mockResolvedValue({
        recoveryPhrase: words.join(" "),
        seed_scheme: "bip39-english-24-empty-passphrase-v1",
      }),
      acknowledgeBackup: jest.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseAcknowledgement = resolve;
          }),
      ),
      balance: jest.fn().mockResolvedValue(balance(90)),
    });
    render(<WcashWallet />);

    expect(await screen.findByRole("heading", { name: "Finish the recovery phrase backup" })).toBeInTheDocument();
    expect(screen.queryByText("backup24")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue backup" }));
    expect(await screen.findByText("backup24")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Word 4"), "backup4");
    await user.type(screen.getByLabelText("Word 12"), "backup12");
    await user.type(screen.getByLabelText("Word 20"), "backup20");
    await user.click(screen.getByRole("button", { name: "Confirm offline backup" }));

    expect(screen.queryByText("backup24")).not.toBeInTheDocument();
    expect(bridge.acknowledgeBackup).toHaveBeenCalledWith();
    expect(bridge.open).not.toHaveBeenCalled();
    act(() => {
      releaseAcknowledgement?.({ state: "database-and-secret-ready", wallet });
    });
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(bridge.revealBackup).toHaveBeenCalledWith();
    expect(bridge.open).toHaveBeenCalledWith();
  });

  it("reviews a validated private payment before invoking transaction authority", async () => {
    const user = userEvent.setup();
    const bridge = installBridge({
      status: jest.fn().mockResolvedValue({
        network: "Wcash Testnet",
        ticker: "TWC",
        storage_namespace: "wcashtestnet-v5",
        state: "database-and-secret-ready",
        wallet,
      }),
      balance: jest.fn().mockResolvedValue(balance(100)),
    });
    render(<WcashWallet />);

    await user.click(await screen.findByRole("button", { name: "Open wallet" }));
    await screen.findByText("Verified at block 100.");
    await user.type(screen.getByLabelText("Wcash Testnet recipient"), ironwoodRecipient);
    await user.type(screen.getByLabelText("Amount (TWC)"), "1.25");
    await user.type(screen.getByLabelText(/^Private memo \(optional\)/), "hello 💚");
    await user.click(screen.getByRole("button", { name: "Review payment" }));

    expect(await screen.findByRole("heading", { name: "Check every payment detail" })).toBeInTheDocument();
    expect(screen.getByText(ironwoodRecipient)).toBeInTheDocument();
    expect(screen.getByText(/1\.25 TWC · 125000000 zatoshis/)).toBeInTheDocument();
    expect(bridge.validateRecipient).toHaveBeenCalledWith(ironwoodRecipient);
    expect(bridge.send).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Go back" }));
    expect(bridge.send).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Review payment" }));
    await user.click(await screen.findByRole("button", { name: "Continue to system confirmation" }));

    await waitFor(() => expect(bridge.send).toHaveBeenCalledTimes(1));
    expect(bridge.send).toHaveBeenCalledWith({
      payments: [{ address: ironwoodRecipient, amount: "1.25", memo: "hello 💚" }],
    });
    expect(await screen.findByText(/was accepted for broadcast/i)).toBeInTheDocument();
  });

  it("keeps transaction controls disabled when the wallet is not at the exact tip", async () => {
    const user = userEvent.setup();
    const bridge = installBridge({
      status: jest.fn().mockResolvedValue({
        network: "Wcash Testnet",
        ticker: "TWC",
        storage_namespace: "wcashtestnet-v5",
        state: "database-and-secret-ready",
        wallet,
      }),
      balance: jest.fn().mockResolvedValue(balance(101, 100)),
    });
    render(<WcashWallet />);

    await user.click(await screen.findByRole("button", { name: "Open wallet" }));
    expect(await screen.findByRole("button", { name: "Review payment" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review shielding" })).toBeDisabled();
    expect(bridge.validateRecipient).not.toHaveBeenCalled();
    expect(bridge.send).not.toHaveBeenCalled();
  });

  it("keeps signing locked when signed pending status cannot be verified", async () => {
    const user = userEvent.setup();
    installBridge({
      status: jest.fn().mockResolvedValue({
        network: "Wcash Testnet",
        ticker: "TWC",
        storage_namespace: "wcashtestnet-v5",
        state: "database-and-secret-ready",
        wallet,
      }),
      balance: jest.fn().mockResolvedValue(balance(100)),
      pendingTransactions: jest.fn().mockRejectedValue(new Error("private endpoint diagnostic")),
    });
    render(<WcashWallet />);

    await user.click(await screen.findByRole("button", { name: "Open wallet" }));
    expect(await screen.findByText(/Signed pending status is unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review payment" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review shielding" })).toBeDisabled();
  });

  it("rejects a pending snapshot whose tip changes between pages", async () => {
    const user = userEvent.setup();
    const pendingTxid = "f".repeat(64);
    const pendingTransactions = jest
      .fn()
      .mockResolvedValueOnce({
        schema_version: 1,
        exact_tip_height: 100,
        transactions: [
          {
            txid: pendingTxid,
            branch_id: "b3cfd27e",
            expiry_height: 140,
            lifecycle: "unexpired",
            rebroadcast_allowed: true,
            blocks_new_signing: true,
          },
        ],
        next_cursor: "1",
      })
      .mockResolvedValueOnce({ schema_version: 1, exact_tip_height: 101, transactions: [], next_cursor: null });
    installBridge({
      status: jest.fn().mockResolvedValue({
        network: "Wcash Testnet",
        ticker: "TWC",
        storage_namespace: "wcashtestnet-v5",
        state: "database-and-secret-ready",
        wallet,
      }),
      balance: jest.fn().mockResolvedValue(balance(100)),
      pendingTransactions,
    });
    render(<WcashWallet />);

    await user.click(await screen.findByRole("button", { name: "Open wallet" }));
    expect(await screen.findByText(/Signed pending status is unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review payment" })).toBeDisabled();
    expect(pendingTransactions).toHaveBeenNthCalledWith(1, undefined);
    expect(pendingTransactions).toHaveBeenNthCalledWith(2, "1");
  });

  it("allows new signing after every durable pending row is expired at the same exact tip", async () => {
    const user = userEvent.setup();
    const expiredTxid = "e".repeat(64);
    installBridge({
      status: jest.fn().mockResolvedValue({
        network: "Wcash Testnet",
        ticker: "TWC",
        storage_namespace: "wcashtestnet-v5",
        state: "database-and-secret-ready",
        wallet,
      }),
      balance: jest.fn().mockResolvedValue(balance(100)),
      pendingTransactions: jest.fn().mockResolvedValue({
        schema_version: 1,
        exact_tip_height: 100,
        transactions: [
          {
            txid: expiredTxid,
            branch_id: "b3cfd27e",
            expiry_height: 100,
            lifecycle: "expired",
            rebroadcast_allowed: false,
            blocks_new_signing: false,
          },
        ],
        next_cursor: null,
      }),
    });
    render(<WcashWallet />);

    await user.click(await screen.findByRole("button", { name: "Open wallet" }));
    expect(await screen.findByText(expiredTxid)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review payment" })).toBeEnabled();
  });

  it("reports definitive rejection without claiming that the transaction was accepted", async () => {
    const user = userEvent.setup();
    const bridge = installBridge({
      status: jest.fn().mockResolvedValue({
        network: "Wcash Testnet",
        ticker: "TWC",
        storage_namespace: "wcashtestnet-v5",
        state: "database-and-secret-ready",
        wallet,
      }),
      balance: jest.fn().mockResolvedValue(balance(100)),
      send: jest.fn().mockResolvedValue({
        ...broadcastResult(),
        outcome: "rejected",
        broadcast: null,
        rejection: {
          code: "transaction_rejected",
          node_code: -26,
          message:
            "The Wcash node rejected this signed transaction. Wait for it to expire before creating a replacement.",
        },
      }),
    });
    render(<WcashWallet />);

    await user.click(await screen.findByRole("button", { name: "Open wallet" }));
    await user.type(screen.getByLabelText("Wcash Testnet recipient"), ironwoodRecipient);
    await user.type(screen.getByLabelText("Amount (TWC)"), "1");
    await user.click(screen.getByRole("button", { name: "Review payment" }));
    await user.click(await screen.findByRole("button", { name: "Continue to system confirmation" }));

    expect(await screen.findByText(/definitively rejected by the Wcash node \(code -26\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/was accepted for broadcast/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review payment" })).toBeDisabled();
    expect(bridge.send).toHaveBeenCalledTimes(1);
  });

  it("dismisses a reviewed payment after an unknown post-invocation status", async () => {
    const user = userEvent.setup();
    const bridge = installBridge({
      status: jest.fn().mockResolvedValue({
        network: "Wcash Testnet",
        ticker: "TWC",
        storage_namespace: "wcashtestnet-v5",
        state: "database-and-secret-ready",
        wallet,
      }),
      balance: jest.fn().mockResolvedValue(balance(100)),
      send: jest.fn().mockRejectedValue(new Error("native response was lost after signing")),
    });
    render(<WcashWallet />);

    await user.click(await screen.findByRole("button", { name: "Open wallet" }));
    await user.type(screen.getByLabelText("Wcash Testnet recipient"), ironwoodRecipient);
    await user.type(screen.getByLabelText("Amount (TWC)"), "1");
    await user.click(screen.getByRole("button", { name: "Review payment" }));
    await user.click(await screen.findByRole("button", { name: "Continue to system confirmation" }));

    expect(await screen.findByText(/Transaction status is unknown/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Check every payment detail" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Wcash Testnet recipient")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Review payment" })).toBeDisabled();
    expect(screen.getByText(/Do not create a replacement transaction/)).toBeInTheDocument();
    expect(bridge.send).toHaveBeenCalledTimes(1);
  });

  it("requires mature coinbase before reviewing shielding and allows a local cancellation", async () => {
    const user = userEvent.setup();
    const matureAccount = {
      ...balanceAccount,
      transparent_coinbase_spendable_zat: 625_000_000,
      transparent_coinbase_pending_zat: 0,
    };
    const bridge = installBridge({
      status: jest.fn().mockResolvedValue({
        network: "Wcash Testnet",
        ticker: "TWC",
        storage_namespace: "wcashtestnet-v5",
        state: "database-and-secret-ready",
        wallet,
      }),
      balance: jest.fn().mockResolvedValue({ ...balance(100), accounts: [matureAccount] }),
    });
    render(<WcashWallet />);

    await user.click(await screen.findByRole("button", { name: "Open wallet" }));
    await user.click(await screen.findByRole("button", { name: "Review shielding" }));
    expect(await screen.findByRole("heading", { name: /Shield up to 6\.25000000 TWC/ })).toBeInTheDocument();
    expect(screen.getByText(/own private Ironwood receiver/i)).toBeInTheDocument();
    expect(bridge.shieldCoinbase).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Go back" }));
    expect(bridge.shieldCoinbase).not.toHaveBeenCalled();
  });

  it("shows durable pending transactions and blocks retry at or after expiry", async () => {
    const user = userEvent.setup();
    const activeTxid = "b".repeat(64);
    const expiredTxid = "c".repeat(64);
    const bridge = installBridge({
      status: jest.fn().mockResolvedValue({
        network: "Wcash Testnet",
        ticker: "TWC",
        storage_namespace: "wcashtestnet-v5",
        state: "database-and-secret-ready",
        wallet,
      }),
      balance: jest.fn().mockResolvedValue(balance(100)),
      pendingTransactions: jest.fn().mockResolvedValue({
        schema_version: 1,
        exact_tip_height: 100,
        transactions: [
          {
            txid: activeTxid,
            branch_id: "b3cfd27e",
            expiry_height: 120,
            lifecycle: "unexpired",
            rebroadcast_allowed: true,
            blocks_new_signing: true,
          },
          {
            txid: expiredTxid,
            branch_id: "b3cfd27e",
            expiry_height: 100,
            lifecycle: "expired",
            rebroadcast_allowed: false,
            blocks_new_signing: false,
          },
        ],
        next_cursor: null,
      }),
      rebroadcastPending: jest.fn().mockResolvedValue({
        ...broadcastResult("rebroadcast_pending"),
        txid: activeTxid,
        broadcast: {
          txid: activeTxid,
          disposition: "already_known",
          status: { state: "mempool" },
        },
      }),
    });
    render(<WcashWallet />);

    await user.click(await screen.findByRole("button", { name: "Open wallet" }));
    expect(await screen.findByText(activeTxid)).toBeInTheDocument();
    expect(screen.getByText(expiredTxid)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review payment" })).toBeDisabled();
    expect(screen.getByText(/Resolve the signed pending transaction/i)).toBeInTheDocument();
    const retryButtons = screen.getAllByRole("button", { name: "Retry exact transaction" });
    expect(retryButtons[0]).toBeEnabled();
    expect(retryButtons[1]).toBeDisabled();
    await user.click(retryButtons[0]);
    await waitFor(() => expect(bridge.rebroadcastPending).toHaveBeenCalledWith(activeTxid));
    expect(screen.getByText(/never creates a replacement automatically/i)).toBeInTheDocument();
  });
});
