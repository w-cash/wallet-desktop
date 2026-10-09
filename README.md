# Wcash Wallet desktop

Wcash Wallet desktop is an experimental desktop client for Wcash (WEC). It
preserves the upstream Zingo PC 2.0.25 user interface and routes wallet
operations through the Wcash core adapter.

> [!WARNING]
> The only published desktop packages are **unsigned developer Mainnet
> candidates**. They are prereleases, have not passed the release qualification
> gates, and are unsupported for material funds. They connect to the wallet
> service over plaintext HTTP, so network traffic is not authenticated or
> encrypted. A network or service attacker may be able to observe or alter data.

These packages are available for developer review and testing. Their existence
does not certify the wallet as safe, supported, or ready for production use.

## Current published candidate

The current prerelease is
[`wcash-desktop-2.0.25-181`](https://github.com/w-cash/wallet-desktop/releases/tag/wcash-desktop-2.0.25-181),
built from source commit
[`6687e56a30d5477f6e70375fda0666f966cd6118`](https://github.com/w-cash/wallet-desktop/commit/6687e56a30d5477f6e70375fda0666f966cd6118).
Its published
[`MANIFEST.json`](https://github.com/w-cash/wallet-desktop/releases/download/wcash-desktop-2.0.25-181/MANIFEST.json)
records Wcash Mainnet, the endpoint `http://mainnet.zecwec.com:48234`,
`tls: false`, and `signing: "unsigned candidate"`.

| Platform | Published package | Architecture | Install and trust limits |
| --- | --- | --- | --- |
| macOS | ZIP | Apple silicon (arm64) only | Unsigned and not notarized; no Intel build or trusted installer |
| Windows | ZIP | x64 and arm64 | Unsigned archive only; no signed installer or Microsoft Store package |
| Linux | AppImage and Debian package | x86_64/amd64 only | Unsigned; no distribution repository or detached publisher signature |

There is no supported stable desktop release. Test only on a disposable wallet
and environment, and do not rely on a candidate for recovery or access to funds.
See [SUPPORT.md](SUPPORT.md) for the current support boundary and
[SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Verify a downloaded candidate

Download the package and the release's
[`SHA256SUMS.txt`](https://github.com/w-cash/wallet-desktop/releases/download/wcash-desktop-2.0.25-181/SHA256SUMS.txt),
then compare the package SHA-256 value before opening it. For example:

```bash
shasum -a 256 Wcash-Wallet-MAINNET-UNSIGNED-2.0.25-181-mac-arm64.zip
```

On Linux, `sha256sum <filename>` provides the same type of check. Also inspect
the release's
[`SOURCE.txt`](https://github.com/w-cash/wallet-desktop/releases/download/wcash-desktop-2.0.25-181/SOURCE.txt)
and manifest, and compare their full source revision with the release tag.

SHA-256 checksums can detect a corrupted or changed download relative to the
published checksum file. Because this release has no signed checksum, manifest,
or other publisher trust root, those files do **not** authenticate the publisher
or prove that a package is safe.

## Development and Local Regtest QA

Prerequisites are Node.js 22, Yarn 1.22.22, Rust 1.91, CMake, OpenSSL, and
protoc 36.1.

```bash
git clone https://github.com/w-cash/wallet-desktop.git
cd wallet-desktop
yarn install --frozen-lockfile
yarn test:public-docs
yarn verify:upstream-ui-parity
yarn test:run
```

The Local Regtest QA packages are separate from the published Mainnet
prerelease. They connect to `http://127.0.0.1:48234`, use the isolated
`wcashregtest-v5` wallet namespace, and handle funds with no monetary value:

```bash
yarn package:local-regtest-qa:mac-arm64
yarn package:local-regtest-qa:linux-x64
yarn package:local-regtest-qa:windows-x64
yarn package:local-regtest-qa:windows-arm64
```

The native profiles are explicit Cargo features. Candidate commands use Cargo
`--locked` with a selected Wcash network feature so a package cannot silently
fall back to another network. Linux and Windows packages must be built and
tested on their target operating systems.

Production signing, macOS notarization, store packaging, and supported-release
promotion have not been completed. See
[`docs/WCASH_DESKTOP_NEXT_PLATFORMS.md`](docs/WCASH_DESKTOP_NEXT_PLATFORMS.md)
for the exact candidate matrix and remaining release gates.

## Linux package integration

The Debian candidate uses Wcash-owned system names:

- executable and PATH link: `wcash-wallet`
- install path: `/opt/Wcash Wallet/wcash-wallet`
- polkit action: `com.wcashwallet.wallet.authenticate`
- AppArmor profile: `/etc/apparmor.d/wcash-wallet`
- payment scheme: `wcash:`

The `.deb` installs the polkit and AppArmor files. The AppImage cannot install
system policy, so device authentication reports unavailable and the trusted
main process uses the tested unavailable-platform behavior.

## Upstream attribution

Wcash Wallet desktop is adapted from Zingo PC. ZingoLabs does not provide Wcash
security reporting, release support, or wallet-service operation. The upstream
project identity must not be used as the support identity for this repository.

The upstream MIT copyright and source credit remain in [`LICENSE`](LICENSE) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Keep both files with source
or binary redistributions.
