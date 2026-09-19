"use strict";

const fs = require("fs");
const path = require("path");
const asar = require("@electron/asar");

function findResources(directory) {
  const archive = path.join(directory, "app.asar");
  if (fs.existsSync(archive)) return directory;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = findResources(path.join(directory, entry.name));
    if (nested) return nested;
  }
  return null;
}

module.exports = async (context) => {
  const config = context.packager.config;
  const resources = findResources(context.appOutDir);
  if (!resources || context.packager.appInfo.id !== "com.wcashwallet.wallet.mainnet" || config.forceCodeSigning !== false) {
    throw new Error("Wcash Mainnet candidate identity is invalid");
  }
  const metadata = JSON.parse(asar.extractFile(path.join(resources, "app.asar"), "package.json").toString());
  if (metadata.wcashPackagedProfile !== "mainnet" || metadata.main !== "build/electron.js") {
    throw new Error("The packaged wallet does not select Wcash Mainnet");
  }
  const profile = asar.extractFile(path.join(resources, "app.asar"), "build/wcashRuntimeProfile.js").toString();
  if (!profile.includes("http://mainnet.zecwec.com:48234") || !profile.includes("d9c6a7ee")) {
    throw new Error("The packaged Mainnet endpoint or branch ID differs from the reviewed profile");
  }
  const binding = path.join(resources, "app.asar.unpacked", "build", "native.node");
  if (!fs.existsSync(binding) || !fs.readFileSync(binding).includes(Buffer.from("wcashmainnet-v1"))) {
    throw new Error("The packaged native binding lacks the Mainnet wallet profile");
  }
};
