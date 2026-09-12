"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const keytarSource = path.join(root, "node_modules", "keytar");
const output = path.join(keytarSource, "build", "Release", "keytar.node");
const allowedPlatforms = new Set(["darwin", "linux", "win32"]);
const allowedArchitectures = new Set(["x64", "arm64"]);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const platform = argument("--platform");
const arch = argument("--arch");

if (!allowedPlatforms.has(platform) || !allowedArchitectures.has(arch)) {
  console.error("stage-keytar-native: pass --platform darwin|linux|win32 and --arch x64|arm64");
  process.exit(1);
}
if (platform !== process.platform) {
  console.error("stage-keytar-native: credential-store bindings must be staged on the target operating system");
  process.exit(1);
}
if (!fs.existsSync(path.join(keytarSource, "package.json"))) {
  console.error("stage-keytar-native: node_modules/keytar is missing; run yarn install first");
  process.exit(1);
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wcash-keytar-"));
const temporaryModule = path.join(temporaryRoot, "keytar");

try {
  fs.cpSync(keytarSource, temporaryModule, { recursive: true });
  fs.rmSync(path.join(temporaryModule, "build"), { recursive: true, force: true });

  const installer = require.resolve("prebuild-install/bin.js");
  const result = spawnSync(
    process.execPath,
    [installer, "--runtime=napi", "--target=3", "--platform=" + platform, "--arch=" + arch],
    {
      cwd: temporaryModule,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "prebuilt binding installation failed").trim());
  }

  const staged = path.join(temporaryModule, "build", "Release", "keytar.node");
  if (!fs.existsSync(staged) || fs.statSync(staged).size === 0) {
    throw new Error("prebuilt credential-store binding is missing or empty");
  }
  const binary = fs.readFileSync(staged);
  let actualArch = null;
  if (platform === "darwin" && binary.length >= 8 && binary.readUInt32LE(0) === 0xfeedfacf) {
    actualArch = { 0x01000007: "x64", 0x0100000c: "arm64" }[binary.readUInt32LE(4)] || null;
  } else if (
    platform === "linux" &&
    binary.length >= 20 &&
    binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  ) {
    actualArch = { 0x3e: "x64", 0xb7: "arm64" }[binary.readUInt16LE(18)] || null;
  } else if (platform === "win32") {
    actualArch = require("./pe-arch").peArch(staged);
  }
  if (actualArch !== arch) {
    throw new Error("downloaded " + String(actualArch) + " binding, expected " + arch);
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(staged, output);
  console.log("stage-keytar-native: staged " + platform + "/" + arch + " credential-store binding");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
