// Scripts injected into every content webview at document-start.

/// Reports page lifecycle (title/URL) back to the shell and intercepts the
/// network APIs pages use for trackers, consulting the blocked-host set the
/// Rust filter engine exported. Hard main-frame decisions stay in Rust.
pub fn bridge_js(blocked_hosts_json: &str) -> String {
    format!(r#"
(() => {{
  const BLOCKED = new Set({blocked_hosts_json});
  const isBlocked = (u) => {{
    try {{
      const h = new URL(u, location.href).hostname.toLowerCase();
      for (const b of BLOCKED) if (h === b || h.endsWith('.' + b)) return true;
    }} catch (e) {{}}
    return false;
  }};
  const report = (kind, url) => window.ipc.postMessage(JSON.stringify(
    {{ t: 'resource', kind, url: String(url), host: location.hostname }}));

  const origFetch = window.fetch;
  window.fetch = function (input, init) {{
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (isBlocked(url)) {{ report('fetch-blocked', url); return Promise.reject(new TypeError('blocked by Phantom')); }}
    report('fetch', url);
    return origFetch.apply(this, arguments);
  }};
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {{
    if (isBlocked(url)) {{ report('xhr-blocked', url); throw new Error('blocked by Phantom'); }}
    report('xhr', url);
    return origOpen.apply(this, arguments);
  }};
  if (navigator.sendBeacon) {{
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => {{
      if (isBlocked(url)) {{ report('beacon-blocked', url); return true; }}
      report('beacon', url);
      return origBeacon(url, data);
    }};
  }}
  // window.open → Little Phantom / new Today tab, decided by the shell.
  window.open = (url) => {{
    window.ipc.postMessage(JSON.stringify({{ t: 'window-open', url: String(url || 'about:blank') }}));
    return null;
  }};
  const notify = () => window.ipc.postMessage(JSON.stringify(
    {{ t: 'page', url: location.href, title: document.title }}));
  window.addEventListener('DOMContentLoaded', notify);
  window.addEventListener('load', notify);
  new MutationObserver(notify).observe(document.documentElement, {{ subtree: true, childList: true }});
}})();
"#)
}
