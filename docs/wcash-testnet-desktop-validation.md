# Wcash Testnet desktop validation

This record covers source commit
`e4b80b0aad0435652b198c1079482b512b47e8da` (`fix(desktop): drain wallet operations on shutdown`).

The build is an unsigned Testnet milestone. It is not a signed public release,
and the mainnet release gate remains closed.

## Locked Wcash dependencies

- Wolf: `9a9c0668784117f116d5b69bdb3a090765092343`
- wallet-core: `da048ab4dd0c29553e3db641f9092f3a0ff9b268`

## Source validation

- Rust library tests: 28 passed
- JavaScript and TypeScript tests: 59 suites and 753 tests passed
- TypeScript type check: passed
- Cargo check: passed
- Clippy with warnings denied: passed
- Rust and JavaScript formatting checks: passed
- JavaScript syntax checks: passed
- unsigned-local package identity guard: passed

The shutdown tests cover synchronous native sync cancellation registration,
generation-safe cancellation cleanup, rejection of new IPC after shutdown,
draining of accepted durable operations, cancellation of queued sync, renderer
loss, and macOS activation while a window close is draining.

## Exact artifacts

| Platform              | Artifact                                                              |       Bytes | SHA-256                                                            |
| --------------------- | --------------------------------------------------------------------- | ----------: | ------------------------------------------------------------------ |
| macOS arm64           | `Wcash Warden Testnet-UNSIGNED-LOCAL-0.1.0-alpha.0-1-arm64.zip`       | 184,790,648 | `914919150c61792c1365db5c5e6bd891802eaca133f2d8da5b3cb04cb79cc1e4` |
| macOS x64             | `Wcash Warden Testnet-UNSIGNED-LOCAL-0.1.0-alpha.0-1-x64.zip`         | 189,687,281 | `3027c6bd06cffbdb8dbcea5ddb31c3a2ada5865848592e8810c98a5547d86b49` |
| Linux x86-64 AppImage | `Wcash Warden Testnet-UNSIGNED-LOCAL-0.1.0-alpha.0-1-x86_64.AppImage` | 239,060,286 | `67293a8a552a2eccae573bd4f98c140085f8aeb9506cbad3afa40df43662ec46` |
| Linux amd64 DEB       | `wcash-warden-testnet_UNSIGNED-LOCAL_0.1.0-alpha.0-1_amd64.deb`       | 187,616,116 | `ff943b125b60dc4f4ffe0c79115465ddba599e0ca7a5fe784c7fbee9a7dcd4ea` |

The macOS application executable, Wcash native module, and credential-store
module match the declared architecture. Both packages remained running for the
launch probe and exited through a normal macOS application Quit request. Their
embedded main process was verified against freshly generated tracked source.

The Linux DEB metadata and all 86 package checksums were verified. Every ELF in
the unpacked application is x86-64 and all of its required runtime libraries
resolve. The AppImage's supported extract-and-run fallback was also exercised
because the isolated build host does not install the optional FUSE 2 library.

## Live Testnet evidence

The Linux native smoke test connected to Wcash Testnet and reported:

- network: Wcash Testnet
- ticker: TWC
- storage namespace: `wcashtestnet-v5`
- synchronized chain tip: 48
- persisted wallet reopened: true
- transaction boundary validated: true

The sandboxed preload exposed only the 17-method `window.wcash` bridge. Direct
`require`, native-module, and generic IPC access were unavailable. Both the
unpacked application and AppImage fallback remained healthy for 30-second GUI
probes under an unprivileged Linux account with an isolated Secret Service.

## Remaining release gates

- The artifacts are deliberately unsigned and named `UNSIGNED-LOCAL`.
- Windows x64 still requires a build and wallet smoke test on a real Windows
  host. Cross-building on macOS is not accepted as Windows validation.
- GitHub-hosted CI is currently unavailable to this repository, so the Windows
  matrix has not run.
- On the tested macOS 14.3 / Electron 40.10 combination, a terminal SIGTERM
  reaches the wallet shutdown gate and completes its operation drain, but the
  Electron native process can remain alive. Normal application Quit exits. A
  forced process termination can never guarantee asynchronous cleanup; the
  persisted signed-transaction recovery journal remains the safety mechanism.
- Mainnet remains disabled until the distinct mainnet network profile and a
  signed release process are separately reviewed and activated.
