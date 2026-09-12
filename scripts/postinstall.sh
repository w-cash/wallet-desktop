#!/bin/bash
set -e

APP_DIR='/opt/Wcash Warden Testnet'
EXECUTABLE='wcash-warden-testnet'
POLICY_NAME='com.wcashwallet.warden.testnet.policy'
POLICY_SRC="$APP_DIR/resources/$POLICY_NAME"
POLICY_DST="/usr/share/polkit-1/actions/$POLICY_NAME"

if [ -f "$POLICY_SRC" ]; then
    cp "$POLICY_SRC" "$POLICY_DST"
    chmod 644 "$POLICY_DST"
fi

# Make chrome-sandbox SUID root so Chromium's process sandbox works on
# Ubuntu 22.04+ / Debian 11+ which restrict unprivileged user namespaces.
CHROME_SANDBOX="$APP_DIR/chrome-sandbox"
if [ -f "$CHROME_SANDBOX" ]; then
    chown root "$CHROME_SANDBOX"
    chmod 4755 "$CHROME_SANDBOX"
fi

# Install the Wcash-specific AppArmor profile so Chromium can create user
# namespaces on Ubuntu 24.04+ / Debian 13+.
APPARMOR_SRC="$APP_DIR/resources/apparmor-wcash-warden-testnet"
APPARMOR_DST='/etc/apparmor.d/wcash-warden-testnet'
if [ -f "$APPARMOR_SRC" ] && [ -d /etc/apparmor.d ]; then
    cp "$APPARMOR_SRC" "$APPARMOR_DST"
    chmod 644 "$APPARMOR_DST"
    if command -v apparmor_parser >/dev/null 2>&1; then
        apparmor_parser -r "$APPARMOR_DST" 2>/dev/null || true
    fi
fi

# Put the Wcash Testnet executable on PATH. The guarded removal script only
# deletes this link when it still points to this exact package installation.
BINARY="$APP_DIR/$EXECUTABLE"
if [ -f "$BINARY" ] && [ -d /usr/bin ]; then
    ln -sf "$BINARY" "/usr/bin/$EXECUTABLE"
fi
