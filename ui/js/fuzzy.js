// Mirror of crates/phantom-core/src/fuzzy.rs (same scoring constants and
// shared expectations; tests/ui.test.js pins the behavior).
'use strict';

const FUZZY = (() => {
  const SCORE_MATCH = 16, SCORE_GAP_START = -3, SCORE_GAP_EXT = -1;
  const BONUS_BOUNDARY = 9, BONUS_CAMEL = 7, BONUS_CONSECUTIVE = 5, BONUS_FIRST_MULTI = 8;

  const cls = (c) => (c >= 'a' && c <= 'z') ? 1 : (c >= 'A' && c <= 'Z') ? 2 : (c >= '0' && c <= '9') ? 3 : 0;
  function bonusFor(prev, cur) {
    if (prev === null) return BONUS_BOUNDARY;
    if (!/[A-Za-z0-9]/.test(prev)) return BONUS_BOUNDARY;
    if (cls(prev) === 1 && cls(cur) === 2) return BONUS_CAMEL;
    if (cls(prev) !== cls(cur)) return BONUS_CAMEL;
    return 0;
  }

  function fuzzyMatch(pattern, text) {
    if (!pattern) return { score: 0, positions: [] };
    const smartCase = /[A-Z]/.test(pattern);
    const eq = (a, b) => smartCase ? a === b : a.toLowerCase() === b.toLowerCase();
    const p = [...pattern], t = [...text];
    const n = t.length, m = p.length;
    if (m > n) return null;
    let pi = 0;
    for (const c of t) { if (pi < m && eq(c, p[pi])) pi++; }
    if (pi < m) return null;

    const NEG = Number.MIN_SAFE_INTEGER / 2;
    const h = Array.from({ length: n }, () => new Array(m).fill(NEG));
    const parent = Array.from({ length: n }, () => new Array(m).fill(-1));
    let best = NEG, bestI = 0;
    for (let i = 0; i < n; i++) {
      const b = bonusFor(i === 0 ? null : t[i - 1], t[i]);
      for (let j = 0; j < m; j++) {
        if (!eq(t[i], p[j])) continue;
        let s;
        if (j === 0) {
          s = SCORE_MATCH + b + (b * BONUS_FIRST_MULTI) / 8 + SCORE_GAP_EXT * i;
        } else {
          let bestPrev = NEG, bestK = -1;
          for (let k = 0; k < i; k++) {
            if (h[k][j - 1] === NEG) continue;
            const gap = i - k - 1;
            const cand = gap === 0
              ? h[k][j - 1] + SCORE_MATCH + Math.max(b, BONUS_CONSECUTIVE)
              : h[k][j - 1] + SCORE_MATCH + b + SCORE_GAP_START + SCORE_GAP_EXT * (gap - 1);
            if (cand > bestPrev) { bestPrev = cand; bestK = k; }
          }
          if (bestPrev === NEG) continue;
          parent[i][j] = bestK;
          s = bestPrev;
        }
        h[i][j] = s;
        if (j === m - 1 && s > best) { best = s; bestI = i; }
      }
    }
    if (best === NEG) return null;
    const positions = new Array(m);
    let i = bestI;
    for (let j = m - 1; j >= 0; j--) {
      positions[j] = i;
      if (j > 0) { i = parent[i][j]; if (i < 0) return null; }
    }
    return { score: best, positions };
  }

  function rank(pattern, items, keyFn) {
    const out = [];
    items.forEach((item, idx) => {
      const hit = fuzzyMatch(pattern, keyFn(item));
      if (hit) out.push({ item, hit, idx });
    });
    out.sort((a, b) => b.hit.score - a.hit.score || a.idx - b.idx);
    return out;
  }

  return { fuzzyMatch, rank };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FUZZY;
