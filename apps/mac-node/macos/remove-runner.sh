#!/usr/bin/env bash
# Removes the first, user-based build runner (a `renki-runner` macOS user, a sudo rule and pf rules).
# It was replaced by the build VM (src/vm.ts) because macOS can't keep a second user away from your
# own localhost services. Run once if you set it up:   sudo bash apps/mac-node/macos/remove-runner.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo." >&2; exit 1; }
user=renki-runner

pkill -9 -u "$user" 2>/dev/null || true
launchctl bootout system/com.zawaer.renki-runner-pf 2>/dev/null || true
rm -f /Library/LaunchDaemons/com.zawaer.renki-runner-pf.plist
/sbin/pfctl -a com.apple/renki-runner -F all 2>/dev/null || true
rm -f /etc/pf.anchors/renki-runner /etc/sudoers.d/renki-runner /usr/local/libexec/renki-runner.mjs
if dscl . -read "/Users/$user" >/dev/null 2>&1; then
  dscl . -delete "/Users/$user"
  dscl . -delete "/Groups/$user" 2>/dev/null || true
fi
rm -rf "/Users/$user"
echo "Removed the Renki build runner."
