export {};

const {
  buildSendConfirmation,
  buildShieldConfirmation,
  cancelledOperation,
  createWcashTransactionController,
  parseCanonicalAmount,
  parseNativeOperationEnvelope,
  parseNativePendingTransactions,
  parseNativeRecipientValidation,
  parseRendererSendRequest,
  requireCanonicalTxid,
  RECOVERY_MESSAGE,
  REJECTION_MESSAGE,
  REVIEW_MESSAGE,
  INVALID_RECIPIENT_MESSAGE,
  visibleText,
} = require("../../public/wcashTransactionBoundary");
const { LOCAL_REGTEST_RUNTIME_PROFILE } = require("../../public/wcashRuntimeProfile");

const TXID = "a".repeat(64);
const ADDRESS = `wutest1${"q".repeat(80)}`;
const CANONICAL_ADDRESS = `wutest1${"p".repeat(80)}`;

const broadcastEnvelope = (overrides = {}) => ({
  schema_version: 1,
  operation: "send",
  outcome: "broadcast",
  txid: TXID,
  branch_id: "b3cfd27e",
  expiry_height: 180,
  target_height: 140,
  fee_zat: "15000",
  internal_change_receiver_verified: true,
  exact_tip_height: 140,
  broadcast: {
    txid: TXID,
    disposition: "submitted",
    status: { state: "mempool" },
  },
  recovery: null,
  rejection: null,
  ...overrides,
});

