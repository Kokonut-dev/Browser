# Phantom — Phase 0: Research & Competitive Analysis

## 1. Competitive Matrix

| Browser | Engine | Platforms | Navigation paradigm | Tracker/ad blocking | Fingerprinting defense | Telemetry | Extensions | Differentiator | Phantom borrows |
|---|---|---|---|---|---|---|---|---|---|
| **Arc** (sunset 22 Dec 2026) | Blink (Chromium) | macOS, Windows, iOS, Android | Sidebar, Spaces, Pinned/Favorites/Today, Command Bar, Split View, Little Arc, Boosts, Easels | uBlock Origin preinstalled | Chromium defaults | Account required, sync telemetry | Chrome Web Store | Spatial organization; tabs as ephemeral by default | The entire navigation model — without the account |
| **Brave** | Blink (Chromium) | All major | Horizontal tabs | **Shields**: native Rust adblock engine, immune to Manifest V3 limits; ~75% less memory after 2026 rewrite | Per-site/session randomization; WebGL/GPU de-identification (1.93+) | Opt-out analytics surface, Rewards | Chrome Web Store + self-hosted MV2 | Blocking compiled into the browser, not an extension | Native (non-extension) blocking engine in Rust |
| **Ungoogled Chromium** | Blink | Linux, macOS, Windows | Horizontal tabs | None built-in | Chromium defaults | All Google endpoints removed at patch level | Chrome Web Store (manual) | Proof that Chromium can be de-Googled via patches | Zero-phone-home as an auditable invariant |
| **LibreWolf** | Gecko (Firefox) | Linux, macOS, Windows | Horizontal tabs | uBlock Origin preinstalled | `resistFingerprinting` on, WebGL off by default | Removed; Sync off unless enabled | Firefox Add-ons | Hardened defaults with zero config work | Privacy on by default, opt-*out* never required |
| **Mullvad Browser** | Gecko (Firefox ESR, Tor patches) | Linux, macOS, Windows | Horizontal tabs | uBlock Origin | **Uniformity**: letterboxing, fixed fonts, JIT off, identical profile for every user | None; no accounts at all | Deliberately limited | Everyone looks the same — anonymity set over randomization | Uniformity-first UA/viewport normalization option |
| **Vivaldi** | Blink | All major | Deeply configurable (sidebar, panels, tab tiling) | Built-in blocker | Chromium defaults | Minimal, EU-hosted | Chrome Web Store | Power-user configurability depth | Keybinding + layout customization depth |
| **qutebrowser** | QtWebEngine (Blink) | Linux, macOS, Windows | Modal, keyboard-first (vim-like) | Hosts-file level | Minimal | None | None (userscripts) | Every action keyboard-reachable | Full keyboard parity; hints-mode inspiration |

**Gap Phantom fills:** Arc proved the spatial/sidebar model and is being discontinued; no surviving browser combines it with Brave-grade native blocking, Mullvad-grade uniformity options, and zero-account/zero-telemetry. Phantom is that combination, native on Hyprland/Wayland and macOS.

## 2. Arc Navigation Deep-Dive (what Phantom replicates)

