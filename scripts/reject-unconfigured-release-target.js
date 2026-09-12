#!/usr/bin/env node
"use strict";

const target = process.argv[2] || "release";
console.error(
  `Wcash Wallet ${target} packaging is disabled. ` +
    "Use a reviewed package:local-regtest-qa:* candidate command. " +
    "Production publishing and signing require a separate Wcash-owned release configuration.",
);
process.exit(1);
