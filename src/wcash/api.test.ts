import {
  formatTwc,
  isExactTipBalance,
  parseBalance,
  parseCreatedWallet,
  parseReceivers,
  parseStatus,
  require24WordRecoveryPhrase,
} from "./api";

const account = {
  account_id: "account-1",
  ironwood_total_zat: 625_000_000,
  ironwood_spendable_zat: 600_000_000,
  ironwood_locked_zat: 10_000_000,
  ironwood_pending_change_zat: 5_000_000,
  ironwood_pending_spendability_zat: 10_000_000,
  sapling_total_zat: 0,
  orchard_total_zat: 0,
  transparent_total_zat: 625_000_000,
  transparent_coinbase_total_zat: 625_000_000,
  transparent_coinbase_spendable_zat: 0,
  transparent_coinbase_pending_zat: 625_000_000,
};

describe("Wcash renderer boundary", () => {
  it("accepts only Wcash Testnet receive address families", () => {
    expect(
      parseReceivers({
        ironwood_address: "wutest1private",
        transparent_coinbase_address: "WTmining",
      }),
    ).toEqual({ ironwoodAddress: "wutest1private", transparentCoinbaseAddress: "WTmining" });

    expect(() => parseReceivers({ ironwood_address: "utest1zcash", transparent_coinbase_address: "tmZcash" })).toThrow(
      "different network",
    );
  });

  it("shows a balance only when scanning has reached the exact known tip", () => {
    const exact = parseBalance({
      chain_tip_height: 80,
      fully_scanned_height: 80,
      synchronized: true,
      accounts: [account],
    });
    const stale = parseBalance({
      chain_tip_height: 81,
      fully_scanned_height: 80,
      synchronized: false,
      accounts: [account],
    });

    expect(isExactTipBalance(exact)).toBe(true);
    expect(isExactTipBalance(stale)).toBe(false);
    expect(exact.accounts[0].ironwoodPendingZat).toBe(25_000_000n);
  });

  it("formats all eight Wcash decimal places without floating point", () => {
    expect(formatTwc(625_000_001n)).toBe("6.25000001");
    expect(formatTwc(1n)).toBe("0.00000001");
  });

  it("requires a complete 24-word restore phrase", () => {
    const phrase = Array.from({ length: 24 }, (_, index) => `word${index + 1}`).join(" ");
    expect(require24WordRecoveryPhrase(`  ${phrase.toUpperCase()}  `)).toBe(phrase);
    expect(() => require24WordRecoveryPhrase("too short")).toThrow("complete 24-word");
  });

  it("never includes a malformed sensitive payload in an error", () => {
    const secret = "private recovery phrase must not escape";
    let message = "";
    try {
      parseCreatedWallet(`{${secret}`);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe("Wallet creation returned malformed data");
    expect(message).not.toContain(secret);
  });

  it("parses only the explicit crash-recovery lifecycle states", () => {
    const base = {
      network: "Wcash Testnet",
      ticker: "TWC",
      storage_namespace: "wcashtestnet-v5",
    };
    expect(parseStatus({ ...base, state: "no-database-no-secret" })).toMatchObject({
      state: "no-database-no-secret",
    });
    expect(parseStatus({ state: "no-database-no-secret" })).toEqual({ state: "no-database-no-secret" });
    expect(
      parseStatus({
        ...base,
        state: "secret-only-pending",
        intent: "restore",
        birthdayHeight: 17,
      }),
    ).toMatchObject({ state: "secret-only-pending", intent: "restore", birthdayHeight: 17 });
    expect(() => parseStatus({ ...base, state: "unknown" })).toThrow("malformed data");
    expect(parseStatus({ ...base, state: "secret-only-pending", intent: "create", birthdayHeight: 17 })).toMatchObject({
      state: "secret-only-pending",
      intent: "create",
      birthdayHeight: 17,
    });
    expect(() =>
      parseStatus({ ...base, state: "secret-only-pending", intent: "create", birthdayHeight: null }),
    ).toThrow("malformed data");
    expect(
      parseStatus({
        state: "database-secret-backup-required",
        wallet: { account_id: "id", birthday_height: 1 },
      }),
    ).toMatchObject({
      state: "database-secret-backup-required",
      wallet: { accountId: "id", birthdayHeight: 1 },
    });
  });
});
