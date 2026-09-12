#!/bin/bash
# zypak supplies Chromium sandbox integration inside Flatpak.
if [[ "$1" == wcash:* ]]; then
  exec env WCASH_WALLET_URI="$1" zypak-wrapper /app/lib/wcash-wallet/wcash-wallet
fi
exec zypak-wrapper /app/lib/wcash-wallet/wcash-wallet "$@"
