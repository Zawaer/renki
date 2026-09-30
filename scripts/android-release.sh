#!/usr/bin/env bash
# Build the phone app for release and install it on the connected device,
# always signed with your release key.
#
#   pnpm android:release            # build + install on the one adb device
#   pnpm android:release --device X # pick a device when several are attached
#
# Why a script: without the four RENKI_ANDROID_* variables the release build
# quietly signs with the debug key, and a phone that has the release build
# installed refuses it as an update ("signatures do not match"). This finds
# the key and its password itself, and stops instead of falling back.
#
# Where it looks (override any with the variable):
#   RENKI_ANDROID_KEYSTORE           ~/.renki/renki-release.keystore
#   RENKI_ANDROID_KEY_ALIAS          renki
#   RENKI_ANDROID_KEYSTORE_PASSWORD  contents of ~/.renki/keystore-password.txt
#   RENKI_ANDROID_KEY_PASSWORD       same as the keystore password
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
mobile="$repo/apps/mobile"

export RENKI_ANDROID_KEYSTORE="${RENKI_ANDROID_KEYSTORE:-$HOME/.renki/renki-release.keystore}"
export RENKI_ANDROID_KEY_ALIAS="${RENKI_ANDROID_KEY_ALIAS:-renki}"
if [[ -z "${RENKI_ANDROID_KEYSTORE_PASSWORD:-}" && -f "$HOME/.renki/keystore-password.txt" ]]; then
  RENKI_ANDROID_KEYSTORE_PASSWORD="$(cat "$HOME/.renki/keystore-password.txt")"
fi
export RENKI_ANDROID_KEYSTORE_PASSWORD="${RENKI_ANDROID_KEYSTORE_PASSWORD:-}"
export RENKI_ANDROID_KEY_PASSWORD="${RENKI_ANDROID_KEY_PASSWORD:-$RENKI_ANDROID_KEYSTORE_PASSWORD}"

fail() { echo "✗ $*" >&2; exit 1; }

[[ -f "$RENKI_ANDROID_KEYSTORE" ]] || fail "No release keystore at $RENKI_ANDROID_KEYSTORE (set RENKI_ANDROID_KEYSTORE). Refusing to build with the debug key."
[[ -n "$RENKI_ANDROID_KEYSTORE_PASSWORD" ]] || fail "No keystore password: set RENKI_ANDROID_KEYSTORE_PASSWORD or put it in ~/.renki/keystore-password.txt."
keytool -list -keystore "$RENKI_ANDROID_KEYSTORE" -storepass "$RENKI_ANDROID_KEYSTORE_PASSWORD" -alias "$RENKI_ANDROID_KEY_ALIAS" >/dev/null 2>&1 \
  || fail "The keystore didn't open with that password and alias '$RENKI_ANDROID_KEY_ALIAS'."
echo "✓ Signing with $RENKI_ANDROID_KEYSTORE (alias $RENKI_ANDROID_KEY_ALIAS)"

# The generated Android project caches absolute paths to native modules.
# After the repo moves (it was renamed once), those point nowhere and Gradle
# fails with "No matching variant ... No variants exist". Clear the caches
# when they mention anything outside this checkout; they're regenerated.
if [[ -d "$mobile/android" ]]; then
  cache="$mobile/android/build/generated/autolinking/autolinking.json"
  if [[ -f "$cache" ]] && ! grep -q "\"$repo/" "$cache"; then
    echo "• The native module cache points outside this checkout; clearing Android build output"
    rm -rf "$mobile/android/build" "$mobile/android/app/build" "$mobile/android/app/.cxx"
  fi
fi

# Firebase config is what lets the phone receive pushes (see SETUP.md).
[[ -f "$mobile/google-services.json" ]] || echo "! No apps/mobile/google-services.json — this build won't receive push notifications."

cd "$repo"
exec pnpm --filter @renki/mobile exec expo run:android --variant release --no-bundler "$@"
