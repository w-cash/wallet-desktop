"use strict";

const runtime = require("../config/wcash-runtime.json");

if (runtime.releaseReady !== true) {
  console.error(
    "Release packaging is blocked: platform identity, signing, update, and installer metadata are not yet approved for Wcash.",
  );
  process.exit(1);
}
