// fzf-style fuzzy scoring (v2 algorithm, simplified constants).
// Shared test vectors with ui/js/fuzzy.js — keep the two in sync.

pub const SCORE_MATCH: i32 = 16;
pub const SCORE_GAP_START: i32 = -3;
pub const SCORE_GAP_EXT: i32 = -1;
pub const BONUS_BOUNDARY: i32 = 9;
pub const BONUS_CAMEL: i32 = 7;
pub const BONUS_CONSECUTIVE: i32 = 5;
pub const BONUS_FIRST_MULTI: i32 = 8;

#[derive(Debug, Clone, PartialEq)]
pub struct FuzzyHit {
    pub score: i32,
    /// Byte offsets of matched characters, for highlight rendering.
    pub positions: Vec<usize>,
}

fn char_class(c: char) -> u8 {
    if c.is_lowercase() { 1 } else if c.is_uppercase() { 2 } else if c.is_ascii_digit() { 3 } else { 0 }
}

fn bonus_for(prev: Option<char>, cur: char) -> i32 {
    match prev {
        None => BONUS_BOUNDARY,
        Some(p) => {
            if !p.is_alphanumeric() { BONUS_BOUNDARY }
            else if char_class(p) != char_class(cur) { BONUS_CAMEL } // incl. lower->Upper camel humps
            else { 0 }
        }
    }
}

/// Returns None if `pattern` is not a subsequence of `text` (case-insensitive
/// unless the pattern contains an uppercase char — smart case).
pub fn fuzzy_match(pattern: &str, text: &str) -> Option<FuzzyHit> {
    if pattern.is_empty() {
        return Some(FuzzyHit { score: 0, positions: Vec::new() });
    }
    let smart_case = pattern.chars().any(|c| c.is_uppercase());
    let eq = |a: char, b: char| if smart_case { a == b } else { a.eq_ignore_ascii_case(&b) };

    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (n, m) = (t.len(), p.len());
    if m > n { return None; }

    // Quick subsequence check.
    let mut pi = 0;
    for &c in &t { if pi < m && eq(c, p[pi]) { pi += 1; } }
    if pi < m { return None; }

    // DP over prefixes: h[i][j] = best score aligning p[..=j] with t[i] matched to p[j].
    // Transitions consider every earlier match position for p[j-1], charging gap
    // penalties for skipped characters — O(n^2 * m) worst case, fine for titles/URLs.
    let neg = i32::MIN / 2;
    let mut h = vec![vec![neg; m]; n];
    let mut parent = vec![vec![usize::MAX; m]; n];
    let mut best = neg;
    let mut best_pos = (0usize, 0usize);
    for i in 0..n {
        let b = bonus_for(if i == 0 { None } else { Some(t[i - 1]) }, t[i]);
        for j in 0..m {
            if !eq(t[i], p[j]) { continue; }
            let s = if j == 0 {
                SCORE_MATCH + b + b * BONUS_FIRST_MULTI / 8 + SCORE_GAP_EXT * i as i32
            } else {
                let mut best_prev = neg;
                let mut best_k = usize::MAX;
                for (k, prev_row) in h.iter().enumerate().take(i) {
                    let prev = prev_row[j - 1];
                    if prev == neg { continue; }
                    let gap = (i - k - 1) as i32;
                    let cand = if gap == 0 {
                        prev + SCORE_MATCH + b.max(BONUS_CONSECUTIVE)
                    } else {
                        prev + SCORE_MATCH + b + SCORE_GAP_START + SCORE_GAP_EXT * (gap - 1)
                    };
                    if cand > best_prev { best_prev = cand; best_k = k; }
                }
                if best_prev == neg { continue; }
                parent[i][j] = best_k;
                best_prev
            };
            h[i][j] = s;
            if j == m - 1 && s > best { best = s; best_pos = (i, j); }
        }
    }
    if best == neg { return None; }

    let mut positions = vec![0usize; m];
    let (mut i, mut j) = best_pos;
    loop {
        positions[j] = i;
        if j == 0 { break; }
        i = parent[i][j];
        if i == usize::MAX { return None; }
        j -= 1;
    }
    Some(FuzzyHit { score: best, positions })
}

/// Rank items by fuzzy score against `pattern`, best first. Stable for ties.
pub fn rank<'a, T>(pattern: &str, items: &'a [T], key: impl Fn(&T) -> &str) -> Vec<(&'a T, FuzzyHit)> {
    let mut hits: Vec<(usize, &T, FuzzyHit)> = items.iter().enumerate()
        .filter_map(|(i, it)| fuzzy_match(pattern, key(it)).map(|h| (i, it, h)))
        .collect();
    hits.sort_by(|a, b| b.2.score.cmp(&a.2.score).then(a.0.cmp(&b.0)));
    hits.into_iter().map(|(_, it, h)| (it, h)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subsequence_required() {
        assert!(fuzzy_match("xyz", "hello world").is_none());
        assert!(fuzzy_match("hlo", "hello").is_some());
    }

    #[test]
    fn consecutive_beats_scattered() {
        // Like fzf, every-char-on-a-boundary (g-i-t) legitimately scores high;
        // what must hold is consecutive > scattered subsequence.
        let a = fuzzy_match("git", "github.com").unwrap().score;
        let b = fuzzy_match("git", "guitar-italy.travel").unwrap().score;
        assert!(a > b, "{a} should beat {b}");
    }

    #[test]
    fn boundary_bonus_ranks_acronym() {
        let items = vec!["random page", "GitHub Pull Requests", "guitar tabs"];
        let ranked = rank("gpr", &items, |s| s);
        assert_eq!(*ranked[0].0, "GitHub Pull Requests");
    }

    #[test]
    fn smart_case() {
        assert!(fuzzy_match("GH", "github").is_none());
        assert!(fuzzy_match("gh", "GitHub").is_some());
    }

    #[test]
    fn ten_k_entries_rank_fast_enough() {
        // Not a benchmark harness; guards against accidental O(n^3) blowups.
        let items: Vec<String> = (0..10_000).map(|i| format!("Page title number {i} on example-{}.com", i % 97)).collect();
        let ranked = rank("ptn42", &items, |s| s.as_str());
        assert!(!ranked.is_empty());
    }
}
