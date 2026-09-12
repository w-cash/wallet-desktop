# Wcash Warden Desktop

Wcash Warden is the native desktop wallet for Wcash. This repository adapts the
Zingo PC desktop shell to a Wcash-only runtime backed by the Rust Wcash wallet
core.

The current build is an engineering release for **Wcash Testnet (`TWC`)**. It is
not a Wcash mainnet release and it does not fall back to Zcash when Wcash startup
checks fail.

## Current scope

| Area                                                           | Status                     |
| -------------------------------------------------------------- | -------------------------- |
| Wcash Testnet wallet runtime                                   | Enabled                    |
| Create and restore a 24-word wallet                            | Enabled                    |
| Ironwood and transparent coinbase receivers                    | Enabled                    |
| Synchronize, display balances, send, and shield coinbase funds | Enabled                    |
| Crash-safe signed transaction recovery                         | Enabled                    |
| macOS ARM64 unsigned package                                   | Locally built and launched |
| macOS Intel, Linux x64, and Windows x64 packages               | Native CI matrix prepared  |
| Signed public desktop release                                  | Deliberately blocked       |
| Wcash mainnet                                                  | Not enabled                |

Mobile wallets are a separate milestone. Desktop correctness and native package
validation come first.

## Security model

- The Electron renderer is sandboxed and has no Node.js integration.
- The renderer receives only the narrow Wcash preload API. The inherited Zcash
  bridge and URI handlers are unavailable to the active application.
- The application uses a Wcash-specific bundle ID, executable name, storage
  namespace, Linux policy, and AppArmor profile.
- Wallet-core and node dependencies are pinned to immutable reviewed commits in
  `native/Cargo.toml` and `native/Cargo.lock`.
- Send and shield operations require an exact Wcash chain tip. The final active
  transaction check is repeated while holding the wallet writer lock.
- Signed transaction bytes remain authoritative during recovery. Warden never
  silently creates a replacement for an uncertain broadcast.
- Optional signing authentication is owner-window-bound on macOS and Windows.
  The Linux `.deb` integration uses a Wcash-specific polkit action.

## Build requirements

- Node.js 22 (Node.js 18 or newer is supported)
- Yarn 1.x
- Stable Rust with `rustfmt` and `clippy`
- CMake
- Protocol Buffers compiler
- A platform C/C++ toolchain and OpenSSL development files
- Linux: `pkg-config` and `libsecret-1-dev`

Install JavaScript dependencies without changing the lockfile:

```bash
yarn install --frozen-lockfile --network-timeout 600000
```

Build the native Rust module and production renderer:

```bash
yarn build:runtime
```

## Verification

Run the deterministic source checks:

```bash
cargo fmt --manifest-path native/Cargo.toml --all -- --check
yarn tsc --noEmit --pretty false
yarn test:run
yarn cargo:test
yarn cargo:clippy
yarn test:package:unsigned-local
```

After building the native module, the sandbox contract can be checked with:

```bash
yarn test:wcash-sandbox-preload
```

The live native smoke test connects to the configured Wcash Testnet endpoint,
creates an isolated temporary wallet, synchronizes it to an exact tip, validates
the Wcash receiver prefixes, reopens the database, and deletes the temporary
wallet when finished:

```bash
yarn neon
yarn test:wcash-live-native
```

The live smoke test does not prove a funded send or coinbase-shield transaction.
Those tests require controlled Testnet funds and are tracked separately from the
offline build gate.

## Unsigned native packages

Each package command builds on its target operating system and runs an `afterPack`
identity and native-binding check before the archive is created:

```bash
yarn package:unsigned-local:mac-arm64
yarn package:unsigned-local:mac-x64
yarn package:unsigned-local:linux
yarn package:unsigned-local:win-x64
```

Artifacts are written under `dist/unsigned-local/` and include
`UNSIGNED-LOCAL` in their names. They are for Testnet validation only. The
commands disable certificate discovery and publishing, and cannot enable the
public release path.

## Release boundary

`config/wcash-runtime.json` keeps `releaseReady` set to `false`. Do not change it
until native package testing, funded Testnet transaction testing, Wcash-specific
signing identities, update metadata, and installer review are complete.

The Wcash-only CI workflow intentionally builds unsigned packages. It does not
use the inherited Zingo signing credentials, release tags, helper binaries, or
artifact names.

## Upstream maintenance

The fork retains upstream history so security fixes can be reviewed and merged.
Wcash consensus, address, transaction, and storage boundaries remain explicit;
an upstream merge must never restore a legacy Zcash runtime fallback.

## License

See [LICENSE](LICENSE).
