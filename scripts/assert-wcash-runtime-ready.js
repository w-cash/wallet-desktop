"use strict";

const runtime = require("../config/wcash-runtime.json");

const pinnedRevision = typeof runtime.coreRevision === "string" && /^[0-9a-f]{40}$/.test(runtime.coreRevision);

if (
  runtime.runtimeReady !== true ||
  !pinnedRevision ||
  runtime.appId !== "com.wcashwallet.warden.testnet" ||
  runtime.network !== "Wcash Testnet"
) {
  console.error(
    "Release packaging is blocked: pin and review an exact Wcash wallet-core commit, then update config/wcash-runtime.json.",
  );
  process.exit(1);
}
