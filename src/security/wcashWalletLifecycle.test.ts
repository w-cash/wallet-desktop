export {};

const { LIFECYCLE_STATES, SEED_SCHEME, createWcashWalletLifecycle } = require("../../public/wcashWalletLifecycle");

const PHRASE = `${"abandon ".repeat(23)}art`;
const SERVICE = "com.wcashwallet.warden.testnet.wallet-seed.v1";
const ACCOUNT = "wcash-testnet-primary";
const WALLET = { account_id: 0, birthday_height: 321, address: "wutest1example" };
const STATUS_IDENTITY = {
  network: "Wcash Testnet",
  ticker: "TWC",
  storage_namespace: "wcashtestnet-v5",
};

const publicState = (state: string, fields = {}) => ({ state, ...STATUS_IDENTITY, ...fields });
const statusJson = (wallet: object | null) => JSON.stringify({ ...STATUS_IDENTITY, wallet });

type HarnessOptions = {
  stored?: string | null;
  status?: unknown;
};

function record(
  intent: "create" | "restore",
  birthdayHeight: number,
  phrase = PHRASE,
  backupAcknowledged = intent === "restore",
) {
  return JSON.stringify({
    version: 1,
    scheme: SEED_SCHEME,
    intent,
    birthdayHeight,
    backupAcknowledged,
    phrase,
  });
}

function harness({ stored = null, status = { wallet: null } }: HarnessOptions = {}) {
  let credential = stored;
  const events: string[] = [];
  const authenticate: jest.Mock<Promise<unknown>, []> = jest.fn(async () => {
    events.push("authenticate");
    return true;
  });
  const keytar = {
    getPassword: jest.fn(async () => {
      events.push("getPassword");
      return credential;
    }),
    setPassword: jest.fn(async (_service: string, _account: string, value: string) => {
      events.push("setPassword");
      credential = value;
    }),
    deletePassword: jest.fn(async () => {
      events.push("deletePassword");
      credential = null;
      return true;
    }),
  };
  const native = {
    wcash_status: jest.fn(async () => {
      events.push("status");
      return typeof status === "string" ? status : JSON.stringify({ ...STATUS_IDENTITY, ...(status as object) });
    }),
    wcash_generate_mnemonic: jest.fn(async () => {
      events.push("generate");
      return PHRASE;
    }),
    wcash_validate_mnemonic: jest.fn(async (phrase: string) => {
      events.push("validate");
      return phrase.trim().replace(/\s+/gu, " ");
    }),
    wcash_verify_mnemonic: jest.fn(async () => {
      events.push("verify");
      return true;
    }),
    wcash_create: jest.fn(async () => {
      events.push("create");
      return JSON.stringify({ wallet: WALLET, seed_scheme: SEED_SCHEME });
    }),
    wcash_restore: jest.fn(async () => {
      events.push("restore");
      return JSON.stringify({ wallet: WALLET, seed_scheme: SEED_SCHEME });
    }),
    wcash_send_and_broadcast: jest.fn(async () => {
      events.push("send");
      return JSON.stringify({ safe: "send-result" });
    }),
    wcash_shield_coinbase_and_broadcast: jest.fn(async () => {
      events.push("shield");
      return JSON.stringify({ safe: "shield-result" });
    }),
    wcash_pending_transactions: jest.fn(async () => {
      events.push("pending");
      return JSON.stringify({ safe: "pending-result" });
    }),
    wcash_rebroadcast_pending: jest.fn(async () => {
      events.push("rebroadcast");
      return JSON.stringify({ safe: "rebroadcast-result" });
    }),
  };
  const lifecycle = createWcashWalletLifecycle({
    keytar,
    native,
    authenticate,
    service: SERVICE,
    account: ACCOUNT,
  });
  return { authenticate, events, keytar, lifecycle, native, readCredential: () => credential };
}

