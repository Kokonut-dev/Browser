// Browsing policy: the pure decisions the shell asks about every navigation
// and subresource load. No I/O — the shell supplies settings, this returns verdicts.

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum HttpsMode { Only, Upgrade, Off }

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WebRtcPolicy { Disabled, NoNonProxiedUdp, Default }

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FingerprintMode {
    /// Mullvad-style: identical values for every Phantom user.
    Uniform,
    /// Brave-style: per-origin seeded noise, stable within an origin+session.
    RandomizePerOrigin,
    Off,
}

#[derive(Debug, Clone)]
pub struct Settings {
    pub https: HttpsMode,
    pub https_exceptions: Vec<String>, // hosts allowed over http
    pub webrtc: WebRtcPolicy,
    pub fingerprint: FingerprintMode,
    pub block_third_party_cookies: bool,
    pub history_enabled: bool,
    pub archive_after_minutes: u64, // 0 = never archive
    pub doh_url: Option<String>,   // None = system resolver (chosen by the user)
    pub search_template: String,    // contains "{query}"
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            https: HttpsMode::Only,
            https_exceptions: Vec::new(),
            webrtc: WebRtcPolicy::NoNonProxiedUdp,
            fingerprint: FingerprintMode::RandomizePerOrigin,
            block_third_party_cookies: true,
            history_enabled: false,
            archive_after_minutes: 12 * 60,
            doh_url: None,
            // DuckDuckGo HTML endpoint: no JS, no tracking params. User-changeable;
            // first-run asks before anything is fetched.
            search_template: "https://html.duckduckgo.com/html/?q={query}".to_string(),
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum NavDecision {
    Allow(String),
    /// http blocked by HTTPS-Only; shell shows the interstitial with this https URL.
    BlockHttp { https_url: String },
    Search(String),
}

fn host_of(url: &str) -> &str {
    let after = url.split("://").nth(1).unwrap_or(url);
    let end = after.find(['/', ':', '?', '#']).unwrap_or(after.len());
    &after[..end]
}

fn looks_like_url(input: &str) -> bool {
    if input.contains(char::is_whitespace) { return false; }
    if input.contains("://") { return true; }
    if input == "localhost" || input.starts_with("localhost:") || input.starts_with("localhost/") { return true; }
    // host with a dot and a plausible TLD, or an IPv4 literal
    let host = input.split('/').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("");
    if host.split('.').count() == 4 && host.split('.').all(|p| p.parse::<u8>().is_ok()) { return true; }
    match host.rsplit('.').next() {
        Some(tld) => host.contains('.') && tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()),
        None => false,
    }
}

pub fn resolve_input(input: &str, s: &Settings) -> NavDecision {
    let input = input.trim();
    if input.starts_with("phantom://") || input.starts_with("about:") || input.starts_with("data:") {
        return NavDecision::Allow(input.to_string());
    }
    // Dangerous schemes never navigate, whatever the user pasted.
    let lower = input.to_ascii_lowercase();
    if lower.starts_with("javascript:") || lower.starts_with("vbscript:") || lower.starts_with("file:") {
        return NavDecision::Search(s.search_template.replace("{query}", &url_encode(input)));
    }
    if !looks_like_url(input) {
        return NavDecision::Search(s.search_template.replace("{query}", &url_encode(input)));
    }
    let with_scheme = if input.contains("://") { input.to_string() } else { format!("https://{input}") };
    apply_https_policy(&with_scheme, s)
}

pub fn apply_https_policy(url: &str, s: &Settings) -> NavDecision {
    if let Some(rest) = url.strip_prefix("http://") {
        let host = host_of(url);
        let excepted = s.https_exceptions.iter().any(|h| h == host);
        let local = host == "localhost" || host.ends_with(".local") || host.starts_with("127.") || host.starts_with("192.168.") || host.starts_with("10.");
        if excepted || local { return NavDecision::Allow(url.to_string()); }
        return match s.https {
            HttpsMode::Only => NavDecision::BlockHttp { https_url: format!("https://{rest}") },
            HttpsMode::Upgrade => NavDecision::Allow(format!("https://{rest}")),
            HttpsMode::Off => NavDecision::Allow(url.to_string()),
        };
    }
    NavDecision::Allow(url.to_string())
}

/// Referrer to send: full URL same-origin, origin only cross-origin, nothing on downgrade.
pub fn trim_referrer(referrer: &str, target: &str) -> Option<String> {
    let origin = |u: &str| -> Option<String> {
        let (scheme, rest) = u.split_once("://")?;
        let host = rest.split(['/', '?', '#']).next()?;
        Some(format!("{scheme}://{host}/"))
    };
    let (r_origin, t_origin) = (origin(referrer)?, origin(target)?);
    if referrer.starts_with("https://") && target.starts_with("http://") { return None; }
    if r_origin == t_origin {
        // Strip fragment and any embedded credentials.
        let clean = referrer.split('#').next().unwrap_or(referrer);
        Some(clean.to_string())
    } else {
        Some(r_origin)
    }
}

