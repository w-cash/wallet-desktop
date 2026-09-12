"use strict";

const path = require("path");
const { nativeDependencyPinsMatch } = require("./wcash-native-pins");
const runtime = require("../config/wcash-runtime.json");

const reviewedRevision = "58bc22ec63bbe3eddab5f961c137836431589c95";
const reviewedWolfRevision = "5b4e29980eb45e84ddab9024f530c923986d7e1e";
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
