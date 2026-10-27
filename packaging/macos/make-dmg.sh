#!/bin/sh
# Build the downloadable macOS installer:
#   dist/Phantom-<version>-universal.dmg      (default, Apple Silicon + Intel)
#   dist/Phantom-<version>-<arch>.dmg         (./make-dmg.sh native)
#
# The DMG contains Phantom.app and an /Applications symlink — open it,
# drag Phantom into Applications, done. DMG creation requires macOS
# (hdiutil). Set PHANTOM_SIGN_ID to codesign the app and the DMG.
set -eu
cd "$(dirname "$0")/../.."

MODE="${1:-universal}"
case "$MODE" in
  universal|native) ;;
  *) echo "usage: $0 [universal|native]" >&2; exit 2 ;;
esac

if ! command -v hdiutil >/dev/null 2>&1; then
  echo "error: hdiutil not found - creating a .dmg requires macOS." >&2
  exit 1
fi

VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' crates/phantom-app/Cargo.toml | head -1)"
[ -n "$VERSION" ] || VERSION="0.1.0"
if [ "$MODE" = "universal" ]; then
  ARCH_LABEL="universal"
else
  ARCH_LABEL="$(uname -m)"
fi
DMG="dist/Phantom-${VERSION}-${ARCH_LABEL}.dmg"

# 1. Build (and optionally sign) Phantom.app.
./packaging/macos/make-app.sh "$MODE"

# 2. Stage the disk image contents: the app + an Applications shortcut.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT INT TERM
ditto "dist/Phantom.app" "$STAGE/Phantom.app"
ln -s /Applications "$STAGE/Applications"

# 3. Create a compressed, read-only DMG (UDZO is the standard format).
mkdir -p dist
rm -f "$DMG"
hdiutil create \
  -volname "Phantom" \
  -srcfolder "$STAGE" \
  -fs HFS+ \
  -format UDZO \
  -imagekey zlib-level=9 \
  -ov \
  "$DMG"

# 4. Sign the DMG itself when an identity is configured (notarization-ready).
if [ -n "${PHANTOM_SIGN_ID:-}" ]; then
  codesign --force --sign "$PHANTOM_SIGN_ID" "$DMG"
  echo "Signed DMG with: $PHANTOM_SIGN_ID"
  echo "Notarize with: xcrun notarytool submit \"$DMG\" --keychain-profile <profile> --wait && xcrun stapler staple \"$DMG\""
fi

echo "Built $DMG"
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$DMG"
fi
