"use strict";

const path = require("path");
const { app, BrowserWindow } = require("electron");

const EXPECTED_METHODS = [
  "acknowledgeBackup",
  "balance",
  "config",
  "create",
  "open",
  "pendingTransactions",
  "rebroadcastPending",
  "receivers",
  "restore",
  "resumePending",
  "revealBackup",
  "status",
  "stopSync",
  "send",
  "shieldCoinbase",
  "sync",
  "validateRecipient",
];

const timeout = setTimeout(() => {
  console.error("sandboxed Wcash preload smoke timed out");
  app.exit(1);
}, 15_000);

async function run() {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      preload: path.join(__dirname, "..", "public", "preload.js"),
    },
  });

  await window.loadURL("data:text/html;charset=utf-8,%3Ctitle%3EWcash%20preload%20smoke%3C%2Ftitle%3E");
  const result = await window.webContents.executeJavaScript(`(() => {
    const bridge = window.wcash;
    return {
      methods: Object.keys(bridge || {}).sort(),
      config: bridge && bridge.config,
      directRequire: typeof window.require,
      directNative: typeof window.native,
      directInvoke: typeof window.invoke,
    };
  })()`);

  if (
    JSON.stringify(result.methods) !== JSON.stringify([...EXPECTED_METHODS].sort()) ||
    result.config?.productName !== "Wcash Warden Testnet" ||
    result.config?.network !== "Wcash Testnet" ||
    result.config?.ticker !== "TWC" ||
    result.config?.runtimeReady !== true ||
    result.config?.coreRevision !== "da048ab4dd0c29553e3db641f9092f3a0ff9b268" ||
    result.directRequire !== "undefined" ||
    result.directNative !== "undefined" ||
    result.directInvoke !== "undefined"
  ) {
    throw new Error(`sandboxed Wcash preload contract mismatch: ${JSON.stringify(result)}`);
  }

  console.log(
    JSON.stringify({
      ok: true,
      sandboxed: true,
      network: result.config.network,
      ticker: result.config.ticker,
      exposedMethods: result.methods,
      directGlobals: {
        require: result.directRequire,
        native: result.directNative,
        invoke: result.directInvoke,
      },
    }),
  );
  window.destroy();
}

app
  .whenReady()
  .then(run)
  .then(() => {
    clearTimeout(timeout);
    app.exit(0);
  })
  .catch((error) => {
    clearTimeout(timeout);
    console.error(error instanceof Error ? error.message : String(error));
    app.exit(1);
  });
