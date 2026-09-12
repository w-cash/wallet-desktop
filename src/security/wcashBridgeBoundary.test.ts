const runtimeConfig = {
  profile: "testnet",
  productName: "Wcash Warden Testnet",
  runtimeReady: true,
  coreRevision: "58bc22ec63bbe3eddab5f961c137836431589c95",
  network: "Wcash Testnet",
  ticker: "TWC",
  endpoint: "https://wallet-testnet.wcashexplorer.com:443",
  storageNamespace: "wcashtestnet-v5",
  branchId: "b3cfd27e",
};

const loadPreload = (selectedRuntime = runtimeConfig) => {
  jest.resetModules();
  const exposeInMainWorld = jest.fn();
  const invoke = jest.fn().mockResolvedValue({ ok: true });
  const ipcRenderer = {
    invoke,
    sendSync: jest.fn().mockReturnValue(selectedRuntime),
    send: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
    removeListener: jest.fn(),
  };

  jest.doMock("electron", () => ({ contextBridge: { exposeInMainWorld }, ipcRenderer }));
  jest.isolateModules(() => require("../../public/preload.js"));

  return {
    exposed: Object.fromEntries(exposeInMainWorld.mock.calls.map(([name, value]) => [name, value])),
    invoke,
    ipcRenderer,
  };
};

describe("Wcash renderer bridge boundary", () => {
  it("keeps every inherited native, invoke and filesystem path closed when Wcash is ready", async () => {
    const { exposed, invoke, ipcRenderer } = loadPreload();

    await expect(exposed.electronAPI.native.get_seed()).rejects.toThrow("Legacy Zcash renderer bridge");
    await expect(exposed.electronAPI.fs.promises.readFile("/tmp/seed")).rejects.toThrow("Legacy Zcash renderer bridge");
    await expect(exposed.electronAPI.ipcRenderer.invoke("fs:readFile", "/tmp/seed")).rejects.toThrow(
      "IPC channel not allowed",
    );
    exposed.electronAPI.ipcRenderer.send("wallet-dir:change", "/tmp/other");

    expect(invoke).not.toHaveBeenCalled();
    expect(ipcRenderer.send).not.toHaveBeenCalled();
  });

  it("exposes only the fixed Wcash semantic wallet allowlist and no seed, raw signing, or path controls", async () => {
    const { exposed, invoke } = loadPreload();
    const wcash = exposed.wcash;

    expect(Object.isFrozen(wcash)).toBe(true);
    expect(Object.isFrozen(wcash.config)).toBe(true);
    expect(Object.keys(wcash).sort()).toEqual(
      [
        "acknowledgeBackup",
        "balance",
        "config",
        "create",
        "history",
        "open",
        "pendingTransactions",
        "rebroadcastPending",
        "receivers",
        "resumePending",
        "revealBackup",
        "restore",
        "status",
        "stopSync",
        "send",
        "shieldCoinbase",
        "sync",
        "validateRecipient",
      ].sort(),
    );
    expect(wcash.getSeed).toBeUndefined();
    expect(wcash.setWalletBaseDir).toBeUndefined();
    expect(wcash.changeServer).toBeUndefined();
    expect(wcash.sign).toBeUndefined();
    expect(wcash.broadcast).toBeUndefined();
    expect(wcash.rawTransaction).toBeUndefined();

    await wcash.status();
    await wcash.create();
    await wcash.restore("valid phrase", 42);
    await wcash.resumePending();
    await wcash.revealBackup();
    await wcash.acknowledgeBackup();
    await wcash.open();
    await wcash.sync();
    await wcash.stopSync();
    await wcash.balance();
    await wcash.history();
    await wcash.receivers();
    await wcash.validateRecipient("wutest1recipient");
    await wcash.send({ payments: [{ address: "wutest1recipient", amount: "1" }] });
    await wcash.shieldCoinbase();
    await wcash.pendingTransactions("42");
    await wcash.rebroadcastPending("a".repeat(64));

    expect(invoke.mock.calls).toEqual([
      ["wcash:status"],
      ["wcash:create"],
      ["wcash:restore", "valid phrase", 42],
      ["wcash:resume-pending"],
      ["wcash:reveal-backup"],
      ["wcash:acknowledge-backup"],
      ["wcash:open"],
      ["wcash:sync"],
      ["wcash:stop-sync"],
      ["wcash:balance"],
      ["wcash:history"],
      ["wcash:receivers"],
      ["wcash:validate-recipient", "wutest1recipient"],
      ["wcash:send", { payments: [{ address: "wutest1recipient", amount: "1" }] }],
      ["wcash:shield-coinbase"],
      ["wcash:pending-transactions", "42"],
      ["wcash:rebroadcast-pending", "a".repeat(64)],
    ]);
  });

  it("publishes the exact reviewed Wcash Testnet identity without loading a local preload module", () => {
    const { exposed } = loadPreload();

    expect(exposed.wcash.config).toEqual({
      profile: runtimeConfig.profile,
      productName: runtimeConfig.productName,
      network: runtimeConfig.network,
      ticker: runtimeConfig.ticker,
      endpoint: runtimeConfig.endpoint,
      storageNamespace: runtimeConfig.storageNamespace,
      branchId: runtimeConfig.branchId,
      runtimeReady: true,
      coreRevision: runtimeConfig.coreRevision,
    });
  });

  it("accepts only the exact main-process local Regtest identity", () => {
    const localRuntime = {
      profile: "local-regtest",
      productName: "Wcash Warden Local Regtest",
      network: "Wcash Regtest",
      ticker: "TWC",
      endpoint: "http://127.0.0.1:48234",
      storageNamespace: "wcashregtest-v5",
      branchId: "c3a6678a",
      runtimeReady: true,
      coreRevision: runtimeConfig.coreRevision,
    };
    expect(loadPreload(localRuntime).exposed.wcash.config).toEqual(localRuntime);
    expect(() => loadPreload({ ...localRuntime, endpoint: "http://127.0.0.1:9999" })).toThrow(
      "invalid runtime profile",
    );
    expect(() => loadPreload({ ...runtimeConfig, network: "Wcash Regtest" })).toThrow("invalid runtime profile");
  });
});
