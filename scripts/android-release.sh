#!/usr/bin/env bash
# Build the phone app for release and install it on the connected device,
# always signed with your release key.
#
#   pnpm android:release                      # build + install on the connected phone
#   ANDROID_SERIAL=<serial> pnpm android:release  # choose, when several are attached
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

# Bring app.json into the native project: android/ is generated, so settings
# like the over-the-air update URL and runtime version only reach the build
# through prebuild. Without --clean it keeps the existing project.
(cd "$mobile" && CI=1 npx expo prebuild --platform android --no-install)

# Firebase config is what lets the phone receive pushes (see SETUP.md).
[[ -f "$mobile/google-services.json" ]] || echo "! No apps/mobile/google-services.json — this build won't receive push notifications."

# The phone to install on. Emulators are left out: `expo run:android` once
# quietly installed onto a running emulator instead of the phone plugged in.
serial="${ANDROID_SERIAL:-}"
if [[ -z "$serial" ]]; then
  phones=()
  while read -r id state; do
    [[ "$state" == "device" && "$id" != emulator-* ]] && phones+=("$id")
  done < <(adb devices | tail -n +2)
  if [[ ${#phones[@]} -eq 0 ]]; then
    fail "No phone connected over adb (emulators are ignored; set ANDROID_SERIAL to install on one)."
  fi
  # The same phone over USB and wireless debugging at once is two entries
  # but one device: compare hardware serials, and prefer the USB one.
  first_hw="$(adb -s "${phones[0]}" shell getprop ro.serialno | tr -d '\r')"
  serial="${phones[0]}"
  for id in "${phones[@]}"; do
    [[ "$(adb -s "$id" shell getprop ro.serialno | tr -d '\r')" == "$first_hw" ]] \
      || fail "More than one phone connected (${phones[*]}); choose with ANDROID_SERIAL=<serial>."
    [[ "$id" != *:* ]] && serial="$id"
  done
fi
echo "✓ Installing on $(adb -s "$serial" shell getprop ro.product.model | tr -d '\r') ($serial)"

# expo-updates writes the build's runtime version (the fingerprint) in a Gradle
# task whose only inputs are paths, so after its first run Gradle calls it up
# to date forever and every build ships that first fingerprint. Over-the-air
# updates are published for the current one, so they never reached the phone.
# Deleting its output makes it run again.
rm -rf "$mobile/android/app/build/generated/assets/createReleaseUpdatesResources"

# Gradle's release build bundles the JavaScript itself.
(cd "$mobile/android" && ./gradlew app:assembleRelease -x lint -x test --build-cache)
apk="$mobile/android/app/build/outputs/apk/release/app-release.apk"

# The fingerprint `pnpm android:update` publishes for, against the one built in.
expected="$(cd "$mobile" && npx expo-updates runtimeversion:resolve --platform android | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).runtimeVersion')"
built="$(unzip -p "$apk" assets/fingerprint)"
[[ "$built" == "$expected" ]] \
  || fail "This build's runtime version is $built but updates publish for $expected, so it would never take them. Not installing."
echo "✓ Runtime version $built — takes over-the-air updates"

adb -s "$serial" install -r "$apk"
adb -s "$serial" shell monkey -p com.zawaer.renki -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
echo "✓ Installed and opened on $serial"
