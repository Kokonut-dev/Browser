// Adblock Plus / uBlock Origin filter syntax: network rules (`||ads.example^$third-party`),
// exceptions (`@@||example.com^$document`), and cosmetic rules (`example.com##.ad`).
// Network matching implements domain anchors, separators (`^`), wildcards (`*`),
// start/end anchors, and the common $options: third-party, domain=, and resource types.

use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ResourceType { Document, Script, Image, Stylesheet, Xhr, Font, Media, Other }

#[derive(Debug, Clone, Default)]
struct Options {
    third_party: Option<bool>, // Some(true)=$third-party, Some(false)=$first-party
    types: Vec<(ResourceType, bool)>, // (type, positive?)
    domains: Vec<(String, bool)>,     // (host, positive?) from domain=
    important: bool,
}

#[derive(Debug, Clone)]
struct Rule {
    pattern: String,
    exception: bool,
    opts: Options,
}

#[derive(Debug, Default)]
pub struct FilterEngine {
    rules: Vec<Rule>,
    /// host -> CSS selectors to hide (cosmetic rules, host-specific + generic under "")
    cosmetic: HashMap<String, Vec<String>>,
    pub stats: (usize, usize), // (network rules, cosmetic rules)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Verdict { Allow, Block }

pub struct Request<'a> {
    pub url: &'a str,
    pub source_host: &'a str, // top-level document host, "" for main-frame
    pub kind: ResourceType,
}

impl FilterEngine {
    pub fn from_lists(lists: &[&str]) -> FilterEngine {
        let mut e = FilterEngine::default();
        for list in lists { e.add_list(list); }
        e.stats = (e.rules.len(), e.cosmetic.values().map(|v| v.len()).sum());
        e
    }

    pub fn add_list(&mut self, text: &str) {
        for raw in text.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('!') || line.starts_with('[') { continue; }
            if let Some(idx) = line.find("##") {
                let (hosts, selector) = (&line[..idx], &line[idx + 2..]);
                if selector.is_empty() { continue; }
                if hosts.is_empty() {
                    self.cosmetic.entry(String::new()).or_default().push(selector.to_string());
                } else {
                    for h in hosts.split(',') {
                        if !h.starts_with('~') {
                            self.cosmetic.entry(h.to_string()).or_default().push(selector.to_string());
                        }
                    }
                }
                continue;
            }
            // Skip cosmetic exceptions (#@#) and scriptlet/HTML rules we don't implement.
            if line.contains("#@#") || line.contains("##+") || line.contains("#$#") { continue; }
            if let Some(rule) = parse_network_rule(line) { self.rules.push(rule); }
        }
        self.stats = (self.rules.len(), self.cosmetic.values().map(|v| v.len()).sum());
    }

    pub fn check(&self, req: &Request) -> Verdict {
        let mut blocked = false;
        let mut important_block = false;
        let mut excepted = false;
        for rule in &self.rules {
            if !options_match(&rule.opts, req) { continue; }
            if !pattern_matches(&rule.pattern, req.url) { continue; }
            if rule.exception { excepted = true; }
            else if rule.opts.important { important_block = true; }
            else { blocked = true; }
        }
        if important_block || (blocked && !excepted) { Verdict::Block } else { Verdict::Allow }
    }

    /// Host suffixes from `||host…` rules, for the fast in-page interceptor.
    /// Covers the dominant rule shape in EasyList/EasyPrivacy; the full engine
    /// still arbitrates main-frame navigations and Shields accounting in Rust.
    pub fn blocked_host_suffixes(&self) -> Vec<String> {
        let mut out = Vec::new();
        for r in &self.rules {
            if r.exception { continue; }
            if let Some(rest) = r.pattern.strip_prefix("||") {
                let host: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-').collect();
                if host.contains('.') && !host.starts_with('.') { out.push(host.to_ascii_lowercase()); }
            }
        }
        out.sort();
        out.dedup();
        out
    }

    /// CSS to inject for a host: generic + host-specific cosmetic rules.
    pub fn cosmetic_css(&self, host: &str) -> String {
        let mut sels: Vec<&str> = Vec::new();
        if let Some(g) = self.cosmetic.get("") { sels.extend(g.iter().map(|s| s.as_str())); }
        // Walk up parent domains: a rule for example.com applies to www.example.com.
        let mut h = host;
        loop {
            if let Some(s) = self.cosmetic.get(h) { sels.extend(s.iter().map(|x| x.as_str())); }
            match h.find('.') { Some(i) => h = &h[i + 1..], None => break }
        }
        if sels.is_empty() { String::new() } else { format!("{} {{ display: none !important; }}", sels.join(", ")) }
    }
}

