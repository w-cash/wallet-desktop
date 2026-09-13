# Wcash Wallet desktop QA CI

`.github/workflows/electron.yml` is the reusable build boundary for desktop
Local Regtest QA candidates. It may be started manually with
`workflow_dispatch` or called from another workflow with `workflow_call`.
It never publishes a release, has only `contents: read`, and receives no signing
or store credentials.

The workflow preserves the reviewed upstream Zingo UI. Its jobs exercise only
packaging, platform integration, and the fixed Wcash Regtest native boundary.

## Candidate matrix

| Target        | Native runner                 | Unsigned QA artifact |
| ------------- | ----------------------------- | -------------------- |
| macOS arm64   | `macos-26` arm64              | ZIP                  |
| Linux x64     | `ubuntu-24.04` x64            | AppImage and DEB     |
| Windows x64   | `windows-2025` x64            | ZIP                  |
| Windows arm64 | `windows-11-vs2026-arm` arm64 | ZIP                  |

Each job installs Rust 1.91.0, Node.js 22, Yarn 1.22.22, and protoc 36.1,
installs the locked JavaScript dependencies, runs the desktop candidate policy,
and builds with Cargo `--locked`. Native modules are compiled and rebuilt for
Electron 40.10.0 on the same architecture that executes their verification.

## Native runtime proof

The package check does more than inspect binary strings. It starts the packaged
Electron executable with `ELECTRON_RUN_AS_NODE=1`, requires the staged
`native.node`, and checks its complete exported API. It then creates a temporary
empty wallet directory and calls the offline `wcash_status` operation. The
returned profile must say:

- profile `local-regtest`
- network `Wcash Regtest`
- ticker `TWC`
- endpoint `http://127.0.0.1:48234`
- storage namespace `wcashregtest-v5`
- branch ID `c3a6678a`
- no existing wallet

The temporary directory is deleted before the check exits. This probe does not
create a wallet, contact a server, handle keys, or broadcast a transaction.

Every uploaded artifact set contains
`WCASH-NATIVE-LOCAL-REGTEST-QA-ATTESTATION.json`, a candidate manifest, and a
`SHA256SUMS.txt` file. The manifest identifies the source revision, toolchain,
target, native attestation, and hashes of the platform artifacts. It explicitly
sets `signing` to `unsigned` and `releaseEligible` to `false`. GitHub retains the
artifact set for 14 days.

## Reuse from a reviewed workflow

Call the workflow by an immutable reviewed commit:

```yaml
jobs:
  desktop-local-regtest-qa:
    uses: w-cash/wallet-desktop/.github/workflows/electron.yml@<reviewed-commit-sha>
```

All third-party actions inside the workflow are pinned to immutable commits.
Their reviewed release tags are recorded in the step names and beside each
`uses` entry. `yarn verify:wcash-candidate-policy` rejects a moving action ref,
write permission, secret reference, signing hook, store identity, or publishing
step.

## Release boundary

These artifacts are useful for installation and target-host QA, but they are
not production releases. A complete Linux or Windows readiness claim still
requires create/restore, sync, receive, send, history, and restart testing
against a Wcash Regtest service reachable from that operating system. Public
Testnet and Mainnet builds also require separately reviewed endpoint/network
profiles, Wcash-owned signing identities, and release publishing configuration.
The existing production and store commands remain fail-closed until that work
is reviewed.
