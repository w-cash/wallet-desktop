#!/bin/bash
# Protocol handler wrapper for wcash: URIs.
# The packaged Electron binary treats positional arguments as the app-module
# path (defaultApp mode), so we pass the URI via env var instead.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="$(dirname "$SCRIPT_DIR")/zingo-pc"
exec env WCASH_WALLET_URI="$1" "$BINARY"
