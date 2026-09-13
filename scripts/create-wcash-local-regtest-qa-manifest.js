#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  NATIVE_ATTESTATION_FILENAME,
  validateNativeAttestation,
} = require("./verify-wcash-cross-platform-candidate-after-pack");

const TARGETS = {
  "macos-arm64": {
    nativePlatform: "darwin",
    config: "config/electron-builder.local-regtest-qa.json",
    artifactPattern: /^Wcash-Wallet-LOCAL-REGTEST-QA-UNSIGNED-.+-arm64\.zip$/,
    extensions: [".zip"],
  },
  "linux-x64": {
    nativePlatform: "linux",
    config: "config/electron-builder.local-regtest-qa.linux-x64.json",
    artifactPattern: /^Wcash-Wallet-LOCAL-REGTEST-QA-UNSIGNED-.+-linux-(?:x86_64\.AppImage|amd64\.deb)$/,
    extensions: [".AppImage", ".deb"],
  },
  "windows-x64": {
    nativePlatform: "win32",
    config: "config/electron-builder.local-regtest-qa.windows-x64.json",
    artifactPattern: /^Wcash-Wallet-LOCAL-REGTEST-QA-UNSIGNED-.+-windows-x64\.zip$/,
    extensions: [".zip"],
  },
  "windows-arm64": {
    nativePlatform: "win32",
    config: "config/electron-builder.local-regtest-qa.windows-arm64.json",
    artifactPattern: /^Wcash-Wallet-LOCAL-REGTEST-QA-UNSIGNED-.+-windows-arm64\.zip$/,
    extensions: [".zip"],
  },
};

const MANIFEST_PREFIX = "Wcash-Wallet-LOCAL-REGTEST-QA-UNSIGNED";

function invariant(condition, message) {
  if (!condition) throw new Error(`Wcash Local Regtest QA manifest failed: ${message}`);
}

function sha256(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function gitValue(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function sourceTimestamp(environment) {
  const epoch = Number(environment.SOURCE_DATE_EPOCH);
  if (Number.isSafeInteger(epoch) && epoch >= 0) return new Date(epoch * 1000).toISOString();
  return new Date().toISOString();
}

function createArtifactManifest({
  target,
  directory,
  root = path.resolve(__dirname, ".."),
  environment = process.env,
}) {
  const targetPolicy = TARGETS[target];
  invariant(targetPolicy, `unsupported target ${target}`);
  const absoluteDirectory = path.resolve(directory);
  invariant(fs.existsSync(absoluteDirectory), `artifact directory does not exist: ${directory}`);
  invariant(fs.statSync(absoluteDirectory).isDirectory(), `artifact path is not a directory: ${directory}`);

  const artifactNames = fs
    .readdirSync(absoluteDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && targetPolicy.artifactPattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  invariant(artifactNames.length === targetPolicy.extensions.length, `target ${target} has the wrong artifact count`);
  for (const extension of targetPolicy.extensions) {
    invariant(
      artifactNames.some((name) => name.endsWith(extension)),
      `target ${target} is missing ${extension}`,
    );
  }

  const attestationPath = path.join(absoluteDirectory, NATIVE_ATTESTATION_FILENAME);
  invariant(fs.existsSync(attestationPath), `native runtime attestation is missing: ${NATIVE_ATTESTATION_FILENAME}`);
  const nativeAttestation = JSON.parse(fs.readFileSync(attestationPath, "utf8"));
  validateNativeAttestation(nativeAttestation, targetPolicy.nativePlatform);

  const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const candidateConfig = JSON.parse(fs.readFileSync(path.join(root, targetPolicy.config), "utf8"));
  const revision = environment.GITHUB_SHA || gitValue(root, ["rev-parse", "HEAD"]);
  invariant(revision && /^[0-9a-f]{40}$/i.test(revision), "source revision is unavailable or invalid");
  const sourceStatus = gitValue(root, ["status", "--porcelain=v1"]);
  const artifacts = artifactNames.map((name) => {
    const file = path.join(absoluteDirectory, name);
    return { name, bytes: fs.statSync(file).size, sha256: sha256(file) };
  });
  const manifestName = `${MANIFEST_PREFIX}-${target}-MANIFEST.json`;
  const checksumsName = `${MANIFEST_PREFIX}-${target}-SHA256SUMS.txt`;
  const manifestPath = path.join(absoluteDirectory, manifestName);
  const checksumsPath = path.join(absoluteDirectory, checksumsName);
  const manifest = {
    schemaVersion: 1,
    candidate: {
      product: "Wcash Wallet",
      profile: "local-regtest-qa",
      network: "Wcash Regtest",
      endpoint: "http://127.0.0.1:48234",
      signing: "unsigned",
      releaseEligible: false,
      target,
      version: packageMetadata.version,
      buildVersion: candidateConfig.buildVersion,
    },
    source: {
      repository: environment.GITHUB_REPOSITORY || "w-cash/wallet-desktop",
      revision,
      ref: environment.GITHUB_REF || gitValue(root, ["branch", "--show-current"]) || null,
      dirty: sourceStatus === null ? null : sourceStatus.length > 0,
    },
    build: {
      generatedAt: sourceTimestamp(environment),
      githubRunId: environment.GITHUB_RUN_ID || null,
      githubRunAttempt: environment.GITHUB_RUN_ATTEMPT || null,
      node: process.version,
      electron: "40.10.0",
      rust: "1.91.0",
    },
    nativeAttestation,
    artifacts,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });

  const checksumEntries = [
    ...artifacts.map(({ name, sha256: digest }) => ({ name, digest })),
    { name: NATIVE_ATTESTATION_FILENAME, digest: sha256(attestationPath) },
    { name: manifestName, digest: sha256(manifestPath) },
  ].sort((left, right) => left.name.localeCompare(right.name));
  fs.writeFileSync(checksumsPath, `${checksumEntries.map(({ name, digest }) => `${digest}  ${name}`).join("\n")}\n`, {
    mode: 0o644,
  });
  return { manifest, manifestPath, checksumsPath, attestationPath };
}

if (require.main === module) {
  const [target, directory] = process.argv.slice(2);
  if (!target || !directory || process.argv.length !== 4) {
    console.error(
      "Usage: node scripts/create-wcash-local-regtest-qa-manifest.js " +
        "<macos-arm64|linux-x64|windows-x64|windows-arm64> <artifact-directory>",
    );
    process.exit(2);
  }
  const result = createArtifactManifest({ target, directory });
  console.log(`Wrote unsigned QA manifest: ${result.manifestPath}`);
  console.log(`Wrote SHA-256 checksums: ${result.checksumsPath}`);
}

module.exports = { createArtifactManifest, sha256, TARGETS };
