#!/bin/sh
# Build Phantom.app (unsigned by default; set PHANTOM_SIGN_ID to codesign).
# Usage: ./packaging/macos/make-app.sh [universal|native]
set -eu
cd "$(dirname "$0")/../.."

MODE="${1:-native}"
APP="dist/Phantom.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/ui"

if [ "$MODE" = "universal" ]; then
  rustup target add x86_64-apple-darwin aarch64-apple-darwin
  cargo build --release -p phantom-app --target x86_64-apple-darwin
  cargo build --release -p phantom-app --target aarch64-apple-darwin
  lipo -create -output "$APP/Contents/MacOS/phantom" \
    target/x86_64-apple-darwin/release/phantom \
    target/aarch64-apple-darwin/release/phantom
else
  cargo build --release -p phantom-app
  cp target/release/phantom "$APP/Contents/MacOS/phantom"
fi

cp packaging/macos/Info.plist "$APP/Contents/Info.plist"
cp ui/index.html "$APP/Contents/Resources/ui/"
cp -r ui/css ui/js "$APP/Contents/Resources/ui/"
# The shell resolves ui/ next to the executable; bridge that to Resources/.
ln -sf ../Resources/ui "$APP/Contents/MacOS/ui"

if [ -n "${PHANTOM_SIGN_ID:-}" ]; then
  codesign --force --options runtime --sign "$PHANTOM_SIGN_ID" "$APP"
  echo "Signed with: $PHANTOM_SIGN_ID"
else
  echo "Unsigned build. Set PHANTOM_SIGN_ID to codesign (e.g. 'Developer ID Application: …')."
  echo "First launch: right-click Phantom.app → Open."
fi

echo "Built $APP"
