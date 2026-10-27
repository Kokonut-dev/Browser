// UI logic tests — run with `npm test` (node --test). These mirror the Rust
// unit tests in crates/phantom-core so the two implementations can't drift.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Path = require('node:path');

const FUZZY = require('../ui/js/fuzzy.js');
const FILTERS = require('../ui/js/filters.js');
const { resolveInput, DEFAULT_SETTINGS } = require('../ui/js/state.js');

test('fuzzy: subsequence required', () => {
  assert.equal(FUZZY.fuzzyMatch('xyz', 'hello world'), null);
  assert.ok(FUZZY.fuzzyMatch('hlo', 'hello'));
});

test('fuzzy: consecutive beats scattered', () => {
  // Note: like fzf, a match where every char sits on a delimiter boundary
  // (g-i-t) legitimately scores high — boundaries are real signal. What must
  // hold is that a clean consecutive run beats a scattered subsequence.
  const a = FUZZY.fuzzyMatch('git', 'github.com').score;
  const b = FUZZY.fuzzyMatch('git', 'guitar-italy.travel').score;
  assert.ok(a > b, `${a} should beat ${b}`);
});

test('fuzzy: acronym ranking + smart case', () => {
  const items = ['random page', 'GitHub Pull Requests', 'guitar tabs'];
  const ranked = FUZZY.rank('gpr', items, (s) => s);
  assert.equal(ranked[0].item, 'GitHub Pull Requests');
  assert.equal(FUZZY.fuzzyMatch('GH', 'github'), null);
  assert.ok(FUZZY.fuzzyMatch('gh', 'GitHub'));
});

test('fuzzy: 10k entries rank correctly', () => {
  const items = Array.from({ length: 10_000 }, (_, i) => `Page title number ${i} on example-${i % 97}.com`);
  const ranked = FUZZY.rank('ptn42', items, (s) => s);
  assert.ok(ranked.length > 0);
  assert.ok(ranked[0].item.includes('42'));
});

test('filter: domain anchor blocks subdomains, not lookalikes', () => {
  const e = FILTERS.createEngine(['||ads.example.com^']);
  assert.equal(e.check('https://ads.example.com/b.js', 'news.test', 'script'), true);
  assert.equal(e.check('https://sub.ads.example.com/b.js', 'news.test', 'script'), true);
  assert.equal(e.check('https://notads.example.com/b.js', 'news.test', 'script'), false);
  assert.equal(e.check('https://example.com/?u=ads.example.com', 'news.test', 'script'), false);
});

test('filter: third-party + type + exceptions + important', () => {
  const e = FILTERS.createEngine(['||tracker.io^$third-party,script']);
  assert.equal(e.check('https://tracker.io/t.js', 'site.test', 'script'), true);
  assert.equal(e.check('https://tracker.io/t.js', 'site.test', 'image'), false);
  assert.equal(e.check('https://tracker.io/t.js', 'tracker.io', 'script'), false);

  const e2 = FILTERS.createEngine(['||example.com/ads/*\n@@||example.com/ads/allowed.js']);
  assert.equal(e2.check('https://example.com/ads/x.js', 'a.test', 'script'), true);
  assert.equal(e2.check('https://example.com/ads/allowed.js', 'a.test', 'script'), false);

  const e3 = FILTERS.createEngine(['||example.com/ads/*$important\n@@||example.com/ads/allowed.js']);
  assert.equal(e3.check('https://example.com/ads/allowed.js', 'a.test', 'script'), true);
});

test('filter: cosmetic rules inherit to subdomains', () => {
  const e = FILTERS.createEngine(['##.generic-ad\nexample.com##.banner']);
  const css = e.cosmeticCss('www.example.com');
  assert.match(css, /\.generic-ad/);
  assert.match(css, /\.banner/);
  assert.doesNotMatch(e.cosmeticCss('other.test'), /\.banner/);
});

test('filter: bundled base list parses and blocks known trackers', () => {
  const base = fs.readFileSync(Path.join(__dirname, '..', 'assets', 'filters', 'base.txt'), 'utf8');
  const e = FILTERS.createEngine([base]);
  assert.ok(e.stats.network >= 60, `expected >=60 network rules, got ${e.stats.network}`);
  assert.ok(e.stats.cosmetic >= 10);
  assert.equal(e.check('https://www.google-analytics.com/g/collect?v=2', 'news.test', 'xhr'), true);
  assert.equal(e.check('https://doubleclick.net/ad.js', 'news.test', 'script'), true);
  assert.equal(e.check('https://connect.facebook.net/en_US/fbevents.js', 'news.test', 'script'), true);
  assert.equal(e.check('https://connect.facebook.net/en_US/fbevents.js', 'facebook.com', 'script'), false);
  assert.equal(e.check('https://en.wikipedia.org/wiki/Privacy', 'news.test', 'document'), false);
});

test('policy: input resolution mirrors policy.rs', () => {
  const s = { ...DEFAULT_SETTINGS, searchTemplate: 'https://s.example/?q={query}', httpsMode: 'only', httpsExceptions: [] };
  assert.deepEqual(resolveInput('example.com/Path', s), { kind: 'allow', url: 'https://example.com/Path' });
  assert.equal(resolveInput('how do i center a div', s).kind, 'search');
  assert.match(resolveInput('how do i center a div', s).url, /how\+do\+i\+center\+a\+div/);
  assert.equal(resolveInput('http://example.com', s).kind, 'blocked-http');
  assert.equal(resolveInput('http://localhost:8080', s).kind, 'allow');
  assert.equal(resolveInput('javascript:alert(1)', s).kind, 'search');
});

test('chrome sources contain no telemetry endpoints or placeholders', () => {
  const files = ['ui/js/app.js', 'ui/js/state.js', 'ui/js/filters.js', 'ui/js/fuzzy.js', 'ui/css/phantom.css', 'ui/index.html'];
  for (const f of files) {
    const src = fs.readFileSync(Path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /TODO|FIXME|lorem ipsum/i, f);
    // Filter-rule lines (starting with ||) legitimately name trackers; strip them first.
    const codeOnly = src.split('\n').filter((l) => !l.includes('||')).join('\n');
    assert.doesNotMatch(codeOnly, /google-analytics|googletagmanager|mixpanel|amplitude\.com/i, `${f} must not embed trackers`);
  }
});
