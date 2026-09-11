const runtimeConfig = {
  appId: "com.wcashwallet.warden.testnet",
  productName: "Wcash Warden Testnet",
  runtimeReady: true,
  coreRevision: "62d729a17fed2263eddac9a11731def20062293d",
  network: "Wcash Testnet",
  ticker: "TWC",
};

const loadPreload = () => {
  jest.resetModules();
  const exposeInMainWorld = jest.fn();
  const invoke = jest.fn().mockResolvedValue({ ok: true });
  const ipcRenderer = {
    invoke,
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

  it("exposes only the fixed Wcash receive-wallet allowlist and no seed retrieval or path controls", async () => {
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
        "open",
        "receivers",
        "resumePending",
        "revealBackup",
        "restore",
        "status",
        "stopSync",
        "sync",
      ].sort(),
    );
    expect(wcash.getSeed).toBeUndefined();
    expect(wcash.setWalletBaseDir).toBeUndefined();
    expect(wcash.changeServer).toBeUndefined();

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
    await wcash.receivers();

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
      ["wcash:receivers"],
    ]);
  });

  it("publishes the exact reviewed Wcash Testnet identity without loading a local preload module", () => {
    const { exposed } = loadPreload();

    expect(exposed.wcash.config).toEqual({
      productName: runtimeConfig.productName,
      network: runtimeConfig.network,
      ticker: runtimeConfig.ticker,
      runtimeReady: true,
      coreRevision: runtimeConfig.coreRevision,
    });
  });
});
