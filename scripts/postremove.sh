#!/bin/bash
rm -f '/usr/share/polkit-1/actions/com.wcashwallet.wallet.policy'

if [ -L /usr/bin/wcash-wallet ] && [ "$(readlink /usr/bin/wcash-wallet)" = '/opt/Wcash Wallet/wcash-wallet' ]; then
    rm -f /usr/bin/wcash-wallet
fi

APPARMOR_DST='/etc/apparmor.d/wcash-wallet'
if [ -f "$APPARMOR_DST" ]; then
    if command -v apparmor_parser >/dev/null 2>&1; then
        apparmor_parser -R "$APPARMOR_DST" 2>/dev/null || true
    fi
    rm -f "$APPARMOR_DST"
fi
