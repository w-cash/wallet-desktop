#!/usr/bin/env node
"use strict";

const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { peArch } = require("./pe-arch");
const { assertRegtestNative, elfArch } = require("./verify-wcash-cross-platform-candidate-after-pack");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wcash-package-verifier-"));
try {
  for (const [machine, expected] of [
    [62, "x64"],
    [183, "arm64"],
  ]) {
    const file = path.join(temp, `fixture-${expected}.elf`);
    const bytes = Buffer.alloc(64);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(bytes);
    bytes[4] = 2;
    bytes[5] = 1;
    bytes.writeUInt16LE(machine, 18);
    fs.writeFileSync(file, bytes);
    assert.strictEqual(elfArch(file), expected);
  }

  for (const [machine, expected] of [
    [0x8664, "x64"],
    [0xaa64, "arm64"],
  ]) {
    const file = path.join(temp, `fixture-${expected}.exe`);
    const bytes = Buffer.alloc(128);
    bytes.writeUInt32LE(64, 0x3c);
    Buffer.from("PE\0\0").copy(bytes, 64);
    bytes.writeUInt16LE(machine, 68);
    fs.writeFileSync(file, bytes);
    assert.strictEqual(peArch(file), expected);
  }

  const regtest = path.join(temp, "native-regtest.node");
  fs.writeFileSync(regtest, "http://127.0.0.1:48234\0wcashregtest-v5\0");
  assert.doesNotThrow(() => assertRegtestNative(regtest));

  const contaminated = path.join(temp, "native-contaminated.node");
  fs.writeFileSync(
    contaminated,
    "http://127.0.0.1:48234\0wcashregtest-v5\0https://wallet-testnet.wcashexplorer.com:443\0",
  );
  assert.throws(() => assertRegtestNative(contaminated), /Testnet endpoint/);

  const reject = spawnSync(process.execPath, [
    path.join(__dirname, "reject-unconfigured-release-target.js"),
    "windows-release",
  ]);
  assert.strictEqual(reject.status, 1);
  assert.match(reject.stderr.toString(), /packaging is disabled/);

  const legacySigner = spawnSync("bash", [path.join(__dirname, "..", "bin", "signbinaries.sh")]);
  assert.strictEqual(legacySigner.status, 1);
  assert.match(legacySigner.stderr.toString(), /release signing is disabled/);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("Wcash cross-platform staged-package verifier tests passed");
