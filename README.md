# Wcash Wallet desktop

Wcash Wallet desktop preserves the upstream Zingo PC 2.0.25 user interface and
routes wallet operations through the reviewed Wcash core adapter. Visible
product branding is Wcash Wallet. The upstream MIT copyright and source credit
remain in `LICENSE` and `THIRD_PARTY_NOTICES.md`.

The current distributable is for **Local Regtest QA only**. It connects to
`http://127.0.0.1:48234`, uses the isolated `wcashregtest-v5` wallet namespace,
and handles funds with no monetary value. It is not a Mainnet or Testnet release.

## Development

Prerequisites are Node.js 22, Yarn 1, Rust 1.91, CMake, OpenSSL, and protoc 36.1.

```bash
git clone https://github.com/w-cash/wallet-desktop.git
cd wallet-desktop
yarn install --frozen-lockfile
yarn verify:upstream-ui-parity
yarn test:run
```

The native Wcash profiles are explicit Cargo features. Candidate builds use
`--locked --no-default-features --features wcash-regtest` so a local package
cannot silently fall back to another network.

## Unsigned candidate packages

The following commands are review candidates. Artifact names visibly contain
`LOCAL-REGTEST-QA` and `UNSIGNED`.

```bash
yarn package:local-regtest-qa:mac-arm64
yarn package:local-regtest-qa:linux-x64
yarn package:local-regtest-qa:windows-x64
yarn package:local-regtest-qa:windows-arm64
```

Each package command checks the immutable Wcash profile, target architecture,
credential-store native binding, exact upstream UI parity, app identity, and the
absence of inherited release signing. Linux and Windows must be built and tested
on their target operating systems; the manual workflow in
`.github/workflows/electron.yml` supplies those build hosts.

Production distribution commands, macOS App Store packaging, Microsoft Store
packaging, signing, notarization, and release publishing are intentionally
disabled. See `docs/WCASH_DESKTOP_NEXT_PLATFORMS.md` for the promotion gates.

## Linux package integration

The Debian candidate uses only Wcash-owned system names:

- executable and PATH link: `wcash-wallet`
- install path: `/opt/Wcash Wallet/wcash-wallet`
- polkit action: `com.wcashwallet.wallet.authenticate`
- AppArmor profile: `/etc/apparmor.d/wcash-wallet`
- payment scheme for a future non-local package: `wcash:`

The Local Regtest candidate does not register the payment scheme. Its `.deb`
installs the polkit and AppArmor files; the AppImage cannot install system policy,
so device authentication reports unavailable and the trusted main process uses
the tested unavailable-platform behavior.

## Security and attribution

Sensitive seed export and transaction confirmation are authenticated in the
trusted Electron main process whenever the operating system authenticator is
available. The renderer cannot bypass that policy. Wallet deletion completes in
the native backend before renderer metadata is removed.

This adaptation keeps upstream legal attribution intact. Refer to `LICENSE` and
`THIRD_PARTY_NOTICES.md` when redistributing source or candidates.
