# Phantom Privacy Model

**The invariant: Phantom makes zero unsolicited network connections.** No telemetry, no analytics, no crash uploads, no update pings, no Safe-Browsing lookups, no search suggestions as you type, no favicon fetching from third parties (sites get locally generated letter tiles). The complete list of things that can trigger a network request:

1. You navigate (type a URL, click a link, pick a command-bar result).
2. A page you loaded makes its own requests (subject to Shields below).
3. You press **Update** on a filter list in Settings → its configured URL is fetched.
4. You configured a DoH resolver → DNS queries go there (and only there).

There is no #5. There is no account system to have a #5 with.

## Defense matrix

| Threat | Defense | Where |
|---|---|---|
| Ad/tracker requests | Native ABP-syntax engine (domain anchors, separators, wildcards, `$third-party`, `$domain`, type options, `@@` exceptions, `$important`), EasyList/EasyPrivacy/Peter Lowe/custom lists | `crates/phantom-core/src/filter.rs`, bundled starter list in `assets/filters/base.txt` |
| Cosmetic ads/consent spam | `##` rules compiled to per-host CSS, inherited by subdomains | `filter.rs::cosmetic_css`, injected by shell |
| Canvas fingerprinting | Per-origin seeded pixel perturbation on readback (stable per origin+session, unlinkable across origins) | `policy.rs::fingerprint_shim_js` |
| AudioContext fingerprinting | Deterministic micro-offsets on analyser readback | shim |
| WebGL fingerprinting | Vendor/renderer normalized to a fixed string pair | shim |
| Hardware enumeration | `hardwareConcurrency`/`deviceMemory`/`maxTouchPoints` clamped | shim |
| UA fingerprinting | Reduced UA: fixed platform token, engine major version only — identical for all Phantom users per OS | `policy.rs::normalized_user_agent` |
| Uniformity mode | Optional Mullvad-style fixed seed so every Phantom user presents identically | Settings → Fingerprinting: Uniform |
| WebRTC IP leaks | Default `no-non-proxied-udp`; full disable available | Settings → WebRTC |
| Third-party cookies | Blocked by default; all storage isolated **per Space** (separate WebKit data stores on desktop) | Settings, shell |
| Referrer leakage | Same-origin: full URL (fragment stripped). Cross-origin: origin only. HTTPS→HTTP: nothing | `policy.rs::trim_referrer` |
| Cleartext HTTP | HTTPS-Only by default with interstitial; local/LAN hosts exempt; per-host exceptions are yours to grant | `policy.rs::apply_https_policy` |
| DNS surveillance | DoH with a resolver **you** pick at first run — Phantom ships no default provider and asks before browsing | First-run dialog, Settings › Search & DNS |
| History exposure | History is **off by default** (opt-in). Archive holds closed tabs locally; clearable anytime | Settings › Privacy, › Data |
| Dangerous URLs | `javascript:`/`vbscript:`/`file:` input can never navigate; it's treated as a search | `policy.rs::resolve_input` |

## What Phantom does *not* do (honestly)

- **IP anonymity.** Phantom is not Tor. Sites see your IP (or your VPN's). The WebRTC default is chosen so Phantom doesn't undermine a VPN; pair them.
- **Engine 0-days.** WebKit's sandbox + site isolation mitigate; nothing eliminates. System WebKit means security fixes arrive with your OS updates.
- **First-party tracking.** If you log into a site, that site knows it's you. Spaces limit the blast radius (Work-you and Personal-you get separate jars).
- **Encrypted-at-rest database.** Settings/bookmarks/history live in a local SQLite file, protected by your OS account + disk encryption — the realistic threat boundary for a desktop browser. If you need stronger, use full-disk encryption (you should anyway).

## Verify it yourself

- `npm test` and `cargo test -p phantom-core` include a test that scans the chrome sources for tracker endpoints and placeholder markers.
- Point Phantom at `coveryourtracks.eff.org` and `browserleaks.com` (linked from the new-tab page).
- Watch it with `ss -tp` / Little Snitch at idle: nothing. That's the design working, not a bug.