describe("Wcash main-process wallet lifecycle", () => {
  it.each([
    [null, { wallet: null }, publicState(LIFECYCLE_STATES.EMPTY)],
    [
      record("create", 1),
      { wallet: null },
      publicState(LIFECYCLE_STATES.PENDING, { intent: "create", birthdayHeight: 1 }),
    ],
    [record("create", 321), { wallet: WALLET }, publicState(LIFECYCLE_STATES.BACKUP_REQUIRED, { wallet: WALLET })],
    [record("restore", 123), { wallet: WALLET }, publicState(LIFECYCLE_STATES.READY, { wallet: WALLET })],
    [null, { wallet: WALLET }, publicState(LIFECYCLE_STATES.FAIL_CLOSED, { wallet: WALLET })],
  ])("classifies database and credential state without exposing the phrase", async (stored, status, expected) => {
    const { lifecycle } = harness({ stored, status });

    const result = await lifecycle.inspectState();

    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain("abandon");
  });

  it("rejects status that does not attest the fixed Wcash Testnet identity", async () => {
    const wrongNetworkStatus = JSON.stringify({
      ...STATUS_IDENTITY,
      ticker: "ZEC",
      wallet: null,
    });
    const { lifecycle } = harness({ status: wrongNetworkStatus });

    await expect(lifecycle.inspectState()).rejects.toMatchObject({ code: "NATIVE_STATUS_AMBIGUOUS" });
  });

  it("authenticates immediately before every existing-wallet credential read and exposes no seed getter", async () => {
    const { authenticate, events, keytar, lifecycle } = harness({
      stored: record("restore", 123),
      status: { wallet: WALLET },
    });

    await lifecycle.inspectState();
    await lifecycle.inspectState();

    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(keytar.getPassword).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      "status",
      "authenticate",
      "getPassword",
      "verify",
      "status",
      "authenticate",
      "getPassword",
      "verify",
    ]);
    expect(lifecycle.getSeed).toBeUndefined();
    expect(lifecycle.getCredential).toBeUndefined();
  });

  it("shows empty or pending onboarding state without an unnecessary device-auth prompt", async () => {
    const empty = harness();
    await expect(empty.lifecycle.inspectState()).resolves.toEqual(publicState(LIFECYCLE_STATES.EMPTY));
    expect(empty.authenticate).not.toHaveBeenCalled();
    expect(empty.events).toEqual(["status", "getPassword"]);

    const pending = harness({ stored: record("create", 1) });
    await expect(pending.lifecycle.inspectState()).resolves.toEqual(
      publicState(LIFECYCLE_STATES.PENDING, { intent: "create", birthdayHeight: 1 }),
    );
    expect(pending.authenticate).not.toHaveBeenCalled();
    expect(JSON.stringify(await pending.lifecycle.inspectState())).not.toContain("abandon");
  });

  it.each([undefined, null, {}, { success: false }, { success: true }])(
    "does not read the credential for a non-true authentication result: %p",
    async (authenticationResult) => {
      const { authenticate, keytar, lifecycle } = harness({ status: { wallet: WALLET } });
      authenticate.mockResolvedValueOnce(authenticationResult);

      await expect(lifecycle.inspectState()).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });

      expect(keytar.getPassword).not.toHaveBeenCalled();
    },
  );

  it("does not read the credential when authentication rejects", async () => {
    const failure = new Error("authentication unavailable");
    const { authenticate, keytar, lifecycle } = harness({ status: { wallet: WALLET } });
    authenticate.mockRejectedValueOnce(failure);

    await expect(lifecycle.inspectState()).rejects.toBe(failure);

    expect(keytar.getPassword).not.toHaveBeenCalled();
  });

  it("stores a versioned create record before native initialization and returns the phrase only on success", async () => {
    const { events, keytar, lifecycle, native, readCredential } = harness();

    const result = await lifecycle.create();

    expect(events.indexOf("setPassword")).toBeLessThan(events.indexOf("create"));
    expect(native.wcash_create.mock.invocationCallOrder[0]).toBeLessThan(
      native.wcash_verify_mnemonic.mock.invocationCallOrder[0],
    );
    expect(events.indexOf("verify")).toBeLessThan(events.lastIndexOf("setPassword"));
    expect(JSON.parse(keytar.setPassword.mock.calls[0][2])).toEqual({
      version: 1,
      scheme: SEED_SCHEME,
      intent: "create",
      birthdayHeight: 1,
      backupAcknowledged: false,
      phrase: PHRASE,
    });
    expect(JSON.parse(readCredential() as string)).toEqual({
      version: 1,
      scheme: SEED_SCHEME,
      intent: "create",
      birthdayHeight: WALLET.birthday_height,
      backupAcknowledged: false,
      phrase: PHRASE,
    });
    expect(keytar.setPassword).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      wallet: WALLET,
      seed_scheme: SEED_SCHEME,
      recoveryPhrase: PHRASE,
    });
  });

  it("stores restore intent and birthday before initialization without returning the phrase", async () => {
    const { events, lifecycle, native, readCredential } = harness();

    const result = await lifecycle.restore(PHRASE, 2468);

    expect(events.indexOf("setPassword")).toBeLessThan(events.indexOf("restore"));
    expect(JSON.parse(readCredential() as string)).toEqual({
      version: 1,
      scheme: SEED_SCHEME,
      intent: "restore",
      birthdayHeight: 2468,
      backupAcknowledged: true,
      phrase: PHRASE,
    });
    expect(native.wcash_restore).toHaveBeenCalledWith(PHRASE, 2468);
    expect(result).toEqual({ wallet: WALLET, seed_scheme: SEED_SCHEME });
    expect(JSON.stringify(result)).not.toContain("abandon");
  });

  it("allowlists initialization output so unexpected native secret fields cannot cross the boundary", async () => {
    const { lifecycle, native } = harness();
    native.wcash_create.mockResolvedValueOnce(
      JSON.stringify({
        wallet: WALLET,
        seed_scheme: SEED_SCHEME,
        mnemonic: PHRASE,
        masterSeed: "private-seed-marker",
        futureField: { phrase: PHRASE },
      }),
    );

    const result = await lifecycle.create();

    expect(result).toEqual({
      wallet: WALLET,
      seed_scheme: SEED_SCHEME,
      recoveryPhrase: PHRASE,
    });
    expect(result).not.toHaveProperty("mnemonic");
    expect(result).not.toHaveProperty("masterSeed");
    expect(result).not.toHaveProperty("futureField");
  });

  it("does not initialize a database when storing the credential fails", async () => {
    const failure = new Error("keychain unavailable");
    const { keytar, lifecycle, native } = harness();
    keytar.setPassword.mockRejectedValueOnce(failure);

    await expect(lifecycle.create()).rejects.toBe(failure);

    expect(native.wcash_create).not.toHaveBeenCalled();
    expect(keytar.deletePassword).not.toHaveBeenCalled();
  });

  it("deletes a newly stored credential after native failure only when re-inspection proves no database", async () => {
    const failure = new Error("native init failed");
    const { keytar, lifecycle, native, readCredential } = harness();
    native.wcash_create.mockRejectedValueOnce(failure);

    await expect(lifecycle.create()).rejects.toBe(failure);

    expect(native.wcash_status).toHaveBeenCalledTimes(2);
    expect(keytar.deletePassword).toHaveBeenCalledWith(SERVICE, ACCOUNT);
    expect(readCredential()).toBeNull();
  });

  it("retains the credential after native failure when re-inspection finds a database", async () => {
    const failure = new Error("native init failed after commit");
    const { keytar, lifecycle, native, readCredential } = harness();
    native.wcash_status.mockResolvedValueOnce(statusJson(null)).mockResolvedValueOnce(statusJson(WALLET));
    native.wcash_create.mockRejectedValueOnce(failure);

    await expect(lifecycle.create()).rejects.toBe(failure);

    expect(keytar.deletePassword).not.toHaveBeenCalled();
    expect(readCredential()).not.toBeNull();
  });

  it("retains the credential after native failure when re-inspection is ambiguous", async () => {
    const failure = new Error("native init failed");
    const { keytar, lifecycle, native, readCredential } = harness();
    native.wcash_status.mockResolvedValueOnce(statusJson(null)).mockRejectedValueOnce(new Error("inspection failed"));
    native.wcash_create.mockRejectedValueOnce(failure);

    await expect(lifecycle.create()).rejects.toBe(failure);

    expect(keytar.deletePassword).not.toHaveBeenCalled();
    expect(readCredential()).not.toBeNull();
  });

  it("reports ready only when the stored phrase strictly verifies against the database", async () => {
    const existing = record("restore", 123);
    const { lifecycle, native } = harness({ stored: existing, status: { wallet: WALLET } });

    await expect(lifecycle.inspectState()).resolves.toEqual(publicState(LIFECYCLE_STATES.READY, { wallet: WALLET }));

    expect(native.wcash_verify_mnemonic).toHaveBeenCalledWith(PHRASE);
  });

  it("classifies a database with a mismatched credential as fail-closed", async () => {
    const existing = record("restore", 123);
    const { lifecycle, native, readCredential } = harness({ stored: existing, status: { wallet: WALLET } });
    native.wcash_verify_mnemonic.mockResolvedValueOnce(false);

    const result = await lifecycle.inspectState();

    expect(result).toEqual(publicState(LIFECYCLE_STATES.FAIL_CLOSED, { wallet: WALLET }));
    expect(JSON.stringify(result)).not.toContain("abandon");
    expect(readCredential()).toBe(existing);
  });

  it("classifies a database as fail-closed and retains the credential when verification throws", async () => {
    const existing = record("create", 321);
    const { keytar, lifecycle, native, readCredential } = harness({
      stored: existing,
      status: { wallet: WALLET },
    });
    native.wcash_verify_mnemonic.mockRejectedValueOnce(new Error("verification unavailable"));

    await expect(lifecycle.inspectState()).resolves.toEqual(
      publicState(LIFECYCLE_STATES.FAIL_CLOSED, { wallet: WALLET }),
    );

    expect(keytar.deletePassword).not.toHaveBeenCalled();
    expect(readCredential()).toBe(existing);
  });

  it("retains the credential when post-initialization ownership verification mismatches", async () => {
    const { keytar, lifecycle, native, readCredential } = harness();
    native.wcash_status.mockResolvedValueOnce(statusJson(null)).mockResolvedValueOnce(statusJson(WALLET));
    native.wcash_verify_mnemonic.mockResolvedValueOnce(false);

    await expect(lifecycle.create()).rejects.toMatchObject({
      code: "WALLET_OWNERSHIP_MISMATCH",
    });

    expect(native.wcash_create.mock.invocationCallOrder[0]).toBeLessThan(
      native.wcash_verify_mnemonic.mock.invocationCallOrder[0],
    );
    expect(native.wcash_status).toHaveBeenCalledTimes(2);
    expect(keytar.deletePassword).not.toHaveBeenCalled();
    expect(readCredential()).not.toBeNull();
  });

  it("retains the credential when post-initialization ownership verification throws", async () => {
    const failure = new Error("ownership verification unavailable");
    const { keytar, lifecycle, native, readCredential } = harness();
    native.wcash_status.mockResolvedValueOnce(statusJson(null)).mockResolvedValueOnce(statusJson(WALLET));
    native.wcash_verify_mnemonic.mockRejectedValueOnce(failure);

    await expect(lifecycle.create()).rejects.toBe(failure);

    expect(native.wcash_create).toHaveBeenCalledTimes(1);
    expect(native.wcash_status).toHaveBeenCalledTimes(2);
    expect(keytar.deletePassword).not.toHaveBeenCalled();
    expect(readCredential()).not.toBeNull();
  });

  it("applies the same cleanup rule when native initialization returns invalid JSON", async () => {
    const { keytar, lifecycle, native, readCredential } = harness();
    native.wcash_create.mockResolvedValueOnce("not-json");

    await expect(lifecycle.create()).rejects.toMatchObject({ code: "NATIVE_DATA_INVALID" });

    expect(native.wcash_status).toHaveBeenCalledTimes(2);
    expect(keytar.deletePassword).toHaveBeenCalledTimes(1);
    expect(readCredential()).toBeNull();
  });

  it("re-inspects but retains the credential if native validation fails while resuming", async () => {
    const failure = new Error("native validation failed");
    const { keytar, lifecycle, native, readCredential } = harness({
      stored: record("create", 1),
    });
    native.wcash_validate_mnemonic.mockRejectedValueOnce(failure);

    await expect(lifecycle.resumePending()).rejects.toBe(failure);

    expect(native.wcash_status).toHaveBeenCalledTimes(2);
    expect(keytar.deletePassword).not.toHaveBeenCalled();
    expect(readCredential()).toBe(record("create", 1));
  });

  it("never overwrites an existing credential", async () => {
    const existing = record("restore", 456);
    const { keytar, lifecycle, native, readCredential } = harness({ stored: existing });

    await expect(lifecycle.create()).rejects.toMatchObject({ code: "WALLET_ALREADY_INITIALIZED" });

    expect(keytar.setPassword).not.toHaveBeenCalled();
    expect(native.wcash_generate_mnemonic).not.toHaveBeenCalled();
    expect(native.wcash_create).not.toHaveBeenCalled();
    expect(readCredential()).toBe(existing);
  });

  it("resumes every pending create as a restore from its durable birthday", async () => {
    const existing = record("create", 1);
    const { keytar, lifecycle, native } = harness({ stored: existing });

    const result = await lifecycle.resumePending();

    expect(native.wcash_create).not.toHaveBeenCalled();
    expect(native.wcash_restore).toHaveBeenCalledWith(PHRASE, 1);
    expect(keytar.setPassword).toHaveBeenCalledTimes(1);
    expect(JSON.parse(keytar.setPassword.mock.calls[0][2])).toMatchObject({
      intent: "create",
      birthdayHeight: WALLET.birthday_height,
      backupAcknowledged: false,
    });
    expect(result.recoveryPhrase).toBe(PHRASE);
  });

  it("resumes pending restore with its birthday and never returns the phrase", async () => {
    const existing = record("restore", 789);
    const { lifecycle, native } = harness({ stored: existing });

    const result = await lifecycle.resumePending();

    expect(native.wcash_restore).toHaveBeenCalledWith(PHRASE, 789);
    expect(result).toEqual({ wallet: WALLET, seed_scheme: SEED_SCHEME });
    expect(JSON.stringify(result)).not.toContain("abandon");
  });

  it("reveals an unacknowledged create backup only after authentication and ownership verification", async () => {
    const existing = record("create", WALLET.birthday_height);
    const { events, lifecycle, native } = harness({ stored: existing, status: { wallet: WALLET } });

    await expect(lifecycle.revealBackup()).resolves.toEqual({
      recoveryPhrase: PHRASE,
      seed_scheme: SEED_SCHEME,
    });

    expect(events).toEqual(["status", "authenticate", "getPassword", "verify"]);
    expect(native.wcash_verify_mnemonic).toHaveBeenCalledWith(PHRASE);
  });

  it("acknowledges a verified backup by rewriting only its durable metadata", async () => {
    const existing = record("create", 1);
    const { events, keytar, lifecycle, readCredential } = harness({
      stored: existing,
      status: { wallet: WALLET },
    });

    await expect(lifecycle.acknowledgeBackup()).resolves.toEqual(
      publicState(LIFECYCLE_STATES.READY, { wallet: WALLET }),
    );

    expect(events.indexOf("verify")).toBeLessThan(events.indexOf("setPassword"));
    expect(JSON.parse(readCredential() as string)).toEqual({
      version: 1,
      scheme: SEED_SCHEME,
      intent: "create",
      birthdayHeight: WALLET.birthday_height,
      backupAcknowledged: true,
      phrase: PHRASE,
    });
    expect(keytar.deletePassword).not.toHaveBeenCalled();
  });

  it("does not acknowledge or reveal a backup when native ownership verification fails", async () => {
    const existing = record("create", WALLET.birthday_height);
    const { keytar, lifecycle, native, readCredential } = harness({
      stored: existing,
      status: { wallet: WALLET },
    });
    native.wcash_verify_mnemonic.mockResolvedValue(false);

    await expect(lifecycle.revealBackup()).rejects.toMatchObject({ code: "WALLET_OWNERSHIP_UNVERIFIED" });
    await expect(lifecycle.acknowledgeBackup()).rejects.toMatchObject({ code: "WALLET_OWNERSHIP_UNVERIFIED" });

    expect(keytar.setPassword).not.toHaveBeenCalled();
    expect(keytar.deletePassword).not.toHaveBeenCalled();
    expect(readCredential()).toBe(existing);
  });

  it("retains an unacknowledged backup when the acknowledgment keychain write fails", async () => {
    const failure = new Error("keychain write failed");
    const existing = record("create", 1);
    const { keytar, lifecycle, readCredential } = harness({ stored: existing, status: { wallet: WALLET } });
    keytar.setPassword.mockRejectedValueOnce(failure);

    await expect(lifecycle.acknowledgeBackup()).rejects.toBe(failure);

    expect(readCredential()).toBe(existing);
    expect(keytar.deletePassword).not.toHaveBeenCalled();
  });

  it("retains and can repair the conservative record when the post-create birthday rewrite fails", async () => {
    const failure = new Error("metadata rewrite failed");
    const { keytar, lifecycle, native, readCredential } = harness();
    const successfulSet = keytar.setPassword.getMockImplementation();
    if (!successfulSet) throw new Error("test harness did not install setPassword");
    keytar.setPassword.mockImplementationOnce(successfulSet).mockRejectedValueOnce(failure);
    native.wcash_status.mockResolvedValueOnce(statusJson(null)).mockResolvedValue(statusJson(WALLET));

    await expect(lifecycle.create()).rejects.toMatchObject({ code: "CREDENTIAL_UPDATE_FAILED", cause: failure });

    expect(JSON.parse(readCredential() as string)).toMatchObject({
      intent: "create",
      birthdayHeight: 1,
      backupAcknowledged: false,
    });
    expect(keytar.deletePassword).not.toHaveBeenCalled();
    await expect(lifecycle.inspectState()).resolves.toEqual(
      publicState(LIFECYCLE_STATES.BACKUP_REQUIRED, { wallet: WALLET }),
    );
    await expect(lifecycle.acknowledgeBackup()).resolves.toEqual(
      publicState(LIFECYCLE_STATES.READY, { wallet: WALLET }),
    );
    expect(JSON.parse(readCredential() as string)).toMatchObject({
      birthdayHeight: WALLET.birthday_height,
      backupAcknowledged: true,
    });
  });

  it("fails closed when a database exists without a credential", async () => {
    const { keytar, lifecycle, native } = harness({ status: { wallet: WALLET } });

    await expect(lifecycle.create()).rejects.toMatchObject({ code: "WALLET_SECRET_MISSING" });
    await expect(lifecycle.resumePending()).rejects.toMatchObject({ code: "WALLET_SECRET_MISSING" });

    expect(keytar.setPassword).not.toHaveBeenCalled();
    expect(native.wcash_create).not.toHaveBeenCalled();
  });

  it("authenticates and verifies ownership before passing the phrase to the composite send operation", async () => {
    const { events, lifecycle, native } = harness({
      stored: record("restore", 123),
      status: { wallet: WALLET },
    });
    const request = JSON.stringify({ payments: [{ address: "wutest1recipient", amount: "1" }] });

    await expect(lifecycle.sendAndBroadcast(request)).resolves.toEqual({ safe: "send-result" });

    expect(events).toEqual(["status", "authenticate", "getPassword", "verify", "send"]);
    expect(native.wcash_send_and_broadcast).toHaveBeenCalledWith(PHRASE, request);
    expect(JSON.stringify(await lifecycle.sendAndBroadcast(request))).not.toContain(PHRASE);
  });

  it("authenticates before shielding and never returns the credential", async () => {
    const { events, lifecycle, native } = harness({
      stored: record("restore", 123),
      status: { wallet: WALLET },
    });

    const result = await lifecycle.shieldCoinbaseAndBroadcast();

    expect(events).toEqual(["status", "authenticate", "getPassword", "verify", "shield"]);
    expect(native.wcash_shield_coinbase_and_broadcast).toHaveBeenCalledWith(PHRASE);
    expect(result).toEqual({ safe: "shield-result" });
    expect(JSON.stringify(result)).not.toContain(PHRASE);
  });

  it("requires authenticated READY state for pending recovery without passing the phrase to native", async () => {
    const { events, lifecycle, native } = harness({
      stored: record("restore", 123),
      status: { wallet: WALLET },
    });

    await expect(lifecycle.pendingTransactions("42")).resolves.toEqual({ safe: "pending-result" });
    await expect(lifecycle.rebroadcastPending("a".repeat(64))).resolves.toEqual({ safe: "rebroadcast-result" });

    expect(native.wcash_pending_transactions).toHaveBeenCalledWith("42");
    expect(native.wcash_rebroadcast_pending).toHaveBeenCalledWith("a".repeat(64));
    expect(native.wcash_pending_transactions.mock.calls.flat()).not.toContain(PHRASE);
    expect(native.wcash_rebroadcast_pending.mock.calls.flat()).not.toContain(PHRASE);
    expect(events).toEqual([
      "status",
      "authenticate",
      "getPassword",
      "verify",
      "pending",
      "status",
      "authenticate",
      "getPassword",
      "verify",
      "rebroadcast",
    ]);
  });

  it("does not call transaction native methods unless the database, credential, and backup are ready", async () => {
    const { lifecycle, native } = harness({
      stored: record("create", 321),
      status: { wallet: WALLET },
    });

    await expect(lifecycle.sendAndBroadcast('{"payments":[]}')).rejects.toMatchObject({
      code: "WALLET_BACKUP_REQUIRED",
    });
    await expect(lifecycle.shieldCoinbaseAndBroadcast()).rejects.toMatchObject({ code: "WALLET_BACKUP_REQUIRED" });

    expect(native.wcash_send_and_broadcast).not.toHaveBeenCalled();
    expect(native.wcash_shield_coinbase_and_broadcast).not.toHaveBeenCalled();
  });

  it("serializes transaction authority so duplicate submits cannot sign concurrently", async () => {
    const { lifecycle, native } = harness({
      stored: record("restore", 123),
      status: { wallet: WALLET },
    });
    const releases: Array<() => void> = [];
    native.wcash_send_and_broadcast.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve(JSON.stringify({ safe: "send-result" })));
        }),
    );

    const first = lifecycle.sendAndBroadcast('{"payments":[{"address":"wutest1recipient","amount":"1"}]}');
    const second = lifecycle.sendAndBroadcast('{"payments":[{"address":"wutest1recipient","amount":"2"}]}');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(native.wcash_send_and_broadcast).toHaveBeenCalledTimes(1);
    releases.shift()!();
    await first;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(native.wcash_send_and_broadcast).toHaveBeenCalledTimes(2);
    releases.shift()!();
    await second;
  });
});
