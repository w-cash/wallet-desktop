# Wcash Wallet desktop candidate matrix

Wcash Wallet desktop has two distinct candidate tracks. Neither is a supported
consumer release.

## Published Mainnet developer candidate

The GitHub prerelease
[`wcash-desktop-2.0.25-181`](https://github.com/w-cash/wallet-desktop/releases/tag/wcash-desktop-2.0.25-181)
was built from commit `6687e56a30d5477f6e70375fda0666f966cd6118`.
Every package is unsigned, unsupported for material funds, and uses the
plaintext endpoint `http://mainnet.zecwec.com:48234` with TLS disabled.

| Target | Published package | Current limit |
| --- | --- | --- |
| macOS arm64 | ZIP | Unsigned and not notarized; Apple silicon only |
| Linux x86_64 | AppImage and amd64 `.deb` | Unsigned; no repository or detached publisher signature |
| Windows x64 | ZIP | Unsigned archive; no signed installer or Store package |
| Windows arm64 | ZIP | Unsigned archive; native install/runtime qualification is incomplete |
| macOS x64 / Linux arm64 / Flatpak / MSIX | none | No published candidate |

The release includes a manifest, source record, and SHA-256 checksum file.
Checksums detect changes relative to the checksum file but do not authenticate
the publisher because the release has no signed trust root.

## Local Regtest QA candidates

The manual workflow in `.github/workflows/electron.yml` builds separate,
short-lived unsigned artifacts. They connect only to
`http://127.0.0.1:48234`, use the `wcashregtest-v5` storage namespace, and
handle funds with no monetary value.

| Target | Candidate command | Current verification boundary |
| --- | --- | --- |
| macOS arm64 | `yarn package:local-regtest-qa:mac-arm64` | Built, launched, and exercised against local Wcash Regtest on Apple silicon |
| Linux x64 | `yarn package:local-regtest-qa:linux-x64` | Linux runtime and wallet flows must pass on Linux before promotion |
| Windows x64 | `yarn package:local-regtest-qa:windows-x64` | Windows runtime and wallet flows must pass on Windows before promotion |
| Windows arm64 | `yarn package:local-regtest-qa:windows-arm64` | Runtime and wallet flows must pass on native ARM64 Windows before promotion |

## Supported-release gates

Before any candidate can be called a supported release:

1. Replace the plaintext Mainnet service with authenticated TLS and verify the
   Wcash network identity without downgrade or plaintext fallback.
2. Pin and review the final Wcash wallet-core and Wolf revisions.
3. Complete create/restore, sync, receive, shield, send, history, restart,
   migration, and reorg tests on every advertised operating system.
4. Add Wcash-owned signing identities, notarization or platform signing, signed
   release metadata, provenance, and an SBOM in a separate reviewed change.
5. Test the final signed artifacts from the protected release tag on clean,
   native hosts before promotion.
