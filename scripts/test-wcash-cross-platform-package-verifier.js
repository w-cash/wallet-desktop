#!/usr/bin/env node
"use strict";

const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { peArch } = require("./pe-arch");
const {
  NATIVE_ATTESTATION_FILENAME,
  assertRegtestNative,
  elfArch,
  expectedNativeMethods,
  probePackagedNative,
  validateNativeAttestation,
  writeNativeAttestation,
} = require("./verify-wcash-cross-platform-candidate-after-pack");
const { createArtifactManifest, sha256 } = require("./create-wcash-local-regtest-qa-manifest");

function fixtureAttestation(platform) {
  return {
    schemaVersion: 1,
    marker: "wcash-native-local-regtest-qa",
    platform,
    apiMethods: expectedNativeMethods(platform),
    status: {
      profile: "local-regtest",
      network: "Wcash Regtest",
      ticker: "TWC",
      endpoint: "http://127.0.0.1:48234",
      storage_namespace: "wcashregtest-v5",
      branch_id: "c3a6678a",
      wallet: null,
    },
  };
}

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

  for (const platform of ["darwin", "linux", "win32"]) {
    assert.doesNotThrow(() => validateNativeAttestation(fixtureAttestation(platform), platform));
  }
  const wrongApi = fixtureAttestation("linux");
  wrongApi.apiMethods = wrongApi.apiMethods.filter((method) => method !== "wcash_status");
  assert.throws(() => validateNativeAttestation(wrongApi, "linux"), /fixed-profile Wcash boundary/);

  const nativeFixture = path.join(temp, "native-regtest-fixture.js");
  const linuxMethods = expectedNativeMethods("linux");
  fs.writeFileSync(
    nativeFixture,
    `"use strict";\n` +
      `// http://127.0.0.1:48234 wcashregtest-v5\n` +
      `const status = ${JSON.stringify(fixtureAttestation("linux").status)};\n` +
      `for (const method of ${JSON.stringify(linuxMethods)}) exports[method] = () => undefined;\n` +
      `exports.set_wallet_base_dir = (directory) => require("path").isAbsolute(directory);\n` +
      `exports.wcash_status = async () => JSON.stringify(status);\n`,
  );
  const probed = probePackagedNative(process.execPath, nativeFixture, "linux");
  assert.deepStrictEqual(probed, fixtureAttestation("linux"));

  const manifestDirectory = path.join(temp, "candidate");
  fs.mkdirSync(manifestDirectory);
  const artifactName = "Wcash-Wallet-LOCAL-REGTEST-QA-UNSIGNED-2.0.25-180.1-arm64.zip";
  const artifactPath = path.join(manifestDirectory, artifactName);
  fs.writeFileSync(artifactPath, "unsigned macOS candidate fixture");
  writeNativeAttestation(path.join(manifestDirectory, NATIVE_ATTESTATION_FILENAME), fixtureAttestation("darwin"));
  const generated = createArtifactManifest({
    target: "macos-arm64",
    directory: manifestDirectory,
    environment: {
      GITHUB_REPOSITORY: "w-cash/wallet-desktop",
      GITHUB_REF: "refs/heads/wcash/exact-zingo-desktop",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      SOURCE_DATE_EPOCH: "0",
    },
  });
  assert.strictEqual(generated.manifest.candidate.signing, "unsigned");
  assert.strictEqual(generated.manifest.candidate.releaseEligible, false);
  assert.strictEqual(generated.manifest.source.revision, "a".repeat(40));
  assert.strictEqual(generated.manifest.build.generatedAt, "1970-01-01T00:00:00.000Z");
  assert.strictEqual(generated.manifest.artifacts[0].sha256, sha256(artifactPath));
  const checksums = fs.readFileSync(generated.checksumsPath, "utf8");
  assert.match(checksums, new RegExp(`${sha256(artifactPath)}  ${artifactName}`));
  assert.match(checksums, new RegExp(`  ${NATIVE_ATTESTATION_FILENAME}`));
  assert.match(checksums, /-MANIFEST\.json/);

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
