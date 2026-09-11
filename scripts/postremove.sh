#!/bin/bash

POLICY_DST='/usr/share/polkit-1/actions/com.wcashwallet.warden.testnet.policy'
APPARMOR_DST='/etc/apparmor.d/wcash-warden-testnet'
EXECUTABLE_LINK='/usr/bin/wcash-warden-testnet'
INSTALLED_EXECUTABLE='/opt/Wcash Warden Testnet/wcash-warden-testnet'

rm -f "$POLICY_DST"

# Remove only the symlink created by this package.
if [ -L "$EXECUTABLE_LINK" ] && [ "$(readlink "$EXECUTABLE_LINK")" = "$INSTALLED_EXECUTABLE" ]; then
    rm -f "$EXECUTABLE_LINK"
fi

# Unload and remove only the Wcash-specific AppArmor profile.
if [ -f "$APPARMOR_DST" ]; then
    if command -v apparmor_parser >/dev/null 2>&1; then
        apparmor_parser -R "$APPARMOR_DST" 2>/dev/null || true
    fi
    rm -f "$APPARMOR_DST"
fi
