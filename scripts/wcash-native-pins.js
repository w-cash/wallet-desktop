"use strict";

const fs = require("fs");
const path = require("path");

const WALLET_CORE_REPOSITORY = "https://github.com/w-cash/wallet-core.git";
const WOLF_REPOSITORY = "https://github.com/w-cash/wolf.git";
const REVISION = /^[0-9a-f]{40}$/u;

function structuralTomlLines(source) {
  let multilineDelimiter;

  return source.split(/\r?\n/u).map((line) => {
    const structural = multilineDelimiter === undefined;
    let quote;

    for (let index = 0; index < line.length; index += 1) {
      if (multilineDelimiter !== undefined) {
        if (!line.startsWith(multilineDelimiter, index)) continue;
        if (multilineDelimiter === '\"\"\"') {
          let precedingBackslashes = 0;
          for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) {
            precedingBackslashes += 1;
          }
          if (precedingBackslashes % 2 === 1) continue;
        }
        index += multilineDelimiter.length - 1;
        multilineDelimiter = undefined;
        continue;
      }

      if (quote !== undefined) {
        if (line[index] === quote && (quote === "'" || line[index - 1] !== "\\")) quote = undefined;
        continue;
      }
      if (line[index] === "#") break;
      if (line.startsWith('\"\"\"', index) || line.startsWith("'''", index)) {
        multilineDelimiter = line.slice(index, index + 3);
        index += 2;
        continue;
      }
      if (line[index] === '\"' || line[index] === "'") quote = line[index];
    }

    return structural ? line : undefined;
  });
}

function dependencyLine(manifest, name) {
  let inDependencies = false;
  for (const line of structuralTomlLines(manifest)) {
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inDependencies = /^\[dependencies\](?:\s*#.*)?$/u.test(trimmed);
      continue;
    }
    if (inDependencies && line.startsWith(`${name} = {`)) return line;
  }
  return undefined;
}

function packageSources(lockfile, name) {
  const packages = [];
  let currentPackage;
  for (const line of structuralTomlLines(lockfile)) {
    if (line === undefined) continue;
    if (line === "[[package]]") {
      currentPackage = { name: undefined, source: undefined };
      packages.push(currentPackage);
      continue;
    }
    if (line.trimStart().startsWith("[")) {
      currentPackage = undefined;
      continue;
    }
    if (currentPackage === undefined) continue;
    const packageName = line.match(/^name = "([^"]+)"$/u);
    const packageSource = line.match(/^source = "([^"]+)"$/u);
    if (packageName) currentPackage.name = packageName[1];
    if (packageSource) currentPackage.source = packageSource[1];
  }
  return packages.filter((entry) => entry.name === name).map((entry) => entry.source ?? null);
}

function nativeDependencyPinsMatch({ root, coreRevision, wolfRevision }) {
  if (
    typeof root !== "string" ||
    !path.isAbsolute(root) ||
    !REVISION.test(coreRevision) ||
    !REVISION.test(wolfRevision)
  ) {
    return false;
  }

  const manifest = fs.readFileSync(path.join(root, "native", "Cargo.toml"), "utf8");
  const lockfile = fs.readFileSync(path.join(root, "native", "Cargo.lock"), "utf8");
  const coreDependency = dependencyLine(manifest, "zingolib");
  const wolfDependency = dependencyLine(manifest, "wcash-wallet");
  const expectedCoreDependency = `zingolib = { git = "${WALLET_CORE_REPOSITORY}", rev = "${coreRevision}", optional = true }`;
  const expectedWolfDependency = `wcash-wallet = { git = "${WOLF_REPOSITORY}", rev = "${wolfRevision}" }`;
  const expectedCoreSource = `git+${WALLET_CORE_REPOSITORY}?rev=${coreRevision}#${coreRevision}`;
  const expectedWolfSource = `git+${WOLF_REPOSITORY}?rev=${wolfRevision}#${wolfRevision}`;

  return (
    coreDependency === expectedCoreDependency &&
    wolfDependency === expectedWolfDependency &&
    JSON.stringify(packageSources(lockfile, "zingolib")) === JSON.stringify([expectedCoreSource]) &&
    JSON.stringify(packageSources(lockfile, "wcash-wallet")) === JSON.stringify([expectedWolfSource])
  );
}

module.exports = { nativeDependencyPinsMatch };