fn parse_network_rule(line: &str) -> Option<Rule> {
    let (exception, rest) = if let Some(r) = line.strip_prefix("@@") { (true, r) } else { (false, line) };
    let (pattern, opt_str) = match rest.rfind('$') {
        // Only treat `$` as the option separator if what follows looks like options.
        Some(i) if rest[i + 1..].chars().all(|c| c.is_ascii_alphanumeric() || ",=~|-_.".contains(c)) && !rest[i + 1..].is_empty() => {
            (&rest[..i], &rest[i + 1..])
        }
        _ => (rest, ""),
    };
    if pattern.is_empty() { return None; }
    let mut opts = Options::default();
    for part in opt_str.split(',').filter(|s| !s.is_empty()) {
        let (neg, name) = if let Some(n) = part.strip_prefix('~') { (true, n) } else { (false, part) };
        match name {
            "third-party" | "3p" => opts.third_party = Some(!neg),
            "first-party" | "1p" => opts.third_party = Some(neg),
            "important" => opts.important = true,
            "script" => opts.types.push((ResourceType::Script, !neg)),
            "image" => opts.types.push((ResourceType::Image, !neg)),
            "stylesheet" | "css" => opts.types.push((ResourceType::Stylesheet, !neg)),
            "xmlhttprequest" | "xhr" | "fetch" => opts.types.push((ResourceType::Xhr, !neg)),
            "font" => opts.types.push((ResourceType::Font, !neg)),
            "media" => opts.types.push((ResourceType::Media, !neg)),
            "document" | "doc" => opts.types.push((ResourceType::Document, !neg)),
            _ => {
                if let Some(domains) = name.strip_prefix("domain=") {
                    for d in domains.split('|') {
                        if let Some(nh) = d.strip_prefix('~') { opts.domains.push((nh.to_string(), false)); }
                        else { opts.domains.push((d.to_string(), true)); }
                    }
                }
                // Unknown options (redirect=, csp=, removeparam=…) are ignored:
                // the rule then applies as a plain pattern rule. Blocking slightly
                // more than intended beats silently dropping privacy rules.
            }
        }
    }
    Some(Rule { pattern: pattern.to_string(), exception, opts })
}

fn host_of(url: &str) -> &str {
    let after = url.split("://").nth(1).unwrap_or(url);
    let end = after.find(|c| c == '/' || c == ':' || c == '?' || c == '#').unwrap_or(after.len());
    &after[..end]
}

fn is_third_party(url: &str, source_host: &str) -> bool {
    if source_host.is_empty() { return false; }
    let h = host_of(url);
    !(h == source_host || h.ends_with(&format!(".{source_host}")) || source_host.ends_with(&format!(".{h}")))
}

fn options_match(opts: &Options, req: &Request) -> bool {
    if let Some(want_3p) = opts.third_party {
        if is_third_party(req.url, req.source_host) != want_3p { return false; }
    }
    if !opts.types.is_empty() {
        let positive: Vec<ResourceType> = opts.types.iter().filter(|(_, p)| *p).map(|(t, _)| *t).collect();
        let negative: Vec<ResourceType> = opts.types.iter().filter(|(_, p)| !*p).map(|(t, _)| *t).collect();
        if !positive.is_empty() && !positive.contains(&req.kind) { return false; }
        if negative.contains(&req.kind) { return false; }
    }
    if !opts.domains.is_empty() {
        let has_positive = opts.domains.iter().any(|(_, p)| *p);
        let included = opts.domains.iter().any(|(d, p)| *p && (req.source_host == d || req.source_host.ends_with(&format!(".{d}"))));
        let excluded = opts.domains.iter().any(|(d, p)| !*p && (req.source_host == d || req.source_host.ends_with(&format!(".{d}"))));
        if excluded || (has_positive && !included) { return false; }
    }
    true
}

fn is_separator(c: char) -> bool {
    !(c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' || c == '%')
}

/// ABP pattern matching against a URL. Handles `||` (domain anchor), `|` (start/end
/// anchor), `^` (separator), and `*` (wildcard) by splitting the pattern into literal
/// segments that must appear in order.
fn pattern_matches(pattern: &str, url: &str) -> bool {
    let url_l = url.to_ascii_lowercase();
    let pat_l = pattern.to_ascii_lowercase();
    let mut pat: &str = &pat_l;
    let mut start_anchor = false;
    let mut host_anchor = false;
    if let Some(rest) = pat.strip_prefix("||") { host_anchor = true; pat = rest; }
    else if let Some(rest) = pat.strip_prefix('|') { start_anchor = true; pat = rest; }
    let end_anchor = pat.ends_with('|');
    if end_anchor { pat = &pat[..pat.len() - 1]; }

    // Candidate start offsets.
    let starts: Vec<usize> = if host_anchor {
        match url_l.find("://") {
            Some(i) => {
                let host_start = i + 3;
                let mut v = vec![host_start];
                // Subdomain boundary starts: every '.' inside the host part.
                let host_end = url_l[host_start..].find(|c| c == '/' || c == ':' || c == '?').map(|e| host_start + e).unwrap_or(url_l.len());
                for (off, c) in url_l[host_start..host_end].char_indices() {
                    if c == '.' { v.push(host_start + off + 1); }
                }
                v
            }
            None => return false,
        }
    } else if start_anchor { vec![0] } else { (0..=url_l.len()).collect() };

    // Split pattern into wildcard-separated segments; a segment may contain `^`.
    let segments: Vec<&str> = pat.split('*').collect();
    'outer: for start in starts {
        let mut pos = start;
        for (idx, seg) in segments.iter().enumerate() {
            if seg.is_empty() { continue; }
            match match_segment(seg, &url_l, pos, idx == 0 && (host_anchor || start_anchor)) {
                Some(end) => pos = end,
                None => continue 'outer,
            }
        }
        if end_anchor && pos != url_l.len() { continue; }
        return true;
    }
    false
}