/// Reduced UA: no build numbers, no patch versions — engine major only,
/// platform token fixed per OS so all Phantom users on an OS share a UA.
pub fn normalized_user_agent(webkit_major: u32, macos: bool) -> String {
    let platform = if macos { "Macintosh; Intel Mac OS X 10_15_7" } else { "X11; Linux x86_64" };
    format!("Mozilla/5.0 ({platform}) AppleWebKit/{webkit_major}.1.15 (KHTML, like Gecko) Version/17.0 Safari/{webkit_major}.1.15")
}

/// JS injected at document-start (before any page script) implementing the
/// fingerprint countermeasures WebKit doesn't already cover. The seed makes
/// canvas/audio noise stable per origin+session but unlinkable across origins.
pub fn fingerprint_shim_js(mode: FingerprintMode, seed: u64) -> String {
    match mode {
        FingerprintMode::Off => String::new(),
        FingerprintMode::Uniform => UNIFORM_SHIM.replace("__SEED__", "4660"),
        FingerprintMode::RandomizePerOrigin => UNIFORM_SHIM.replace("__SEED__", &seed.to_string()),
    }
}

const UNIFORM_SHIM: &str = r#"
(() => {
  'use strict';
  let s = __SEED__ >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

  // Canvas: perturb a deterministic handful of pixels on readback.
  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (...a) {
    const img = origGetImageData.apply(this, a);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4096) { d[i] = (d[i] + ((rand() * 3) | 0) - 1) & 255; }
    return img;
  };
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (...a) {
    const ctx = this.getContext('2d');
    if (ctx) { try { const p = ctx.getImageData(0, 0, 1, 1); ctx.putImageData(p, 0, 0); } catch (e) {} }
    return origToDataURL.apply(this, a);
  };

  // AudioContext: tiny deterministic offset on analyser readback.
  if (window.AnalyserNode) {
    const origFloat = AnalyserNode.prototype.getFloatFrequencyData;
    AnalyserNode.prototype.getFloatFrequencyData = function (arr) {
      origFloat.call(this, arr);
      for (let i = 0; i < arr.length; i += 64) arr[i] += (rand() - 0.5) * 0.0001;
    };
  }

  // WebGL: normalize vendor/renderer, the two highest-entropy params.
  const patchGL = (proto) => {
    if (!proto) return;
    const orig = proto.getParameter;
    proto.getParameter = function (p) {
      if (p === 37445) return 'Apple Inc.';                    // UNMASKED_VENDOR_WEBGL
      if (p === 37446) return 'Apple GPU';                     // UNMASKED_RENDERER_WEBGL
      return orig.call(this, p);
    };
  };
  patchGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  patchGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);

  // Navigator surface: clamp values that leak exact hardware.
  const def = (obj, prop, val) => { try { Object.defineProperty(obj, prop, { get: () => val, configurable: true }); } catch (e) {} };
  def(navigator, 'hardwareConcurrency', 8);
  def(navigator, 'deviceMemory', 8);
  def(navigator, 'maxTouchPoints', 0);
})();
"#;

pub fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Deterministic per-origin seed (FNV-1a over session key + origin).
pub fn origin_seed(session_key: u64, origin: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325 ^ session_key;
    for b in origin.bytes() { h ^= b as u64; h = h.wrapping_mul(0x100000001b3); }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Settings { Settings::default() }

    #[test]
    fn bare_domain_gets_https() {
        assert_eq!(resolve_input("example.com/Path", &settings()), NavDecision::Allow("https://example.com/Path".into()));
    }

    #[test]
    fn words_become_search() {
        match resolve_input("how do i center a div", &settings()) {
            NavDecision::Search(u) => assert!(u.contains("how+do+i+center+a+div"), "{u}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn https_only_blocks_http_but_not_local() {
        assert!(matches!(resolve_input("http://example.com", &settings()), NavDecision::BlockHttp { .. }));
        assert_eq!(resolve_input("http://localhost:8080", &settings()), NavDecision::Allow("http://localhost:8080".into()));
    }

    #[test]
    fn javascript_urls_never_navigate() {
        assert!(matches!(resolve_input("javascript:alert(1)", &settings()), NavDecision::Search(_)));
    }

    #[test]
    fn referrer_trimming() {
        assert_eq!(trim_referrer("https://a.test/Path?x=1#f", "https://a.test/other").unwrap(), "https://a.test/Path?x=1");
        assert_eq!(trim_referrer("https://a.test/secret", "https://b.test/").unwrap(), "https://a.test/");
        assert_eq!(trim_referrer("https://a.test/", "http://a.test/"), None);
    }

    #[test]
    fn ua_has_no_patch_version() {
        let ua = normalized_user_agent(605, false);
        assert!(ua.contains("AppleWebKit/605.1.15") && !ua.contains("605.1.15."));

    }

    #[test]
    fn seeds_differ_per_origin_and_session() {
        assert_ne!(origin_seed(1, "https://a.test"), origin_seed(1, "https://b.test"));
        assert_ne!(origin_seed(1, "https://a.test"), origin_seed(2, "https://a.test"));
        assert_eq!(origin_seed(7, "https://a.test"), origin_seed(7, "https://a.test"));
    }
}
