"use strict";

const runtime = require("../config/wcash-runtime.json");

const reviewedRevision = "62d729a17fed2263eddac9a11731def20062293d";

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
