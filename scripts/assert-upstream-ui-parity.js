"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "config", "upstream-ui-parity.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const allowedExtensions = new Set(manifest.protected.extensions);
const excluded = new Set(manifest.protected.excludedPaths);

const toPosix = (value) => value.split(path.sep).join("/");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function visit(relativePath, output) {
  const absolutePath = path.join(root, relativePath);
  const stat = fs.statSync(absolutePath);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolutePath).sort()) {
      visit(toPosix(path.join(relativePath, name)), output);
    }
    return;
  }

  if (!allowedExtensions.has(path.extname(relativePath))) return;
  if (/\.(?:test|spec)\.[^.]+$/.test(relativePath) || relativePath.includes("/__mocks__/")) return;
  if (excluded.has(relativePath)) return;
  output.push(relativePath);
}

const protectedFiles = [];
for (const protectedRoot of manifest.protected.roots) visit(protectedRoot, protectedFiles);
protectedFiles.sort();

const aggregate = crypto.createHash("sha256");
for (const relativePath of protectedFiles) {
  aggregate.update(relativePath);
  aggregate.update("\0");
  aggregate.update(fs.readFileSync(path.join(root, relativePath)));
  aggregate.update("\0");
}

const failures = [];
if (protectedFiles.length !== manifest.protected.fileCount) {
  failures.push(`protected file count ${protectedFiles.length} != ${manifest.protected.fileCount}`);
}
const protectedDigest = aggregate.digest("hex");
if (protectedDigest !== manifest.protected.sha256) {
  failures.push(`protected UI digest ${protectedDigest} != ${manifest.protected.sha256}`);
}

for (const [relativePath, expected] of Object.entries(manifest.approvedBrandingFiles)) {
  const absolutePath = path.join(root, relativePath);
  const actual = fs.existsSync(absolutePath) ? sha256(fs.readFileSync(absolutePath)) : "missing";
  if (actual !== expected) failures.push(`${relativePath}: ${actual} != ${expected}`);
}

for (const [relativePath, expected] of Object.entries(manifest.approvedProtocolFiles || {})) {
  const absolutePath = path.join(root, relativePath);
  const actual = fs.existsSync(absolutePath) ? sha256(fs.readFileSync(absolutePath)) : "missing";
  if (actual !== expected) failures.push(`${relativePath}: ${actual} != ${expected}`);
}

for (const [relativePath, expected] of Object.entries(manifest.approvedLayoutFiles || {})) {
  const absolutePath = path.join(root, relativePath);
  const actual = fs.existsSync(absolutePath) ? sha256(fs.readFileSync(absolutePath)) : "missing";
  if (actual !== expected) failures.push(`${relativePath}: ${actual} != ${expected}`);
}

for (const forbiddenPath of manifest.forbiddenPaths) {
  if (fs.existsSync(path.join(root, forbiddenPath))) failures.push(`${forbiddenPath} must not exist`);
}

if (failures.length > 0) {
  console.error(`Exact Zingo UI parity failed (${manifest.baseline.tag} / ${manifest.baseline.commit}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Exact Zingo UI parity passed: ${protectedFiles.length} protected files, ` +
    `${Object.keys(manifest.approvedBrandingFiles).length} branding files, ` +
    `${Object.keys(manifest.approvedProtocolFiles || {}).length} protocol files, ` +
    `${Object.keys(manifest.approvedLayoutFiles || {}).length} accessibility layout files.`,
);
