"use strict";

const runtime = require("../config/wcash-runtime.json");

const reviewedRevision = "da048ab4dd0c29553e3db641f9092f3a0ff9b268";

if (
  runtime.runtimeReady !== true ||
  runtime.coreRevision !== reviewedRevision ||
  runtime.appId !== "com.wcashwallet.warden.testnet" ||
  runtime.network !== "Wcash Testnet"
) {
  console.error(
    "Wcash runtime build is blocked: config must select the reviewed wallet-core revision and Testnet identity.",
  );
  process.exit(1);
}
