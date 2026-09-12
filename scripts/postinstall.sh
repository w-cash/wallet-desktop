#!/bin/bash
set -e

PRODUCT_ROOT='/opt/Wcash Wallet'
POLICY_SRC="$PRODUCT_ROOT/resources/com.wcashwallet.wallet.policy"
POLICY_DST='/usr/share/polkit-1/actions/com.wcashwallet.wallet.policy'

if [ -f "$POLICY_SRC" ]; then
    cp "$POLICY_SRC" "$POLICY_DST"
    chmod 644 "$POLICY_DST"
fi

WRAPPER="$PRODUCT_ROOT/resources/wcash-wallet-uri.sh"
if [ -f "$WRAPPER" ]; then
    chmod +x "$WRAPPER"
fi

# Restore Chromium's process sandbox on distributions that restrict
# unprivileged user namespaces.
CHROME_SANDBOX="$PRODUCT_ROOT/chrome-sandbox"
if [ -f "$CHROME_SANDBOX" ]; then
    chown root "$CHROME_SANDBOX"
    chmod 4755 "$CHROME_SANDBOX"
fi

APPARMOR_SRC="$PRODUCT_ROOT/resources/apparmor-wcash-wallet"
APPARMOR_DST='/etc/apparmor.d/wcash-wallet'
if [ -f "$APPARMOR_SRC" ] && [ -d /etc/apparmor.d ]; then
    cp "$APPARMOR_SRC" "$APPARMOR_DST"
    chmod 644 "$APPARMOR_DST"
    if command -v apparmor_parser >/dev/null 2>&1; then
        apparmor_parser -r "$APPARMOR_DST" 2>/dev/null || true
    fi
fi

BINARY="$PRODUCT_ROOT/wcash-wallet"
if [ -f "$BINARY" ] && [ -d /usr/bin ]; then
    ln -sf "$BINARY" /usr/bin/wcash-wallet
fi

# A future non-local package can include the wrapper to register wcash: links.
# Local Regtest candidates omit it, so they never take over the system handler.
DESKTOP='/usr/share/applications/wcash-wallet.desktop'
if [ -f "$DESKTOP" ] && [ -f "$WRAPPER" ]; then
    sed -i "s|^Exec=.*|Exec=\"$WRAPPER\" %u|" "$DESKTOP"
    update-desktop-database /usr/share/applications 2>/dev/null || true
fi
