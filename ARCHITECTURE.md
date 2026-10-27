# Phantom Architecture

## Overview

```
┌─────────────────────────────────────────────────────────────┐
│  tao window (GTK4/Wayland on Linux · AppKit on macOS)       │
│                                                             │
│  ┌──────────────┐   IPC (JSON)   ┌───────────────────────┐  │
│  │ Chrome       │◄──────────────►│ phantom-app (Rust)    │  │
│  │ webview      │                │  · tab/space registry │  │
│  │ (ui/ files)  │   layout       │  · policy enforcement │  │
│  └──────────────┘   messages     │  · SQLite store       │  │
│         ▲                        └──────────┬────────────┘  │
│         │ state pushes                      │ owns          │
│  ┌──────┴───────────────────┐    ┌──────────▼────────────┐  │
│  │ content webviews (1 per  │    │ phantom-core (Rust)   │  │
│  │ visible pane, child      │    │  · filter engine      │  │
│  │ views positioned over    │    │  · fuzzy matcher      │  │
│  │ the stage)               │    │  · policy decisions   │  │
│  └──────────────────────────┘    │  · browsing model     │  │
│   WebKit processes (sandboxed,   └───────────────────────┘  │
│   site-isolated, GPU-accelerated)                           │
└─────────────────────────────────────────────────────────────┘
```

## Crates

- **`crates/phantom-core`** — pure Rust, std only, no I/O. Every privacy decision lives here so it can be unit-tested without a display: `filter` (ABP-syntax engine), `fuzzy` (fzf-style scorer), `policy` (input resolution, HTTPS-Only, referrer trimming, UA normalization, fingerprint shim generation, per-origin seeds), `model` (Spaces/zones/archive state machine).
- **`crates/phantom-app`** — the shell. `main.rs` owns windows/webviews and routes IPC; `store.rs` is the SQLite layer; `content_script.rs` builds the document-start bridge injected into pages.
- **`ui/`** — the chrome. Plain HTML/CSS/JS, no build step, no dependencies. The shell inlines `css/phantom.css` and `js/{fuzzy,filters,state,app}.js` into `index.html` at startup (and `tools/dev-server.js` does exactly the same for development, so the preview is byte-identical to the desktop chrome).

## IPC protocol

Chrome → Rust (`window.ipc.postMessage`, JSON): `ready`, `open`, `navigate`, `activate`, `close`, `zone`, `split`, `space-new`, `space-switch`, `restore`, `back|forward|reload`, `layout` (pane rects), `little`, `command-search`, `settings`, `export-bookmarks`, `clear-history`.

Rust → Chrome (`window.__phantomReceive`): `state` (full model snapshot — rendering is a pure function of it), `shields` (per-tab blocked/allowed + last request), `https-blocked`, `relayout`, `command-results`, `exported`.

Content → Rust: `page` (url/title), `resource` (fetch/XHR/beacon observed by the bridge), `window-open` (routed to Little Phantom).

## Key design decisions

**Why system WebKit?** It's the only production engine that is Wayland-native on Hyprland (WebKitGTK), Metal-accelerated on macOS (WKWebView), privacy-hardened upstream (ITP, storage partitioning), and OS-maintained for security updates. CEF would mean shipping/auditing 160MB of Chromium; Servo isn't production-complete. Full tradeoff table: `docs/RESEARCH.md`.

**Why is the chrome a webview?** One UI codebase, pixel-identical on both platforms, GPU-composited by the same engine that renders pages. The alternative (GTK + SwiftUI twins) guarantees drift. This is *not* Electron: there's no Node, no Chromium, and the chrome is ~120KB of hand-written HTML/CSS/JS with zero dependencies.

**State ownership.** Rust owns the browsing model on desktop; the chrome renders snapshots. For standalone development, `ui/js/state.js` mirrors `model.rs` semantics exactly (same shape), and `tests/ui.test.js` + the Rust unit tests pin the shared algorithms so the mirrors can't silently drift.

**Storage isolation per Space.** On desktop, each Space maps to its own WebKit website-data store — cookies/storage isolation is enforced by the engine. In the standalone chrome, Spaces isolate tab sets and settings surface; cookie jars are the host browser's (a preview limitation, stated plainly in the Shields panel).

**Blocking layers.** (1) Main-frame navigation decisions in Rust via `phantom-core`. (2) In-page interception of `fetch`/`XHR`/`sendBeacon` using the engine's exported blocked-host suffixes. (3) Cosmetic CSS injected per host. (4) WebKit's own ITP underneath it all.

**Performance choices** (Phase 4): fat LTO + symbol stripping in release; filter engine compiled once at startup from the bundled list (remote lists load only on user request); content webviews created lazily per tab and hidden (not destroyed) when off-stage, so tab switching is a visibility flip; chrome re-renders preserve live iframes/webviews by keying panes to tab ids; Shields logs are bounded ring buffers (60 entries/tab); fuzzy ranking is O(items × title × pattern) with an early subsequence reject — 10k-entry ranking is covered by tests in both languages.
