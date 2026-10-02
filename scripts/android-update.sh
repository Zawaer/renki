#!/usr/bin/env bash
# Publish the phone app's JavaScript as an over-the-air update. Installed
# builds download it on their next launch and run it on the one after.
#
#   pnpm android:update                    # message = the latest commit's subject
#   pnpm android:update "Queue messages"   # or say what changed
#
# Only reaches builds with the same runtime version (a fingerprint of the
# native side). After a native change — a new native module, a config plugin,
# app.json permissions — build and install a new APK instead
# (pnpm android:release); the update is skipped on older builds, not forced on.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
message="${1:-$(git -C "$repo" log -1 --pretty=%s)}"

# The bundle imports client-core's build output, so make sure it's current.
(cd "$repo" && pnpm turbo run build --filter=@renki/client-core)
(cd "$repo/apps/mobile" && npx -y eas-cli update --channel production --platform android --message "$message")