describe("Wcash transaction main-process boundary", () => {
  it("validates the local Regtest network and branch without accepting them on Testnet", () => {
    const address = `wuregtest1${"q".repeat(80)}`;
    const validation = {
      schema_version: 1,
      valid: true,
      network: "Wcash Regtest",
      recipient_kind: "ironwood",
      canonical_address: address,
      error: null,
    };
    expect(parseNativeRecipientValidation(validation, LOCAL_REGTEST_RUNTIME_PROFILE)).toEqual(validation);
    expect(() => parseNativeRecipientValidation(validation)).toThrow();

    const localEnvelope = broadcastEnvelope({ branch_id: "c3a6678a" });
    expect(parseNativeOperationEnvelope(localEnvelope, "send", LOCAL_REGTEST_RUNTIME_PROFILE)).toEqual(localEnvelope);
    expect(() => parseNativeOperationEnvelope(localEnvelope, "send")).toThrow("wrong branch");
  });

  it.each([
    ["0.00000001", "1"],
    ["1", "100000000"],
    ["1.25", "125000000"],
    ["21000000", "2100000000000000"],
  ])("converts canonical TWC without floating point: %s", (amount, amountZat) => {
    expect(parseCanonicalAmount(amount)).toEqual({ amount, amountZat });
  });

  it.each([
    "",
    "0",
    "00.1",
    "01",
    ".1",
    "1.",
    "1.0",
    "1.250",
    "1.000000000",
    "+1",
    "-1",
    "1e2",
    " 1",
    "1,000",
    "21000000.00000001",
    "9".repeat(18),
  ])("rejects non-canonical or out-of-range amount %p", (amount) => {
    expect(() => parseCanonicalAmount(amount)).toThrow();
  });

  it("accepts exactly one immutable payment and counts UTF-8 memo bytes", () => {
    // eslint-disable-next-line testing-library/render-result-naming-convention -- This parses an IPC request, not a Testing Library render result.
    const parsed = parseRendererSendRequest({ payments: [{ address: ADDRESS, amount: "1.25", memo: "💚" }] });

    expect(parsed).toEqual({
      payments: [{ address: ADDRESS, amount: "1.25", memo: "💚" }],
      amountZat: "125000000",
      memo: "💚",
      memoBytes: 4,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.payments)).toBe(true);
    expect(Object.isFrozen(parsed.payments[0])).toBe(true);
  });

  it("rejects extra request fields, multiple UI recipients, and a 513-byte memo", () => {
    expect(() =>
      parseRendererSendRequest({ payments: [{ address: ADDRESS, amount: "1" }], endpoint: "attacker" }),
    ).toThrow("exactly one");
    expect(() =>
      parseRendererSendRequest({
        payments: [
          { address: ADDRESS, amount: "1" },
          { address: ADDRESS, amount: "1" },
        ],
      }),
    ).toThrow("exactly one");
    expect(() =>
      parseRendererSendRequest({ payments: [{ address: ADDRESS, amount: "1", memo: "é".repeat(257) }] }),
    ).toThrow("512-byte");
    expect(() =>
      parseRendererSendRequest({ payments: [{ address: ADDRESS, amount: "1", memo: "a".repeat(513) }] }),
    ).toThrow("512-byte");
  });

  it("accepts only a Wcash Testnet Ironwood native validation envelope", () => {
    const valid = {
      schema_version: 1,
      valid: true,
      network: "Wcash Testnet",
      recipient_kind: "ironwood",
      canonical_address: ADDRESS,
      error: null,
    };
    expect(parseNativeRecipientValidation(JSON.stringify(valid))).toEqual(valid);

    expect(() => parseNativeRecipientValidation({ ...valid, network: "Zcash Testnet" })).toThrow();
    expect(() => parseNativeRecipientValidation({ ...valid, raw_transaction_hex: "secret" })).toThrow();
  });

  it("preserves a typed invalid-recipient result without trusting extra native data", () => {
    const invalid = {
      schema_version: 1,
      valid: false,
      network: "Wcash Testnet",
      recipient_kind: null,
      canonical_address: null,
      error: { code: "invalid_recipient", message: "Not a Wcash Testnet Ironwood address" },
    };
    expect(parseNativeRecipientValidation(invalid)).toEqual({
      ...invalid,
      error: { code: "invalid_recipient", message: INVALID_RECIPIENT_MESSAGE },
    });
    expect(() => parseNativeRecipientValidation({ ...invalid, error: { ...invalid.error, seed: "bad" } })).toThrow();
  });

  it("allowlists successful and recovery transaction envelopes", () => {
    expect(parseNativeOperationEnvelope(broadcastEnvelope(), "send")).toEqual(broadcastEnvelope());

    const recovery = broadcastEnvelope({
      operation: "shield_coinbase",
      outcome: "recovery_required",
      broadcast: null,
      recovery: {
        code: "exact_transaction_rebroadcast_required",
        message: "sensitive server endpoint diagnostic",
        txids: [TXID],
      },
    });
    expect(parseNativeOperationEnvelope(JSON.stringify(recovery), "shield_coinbase")).toEqual({
      ...recovery,
      recovery: { code: "exact_transaction_rebroadcast_required", message: RECOVERY_MESSAGE, txids: [TXID] },
    });
  });

  it("distinguishes persisted review, definitive rejection, and expired retry outcomes", () => {
    const secondTxid = "b".repeat(64);
    const persistedReview = broadcastEnvelope({
      outcome: "recovery_required",
      expiry_height: null,
      target_height: null,
      fee_zat: null,
      internal_change_receiver_verified: null,
      broadcast: null,
      recovery: {
        code: "exact_transaction_review_required",
        message: "sensitive native diagnostic",
        txids: [TXID, secondTxid],
      },
    });
    expect(parseNativeOperationEnvelope(persistedReview, "send")).toEqual({
      ...persistedReview,
      recovery: {
        code: "exact_transaction_review_required",
        message: REVIEW_MESSAGE,
        txids: [TXID, secondTxid],
      },
    });

    const shieldReview = {
      ...persistedReview,
      operation: "shield_coinbase",
      recovery: {
        code: "exact_transaction_review_required",
        message: "sensitive native diagnostic",
        txids: [TXID],
      },
    };
    expect(parseNativeOperationEnvelope(shieldReview, "shield_coinbase")).toEqual({
      ...shieldReview,
      recovery: {
        code: "exact_transaction_review_required",
        message: REVIEW_MESSAGE,
        txids: [TXID],
      },
    });

    const rejected = broadcastEnvelope({
      outcome: "rejected",
      broadcast: null,
      recovery: null,
      rejection: { code: "transaction_rejected", node_code: -26, message: "" },
    });
    expect(parseNativeOperationEnvelope(rejected, "send")).toEqual({
      ...rejected,
      rejection: { code: "transaction_rejected", node_code: -26, message: REJECTION_MESSAGE },
    });
    expect(() =>
      parseNativeOperationEnvelope(
        { ...rejected, rejection: { code: "transaction_rejected", node_code: 0, message: "" } },
        "send",
      ),
    ).toThrow();

    const expired = broadcastEnvelope({
      operation: "rebroadcast_pending",
      outcome: "expired",
      expiry_height: 140,
      target_height: null,
      fee_zat: null,
      internal_change_receiver_verified: null,
      broadcast: null,
      recovery: null,
      rejection: null,
    });
    expect(parseNativeOperationEnvelope(expired, "rebroadcast_pending")).toEqual(expired);
    expect(() => parseNativeOperationEnvelope({ ...expired, exact_tip_height: 139 }, "rebroadcast_pending")).toThrow(
      "operation-specific metadata",
    );
  });

  it("rejects malformed recovery transaction sets and persisted transactions hidden in native extras", () => {
    const review = broadcastEnvelope({
      outcome: "recovery_required",
      expiry_height: null,
      target_height: null,
      fee_zat: null,
      internal_change_receiver_verified: null,
      broadcast: null,
      recovery: {
        code: "exact_transaction_review_required",
        message: "review",
        txids: [TXID],
      },
    });
    expect(() =>
      parseNativeOperationEnvelope(
        {
          ...review,
          recovery: { code: "exact_transaction_review_required", message: "review", txids: [] },
        },
        "send",
      ),
    ).toThrow();
    expect(() =>
      parseNativeOperationEnvelope(
        {
          ...review,
          recovery: { code: "exact_transaction_review_required", message: "review", txids: [TXID, TXID] },
        },
        "send",
      ),
    ).toThrow();
    expect(() =>
      parseNativeOperationEnvelope(
        { ...broadcastEnvelope(), rejection: { code: "transaction_rejected", node_code: -1, message: "hidden" } },
        "send",
      ),
    ).toThrow();
  });

  it("accepts a single full-metadata review result and rejects persisted review on retry", () => {
    const fullMetadataReview = broadcastEnvelope({
      outcome: "recovery_required",
      broadcast: null,
      recovery: {
        code: "exact_transaction_review_required",
        message: "post-signing consistency failure",
        txids: [TXID],
      },
    });
    expect(parseNativeOperationEnvelope(fullMetadataReview, "send")).toMatchObject({
      outcome: "recovery_required",
      expiry_height: 180,
      recovery: { code: "exact_transaction_review_required", message: REVIEW_MESSAGE, txids: [TXID] },
    });

    expect(() =>
      parseNativeOperationEnvelope(
        {
          ...fullMetadataReview,
          operation: "rebroadcast_pending",
          expiry_height: null,
          target_height: null,
          fee_zat: null,
          internal_change_receiver_verified: null,
        },
        "rebroadcast_pending",
      ),
    ).toThrow("operation-specific metadata");
  });

  it("rejects raw bytes, secret fields, wrong branch, mismatched txid, and unknown status", () => {
    expect(() =>
      parseNativeOperationEnvelope({ ...broadcastEnvelope(), raw_transaction_hex: "deadbeef" }, "send"),
    ).toThrow();
    expect(() => parseNativeOperationEnvelope({ ...broadcastEnvelope(), seed: "phrase" }, "send")).toThrow();
    expect(() => parseNativeOperationEnvelope({ ...broadcastEnvelope(), branch_id: "deadbeef" }, "send")).toThrow(
      "wrong branch",
    );
    expect(() =>
      parseNativeOperationEnvelope(
        { ...broadcastEnvelope(), broadcast: { ...broadcastEnvelope().broadcast, txid: "b".repeat(64) } },
        "send",
      ),
    ).toThrow();
    expect(() =>
      parseNativeOperationEnvelope({ ...broadcastEnvelope(), internal_change_receiver_verified: false }, "send"),
    ).toThrow("operation-specific metadata");
    expect(() => parseNativeOperationEnvelope({ ...broadcastEnvelope(), fee_zat: null }, "send")).toThrow(
      "operation-specific metadata",
    );
    expect(() => parseNativeOperationEnvelope({ ...broadcastEnvelope(), expiry_height: 0 }, "send")).toThrow(
      "operation-specific metadata",
    );
    expect(() => parseNativeOperationEnvelope({ ...broadcastEnvelope(), expiry_height: 140 }, "send")).toThrow(
      "operation-specific metadata",
    );
    expect(() =>
      parseNativeOperationEnvelope(
        { ...broadcastEnvelope(), broadcast: { ...broadcastEnvelope().broadcast, status: { state: "unknown" } } },
        "send",
      ),
    ).toThrow();
  });

  it("allowlists pending metadata without exposing stored signed bytes", () => {
    const pending = {
      schema_version: 1,
      exact_tip_height: 140,
      transactions: [
        {
          txid: TXID,
          branch_id: "b3cfd27e",
          expiry_height: 180,
          lifecycle: "unexpired",
          rebroadcast_allowed: true,
          blocks_new_signing: true,
        },
      ],
      next_cursor: "42",
    };
    expect(parseNativePendingTransactions(pending)).toEqual(pending);
    expect(() =>
      parseNativePendingTransactions({
        ...pending,
        transactions: [{ ...pending.transactions[0], raw_transaction_hex: "deadbeef" }],
      }),
    ).toThrow();
    expect(() => parseNativePendingTransactions({ ...pending, next_cursor: "01" })).toThrow();
  });

  it("derives pending lifecycle from one exact-tip snapshot and treats zero expiry as unexpired", () => {
    const noExpiry = {
      txid: TXID,
      branch_id: "b3cfd27e",
      expiry_height: 0,
      lifecycle: "unexpired",
      rebroadcast_allowed: true,
      blocks_new_signing: true,
    };
    expect(
      parseNativePendingTransactions({
        schema_version: 1,
        exact_tip_height: 0xffff_ffff,
        transactions: [noExpiry],
        next_cursor: null,
      }),
    ).toMatchObject({ transactions: [noExpiry] });

    expect(
      parseNativePendingTransactions({
        schema_version: 1,
        exact_tip_height: null,
        transactions: [{ ...noExpiry, lifecycle: "tip_unknown", rebroadcast_allowed: false, blocks_new_signing: true }],
        next_cursor: null,
      }),
    ).toMatchObject({ exact_tip_height: null, transactions: [{ lifecycle: "tip_unknown" }] });

    expect(() =>
      parseNativePendingTransactions({
        schema_version: 1,
        exact_tip_height: 180,
        transactions: [noExpiry, noExpiry],
        next_cursor: null,
      }),
    ).toThrow();
  });

  it("requires exact lowercase transaction IDs for retry", () => {
    expect(requireCanonicalTxid(TXID)).toBe(TXID);
    expect(() => requireCanonicalTxid(TXID.toUpperCase())).toThrow();
    expect(() => requireCanonicalTxid("../wallet.dat")).toThrow();
  });

  it("makes control and bidi characters visible in system confirmation text", () => {
    expect(visibleText("safe\u202Etxt\n\u0000")).toBe("safe\\u{202E}txt\\u{A}\\u{0}");
    // eslint-disable-next-line testing-library/render-result-naming-convention -- This parses an IPC request, not a Testing Library render result.
    const request = parseRendererSendRequest({
      payments: [{ address: ADDRESS, amount: "1.25", memo: "safe\u202Etxt" }],
    });
    const confirmation = buildSendConfirmation(request, ADDRESS);
    expect(confirmation.detail).toContain(ADDRESS);
    expect(confirmation.detail).toContain("1.25 TWC");
    expect(confirmation.detail).toContain("125000000");
    expect(confirmation.detail).toContain("10 UTF-8 bytes");
    expect(confirmation.detail).toContain("\\u{202E}");
    expect(confirmation.defaultId).toBe(1);
    expect(confirmation.cancelId).toBe(1);
  });

  it("makes shielding consequences explicit and cancellation non-transactional", () => {
    const confirmation = buildShieldConfirmation();
    expect(confirmation.detail).toContain("own private Ironwood receiver");
    expect(confirmation.detail).toContain("Up to 100 mature");
    expect(confirmation.detail).toContain("Maximum value authorized");
    expect(confirmation.detail).toContain("21,000,000 TWC");
    expect(confirmation.detail).toContain("fee");
    expect(cancelledOperation("send")).toEqual({ schema_version: 1, operation: "send", outcome: "cancelled" });
  });

  it("cancels before credential access when the independent send confirmation is declined", async () => {
    const sendAndBroadcast = jest.fn();
    const controller = createWcashTransactionController({
      validateRecipientNative: jest.fn().mockResolvedValue({
        schema_version: 1,
        valid: true,
        network: "Wcash Testnet",
        recipient_kind: "ironwood",
        canonical_address: ADDRESS,
        error: null,
      }),
      sendAndBroadcast,
      shieldCoinbaseAndBroadcast: jest.fn(),
      pendingTransactionsNative: jest.fn(),
      rebroadcastPendingNative: jest.fn(),
      confirmSend: jest.fn().mockResolvedValue(false),
      confirmShield: jest.fn().mockResolvedValue(false),
    });

    await expect(controller.send({ payments: [{ address: ADDRESS, amount: "1" }] })).resolves.toEqual({
      schema_version: 1,
      operation: "send",
      outcome: "cancelled",
    });
    expect(sendAndBroadcast).not.toHaveBeenCalled();
  });

  it("returns a non-transactional cancellation when authorization stops before native signing", async () => {
    const notStarted = Object.assign(new Error("device authentication was cancelled"), {
      name: "WcashWalletLifecycleError",
      code: "TRANSACTION_NOT_STARTED",
    });
    const sendAndBroadcast = jest.fn().mockRejectedValue(notStarted);
    const controller = createWcashTransactionController({
      validateRecipientNative: jest.fn().mockResolvedValue({
        schema_version: 1,
        valid: true,
        network: "Wcash Testnet",
        recipient_kind: "ironwood",
        canonical_address: ADDRESS,
        error: null,
      }),
      sendAndBroadcast,
      shieldCoinbaseAndBroadcast: jest.fn().mockRejectedValue(notStarted),
      pendingTransactionsNative: jest.fn(),
      rebroadcastPendingNative: jest.fn(),
      confirmSend: jest.fn().mockResolvedValue(true),
      confirmShield: jest.fn().mockResolvedValue(true),
    });

    await expect(controller.send({ payments: [{ address: ADDRESS, amount: "1" }] })).resolves.toEqual({
      schema_version: 1,
      operation: "send",
      outcome: "cancelled",
    });
    await expect(controller.shieldCoinbase()).resolves.toEqual({
      schema_version: 1,
      operation: "shield_coinbase",
      outcome: "cancelled",
    });
  });

  it("revalidates, confirms, then invokes one composite sign-and-broadcast operation", async () => {
    const events: string[] = [];
    const sendAndBroadcast = jest.fn(async () => {
      events.push("sign-and-broadcast");
      return broadcastEnvelope();
    });
    const controller = createWcashTransactionController({
      validateRecipientNative: jest.fn(async () => {
        events.push("validate");
        return {
          schema_version: 1,
          valid: true,
          network: "Wcash Testnet",
          recipient_kind: "ironwood",
          canonical_address: CANONICAL_ADDRESS,
          error: null,
        };
      }),
      sendAndBroadcast,
      shieldCoinbaseAndBroadcast: jest.fn(),
      pendingTransactionsNative: jest.fn(),
      rebroadcastPendingNative: jest.fn(),
      confirmSend: jest.fn(async (options: { detail: string }) => {
        events.push("confirm");
        expect(options.detail).toContain(CANONICAL_ADDRESS);
        expect(options.detail).not.toContain(ADDRESS);
        expect(options.detail).toContain("100000000");
        return true;
      }),
      confirmShield: jest.fn(),
    });

    await expect(controller.send({ payments: [{ address: ADDRESS, amount: "1" }] })).resolves.toMatchObject({
      outcome: "broadcast",
      txid: TXID,
    });

    expect(events).toEqual(["validate", "confirm", "sign-and-broadcast"]);
    expect(sendAndBroadcast).toHaveBeenCalledWith(
      JSON.stringify({ payments: [{ address: CANONICAL_ADDRESS, amount: "1" }] }),
    );
  });

  it("replaces rejected dependency diagnostics with stable public errors", async () => {
    const secret = `${"abandon ".repeat(23)}art deadbeef https://private-node.invalid`;
    const validRecipient = {
      schema_version: 1,
      valid: true,
      network: "Wcash Testnet",
      recipient_kind: "ironwood",
      canonical_address: CANONICAL_ADDRESS,
      error: null,
    };
    const dependencies = {
      validateRecipientNative: jest.fn().mockResolvedValue(validRecipient),
      sendAndBroadcast: jest.fn().mockRejectedValue(new Error(secret)),
      shieldCoinbaseAndBroadcast: jest.fn().mockRejectedValue(new Error(secret)),
      pendingTransactionsNative: jest.fn().mockRejectedValue(new Error(secret)),
      rebroadcastPendingNative: jest.fn().mockRejectedValue(new Error(secret)),
      confirmSend: jest.fn().mockResolvedValue(true),
      confirmShield: jest.fn().mockResolvedValue(true),
    };
    const controller = createWcashTransactionController(dependencies);

    for (const [operation, code] of [
      [controller.send({ payments: [{ address: ADDRESS, amount: "1" }] }), "TRANSACTION_STATUS_UNKNOWN"],
      [controller.shieldCoinbase(), "TRANSACTION_STATUS_UNKNOWN"],
      [controller.pendingTransactions(), "PENDING_STATUS_UNAVAILABLE"],
      [controller.rebroadcastPending(TXID), "REBROADCAST_STATUS_UNKNOWN"],
    ] as const) {
      let failure: unknown;
      try {
        await operation;
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toMatchObject({ code });
      expect(String(failure)).not.toContain(secret);
      expect(String(failure)).not.toContain("private-node.invalid");
    }

    dependencies.validateRecipientNative.mockRejectedValueOnce(new Error(secret));
    let validationFailure: unknown;
    try {
      await controller.validateRecipient(ADDRESS);
    } catch (cause) {
      validationFailure = cause;
    }
    expect(validationFailure).toMatchObject({ code: "RECIPIENT_VALIDATION_UNAVAILABLE" });
    expect(String(validationFailure)).not.toContain(secret);
  });

  it("cancels shielding before signing and strictly sanitizes pending recovery", async () => {
    const shieldCoinbaseAndBroadcast = jest.fn();
    const pendingTransactionsNative = jest.fn().mockResolvedValue({
      schema_version: 1,
      exact_tip_height: 140,
      transactions: [
        {
          txid: TXID,
          branch_id: "b3cfd27e",
          expiry_height: 180,
          lifecycle: "unexpired",
          rebroadcast_allowed: true,
          blocks_new_signing: true,
        },
      ],
      next_cursor: null,
    });
    const controller = createWcashTransactionController({
      validateRecipientNative: jest.fn(),
      sendAndBroadcast: jest.fn(),
      shieldCoinbaseAndBroadcast,
      pendingTransactionsNative,
      rebroadcastPendingNative: jest.fn().mockResolvedValue(
        broadcastEnvelope({
          operation: "rebroadcast_pending",
          target_height: null,
          fee_zat: null,
          internal_change_receiver_verified: null,
        }),
      ),
      confirmSend: jest.fn(),
      confirmShield: jest.fn().mockResolvedValue(false),
    });

    await expect(controller.shieldCoinbase()).resolves.toMatchObject({ outcome: "cancelled" });
    expect(shieldCoinbaseAndBroadcast).not.toHaveBeenCalled();
    await expect(controller.pendingTransactions("42")).resolves.toMatchObject({ transactions: [{ txid: TXID }] });
    expect(pendingTransactionsNative).toHaveBeenCalledWith("42");
    await expect(controller.rebroadcastPending(TXID)).resolves.toMatchObject({
      operation: "rebroadcast_pending",
      outcome: "broadcast",
    });
  });
});