/// Match one literal segment (with `^` separators) at or after `from`.
/// Returns the end offset of the match.
fn match_segment(seg: &str, url: &str, from: usize, anchored: bool) -> Option<usize> {
    let parts: Vec<&str> = seg.split('^').collect();
    let mut pos = from;
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            // Consume exactly one separator char (or end-of-string).
            if pos >= url.len() { /* ^ matches end-of-URL */ }
            else if is_separator(url[pos..].chars().next().unwrap()) { pos += url[pos..].chars().next().unwrap().len_utf8(); }
            else { return None; }
        }
        if part.is_empty() { continue; }
        if i == 0 && anchored {
            if url[pos..].starts_with(part) { pos += part.len(); } else { return None; }
        } else {
            match url[pos..].find(part) {
                Some(off) => pos += off + part.len(),
                None => return None,
            }
        }
    }
    Some(pos)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req<'a>(url: &'a str, src: &'a str, kind: ResourceType) -> Request<'a> {
        Request { url, source_host: src, kind }
    }

    #[test]
    fn domain_anchor_blocks_subdomains_not_lookalikes() {
        let e = FilterEngine::from_lists(&["||ads.example.com^"]);
        assert_eq!(e.check(&req("https://ads.example.com/b.js", "news.test", ResourceType::Script)), Verdict::Block);
        assert_eq!(e.check(&req("https://sub.ads.example.com/b.js", "news.test", ResourceType::Script)), Verdict::Block);
        assert_eq!(e.check(&req("https://notads.example.com/b.js", "news.test", ResourceType::Script)), Verdict::Allow);
        assert_eq!(e.check(&req("https://example.com/?u=ads.example.com", "news.test", ResourceType::Script)), Verdict::Allow);
    }

    #[test]
    fn third_party_and_type_options() {
        let e = FilterEngine::from_lists(&["||tracker.io^$third-party,script"]);
        assert_eq!(e.check(&req("https://tracker.io/t.js", "site.test", ResourceType::Script)), Verdict::Block);
        assert_eq!(e.check(&req("https://tracker.io/t.js", "site.test", ResourceType::Image)), Verdict::Allow);
        assert_eq!(e.check(&req("https://tracker.io/t.js", "tracker.io", ResourceType::Script)), Verdict::Allow);
    }

    #[test]
    fn exceptions_and_important() {
        let e = FilterEngine::from_lists(&["||example.com/ads/*\n@@||example.com/ads/allowed.js"]);
        assert_eq!(e.check(&req("https://example.com/ads/x.js", "a.test", ResourceType::Script)), Verdict::Block);
        assert_eq!(e.check(&req("https://example.com/ads/allowed.js", "a.test", ResourceType::Script)), Verdict::Allow);
        let e2 = FilterEngine::from_lists(&["||example.com/ads/*$important\n@@||example.com/ads/allowed.js"]);
        assert_eq!(e2.check(&req("https://example.com/ads/allowed.js", "a.test", ResourceType::Script)), Verdict::Block);
    }

    #[test]
    fn cosmetic_rules_apply_to_subdomains() {
        let e = FilterEngine::from_lists(&["##.generic-ad\nexample.com##.banner"]);
        let css = e.cosmetic_css("www.example.com");
        assert!(css.contains(".generic-ad") && css.contains(".banner"), "{css}");
        assert!(!e.cosmetic_css("other.test").contains(".banner"));
    }

    #[test]
    fn domain_option_scopes_rule() {
        let e = FilterEngine::from_lists(&["||cdn.test/pixel.gif$domain=news.test|~blog.news.test"]);
        assert_eq!(e.check(&req("https://cdn.test/pixel.gif", "news.test", ResourceType::Image)), Verdict::Block);
        assert_eq!(e.check(&req("https://cdn.test/pixel.gif", "blog.news.test", ResourceType::Image)), Verdict::Allow);
        assert_eq!(e.check(&req("https://cdn.test/pixel.gif", "elsewhere.test", ResourceType::Image)), Verdict::Allow);
    }
}
