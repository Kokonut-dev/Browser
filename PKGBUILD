# Maintainer: Phantom contributors
pkgname=phantom-browser
pkgver=0.1.0
pkgrel=1
pkgdesc="Privacy-first browser with Arc-style spatial navigation. Zero telemetry, native Wayland."
arch=('x86_64' 'aarch64')
url="https://github.com/Kokonut-dev/Browser"
license=('MPL-2.0')
depends=('webkit2gtk-4.1' 'gtk3' 'libsoup3' 'openssl' 'hicolor-icon-theme')
makedepends=('cargo' 'rust' 'pkgconf' 'git')
optdepends=(
  'xdg-desktop-portal: file chooser integration on Hyprland/Wayland'
  'gst-plugins-good: additional media codecs'
  'gst-libav: H.264/AAC media playback'
)
source=("$pkgname-$pkgver.tar.gz::$url/archive/refs/tags/v$pkgver.tar.gz")
sha256sums=('SKIP')

build() {
  cd "Browser-$pkgver"
  export RUSTUP_TOOLCHAIN=stable
  export CARGO_TARGET_DIR=target
  # Wayland-native: wry picks WebKitGTK's Wayland backend automatically;
  # no X11 fallback is compiled in or required.
  cargo build --release -p phantom-app
}

check() {
  cd "Browser-$pkgver"
  cargo test -p phantom-core
}

package() {
  cd "Browser-$pkgver"
  install -Dm755 "target/release/phantom" "$pkgdir/usr/bin/phantom"
  install -dm755 "$pkgdir/usr/share/phantom/ui"
  cp -r ui/index.html ui/css ui/js "$pkgdir/usr/share/phantom/ui/"
  install -Dm644 "packaging/linux/phantom.desktop" \
    "$pkgdir/usr/share/applications/phantom.desktop"
  install -Dm644 LICENSE "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
  install -Dm644 README.md "$pkgdir/usr/share/doc/$pkgname/README.md"
}
