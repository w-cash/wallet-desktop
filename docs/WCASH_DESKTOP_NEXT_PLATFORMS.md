# Wcash Wallet desktop platform sequence

The current candidate is an **unsigned macOS arm64 Local Regtest QA build**. It
is not a Mainnet/Testnet release, and this repository does not currently publish
Linux, Windows, Intel macOS, or Mac App Store artifacts.

Linux and Windows are a separate next phase after the exact Zingo desktop UI and
Wcash core adapter pass the Testnet integration suite. For each platform:

1. Build the same reviewed Wcash core revisions recorded in `native/Cargo.toml`
   and `native/Cargo.lock` with `--locked`.
2. Run wallet create/restore, sync, receive, shield, send, history, deletion, and
   device-authentication tests on the target operating system.
3. Add platform-specific package identity and signing only after those runtime
   checks pass and the signing identity has been approved.
4. Add a platform candidate workflow that uploads an artifact for review without
   creating a public release.

The inherited Zingo multi-platform release workflow is intentionally disabled;
it must not be restored for Wcash artifacts.
