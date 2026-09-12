import {
  createSendRequest,
  formatTwc,
  isExactTipBalance,
  memoUtf8Bytes,
  parseBalance,
  parseCanonicalTwcAmount,
  parseCreatedWallet,
  parseOperationResult,
  parsePendingTransactions,
  parseRecipientValidation,
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

  it.each([
    ["0.00000001", 1n],
    ["1", 100_000_000n],
    ["1.25", 125_000_000n],
    ["21000000", 2_100_000_000_000_000n],
  ])("parses canonical TWC amounts exactly: %s", (value, amountZat) => {
    expect(parseCanonicalTwcAmount(value)).toEqual({ amount: value, amountZat });
  });

  it.each(["0", "01", ".1", "1.", "1.0", "1.250", "1.000000000", "+1", "1e2", "1,000", "9".repeat(18)])(
    "rejects unsafe amount syntax %p",
    (value) => expect(() => parseCanonicalTwcAmount(value)).toThrow(),
  );

  it("builds one semantic payment and enforces memo bytes rather than characters", () => {
    expect(memoUtf8Bytes("💚")).toBe(4);
    expect(createSendRequest(`  wutest1${"q".repeat(80)}  `, " 1.25 ", "💚")).toEqual({
      payments: [{ address: `wutest1${"q".repeat(80)}`, amount: "1.25", memo: "💚" }],
    });
    expect(() => createSendRequest(`wutest1${"q".repeat(80)}`, "1", "é".repeat(257))).toThrow("512-byte");
    expect(() => createSendRequest(`wutest1${"q".repeat(80)}`, "1", "a".repeat(513))).toThrow("512-byte");
  });

  it("strictly parses Wcash recipient validation and rejects native extras", () => {
    const validation = {
      schema_version: 1,
      valid: true,
      network: "Wcash Testnet",
      recipient_kind: "ironwood",
      canonical_address: `wutest1${"q".repeat(80)}`,
      error: null,
    };
    expect(parseRecipientValidation(validation)).toMatchObject({
      valid: true,
      network: "Wcash Testnet",
      recipientKind: "ironwood",
      canonicalAddress: validation.canonical_address,
    });
    expect(() => parseRecipientValidation({ ...validation, raw_transaction_hex: "deadbeef" })).toThrow();
  });

  it("parses broadcast and recovery results without exposing signed bytes", () => {
    const txid = "a".repeat(64);
    const base = {
      schema_version: 1,
      operation: "send",
      outcome: "broadcast",
      txid,
      branch_id: "b3cfd27e",
      expiry_height: 200,
      target_height: 160,
      fee_zat: "15000",
      internal_change_receiver_verified: true,
      exact_tip_height: 160,
      broadcast: { txid, disposition: "already_known", status: { state: "mempool" } },
      recovery: null,
      rejection: null,
    };
    expect(parseOperationResult(base, "send")).toMatchObject({
      outcome: "broadcast",
      txid,
      feeZat: 15_000n,
      broadcast: { disposition: "already_known", status: { state: "mempool" } },
    });
    expect(() => parseOperationResult({ ...base, raw_transaction_hex: "deadbeef" }, "send")).toThrow();

    const recovery = {
      ...base,
      outcome: "recovery_required",
      broadcast: null,
      recovery: {
        code: "exact_transaction_rebroadcast_required",
        message: "The signed transaction is stored. Retry this exact transaction; do not create a replacement.",
        txids: [txid],
      },
    };
    expect(parseOperationResult(recovery, "send")).toMatchObject({
      outcome: "recovery_required",
      recovery: {
        code: "exact_transaction_rebroadcast_required",
        message: "The signed transaction is stored. Retry this exact transaction; do not create a replacement.",
        txids: [txid],
      },
    });
    expect(() => parseOperationResult({ ...base, internal_change_receiver_verified: false }, "send")).toThrow();
    expect(() => parseOperationResult({ ...base, expiry_height: 0 }, "send")).toThrow();
    expect(() => parseOperationResult({ ...base, expiry_height: 160 }, "send")).toThrow();
  });

  it("strictly parses review, rejection, and expiry without trusting native diagnostics", () => {
    const txid = "c".repeat(64);
    const secondTxid = "d".repeat(64);
    const common = {
      schema_version: 1,
      operation: "send",
      txid,
      branch_id: "b3cfd27e",
      exact_tip_height: 200,
      broadcast: null,
      rejection: null,
    };
    const review = {
      ...common,
      outcome: "recovery_required",
      expiry_height: null,
      target_height: null,
      fee_zat: null,
      internal_change_receiver_verified: null,
      recovery: {
        code: "exact_transaction_review_required",
        message:
          "The signed transaction is stored but needs review. Refresh signed pending transactions; do not create a replacement.",
        txids: [txid, secondTxid],
      },
    };
    expect(parseOperationResult(review, "send")).toMatchObject({
      outcome: "recovery_required",
      expiryHeight: null,
      exactTipHeight: 200,
      recovery: { code: "exact_transaction_review_required", txids: [txid, secondTxid] },
    });
    expect(() =>
      parseOperationResult({ ...review, recovery: { ...review.recovery, message: "private diagnostic" } }, "send"),
    ).toThrow();

    expect(
      parseOperationResult(
        {
          ...review,
          expiry_height: 240,
          target_height: 200,
          fee_zat: "15000",
          internal_change_receiver_verified: true,
          recovery: { ...review.recovery, txids: [txid] },
        },
        "send",
      ),
    ).toMatchObject({
      outcome: "recovery_required",
      expiryHeight: 240,
      recovery: { code: "exact_transaction_review_required", txids: [txid] },
    });

    const rejected = {
      ...common,
      outcome: "rejected",
      expiry_height: 240,
      target_height: 200,
      fee_zat: "15000",
      internal_change_receiver_verified: true,
      recovery: null,
      rejection: {
        code: "transaction_rejected",
        node_code: -26,
        message:
          "The Wcash node rejected this signed transaction. Wait for it to expire before creating a replacement.",
      },
    };
    expect(parseOperationResult(rejected, "send")).toMatchObject({
      outcome: "rejected",
      rejection: { code: "transaction_rejected", nodeCode: -26 },
    });
    expect(() =>
      parseOperationResult({ ...rejected, rejection: { ...rejected.rejection, node_code: 0 } }, "send"),
    ).toThrow();

    const expired = {
      ...common,
      operation: "rebroadcast_pending",
      outcome: "expired",
      expiry_height: 200,
      target_height: null,
      fee_zat: null,
      internal_change_receiver_verified: null,
      recovery: null,
    };
    expect(parseOperationResult(expired, "rebroadcast_pending")).toMatchObject({
      outcome: "expired",
      expiryHeight: 200,
      exactTipHeight: 200,
    });
    expect(() => parseOperationResult({ ...expired, exact_tip_height: 199 }, "rebroadcast_pending")).toThrow();
  });

  it("parses pending transaction metadata and rejects raw stored bytes", () => {
    const txid = "b".repeat(64);
    const pending = {
      schema_version: 1,
      exact_tip_height: 200,
      transactions: [
        {
          txid,
          branch_id: "b3cfd27e",
          expiry_height: 240,
          lifecycle: "unexpired",
          rebroadcast_allowed: true,
          blocks_new_signing: true,
        },
      ],
      next_cursor: null,
    };
    expect(parsePendingTransactions(pending)).toEqual({
      schemaVersion: 1,
      exactTipHeight: 200,
      transactions: [
        {
          txid,
          branchId: "b3cfd27e",
          expiryHeight: 240,
          lifecycle: "unexpired",
          rebroadcastAllowed: true,
          blocksNewSigning: true,
        },
      ],
      nextCursor: null,
    });
    expect(() =>
      parsePendingTransactions({
        ...pending,
        transactions: [{ ...pending.transactions[0], raw_transaction_hex: "deadbeef" }],
      }),
    ).toThrow();
    expect(() =>
      parsePendingTransactions({
        ...pending,
        transactions: [{ ...pending.transactions[0], lifecycle: "expired", rebroadcast_allowed: false }],
      }),
    ).toThrow();

    expect(
      parsePendingTransactions({
        schema_version: 1,
        exact_tip_height: null,
        transactions: [
          {
            ...pending.transactions[0],
            lifecycle: "tip_unknown",
            rebroadcast_allowed: false,
            blocks_new_signing: true,
          },
        ],
        next_cursor: "18446744073709551615",
      }),
    ).toMatchObject({ exactTipHeight: null, transactions: [{ lifecycle: "tip_unknown", blocksNewSigning: true }] });

    expect(
      parsePendingTransactions({
        schema_version: 1,
        exact_tip_height: 0xffff_ffff,
        transactions: [
          {
            ...pending.transactions[0],
            expiry_height: 0,
            lifecycle: "unexpired",
            rebroadcast_allowed: true,
            blocks_new_signing: true,
          },
        ],
        next_cursor: null,
      }),
    ).toMatchObject({ transactions: [{ expiryHeight: 0, lifecycle: "unexpired", rebroadcastAllowed: true }] });
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
