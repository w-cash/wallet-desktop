"use strict";

const base = require("../package.json").build;

module.exports = {
  ...base,
  appId: "com.wcashwallet.wallet.mainnet",
  buildVersion: "181",
  artifactName: "Wcash-Wallet-MAINNET-UNSIGNED-${version}-${buildVersion}-${os}-${arch}.${ext}",
  forceCodeSigning: false,
  afterPack: "./scripts/verify-wcash-mainnet-candidate-after-pack.js",
  extraMetadata: {
    main: "build/electron.js",
    wcashPackagedProfile: "mainnet",
  },
  directories: {
    ...base.directories,
    output: "dist/mainnet-candidate",
  },
  deb: {
    ...base.deb,
    artifactName: "Wcash-Wallet-MAINNET-UNSIGNED-${version}-${buildVersion}-linux-${arch}.${ext}",
  },
};
