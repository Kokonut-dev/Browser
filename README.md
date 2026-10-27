# Phantom

**A privacy-first browser with spatial, Arc-style navigation. Zero telemetry — not "anonymous analytics", not crash reports, *zero*.**

Phantom takes the navigation model Arc pioneered (sidebar, Spaces, command bar, ephemeral-by-default tabs — Arc itself sunsets in December 2026) and rebuilds it on a privacy architecture closer to Mullvad Browser and Brave: a native Rust blocking engine, per-Space storage containers, anti-fingerprinting, and no account, ever. It runs on the system WebKit — WebKitGTK on Linux/Wayland, WKWebView on macOS — so it's small, GPU-accelerated, and patched by your OS.


## Try it now

```sh
npm run dev     # full browser chrome at http://localhost:4173
npm test        # logic test suite
```

Desktop (Arch/Hyprland): `makepkg -si` · Desktop (macOS): `./packaging/macos/make-dmg.sh` → `dist/Phantom-0.1.0-universal.dmg` (or grab the **phantom-macos-dmg** artifact from CI) · Details: [BUILDING.md](BUILDING.md)

## Features

**Navigation, spatially**
- Sidebar with three zones: **Favorites** (icon grid), **Pinned** (permanent), **Today** (auto-archives after 12h — configurable). Closing a tab archives it; nothing is ever lost to an accidental click.
- **Spaces** — workspaces that are also *storage containers*: separate cookies/site data per Space, each tinting the whole window its own color.
- **Command bar** (`Ctrl/⌘+T`) — fzf-grade fuzzy search across tabs, archive, and actions; or type a URL/search. Tested smooth at 10,000 entries.
- **Split view** up to 4 live panes; **Little Phantom** ephemeral mini-windows; tab hover previews; drag-and-drop everywhere; every action keyboard-reachable with fully customizable bindings.

**Privacy, structurally**
- **No telemetry of any kind.** No update pings, no Safe-Browsing lookups, no suggestion fetching, no third-party favicon service. Phantom's network activity is enumerated in [PRIVACY.md](PRIVACY.md) — the full list fits in four bullets.
- **Phantom Shields** — a built-in ABP-syntax blocking engine in Rust (not an extension): EasyList/EasyPrivacy/Peter Lowe/custom lists, cosmetic filtering, per-tab blocked counts.
- **Anti-fingerprinting** — per-origin seeded canvas/audio noise, normalized WebGL/UA, clamped hardware APIs, plus an optional Mullvad-style uniform mode.
- **HTTPS-Only** by default, **WebRTC** leak-safe by default, third-party cookies blocked, referrers trimmed, **history off by default**, and a first-run DNS choice — Phantom refuses to pick a resolver for you.

## Keyboard (defaults, all rebindable)

| Action | Shortcut | Action | Shortcut |
|---|---|---|---|
| Command bar | `⌘/Ctrl+T` | Split view | `⌘/Ctrl+\` |
| Edit URL | `⌘/Ctrl+L` | Little Phantom | `⌘/Ctrl+Shift+N` |
| Toggle sidebar | `⌘/Ctrl+S` | Shields | `⌘/Ctrl+Shift+S` |
| Archive tab | `⌘/Ctrl+W` | Reopen archived | `⌘/Ctrl+Shift+T` |
| Prev/next tab | `⌘/Ctrl+[` / `]` | Prev/next Space | `⌘/Ctrl+Shift+[` / `]` |
| Jump to tab 1–9 | `⌘/Ctrl+1…9` | Settings | `⌘/Ctrl+,` |
| Back/forward | `Alt+←/→` | Find | `⌘/Ctrl+F` |

## Project map

| Path | What |
|---|---|
| `crates/phantom-core/` | Pure-Rust privacy core: filter engine, fuzzy scorer, policy, browsing model (zero deps) |
| `crates/phantom-app/` | Native shell: tao windows + system WebKit via wry, SQLite store |
| `ui/` | The chrome — dependency-free HTML/CSS/JS, runs identically in-app and standalone |
| `assets/filters/base.txt` | Bundled starter rules (protection works offline on first run) |
| `docs/RESEARCH.md` | Competitive analysis, Arc deep-dive, threat model, architecture decisions |
| `ARCHITECTURE.md` · `PRIVACY.md` · `BUILDING.md` | System design · threat model & defenses · build guide |
| `PKGBUILD` · `packaging/` | Arch package · macOS `.dmg` installer builder |

## License

MPL-2.0 — see [LICENSE](LICENSE).
