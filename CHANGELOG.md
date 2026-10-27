# Changelog

## Unreleased

- **CI is fully green** (Node suite, phantom-core tests + clippy `-D warnings`, Linux/WebKitGTK build, macOS universal DMG). Fixes on the way there: lowercase `Path` keys in `phantom-app/Cargo.toml` (a capital `Path` made cargo ignore the bin Path and fail workspace-wide), `std::Path` → `std::Path`, wry 0.45 builder API (`WebViewBuilder::new(window)` / `build()`), and a round of clippy lints in the core (`if_same_then_else`, `[char]` find/split patterns, `match` → `?`, range-loop over DP rows).
- **macOS now ships as a `.dmg` installer**: `packaging/macos/make-dmg.sh` builds a universal Phantom.app (Apple Silicon + Intel), stages it with an /Applications symlink, and produces `dist/Phantom-<version>-universal.dmg` via hdiutil. CI verifies the DMG (`hdiutil verify`), uploads it as the `phantom-macos-dmg` artifact on every run, and attaches it to a GitHub Release on `v*` tags. Also fixed: `make-app.sh` was missing its executable bit.

## 0.1.0 — 2026-10-27

Initial Phantom: research & architecture record (`docs/RESEARCH.md`), Rust privacy core, native shell (tao + system WebKit), full Arc-paradigm chrome, packaging for Arch/Hyprland and macOS, CI.

### Features

- Sidebar with Favorites / Pinned / Today zones; Today auto-archives (12h default, configurable); closing archives, never deletes; one-click/undo restore.
- Spaces as storage containers (per-Space WebKit data stores on desktop), each tinting the window; drag tabs between Spaces; drag to reorder/pin/favorite.
- Command bar (Ctrl/⌘+T): fzf-grade fuzzy ranking across tabs, archive, and actions, with match highlighting.
- Split view up to 4 live panes (2×2 at four); Little Phantom ephemeral windows (real OS windows on desktop, floating windows standalone) with promote-to-tab.
- Phantom Shields: native ABP-syntax engine in Rust (bundled starter list works offline; EasyList/EasyPrivacy/Peter Lowe/custom lists fetched only on demand), per-tab blocked/allowed accounting, cosmetic filtering.
- Fingerprint defenses: per-origin seeded canvas/audio noise, WebGL vendor/renderer normalization, clamped hardware surface, reduced uniform UA; optional Mullvad-style uniform mode.
- HTTPS-Only with interstitial + per-host exceptions; referrer trimming; WebRTC `no-non-proxied-udp` default; third-party cookies blocked; history off by default.
- First-run DNS choice (no hardcoded resolver); search engine choice; full keybinding customization; dark/light/system themes; bookmark import/export (Netscape HTML); settings import/export (JSON).

### Bug sweep log (found by the test suites during development, fixed before release)

- **Filter engine `$options` parsing dropped `domain=` rules** — the option-separator guard rejected `.`, so any rule with `domain=example.com` was silently misparsed. Caught by `tests/ui.test.js` (bundled-list Facebook exception case); fixed in both the JS and Rust engines.
- **Chrome failed to boot from the dev server** — `String.replace` interpreted `$'` sequences in the inlined JavaScript as replacement patterns, corrupting `filters.js`. Fixed by using replacer functions (Rust's `replace` was never affected). Caught by `tests/smoke.mjs`.
- **All dev-server routes 404'd** — `url.Pathname` (capital P) is `undefined`; the URL API is `url.Pathname`. Also fixed the same slip in `prettyUrl`.
- **`structuredClone` assumption** — added a JSON fallback (`deepClone`) so the chrome also runs on older WebKit builds.
- **Keyboard shortcuts dead after closing the command bar** — focus stayed trapped in the hidden input and the in-field guard swallowed shortcuts. The input is now blurred on close.
- **Fuzzy scorer test expectation corrected** — an every-character-on-a-delimiter match (`g-i-t`) legitimately outscores a plain consecutive run under fzf-style scoring (boundary bonuses are real signal). Tests now assert the meaningful invariant: consecutive beats scattered subsequences.
