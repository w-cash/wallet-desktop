# Wcash Wallet desktop security policy

## Release and support status

Wcash Wallet desktop has no supported stable release. The published
`wcash-desktop-2.0.25-181` packages are unsigned developer Mainnet candidates,
are unsupported for material funds, and connect to the wallet service over
plaintext HTTP. They have not completed the transport, signing, platform, or
wallet qualification gates required for a supported release.

Security fixes may be developed on the active branch, but no candidate version
has a promised security-support lifetime or response service-level agreement.

## Report a vulnerability privately

Do not disclose an unpatched vulnerability in a public issue. Use this
repository's GitHub Private Vulnerability Reporting page:

<https://github.com/w-cash/wallet-desktop/security/advisories/new>

Repository owners must enable and verify Private Vulnerability Reporting in the
GitHub security settings so this route accepts reports. Until that is verified,
the project does not publish a private Wcash security contact. Do not send Wcash
reports to an inherited upstream address.

Include the affected source revision or candidate tag, operating system and
architecture, impact, reproduction steps, and a minimal proof of concept when
it is safe to provide one. Remove seed phrases, spending keys, personal wallet
data, and live credentials from reports.

## Scope

Relevant reports include:

- seed phrase, spending key, or wallet-data exposure;
- unauthorized transaction construction, signing, or broadcast;
- network, endpoint-identity, or cross-network validation failures;
- Electron main-process, renderer, IPC, or navigation boundary bypasses;
- operating-system authentication or credential-store bypasses; and
- package, dependency, update, or release-integrity failures.

Availability problems, support requests, and candidate-installation questions
belong in the public support route described in [SUPPORT.md](SUPPORT.md), unless
they reveal a security vulnerability.

## Upstream code

This repository contains code adapted from Zingo PC, documented in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). ZingoLabs' disclosure contacts,
response promises, and supported-version statements do not apply to Wcash
Wallet desktop. If a report concerns unchanged upstream code, report it here
first so the Wcash impact can be assessed and coordinated responsibly.
