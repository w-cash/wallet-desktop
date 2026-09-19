"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const directory = path.resolve(__dirname, "../dist/mainnet-candidate");
const sourceSha = process.env.GITHUB_SHA || require("child_process").execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const files = fs.readdirSync(directory)
  .filter((name) => /\.(zip|AppImage|deb)$/.test(name) && fs.statSync(path.join(directory, name)).isFile())
  .sort();

if (files.length === 0 || !/^[a-f0-9]{40}$/.test(sourceSha)) {
  throw new Error("A Mainnet candidate artifact and full source revision are required");
}

const artifacts = files.map((name) => {
  const bytes = fs.readFileSync(path.join(directory, name));
  return { name, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
});
const manifest = {
  product: "Wcash Wallet",
  network: "Wcash Mainnet",
  sourceSha,
  endpoint: "http://mainnet.zecwec.com:48234",
  genesis: "5bae12c8662a577b04ce1591af1a137c128f0cb51018a5f1622d861d1bb6fc48",
  branchId: "d9c6a7ee",
  tls: false,
  signing: "unsigned candidate",
  artifacts,
};
fs.writeFileSync(path.join(directory, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(directory, "SHA256SUMS.txt"), artifacts.map(({ name, sha256 }) => `${sha256}  ${name}\n`).join(""));
