# Building Phantom

## Try the chrome right now (any platform, 10 seconds)

```sh
npm run dev          # serves the full UI at http://localhost:4173
npm test             # fuzzy matcher, filter engine, policy — no browser needed
```

The dev server assembles `ui/index.html` exactly the way the desktop shell does. In this standalone mode, web content renders in frames (some sites refuse embedding — they work normally in the desktop build, where each pane is a real WebKit view).

## Desktop build — Arch Linux (Hyprland / Wayland)

Phantom is Wayland-native: WebKitGTK talks to Hyprland via GTK4's Wayland backend (`xdg_shell`, fractional scaling, portals). There is no X11/XWayland requirement.

```sh
sudo pacman -S rust cargo webkit2gtk-4.1 gtk3 libsoup3 pkgconf
cargo build --release -p phantom-app
PHANTOM_UI_DIR=$PWD/ui ./target/release/phantom
```

Or build a package:

```sh
makepkg -si    # uses the PKGBUILD in this repo
```

**HiDPI:** GTK picks up Hyprland's per-output scale automatically. **File pickers/notifications/clipboard** go through `xdg-desktop-portal` and GTK — install a portal backend (e.g. `xdg-desktop-portal-hyprland`) for file dialogs. **GPU:** WebKitGTK composites via OpenGL/Vulkan (DMA-BUF) on Wayland by default; `WEBKIT_DISABLE_DMABUF_RENDERER=1` is the escape hatch for broken drivers.

## Desktop build — macOS (12.0+, Apple Silicon & Intel)

Needs Xcode Command Line Tools and Rust (`rustup`).

```sh
./packaging/macos/make-dmg.sh            # -> dist/Phantom-0.1.0-universal.dmg
open dist/Phantom-0.1.0-universal.dmg    # then drag Phantom into Applications
```

`make-dmg.sh` builds a universal `Phantom.app` (Apple Silicon + Intel in one
binary via `make-app.sh`), stages it next to an `/Applications` symlink, and
packages both into a compressed `.dmg` with `hdiutil`. For a quicker
single-architecture build use `./packaging/macos/make-dmg.sh native`
(`Phantom-<version>-arm64.dmg` or `-x86_64.dmg`), or `./packaging/macos/make-app.sh`
if you only want the bare `.app` in `dist/`.

CI builds the universal DMG on every push (download it from the run's
**phantom-macos-dmg** artifact), and pushing a `v*` Tag attaches the DMG to a
GitHub Release automatically.

Unsigned builds need a right-click → Open on first launch. Set `PHANTOM_SIGN_ID="Developer ID Application: …"` to codesign both the app and the DMG, ready for notarization (`xcrun notarytool submit` — the script prints the exact command).

## Just the Rust core (no display needed)

```sh
cargo test -p phantom-core   # filter engine, fuzzy scorer, policy, model
```

`phantom-core` has zero dependencies and compiles anywhere Rust does.

## Layout of the build

| Piece | Command | Output |
|---|---|---|
| Core library | `cargo build -p phantom-core` | rlib (used by the shell) |
| Browser | `cargo build --release -p phantom-app` | `target/release/phantom` |
| Arch package | `makepkg` | `phantom-browser-*.pkg.tar.zst` |
| macOS installer | `packaging/macos/make-dmg.sh` | `dist/Phantom-<version>-universal.dmg` |
| macOS app (dev) | `packaging/macos/make-app.sh` | `dist/Phantom.app` |
| Chrome preview | `npm run dev` | http://localhost:4173 |

Release profile (workspace `Cargo.toml`): fat LTO, single codegen unit, stripped symbols, `panic=abort`.
