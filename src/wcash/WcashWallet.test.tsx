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

const installBridge = (overrides: Partial<Bridge> = {}): Bridge => {
  const bridge: Bridge = {
    config: {
      productName: "Wcash Warden Testnet",
      network: "Wcash Testnet",
      ticker: "TWC",
      runtimeReady: true,
      coreRevision: "62d729a17fed2263eddac9a11731def20062293d",
    },
    status: jest.fn().mockResolvedValue({
      network: "Wcash Testnet",
      ticker: "TWC",
      storage_namespace: "wcashtestnet-v5",
      state: "no-database-no-secret",
    }),
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
    ...overrides,
  };
  Object.defineProperty(window, "wcash", { configurable: true, value: bridge });
  return bridge;
};

describe("Wcash Testnet desktop wallet", () => {
  afterEach(() => {
    delete (window as Partial<Window>).wcash;
  });

  it("fails closed when the reviewed runtime is unavailable", async () => {
    const bridge = installBridge({
      config: {
        productName: "Wcash Warden Testnet",
        network: "Wcash Testnet",
        ticker: "TWC",
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
});
