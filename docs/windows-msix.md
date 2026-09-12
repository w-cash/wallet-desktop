# Windows Store package status

MSIX/AppX packaging is disabled for Wcash Wallet. The inherited store identity
was removed, and the legacy `dist:win-msix-*` commands stop with an error.

Partner Center identities are publisher-owned values. No placeholder identity
is safe for a wallet package, and an unsigned package cannot be treated as a
release. Add MSIX only after Wcash controls a Partner Center listing and its
exact application ID, identity name, publisher, display name, assets, URI
registration, and target-host test plan have been reviewed together.

The current manual workflow produces unsigned ZIP candidates for Local Regtest
only. It does not submit to Partner Center or create a GitHub release.
