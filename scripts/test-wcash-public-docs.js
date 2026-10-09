"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const documents = [
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/WCASH_DESKTOP_NEXT_PLATFORMS.md",
  "docs/WCASH_DESKTOP_QA_CI.md",
  "docs/windows-msix.md",
  "docs/windows-signing.md",
];
const failures = [];

const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const requireText = (name, text) => {
  const normalized = (value) => value.replace(/\s+/g, " ").trim();
  if (!normalized(read(name)).includes(normalized(text))) {
    failures.push(`${name} must include: ${text}`);
  }
};

for (const name of documents) {
  const contents = read(name);
  const links = contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
  for (const [, target] of links) {
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const file = target.split("#", 1)[0];
    if (!fs.existsSync(path.resolve(root, path.dirname(name), file))) {
      failures.push(`${name} has a missing local link: ${target}`);
    }
  }
}

for (const name of ["README.md", "SECURITY.md", "SUPPORT.md"]) {
  requireText(name, "unsupported for material funds");
}

requireText("README.md", "wcash-desktop-2.0.25-181");
requireText("README.md", "6687e56a30d5477f6e70375fda0666f966cd6118");
requireText("README.md", "http://mainnet.zecwec.com:48234");
requireText("README.md", "do **not** authenticate the publisher");
requireText(
  "SECURITY.md",
  "https://github.com/w-cash/wallet-desktop/security/advisories/new",
);
requireText("SECURITY.md", "must enable and verify Private Vulnerability Reporting");

const inheritedContact = /zingodisclosure|@proton\.me/i;
for (const name of ["README.md", "SECURITY.md", "SUPPORT.md"]) {
  if (inheritedContact.test(read(name))) {
    failures.push(`${name} contains an inherited upstream security contact`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Verified ${documents.length} Wcash public documentation files.`);
