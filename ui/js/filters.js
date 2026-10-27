// Mirror of the Rust filter engine's public behavior (subset for the UI:
// domain anchors, separators, wildcards, @@ exceptions, $third-party/$types).
// In the desktop build Rust arbitrates; this powers the standalone chrome.
'use strict';

const FILTERS = (() => {
  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase(); }
    catch { return ''; }
  }

  function isSeparator(c) { return !/[A-Za-z0-9_\-.%]/.test(c); }

  function matchSegment(seg, url, from, anchored) {
    const parts = seg.split('^');
    let pos = from;
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        if (pos >= url.length) { /* ^ matches end */ }
        else if (isSeparator(url[pos])) pos += 1;
        else return -1;
      }
      const part = parts[i];
      if (!part) continue;
      if (i === 0 && anchored) {
        if (!url.startsWith(part, pos)) return -1;
        pos += part.length;
      } else {
        const off = url.indexOf(part, pos);
        if (off < 0) return -1;
        pos = off + part.length;
      }
    }
    return pos;
  }

  function patternMatches(pattern, urlRaw) {
    const url = urlRaw.toLowerCase();
    let pat = pattern.toLowerCase();
    let startAnchor = false, hostAnchor = false;
    if (pat.startsWith('||')) { hostAnchor = true; pat = pat.slice(2); }
    else if (pat.startsWith('|')) { startAnchor = true; pat = pat.slice(1); }
    let endAnchor = false;
    if (pat.endsWith('|')) { endAnchor = true; pat = pat.slice(0, -1); }

    let starts;
    if (hostAnchor) {
      const schemeEnd = url.indexOf('://');
      if (schemeEnd < 0) return false;
      const hostStart = schemeEnd + 3;
      const hostEndRel = url.slice(hostStart).search(/[/:?#]/);
      const hostEnd = hostEndRel < 0 ? url.length : hostStart + hostEndRel;
      starts = [hostStart];
      for (let i = hostStart; i < hostEnd; i++) if (url[i] === '.') starts.push(i + 1);
    } else if (startAnchor) starts = [0];
    else starts = Array.from({ length: url.length + 1 }, (_, i) => i);

    const segments = pat.split('*');
    for (const start of starts) {
      let pos = start, ok = true;
      for (let s = 0; s < segments.length; s++) {
        if (!segments[s]) continue;
        const end = matchSegment(segments[s], url, pos, s === 0 && (hostAnchor || startAnchor));
        if (end < 0) { ok = false; break; }
        pos = end;
      }
      if (ok && (!endAnchor || pos === url.length)) return true;
    }
    return false;
  }

  function parseList(text) {
    const rules = [], cosmetic = new Map();
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('!') || line.startsWith('[')) continue;
      const cosIdx = line.indexOf('##');
      if (cosIdx >= 0 && !line.includes('#@#')) {
        const hosts = line.slice(0, cosIdx), sel = line.slice(cosIdx + 2);
        if (!sel || sel.startsWith('+js')) continue;
        for (const h of (hosts ? hosts.split(',') : [''])) {
          if (h.startsWith('~')) continue;
          if (!cosmetic.has(h)) cosmetic.set(h, []);
          cosmetic.get(h).push(sel);
        }
        continue;
      }
      if (line.includes('#@#') || line.includes('#$#')) continue;
      let exception = false, rest = line;
      if (rest.startsWith('@@')) { exception = true; rest = rest.slice(2); }
      let pattern = rest, optStr = '';
      const dollar = rest.lastIndexOf('$');
      if (dollar > 0 && /^[a-z0-9,=~|_.\-]+$/i.test(rest.slice(dollar + 1))) {
        pattern = rest.slice(0, dollar); optStr = rest.slice(dollar + 1);
      }
      if (!pattern) continue;
      const opts = { thirdParty: null, types: [], important: false, domains: [] };
      for (const part of optStr.split(',').filter(Boolean)) {
        const neg = part.startsWith('~'), name = neg ? part.slice(1) : part;
        if (name === 'third-party' || name === '3p') opts.thirdParty = !neg;
        else if (name === 'first-party' || name === '1p') opts.thirdParty = neg;
        else if (name === 'important') opts.important = true;
        else if (name.startsWith('domain=')) {
          for (const d of name.slice(7).split('|')) {
            if (d.startsWith('~')) opts.domains.push([d.slice(1), false]);
            else opts.domains.push([d, true]);
          }
        } else if (['script', 'image', 'stylesheet', 'xhr', 'font', 'media', 'document'].includes(name)) {
          opts.types.push([name, !neg]);
        }
      }
      rules.push({ pattern, exception, opts });
    }
    return { rules, cosmetic };
  }

  function createEngine(listTexts) {
    const rules = [], cosmetic = new Map();
    for (const text of listTexts) {
      const parsed = parseList(text);
      rules.push(...parsed.rules);
      for (const [h, sels] of parsed.cosmetic) {
        if (!cosmetic.has(h)) cosmetic.set(h, []);
        cosmetic.get(h).push(...sels);
      }
    }
    function check(url, sourceHost, kind = 'other') {
      const urlHost = hostOf(url);
      const thirdParty = sourceHost
        ? !(urlHost === sourceHost || urlHost.endsWith('.' + sourceHost) || sourceHost.endsWith('.' + urlHost))
        : false;
      let blocked = false, important = false, excepted = false;
      for (const rule of rules) {
        if (rule.opts.thirdParty !== null && rule.opts.thirdParty !== thirdParty) continue;
        if (rule.opts.types.length) {
          const pos = rule.opts.types.filter(([, p]) => p).map(([t]) => t);
          const negTypes = rule.opts.types.filter(([, p]) => !p).map(([t]) => t);
          if (pos.length && !pos.includes(kind)) continue;
          if (negTypes.includes(kind)) continue;
        }
        if (rule.opts.domains.length) {
          const hasPos = rule.opts.domains.some(([, p]) => p);
          const inc = rule.opts.domains.some(([d, p]) => p && (sourceHost === d || sourceHost.endsWith('.' + d)));
          const exc = rule.opts.domains.some(([d, p]) => !p && (sourceHost === d || sourceHost.endsWith('.' + d)));
          if (exc || (hasPos && !inc)) continue;
        }
        if (!patternMatches(rule.pattern, url)) continue;
        if (rule.exception) excepted = true;
        else if (rule.opts.important) important = true;
        else blocked = true;
      }
      return important || (blocked && !excepted);
    }
    function cosmeticCss(host) {
      const sels = [...(cosmetic.get('') || [])];
      let h = host;
      while (h) {
        sels.push(...(cosmetic.get(h) || []));
        const dot = h.indexOf('.');
        h = dot < 0 ? '' : h.slice(dot + 1);
      }
      return sels.length ? sels.join(', ') + ' { display: none !important; }' : '';
    }
    return {
      check, cosmeticCss,
      stats: { network: rules.length, cosmetic: [...cosmetic.values()].reduce((a, v) => a + v.length, 0) },
    };
  }

  return { createEngine, patternMatches, parseList };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FILTERS;
