import React from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { render } from "../../test-utils";
import AddNewWallet from "./AddNewWallet";
import { ipcRenderer, native } from "../../electronBridge";
import fetchServerList from "../../utils/fetchServerList";
import {
  CreationTypeEnum,
  PerformanceLevelEnum,
  ServerChainNameEnum,
  ServerClass,
  ServerSelectionEnum,
} from "../appstate";

jest.mock("../../electronBridge");
jest.mock("../../utils/fetchServerList");

const mockSettings = { serveruri: "", serverchain_name: "main", serverselection: "" };

const liveList = fetchServerList as jest.MockedFunction<typeof fetchServerList>;

const liveServer = (uri: string, chain = ServerChainNameEnum.mainChainName): ServerClass => ({
  uri,
  chain_name: chain,
  latency: null,
  default: false,
  obsolete: false,
});

beforeEach(() => {
  jest.clearAllMocks();
  (ipcRenderer.invoke as jest.Mock).mockResolvedValue(mockSettings);
  liveList.mockReset().mockResolvedValue([]);
});

const baseProps = {
  closeModal: jest.fn(),
  setWallets: jest.fn(),
  setCurrentWallet: jest.fn(),
  navigateToLoadingScreenChangingWallet: jest.fn(),
  doSaveWallet: jest.fn(),
  clearTimers: jest.fn().mockResolvedValue(undefined),
};

describe("AddNewWallet modes", () => {
  it('shows "Add a New Wallet" heading in addnew mode', () => {
    render(<AddNewWallet {...baseProps} />, { initialRoute: "/addnewwallet" });
    expect(screen.getByText("Add a New Wallet")).toBeInTheDocument();
  });

  it('shows "Create Wallet" action button in addnew mode', () => {
    render(<AddNewWallet {...baseProps} />, { initialRoute: "/addnewwallet" });
    expect(screen.getByRole("button", { name: /create wallet/i })).toBeInTheDocument();
  });

  it('shows "Wallet Settings" heading in settings mode', () => {
    render(<AddNewWallet {...baseProps} />, {
      initialRoute: "/addnewwallet",
      contextOverrides: { currentWallet: { wallet_name: "test.dat", chain_name: "main" } as never },
    });
    // Navigate with settings state — use MemoryRouter initialEntries
    render(<AddNewWallet {...baseProps} />, {
      initialRoute: { pathname: "/addnewwallet", state: { mode: "settings" } } as never,
    });
    expect(screen.getAllByText("Wallet Settings").length).toBeGreaterThanOrEqual(1);
  });

  it('shows "Delete Wallet" heading in delete mode', () => {
    render(<AddNewWallet {...baseProps} />, {
      initialRoute: { pathname: "/addnewwallet", state: { mode: "delete" } } as never,
    });
    expect(screen.getAllByText("Delete Wallet").length).toBeGreaterThanOrEqual(1);
  });

  it("shows Cancel button before action button", () => {
    render(<AddNewWallet {...baseProps} />, { initialRoute: "/addnewwallet" });
    const buttons = screen.getAllByRole("button");
    const cancelIdx = buttons.findIndex((b) => /^cancel$/i.test(b.textContent ?? ""));
    const actionIdx = buttons.findIndex((b) => /create wallet/i.test(b.textContent ?? ""));
    expect(cancelIdx).toBeLessThan(actionIdx);
  });

  it("keeps renderer metadata when native wallet deletion fails", async () => {
    const wallet = {
      id: 4,
      fileName: "wcash-wallet-4.dat",
      alias: "Local QA",
      chain_name: ServerChainNameEnum.regtestChainName,
      uri: "http://127.0.0.1:48234",
      selection: ServerSelectionEnum.custom,
      performanceLevel: PerformanceLevelEnum.High,
      creationType: CreationTypeEnum.Seed,
    } as any;
    (native.wallet_exists as jest.Mock).mockResolvedValue(true);
    (native.stop_sync as jest.Mock).mockResolvedValue("stopped");
    (native.deinitialize as jest.Mock).mockResolvedValue("closed");
    (native.delete_wallet as jest.Mock).mockRejectedValue(new Error("database busy"));
    const invoke = ipcRenderer.invoke as jest.Mock;
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "loadSettings") {
        return {
          serveruri: wallet.uri,
          serverchain_name: wallet.chain_name,
          serverselection: wallet.selection,
        };
      }
      if (channel === "wallets:all") return [wallet];
      return undefined;
    });

    render(<AddNewWallet {...baseProps} />, {
      initialRoute: { pathname: "/addnewwallet", state: { mode: "delete" } } as never,
      contextOverrides: { currentWallet: wallet, wallets: [wallet] },
    });
    await screen.findByDisplayValue("wcash-wallet-4.dat");
    fireEvent.click(screen.getByRole("button", { name: /^delete wallet$/i }));

    await waitFor(() => expect(native.delete_wallet).toHaveBeenCalled());
    expect(invoke).not.toHaveBeenCalledWith("wallets:remove", wallet.id);
    expect(invoke).not.toHaveBeenCalledWith("saveSettings", { key: "currentwalletid", value: null });
  });

  it("removes renderer metadata only after native wallet deletion succeeds", async () => {
    const order: string[] = [];
    const wallet = {
      id: 4,
      fileName: "wcash-wallet-4.dat",
      alias: "Local QA",
      chain_name: ServerChainNameEnum.regtestChainName,
      uri: "http://127.0.0.1:48234",
      selection: ServerSelectionEnum.custom,
      performanceLevel: PerformanceLevelEnum.High,
      creationType: CreationTypeEnum.Seed,
    } as any;
    (native.wallet_exists as jest.Mock).mockResolvedValue(true);
    (native.stop_sync as jest.Mock).mockResolvedValue("stopped");
    (native.deinitialize as jest.Mock).mockResolvedValue("closed");
    (native.delete_wallet as jest.Mock).mockImplementation(async () => {
      order.push("native");
      return JSON.stringify({ deleted: true });
    });
    const invoke = ipcRenderer.invoke as jest.Mock;
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "loadSettings") {
        return {
          serveruri: wallet.uri,
          serverchain_name: wallet.chain_name,
          serverselection: wallet.selection,
        };
      }
      if (channel === "wallets:remove") order.push("metadata");
      if (channel === "wallets:all") return [];
      return undefined;
    });

    render(<AddNewWallet {...baseProps} />, {
      initialRoute: { pathname: "/addnewwallet", state: { mode: "delete" } } as never,
      contextOverrides: { currentWallet: wallet, wallets: [wallet] },
    });
    await screen.findByDisplayValue("wcash-wallet-4.dat");
    fireEvent.click(screen.getByRole("button", { name: /^delete wallet$/i }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("wallets:remove", wallet.id));
    expect(order).toEqual(["native", "metadata"]);
  });

  it("locks unsupported choices to the compiled Local Regtest profile", async () => {
    (ipcRenderer.invoke as jest.Mock).mockImplementation(async (channel: string) => {
      if (channel === "loadSettings") {
        return {
          serveruri: "http://127.0.0.1:48234",
          serverchain_name: ServerChainNameEnum.regtestChainName,
          serverselection: ServerSelectionEnum.custom,
        };
      }
      return undefined;
    });
    render(<AddNewWallet {...baseProps} />, { initialRoute: "/addnewwallet" });

    expect(await screen.findByLabelText("Network")).toBeDisabled();
    const creationType = screen.getByLabelText("Type of wallet creation");
    expect(within(creationType).getByRole("option", { name: /Unified Full Viewing Key.*unavailable/i })).toBeDisabled();
    expect(within(creationType).getByRole("option", { name: /DAT file.*unavailable/i })).toBeDisabled();
    expect(screen.getByText(/Fixed Local Regtest profile/)).toBeInTheDocument();
  });
});

