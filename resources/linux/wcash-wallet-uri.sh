#!/bin/bash
# Protocol handler wrapper for wcash: URIs.
# Packaged Electron treats positional arguments as an app module in defaultApp
# mode, so the URI crosses the trusted main-process boundary through an env var.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="$(dirname "$SCRIPT_DIR")/wcash-wallet"
exec env WCASH_WALLET_URI="$1" "$BINARY"
