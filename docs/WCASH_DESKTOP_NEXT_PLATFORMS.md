# Wcash Wallet desktop candidate matrix

All current desktop artifacts are **unsigned Local Regtest QA candidates**.
Their fixed endpoint is `http://127.0.0.1:48234`; Regtest funds have no monetary
value. The production release and store commands remain disabled.

| Target                                     | Candidate command                             | Current verification boundary                                                                                    |
| ------------------------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| macOS arm64                                | `yarn package:local-regtest-qa:mac-arm64`     | Built, launched, and exercised against local Wcash Regtest on Apple Silicon                                      |
| Linux x64                                  | `yarn package:local-regtest-qa:linux-x64`     | Manual read-only CI package job; Linux runtime and wallet flow must pass on Linux before release                 |
| Windows x64                                | `yarn package:local-regtest-qa:windows-x64`   | Manual read-only CI package job; Windows runtime and wallet flow must pass on Windows before release             |
| Windows arm64                              | `yarn package:local-regtest-qa:windows-arm64` | Manual read-only CI package job on a native ARM64 runner; runtime and wallet flow must pass there before release |
| macOS x64 / Mac App Store / Flatpak / MSIX | disabled                                      | Requires a separately reviewed Wcash-owned package and signing identity                                          |

The Linux and Windows jobs compile the same `wcash-regtest` native feature with
Cargo `--locked`, rebuild `keytar` for the target Electron ABI, validate staged
binary architecture and package metadata, and upload short-lived artifacts.
They have `contents: read`, use no repository secrets, and contain no release
publishing step.

Before any public Testnet or Mainnet artifact:

1. Pin the final reviewed Wcash wallet-core and wolf commits in
   `native/Cargo.toml` and `native/Cargo.lock`.
2. Run create/restore, sync, receive, shield, send, history, deletion, and
   device-authentication tests on the target operating system.
3. Add and review Wcash-owned signing and store identities in a separate change.
4. Build new artifacts whose names no longer say `LOCAL-REGTEST-QA` or
   `UNSIGNED`, and publish only after those artifacts pass target-host tests.
