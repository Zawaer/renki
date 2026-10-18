#!/usr/bin/env bash
# Builds "Renki Mac.app" (menu bar switch + bundled Node agent) into ~/Applications.
# Usage: bash apps/mac-node/macos/build-app.sh [destination-dir]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="${1:-$HOME/Applications}"
app="$dest/Renki Mac.app"

(cd "$here/.." && pnpm build >/dev/null)

build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT
mkdir -p "$build/Renki Mac.app/Contents/MacOS" "$build/Renki Mac.app/Contents/Resources"
swiftc -O -o "$build/Renki Mac.app/Contents/MacOS/RenkiMac" "$here/RenkiMac.swift" -framework AppKit -framework ServiceManagement
cp "$here/../dist/renki-mac-node.mjs" "$build/Renki Mac.app/Contents/Resources/"
cp -R "$here/../dist/runner-image" "$build/Renki Mac.app/Contents/Resources/"
node_path="$(command -v node || true)"
cat > "$build/Renki Mac.app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.zawaer.renki.mac</string>
  <key>CFBundleName</key><string>Renki Mac</string>
  <key>CFBundleExecutable</key><string>RenkiMac</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>RenkiNodePath</key><string>${node_path}</string>
</dict></plist>
PLIST
codesign --force --sign - "$build/Renki Mac.app" >/dev/null

# Replace the installed copy, stopping a running one first.
pkill -x RenkiMac 2>/dev/null && sleep 1 || true
mkdir -p "$dest"
rm -rf "$app"
mv "$build/Renki Mac.app" "$app"
echo "Built $app"