- **Sidebar, three zones.** *Favorites* (icon grid, always visible, per-Space), *Pinned* (persistent named tabs, survive restarts, never auto-archive), *Today* (everything else; auto-archived after 12h by default). Closing a Today tab is not destructive — it archives.
- **Spaces.** Named workspaces with their own color/gradient, icon, pinned set, and favorites. Switching is a swipe/`Cmd+Ctrl+←/→` (Arc: `Ctrl+←/→` on macOS) with a crossfade. Phantom adds what Arc never had: **each Space is a storage container** (separate cookies/site data — Firefox Multi-Account Containers semantics).
- **Command Bar** (`Cmd/Ctrl+T`). One input that is simultaneously new-tab, address bar, tab switcher, and command palette. Fuzzy-ranked over open tabs → pinned → history/bookmarks (if enabled) → web search fallback. Phantom uses an fzf-grade scorer (boundary/consecutive/case bonuses, gap penalties), not substring matching.
- **Split View** (`Cmd/Ctrl+\` or drag-to-edge). Two (Phantom: up to four) live panes in one window, each an independent webview with its own navigation state.
- **Little Phantom.** Arc's "Little Arc": a chromeless mini-window for a link you don't want to keep — opens fast, closes without ceremony, can be "promoted" into the main window as a Today tab. Ephemeral storage by construction.
- **Peek & previews.** Hovering a sidebar tab shows a live thumbnail; `Shift+Click` peeks a link in an overlay without losing place.
- **Keyboard map (defaults, all rebindable).** `Cmd/Ctrl+T` command bar · `Cmd/Ctrl+L` edit URL · `Cmd/Ctrl+S` toggle sidebar · `Cmd/Ctrl+Shift+S` Shields · `Cmd/Ctrl+W` archive tab · `Cmd/Ctrl+Shift+T` reopen archived · `Cmd/Ctrl+1…9` jump to favorite/tab · `Cmd/Ctrl+[` / `]` prev/next tab · `Cmd/Ctrl+Shift+[` / `]` prev/next Space · `Cmd/Ctrl+\` split · `Cmd/Ctrl+Shift+N` Little Phantom · `Cmd/Ctrl+R` reload · `Alt+←/→` back/forward · `Cmd/Ctrl+,` settings.
- **What Phantom deliberately drops from Arc:** mandatory account, cloud sync, AI features that phone home, Easels/Boosts cloud sharing. Boosts are replaced by **local-only userstyles** (per-site CSS stored on disk).

## 3. Privacy Threat Model

| Threat | Vector | Phantom countermeasure |
|---|---|---|
| Third-party tracking | Cookies, pixels, beacons, CNAME cloaking (partial) | Native ABP-syntax engine (EasyList/EasyPrivacy/Peter Lowe/custom), third-party cookies blocked, per-Space cookie jars |
| Fingerprinting | Canvas, WebGL params, AudioContext, fonts, screen, UA, `navigator.*`, timezone, battery | Per-origin seeded noise for canvas/audio, WebGL vendor/renderer normalization, font list clamped to bundled set, UA reduced to engine-major-only on a fixed platform token, optional letterboxed viewport buckets (Mullvad mode) |
| WebRTC IP leak | ICE candidates expose LAN/public IP behind VPN | Default policy `disable_non_proxied_udp`; per-site override; mDNS candidates only |
| DNS leakage | System resolver sees every host | DoH with **user-chosen** resolver at first run (no hardcoded provider); system resolver as explicit option |
| Referrer leakage | Full URLs leak cross-origin | `strict-origin-when-cross-origin` ceiling; same-origin full, cross-origin origin-only |
| Connection reuse tracking | H2 coalescing, TLS session resumption across sites | Network state partitioned by top-level site + Space (WebKit ITP partitioning kept on) |
| Telemetry / phone-home | Update pings, crash reports, Safe Browsing lookups | None exist. No update checker, no crash uploader, no remote blocklist lookups. Filter lists update only when the user presses Update (from URLs they configured) |
| Local data exposure | Disk theft, other local users | Settings/bookmarks in a local SQLite DB; history **off by default** (opt-in); Today tabs ephemeral |
| Cleartext downgrade | HTTP interception | HTTPS-Only default with interstitial; per-site exceptions stored locally |

Out of scope (stated honestly): IP-level anonymity (use a VPN/Tor — Phantom exposes a SOCKS5 proxy setting that composes with Tor), 0-day engine exploits (mitigated by WebKit's own sandbox + site isolation, not eliminated).

## 4. Architecture Decision Record

| Decision | Chosen | Alternatives rejected | Why |
|---|---|---|---|
| Rendering engine | **System WebKit via `wry`**: WebKitGTK 4.1 on Linux, WKWebView on macOS | CEF (160MB+ blob, Chrome telemetry surface to audit, no Wayland-native story); Servo (not production-complete); writing an engine (absurd) | WebKit is the only engine that is (a) production-grade, (b) already privacy-hardened upstream (ITP), (c) Wayland-native on Hyprland via GTK4, (d) Metal-accelerated on macOS, (e) ships with the OS → tiny binary, OS-patched security updates |
| Windowing | `tao` (GTK4 on Linux/Wayland, AppKit on macOS) | Qt (LGPL linking friction, non-native feel); raw smithay (months of work) | Native decoration/scaling/IME/clipboard for free on both targets |
| Chrome UI | Privileged webview running local HTML/CSS/JS, talking to Rust over `wry` IPC | egui/iced (custom widget rendering never matches platform text/IME quality); dual GTK+SwiftUI (2× UI code, drift) | One UI codebase, pixel-identical on both platforms, GPU-composited by WebKit itself. The same files run standalone for development |
| Core language | Rust (`phantom-core`: pure-std privacy logic; `phantom-app`: shell) | C++ (memory safety), JS/Electron (forbidden + slow) | Filter matching and policy code is attack surface; it must be memory-safe and fast |
| Content blocking | Own ABP engine in Rust + WebKit content-blocker JSON compilation where supported | Bundling uBlock (extension model doesn't exist in WKWebView/WebKitGTK the Chromium way) | Brave's lesson: blocking compiled in beats blocking bolted on |
| Storage | SQLite (`rusqlite`, bundled) | Flat JSON (no atomicity), SQLCipher (extra native dep; OS full-disk encryption is the realistic boundary — documented in PRIVACY.md) | Atomic, queryable, zero-config |

**Process model:** one UI process (Rust + chrome webview); WebKit spawns sandboxed Web/Network/GPU processes per its own site-isolation policy. Each Space maps to a distinct `WebContext`/website-data-store → cookie/storage isolation is enforced by the engine, not by convention.
