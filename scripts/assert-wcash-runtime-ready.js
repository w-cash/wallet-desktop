"use strict";

const path = require("path");
const { nativeDependencyPinsMatch } = require("./wcash-native-pins");
const runtime = require("../config/wcash-runtime.json");

const reviewedRevision = "db28e549bda764adcc5ba48c295a3e33c033d638";
const reviewedWolfRevision = "b44571035074900570ef13f4fa96787886674ada";
const root = path.resolve(__dirname, "..");

if (
  runtime.runtimeReady !== true ||
  runtime.coreRevision !== reviewedRevision ||
  runtime.appId !== "com.wcashwallet.warden.testnet" ||
  runtime.network !== "Wcash Testnet" ||
  !nativeDependencyPinsMatch({
    root,
    coreRevision: reviewedRevision,
    wolfRevision: reviewedWolfRevision,
  })
) {
  console.error(
    "Wcash runtime build is blocked: config, native manifest, and lockfile must select the reviewed wallet-core/Wolf revisions and Testnet identity.",
  );
  process.exit(1);
}
