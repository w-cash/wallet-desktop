#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const readJson = (relativePath) => JSON.parse(read(relativePath));

function fail(message) {
  console.error(`Wcash Wallet desktop candidate boundary is blocked: ${message}`);
  process.exit(1);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

const packageJson = readJson("package.json");
const workflow = read(".github/workflows/electron.yml");
const candidateConfigs = {
  macArm64: readJson("config/electron-builder.local-regtest-qa.json"),
  linuxX64: readJson("config/electron-builder.local-regtest-qa.linux-x64.json"),
  windowsX64: readJson("config/electron-builder.local-regtest-qa.windows-x64.json"),
  windowsArm64: readJson("config/electron-builder.local-regtest-qa.windows-arm64.json"),
};
const scripts = packageJson.scripts || {};
const exactElectronVersion = read("yarn.lock").includes('electron@^40.0.0:\n  version "40.10.0"');

requireCondition(exactElectronVersion, "candidate native modules are not pinned to Electron 40.10.0");
requireCondition(
  packageJson.name === "wcash-wallet" &&
    packageJson.productName === "Wcash Wallet" &&
    packageJson.author?.name === "Wcash Wallet contributors" &&
    packageJson.author?.url === "https://github.com/w-cash/wallet-desktop" &&
    packageJson.author?.email === undefined &&
    packageJson.repository?.url === "https://github.com/w-cash/wallet-desktop.git",
  "top-level package metadata is not Wcash-owned",
);

const genericBuild = packageJson.build || {};
requireCondition(
  genericBuild.appId === "com.wcashwallet.wallet.candidate",
  "generic package ID is not candidate-scoped",
);
requireCondition(genericBuild.forceCodeSigning === false, "generic packaging can force a signature");
requireCondition(genericBuild.mac?.identity === null, "generic macOS packaging can discover an identity");
requireCondition(genericBuild.win?.signAndEditExecutable === false, "generic Windows packaging can sign executables");
requireCondition(genericBuild.mas === undefined, "Mac App Store packaging is still configured");
requireCondition(genericBuild.appx === undefined, "AppX/MSIX packaging is still configured");
requireCondition(genericBuild.afterSign === undefined, "a signing hook remains configured");
requireCondition(genericBuild.afterAllArtifactBuild === undefined, "a publishing hook remains configured");
requireCondition(genericBuild.publish === undefined, "a package publisher remains configured");
requireCondition(genericBuild.win?.azureSignOptions === undefined, "inherited Windows signing remains configured");
requireCondition(
  genericBuild.artifactName?.includes("UNSIGNED-CANDIDATE"),
  "generic artifact names do not disclose their unsigned candidate status",
);
requireCondition(
  genericBuild.linux?.executableName === "wcash-wallet" &&
    genericBuild.linux?.extraResources?.some(
      (resource) => resource.from === "resources/linux/com.wcashwallet.wallet.policy",
    ) &&
    genericBuild.linux?.extraResources?.some((resource) => resource.from === "resources/linux/wcash-wallet-uri.sh") &&
    genericBuild.linux?.extraResources?.some((resource) => resource.from === "resources/linux/apparmor/wcash-wallet"),
  "generic Linux package paths are not Wcash-owned",
);

for (const [name, config] of Object.entries(candidateConfigs)) {
  const serialized = JSON.stringify(config);
  requireCondition(config.extends === undefined, `${name} inherits another package configuration`);
  requireCondition(config.appId === "com.wcashwallet.wallet.local-regtest-qa", `${name} application ID is wrong`);
  requireCondition(config.productName === "Wcash Wallet", `${name} product name is wrong`);
  requireCondition(config.forceCodeSigning === false, `${name} can force signing`);
  requireCondition(config.npmRebuild === false, `${name} does not use the explicit target rebuild`);
  requireCondition(config.afterSign === undefined, `${name} loads a signing hook`);
  requireCondition(config.afterAllArtifactBuild === undefined, `${name} loads a publishing hook`);
  requireCondition(config.publish === undefined, `${name} loads a publisher`);
  requireCondition(config.mas === undefined && config.appx === undefined, `${name} loads a store package identity`);
  requireCondition(config.extraMetadata?.name === "wcash-wallet-local-regtest-qa", `${name} package name is wrong`);
  requireCondition(config.extraMetadata?.productName === "Wcash Wallet", `${name} visible name is wrong`);
  requireCondition(
    config.extraMetadata?.wcashPackagedProfile === "local-regtest-qa",
    `${name} profile marker is missing`,
  );
  requireCondition(config.artifactName?.includes("LOCAL-REGTEST-QA"), `${name} artifact lacks the network warning`);
  requireCondition(config.artifactName?.includes("UNSIGNED"), `${name} artifact lacks the signing warning`);
  requireCondition(!serialized.includes("protocols"), `${name} can register the wcash: handler from a local build`);
  requireCondition(
    !/(?:co\.zingo\.pc|Juan\s*Carlos|zingo-pc-signing|ZingoPC|Zingo-PC|nym-proxy)/i.test(serialized),
    `${name} contains inherited identity or transport wiring`,
  );
  requireCondition(
    config.extraResources?.some((resource) => resource.from === "LICENSE") &&
      config.extraResources?.some((resource) => resource.from === "THIRD_PARTY_NOTICES.md"),
    `${name} omits upstream legal attribution`,
  );
}

requireCondition(
  candidateConfigs.macArm64.mac?.identity === null &&
    candidateConfigs.macArm64.mac?.target?.join(" ") === "zip" &&
    candidateConfigs.macArm64.linux === undefined &&
    candidateConfigs.macArm64.win === undefined,
  "macOS candidate target boundary is wrong",
);
requireCondition(
  candidateConfigs.linuxX64.linux?.executableName === "wcash-wallet" &&
    candidateConfigs.linuxX64.linux?.target?.join(" ") === "AppImage deb" &&
    candidateConfigs.linuxX64.mac === undefined &&
    candidateConfigs.linuxX64.win === undefined &&
    candidateConfigs.linuxX64.directories?.output === "dist/local-regtest-qa/linux-x64" &&
    candidateConfigs.linuxX64.afterPack === "./scripts/verify-wcash-cross-platform-candidate-after-pack.js",
  "Linux x64 candidate target boundary is wrong",
);
for (const [name, config, output] of [
  ["Windows x64", candidateConfigs.windowsX64, "dist/local-regtest-qa/windows-x64"],
  ["Windows arm64", candidateConfigs.windowsArm64, "dist/local-regtest-qa/windows-arm64"],
]) {
  requireCondition(
    config.win?.executableName === "wcash-wallet" &&
      config.win?.signAndEditExecutable === false &&
      config.win?.target?.join(" ") === "zip" &&
      config.win?.azureSignOptions === undefined &&
      config.mac === undefined &&
      config.linux === undefined &&
      config.directories?.output === output &&
      config.afterPack === "./scripts/verify-wcash-cross-platform-candidate-after-pack.js",
    `${name} candidate target boundary is wrong`,
  );
}

const blockedScripts = [
  "release:prep",
  "dist:linux",
  "dist:linux-only-build",
  "dist:mac-arm64",
  "dist:mac-mas",
  "dist:mac-x64",
  "dist:win-arm64",
  "dist:win-x64",
  "dist:win-msix-arm64",
  "dist:win-msix-x64",
];
for (const name of blockedScripts) {
  requireCondition(
    typeof scripts[name] === "string" &&
      scripts[name].startsWith("node scripts/reject-unconfigured-release-target.js "),
    `${name} is not fail-closed`,
  );
}

const candidates = [
  {
    platform: "mac-arm64",
    native: "neon:wcash-regtest:mac-arm64",
    package: "package:local-regtest-qa:mac-arm64",
    target: "aarch64-apple-darwin",
    config: "config/electron-builder.local-regtest-qa.json",
    builder: "--mac zip --arm64",
  },
  {
    platform: "linux-x64",
    native: "neon:wcash-regtest:linux-x64",
    package: "package:local-regtest-qa:linux-x64",
    target: "x86_64-unknown-linux-gnu",
    config: "config/electron-builder.local-regtest-qa.linux-x64.json",
    builder: "--linux AppImage deb --x64",
  },
  {
    platform: "windows-x64",
    native: "neon:wcash-regtest:windows-x64",
    package: "package:local-regtest-qa:windows-x64",
    target: "x86_64-pc-windows-msvc",
    config: "config/electron-builder.local-regtest-qa.windows-x64.json",
    builder: "--win zip --x64",
  },
  {
    platform: "windows-arm64",
    native: "neon:wcash-regtest:windows-arm64",
    package: "package:local-regtest-qa:windows-arm64",
    target: "aarch64-pc-windows-msvc",
    config: "config/electron-builder.local-regtest-qa.windows-arm64.json",
    builder: "--win zip --arm64",
  },
];
for (const candidate of candidates) {
  const native = scripts[candidate.native] || "";
  for (const token of [
    "--locked",
    "--release",
    `--target ${candidate.target}`,
    "--no-default-features",
    "--features wcash-regtest",
  ]) {
    requireCondition(native.includes(token), `${candidate.platform} native command is missing ${token}`);
  }
  const packageCommand = scripts[candidate.package] || "";
  for (const token of ["yarn verify:wcash-candidate-policy", candidate.config, candidate.builder, "--publish never"]) {
    requireCondition(packageCommand.includes(token), `${candidate.platform} package command is missing ${token}`);
  }
  requireCondition(
    !/(?:stage-nym|sign-nym|azure|appx|msix)/i.test(packageCommand),
    `${candidate.platform} uses inherited release wiring`,
  );
}

const main = read("public/electron.js");
const linuxPolicy = read("resources/linux/com.wcashwallet.wallet.policy");
const linuxWrapper = read("resources/linux/wcash-wallet-uri.sh");
const appArmor = read("resources/linux/apparmor/wcash-wallet");
const postinstall = read("scripts/postinstall.sh");
const postremove = read("scripts/postremove.sh");
const flatpak = read("flatpak/com.wcashwallet.wallet.yml");
const flatpakMetadata = read("flatpak/com.wcashwallet.wallet.metainfo.xml");
const masEntitlements = read("configs/entitlements.mas.plist");
const signingEntryPoint = read("bin/signbinaries.sh");

for (const required of ["com.wcashwallet.wallet.authenticate", 'resources", "wcash-wallet-uri.sh"']) {
  requireCondition(main.includes(required), `trusted main process is missing ${required}`);
}
requireCondition(
  linuxPolicy.includes("<vendor>Wcash Wallet contributors</vendor>") &&
    linuxPolicy.includes('action id="com.wcashwallet.wallet.authenticate"'),
  "Linux authentication policy is not Wcash-owned",
);
requireCondition(
  linuxWrapper.includes('WCASH_WALLET_URI="$1"') && linuxWrapper.includes('/wcash-wallet"'),
  "Linux wcash: wrapper does not launch the Wcash executable safely",
);
requireCondition(
  appArmor.includes('profile wcash-wallet "/opt/Wcash Wallet/wcash-wallet"') &&
    postinstall.includes("/usr/share/polkit-1/actions/com.wcashwallet.wallet.policy") &&
    postinstall.includes("/usr/bin/wcash-wallet") &&
    postinstall.includes("/usr/share/applications/wcash-wallet.desktop") &&
    postremove.includes("/etc/apparmor.d/wcash-wallet"),
  "Linux installation paths are not consistently Wcash-owned",
);
requireCondition(
  flatpak.includes("app-id: com.wcashwallet.wallet") &&
    flatpak.includes("command: wcash-wallet") &&
    flatpakMetadata.includes("<id>com.wcashwallet.wallet</id>") &&
    flatpakMetadata.includes("<name>Wcash Wallet</name>"),
  "Flatpak identity is not Wcash-owned",
);
requireCondition(
  masEntitlements.includes("group.com.wcashwallet.wallet") && !masEntitlements.includes("group.co.zingo.pc"),
  "dormant MAS entitlements retain the inherited application group",
);
requireCondition(
  signingEntryPoint.includes("Wcash Wallet release signing is disabled") && signingEntryPoint.includes("exit 1"),
  "legacy release signing entry point is not fail-closed",
);

for (const removed of [
  "afterMasSign.js",
  "afterSignHook.js",
  "scripts/sign-nym-proxy.ps1",
  "scripts/stage-nym-proxy.js",
  "scripts/generate-appx-assets.ps1",
  "resources/linux/co.zingo.pc.policy",
  "resources/linux/zingo-pc-uri.sh",
  "resources/linux/apparmor/zingo-pc",
  "flatpak/co.zingo.pc.yml",
  "flatpak/co.zingo.pc.metainfo.xml",
  "flatpak/zingo-pc-wrapper.sh",
]) {
  requireCondition(!fs.existsSync(path.join(root, removed)), `${removed} still exists`);
}
requireCondition(!fs.existsSync(path.join(root, "public", "appx")), "inherited AppX tile assets still exist");

const boundarySources = [
  "package.json",
  "public/electron.js",
  ".github/workflows/electron.yml",
  "config/electron-builder.local-regtest-qa.linux-x64.json",
  "config/electron-builder.local-regtest-qa.windows-x64.json",
  "config/electron-builder.local-regtest-qa.windows-arm64.json",
  "resources/linux/com.wcashwallet.wallet.policy",
  "resources/linux/wcash-wallet-uri.sh",
  "resources/linux/apparmor/wcash-wallet",
  "scripts/postinstall.sh",
  "scripts/postremove.sh",
  "flatpak/com.wcashwallet.wallet.yml",
  "flatpak/com.wcashwallet.wallet.metainfo.xml",
  "flatpak/wcash-wallet-wrapper.sh",
  "configs/entitlements.mas.plist",
  "configs/SIGNATURES_README",
  "bin/signbinaries.sh",
  "docs/windows-signing.md",
  "docs/windows-msix.md",
]
  .map(read)
  .join("\n");
for (const forbidden of [
  /co\.zingo\.pc/i,
  /Juan\s*Carlos\s*Carmona/i,
  /zingo-pc-signing/i,
  /JuanCarlosCarmonaCalvo/i,
  /ZingoPC/i,
  /\/opt\/Zingo PC/i,
  /\/usr\/bin\/zingo-pc/i,
]) {
  requireCondition(!forbidden.test(boundarySources), `platform boundary retains inherited identity: ${forbidden}`);
}

requireCondition(/^\s*workflow_dispatch:\s*$/m.test(workflow), "candidate workflow is not manually dispatched");
requireCondition(
  !/^\s*(?:push|pull_request|schedule):\s*$/m.test(workflow),
  "candidate workflow has an automatic trigger",
);
requireCondition(/^permissions:\s*\n\s+contents:\s+read\s*$/m.test(workflow), "workflow permission is not read-only");
for (const required of [
  "runs-on: macos-14",
  "runs-on: ubuntu-24.04",
  "runner: windows-latest",
  "runner: windows-11-vs2026-arm",
  "yarn package:local-regtest-qa:mac-arm64",
  "yarn package:local-regtest-qa:linux-x64",
  "package:local-regtest-qa:windows-x64",
  "package:local-regtest-qa:windows-arm64",
  "wcash-wallet-local-regtest-qa-macos-arm64-unsigned",
  "wcash-wallet-local-regtest-qa-linux-x64-unsigned",
  "wcash-wallet-local-regtest-qa-windows-${{ matrix.electron_arch }}-unsigned",
]) {
  requireCondition(workflow.includes(required), `workflow is missing ${required}`);
}
for (const forbidden of [
  /contents:\s*write/i,
  /secrets\./i,
  /(?:create|publish)[-_ ]release/i,
  /(?:stage|sign)[-_ ]nym/i,
  /(?:azureSign|TrustedSigning|notarize|provisioningProfile)/i,
  /zingo-pc/i,
  /zingolabs/i,
]) {
  requireCondition(!forbidden.test(workflow), `workflow contains release or inherited wiring: ${forbidden}`);
}

console.log(
  "Wcash Wallet desktop candidate package boundary passed for macOS arm64, Linux x64, Windows x64, and Windows arm64.",
);
