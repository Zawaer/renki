#!/usr/bin/env bash
# One-time setup for the Renki Mac agent: writes
# ~/Library/Application Support/Renki/mac-node.json (daemon URL + token) and
# ca.pem (the Caddy root the homelab's https://*.internal certificates use,
# exported from this Mac's keychain, since Node doesn't read the keychain).
#
# Usage: bash apps/mac-node/macos/setup.sh [daemon-url]
#   The token is read from $RENKI_TOKEN, else asked for (it is the same token the
#   web client uses; `renki token` on the daemon prints it).
set -euo pipefail
dir="$HOME/Library/Application Support/Renki"
url="${1:-https://renki.internal/api}"
mkdir -p "$dir"
chmod 700 "$dir"

token="${RENKI_TOKEN:-}"
if [ -z "$token" ]; then
  read -r -s -p "Renki token: " token
  echo
fi

umask 077
node -e 'const [u,t,f]=process.argv.slice(1);require("fs").writeFileSync(f, JSON.stringify({url:u,token:t}, null, 2)+"\n")' "$url" "$token" "$dir/mac-node.json"

if security find-certificate -a -c "Caddy Local Authority" -p > "$dir/ca.pem" 2>/dev/null && [ -s "$dir/ca.pem" ]; then
  echo "Exported the Caddy root certificate to $dir/ca.pem"
else
  rm -f "$dir/ca.pem"
  echo "No Caddy root certificate in the keychain; fine if $url has a public certificate."
fi

code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "$url/mac" || true)"
case "$code" in
  200) echo "Renki answered; setup done." ;;
  401) echo "Renki rejected the token." >&2; exit 1 ;;
  404) echo "Renki answered, but has no /mac route yet: deploy the daemon first." ;;
  *) echo "Couldn't reach $url (HTTP $code)." >&2; exit 1 ;;
esac