describe("AddNewWallet server picker", () => {
  // The server block only appears once the settings read has resolved a chain.
  const openPicker = async () => {
    render(<AddNewWallet {...baseProps} />, { initialRoute: "/addnewwallet" });
    fireEvent.click((await screen.findAllByText("Selected Server"))[0]);
    return screen.findByLabelText("Server list");
  };

  it("offers the registry's servers when it answers", async () => {
    liveList.mockImplementation(async (chain) =>
      chain === ServerChainNameEnum.mainChainName ? [liveServer("https://one.zec.rocks:443")] : [],
    );

    const select = await openPicker();

    expect(await within(select).findByRole("option", { name: /one\.zec\.rocks/ })).toBeInTheDocument();
    // the static mainnet entries gave way to the live ones
    expect(within(select).queryByRole("option", { name: /na\.zec\.rocks/ })).toBeNull();
  });

  it("keeps the static list for a chain the registry says nothing about", async () => {
    const select = await openPicker();

    expect(await within(select).findByRole("option", { name: "https://zec.rocks:443 - Mainnet" })).toBeInTheDocument();
  });

  it("labels an entry with its URI and chain", async () => {
    liveList.mockImplementation(async (chain) =>
      chain === ServerChainNameEnum.mainChainName ? [liveServer("https://one.zec.rocks:443")] : [],
    );

    const select = await openPicker();
    const option = await within(select).findByRole("option", { name: /one\.zec\.rocks/ });

    expect(option.textContent).toBe("https://one.zec.rocks:443 - Mainnet");
  });
});
