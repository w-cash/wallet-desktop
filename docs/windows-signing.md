# Windows release signing status

Wcash Wallet has no production Windows signing owner or credential configured in
this repository. The manual x64 and arm64 workflows build ZIP files whose names
include `LOCAL-REGTEST-QA` and `UNSIGNED`; they never read secrets and never
publish a release.

The package boundary sets `signAndEditExecutable: false` and rejects Azure,
certificate-subject, certificate-thumbprint, AppX, and MSIX settings. A future
release must add a Wcash-owned publisher identity in a separate reviewed change.
It must also test the signed result on clean x64 and arm64 Windows hosts before
publishing.

The candidate build still stages the matching Microsoft Visual C++ runtime next
to `wcash-wallet.exe`, because the Rust and keytar native bindings require it on
clean machines. `scripts/check-win-arch.js` verifies the executable, native
bindings, and staged runtime all match the requested architecture.
