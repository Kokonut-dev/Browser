# Phase 1 Success Criteria — Status

Legend: ✅ implemented & verified by automated tests in this repo · 🖥 implemented in the desktop shell, verified by CI build (needs a display to eyeball) · ◐ implemented with a stated limitation.

## Functional

- ✅ Modern web content via system WebKit (WebKitGTK / WKWebView — HTML5/CSS3/ES2023+/Wasm/WebGL as supported by the OS engine)
- ✅ Arc-style sidebar: Spaces, Favorites, Pinned, Today with configurable auto-archive (12h default)
- ✅ Command bar with fzf-grade fuzzy ranking (tested at 10,000 entries, both implementations)
- ✅ Split view, up to 4 panes (exceeds the 2+ requirement)
- ✅ Little Phantom windows (real always-on-top OS windows on desktop; draggable floating windows in standalone chrome) with promote-to-tab
- ✅ Tab hover previews (scaled live frame + title/URL)
- ✅ Animations on sidebar, space switching (hue crossfade), command bar, panes — one motion curve throughout
- ✅ Every action keyboard-reachable; ✅ full keybinding customization with duplicate eviction

## Privacy

- ✅ Zero telemetry — enumerated exhaustively in `PRIVACY.md`; a unit test scans chrome sources for tracker endpoints
- ✅ Built-in content blocker: ABP engine (Rust) with bundled offline list + EasyList/EasyPrivacy/Peter Lowe/custom (fetched only on demand)
- ✅ Fingerprinting: canvas, AudioContext, WebGL vendor/renderer, hardware clamping, reduced UA; uniform (Mullvad-style) mode available
- ✅ WebRTC: `no-non-proxied-udp` default, full disable available
- ✅ DoH with user-chosen resolver at first run; no hardcoded provider
- ✅ HTTPS-Only default with interstitial and exceptions
- 🖥 Cookie isolation per Space — separate WebKit data stores in the desktop shell (standalone chrome isolates tab sets; jars belong to the host browser — stated in the Shields UI)
- ✅ No history by default (opt-in) · ✅ referrer same-origin-only full · ✅ UA normalization · ✅ Today tabs ephemeral-by-design (archive, don't accumulate)

## Platform

- 🖥 Arch + Hyprland: WebKitGTK/GTK4 Wayland-native build, PKGBUILD, portal-based file pickers, fractional scaling via GTK
- 🖥 macOS 12.0+: universal `.app` via `packaging/macos/make-app.sh`, codesign-ready `Info.plist`, native lifecycle via tao/AppKit
- 🖥 HiDPI, clipboard, notifications, dark-mode following, GPU acceleration (WebKit: DMA-BUF/GL on Linux, Metal on macOS) — inherited from the platform WebKit/GTK/AppKit stack Phantom is built on, exercised by CI builds on `ubuntu-24.04` and `macos-14`

## Performance

- Startup: chrome is a single 119KB inline document; filter compilation uses the bundled list; nothing blocks first paint on network.
- Tab switching: visibility flip of pre-created views (desktop) / preserved frames (standalone) — no reload on switch.
- Memory: bounded per-tab Shields logs; engine stats visible in Settings. RSS targets are engine-dependent (system WebKit), so they're measured on-device rather than claimed here.
- Command bar: pre-indexed surface, subsequence early-reject; ranking 10k entries covered by tests.

## Aesthetic & code quality

- ✅ One design system (`ui/css/phantom.css`): 4pt grid, per-Space hue theming, designed dark **and** light themes (not inversions)
- ✅ Zero TODO/FIXME/placeholder markers — enforced by test
- ✅ Comments explain *why*; no per-function boilerplate docs
