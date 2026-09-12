"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, ipcMain } = require("electron");

const RUNTIME = Object.freeze({
  profile: "local-regtest",
  productName: "Wcash Warden Local Regtest",
  network: "Wcash Regtest",
  ticker: "TWC",
  endpoint: "http://127.0.0.1:48234",
  storageNamespace: "wcashregtest-v5",
  branchId: "c3a6678a",
  runtimeReady: true,
  coreRevision: "58bc22ec63bbe3eddab5f961c137836431589c95",
});

const ironwoodAddress = `wuregtest1${"q".repeat(90)}`;
const transparentAddress = "WRSJjaJAZ75QkqbJoa244F21QmkPHEqhYu8";
const wallet = Object.freeze({
  account_id: "layout-test-account",
  birthday_height: 1,
  address: ironwoodAddress,
  transparent_coinbase_address: transparentAddress,
});

// These addresses are visibly synthetic. The test never loads native.node or
// accesses a wallet database, recovery phrase, or operating-system keychain.
const status = {
  profile: RUNTIME.profile,
  network: RUNTIME.network,
  ticker: RUNTIME.ticker,
  endpoint: RUNTIME.endpoint,
  storage_namespace: RUNTIME.storageNamespace,
  branch_id: RUNTIME.branchId,
  state: "database-and-secret-ready",
  wallet,
};

const balance = {
  chain_tip_height: 4,
  fully_scanned_height: 4,
  synchronized: true,
  accounts: [
    {
      account_id: wallet.account_id,
      ironwood_total_zat: 2_400_000_000,
      ironwood_spendable_zat: 2_400_000_000,
      ironwood_locked_zat: 0,
      ironwood_pending_change_zat: 0,
      ironwood_pending_spendability_zat: 0,
      sapling_total_zat: 0,
      orchard_total_zat: 0,
      transparent_total_zat: 0,
      transparent_coinbase_total_zat: 0,
      transparent_coinbase_spendable_zat: 0,
      transparent_coinbase_pending_zat: 0,
    },
  ],
};

const timeout = setTimeout(() => {
  console.error("small-window scroll regression timed out");
  app.exit(1);
}, 20_000);

function handle(channel, value) {
  ipcMain.handle(channel, async () => value);
}

async function waitForSelector(window, selector) {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (document.querySelector(${JSON.stringify(selector)})) return resolve();
      if (Date.now() - started > 5000) return reject(new Error("missing selector: ${selector}"));
      requestAnimationFrame(check);
    };
    check();
  })`);
}

async function run() {
  const mainProcessSource = fs.readFileSync(path.join(__dirname, "..", "public", "electron.js"), "utf8");
  if (!mainProcessSource.includes("minWidth: 720,\n    minHeight: 480,")) {
    throw new Error("production Wcash window minimum is not the tested 720x480 size");
  }

  ipcMain.on("wcash:runtime-config", (event) => {
    event.returnValue = RUNTIME;
  });
  handle("wcash:status", status);
  handle("wcash:open", { wallet });
  handle("wcash:balance", balance);
  handle("wcash:history", {
    exact_tip: { height: 4, hash: Array(32).fill(4) },
    transactions: [
      {
        txid: "a".repeat(64),
        mined_height: 4,
        direction: "outgoing",
        kind: "transfer",
        amount_delta_zat: -100_015_000,
        fee_zat: 15_000,
        timestamp: 1_788_782_400,
        confirmations: 1,
      },
    ],
  });
  handle("wcash:receivers", {
    ironwood_address: ironwoodAddress,
    transparent_coinbase_address: transparentAddress,
  });
  handle("wcash:pending-transactions", {
    schema_version: 1,
    exact_tip_height: 4,
    transactions: [],
    next_cursor: null,
  });

  const window = new BrowserWindow({
    show: false,
    width: 720,
    height: 480,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      preload: path.join(__dirname, "..", "public", "preload.js"),
    },
  });

  await window.loadFile(path.join(__dirname, "..", "build", "index.html"));
  await waitForSelector(window, ".warden-centered .warden-button");
  await window.webContents.executeJavaScript(`document.querySelector(".warden-centered .warden-button").click()`);
  await waitForSelector(window, "#receive-title");

  const result = await window.webContents.executeJavaScript(`(async () => {
    const shell = document.querySelector(".warden-shell");
    const header = document.querySelector(".warden-header");
    const receive = document.querySelector("#receive-title");
    const style = getComputedStyle(shell);
    const before = {
      scrollTop: shell.scrollTop,
      clientHeight: shell.clientHeight,
      scrollHeight: shell.scrollHeight,
    };
    shell.scrollTop = shell.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const headerRect = header.getBoundingClientRect();
    const receiveRect = receive.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      overflowY: style.overflowY,
      before,
      afterScrollTop: shell.scrollTop,
      maximumScrollTop: shell.scrollHeight - shell.clientHeight,
      header: { top: headerRect.top, bottom: headerRect.bottom },
      receive: { top: receiveRect.top, bottom: receiveRect.bottom },
    };
  })()`);

  if (
    result.overflowY !== "auto" ||
    result.before.scrollHeight <= result.before.clientHeight ||
    result.afterScrollTop <= 0 ||
    Math.abs(result.afterScrollTop - result.maximumScrollTop) > 1 ||
    result.header.top !== 0 ||
    result.receive.top < result.header.bottom ||
    result.receive.bottom > result.viewport.height
  ) {
    throw new Error(`small-window wallet did not scroll correctly: ${JSON.stringify(result)}`);
  }

  const screenshotPath = process.env.WCASH_LAYOUT_SCREENSHOT;
  if (screenshotPath) {
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
  }

  console.log(JSON.stringify({ ok: true, size: "720x480", ...result }));
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
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    app.exit(1);
  });
