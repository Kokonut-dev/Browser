// Phantom chrome application. Rendering is a pure function of backend state;
// interactions call backend methods (Local model here, Rust over IPC on desktop).
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let backend;
let state = null;
let settings;
let filterEngine = null;
let filterListTexts = {}; // list url -> text (bundled preloaded)
const shieldsByTab = new Map(); // tabId -> { blocked, allowed, log: [{url, blocked}] }
const blockedHttpByTab = new Map(); // tabId -> { url, httpsUrl }
const FRAME_BLOCKING_HOSTS = ['google.com', 'www.google.com', 'youtube.com', 'www.youtube.com', 'github.com', 'x.com', 'twitter.com', 'facebook.com', 'instagram.com', 'netflix.com', 'amazon.com', 'www.amazon.com', 'chatgpt.com', 'claude.ai'];

function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } }
function hueForHost(host) { let h = 0; for (const c of host) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }

function faviconHtml(tab, sizeClass = 'tab-letter') {
  if (tab.url.startsWith('phantom://')) return `<span class="${sizeClass}" style="background:hsl(var(--space-hue) 60% 42%)">◐</span>`;
  const host = hostOf(tab.url);
  const letter = (host.replace(/^www\./, '')[0] || '?').toUpperCase();
  // Locally generated letter tiles: fetching favicons from a third-party
  // service would leak every host you visit. Phantom doesn't do that.
  return `<span class="${sizeClass}" style="background:hsl(${hueForHost(host)} 45% 42%)">${esc(letter)}</span>`;
}

function toast(msg, actionLabel, onAction) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (actionLabel) {
    const b = document.createElement('button');
    b.textContent = actionLabel;
    b.onclick = () => { onAction?.(); el.remove(); };
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 5200);
}

// ---------------- Backend wiring ----------------

function onState(next) {
  state = next;
  render();
}

function initBackend() {
  if (NATIVE) {
    backend = new NativeBackend(onState);
    window.__phantomReceive = (msg) => {
      if (msg.t === 'shields') {
        const s = shieldsByTab.get(msg.tab) || { blocked: 0, allowed: 0, log: [] };
        s.blocked = msg.blocked; s.allowed = msg.allowed;
        s.log.unshift({ url: msg.lastUrl, blocked: msg.lastBlocked });
        s.log = s.log.slice(0, 60);
        shieldsByTab.set(msg.tab, s);
        renderShieldsBadge();
        if (!$('#shields-popover').hidden) renderShieldsPopover();
        return;
      }
      if (msg.t === 'https-blocked') {
        blockedHttpByTab.set(msg.tab, { url: msg.url, httpsUrl: msg.httpsUrl });
        render();
        return;
      }
      if (msg.t === 'relayout') { sendLayout(); return; }
      backend.receive(msg);
    };
    settings = backend.settings;
    backend.send({ t: 'ready' });
  } else {
    backend = new LocalBackend(onState);
    settings = backend.settings;
    onState(deepClone(backend.model));
  }
}

function activeSpaceObj() { return state?.spaces.find((s) => s.id === state.activeSpace) || null; }
function tabById(id) {
  if (!state) return null;
  for (const s of state.spaces) { const t = s.tabs.find((t) => t.id === id); if (t) return t; }
  return null;
}
function activeTab() { return state?.activeTab != null ? tabById(state.activeTab) : null; }

// ---------------- Navigation ----------------

function navigateInput(tabId, input) {
  const outcome = resolveInput(input, settings);
  if (outcome.kind === 'blocked-http') {
    blockedHttpByTab.set(tabId, { url: outcome.url, httpsUrl: outcome.httpsUrl });
    render();
    return;
  }
  blockedHttpByTab.delete(tabId);
  countMainFrame(tabId, outcome.url);
  backend.navigateTab(tabId, outcome.url);
}

function openInput(input, zone = 'today', activate = true) {
  const outcome = resolveInput(input, settings);
  if (outcome.kind === 'blocked-http') {
    const id = NATIVE ? null : backend.openTab('phantom://newtab', zone, activate);
    if (id != null) { blockedHttpByTab.set(id, { url: outcome.url, httpsUrl: outcome.httpsUrl }); render(); }
    else if (NATIVE) backend.openTab(outcome.url, zone, activate); // Rust shows the interstitial
    return;
  }
  if (NATIVE) { backend.openTab(outcome.url, zone, activate); return; }
  const id = backend.openTab(outcome.url, zone, activate);
  if (id != null) countMainFrame(id, outcome.url);
}

function countMainFrame(tabId, url) {
  if (!filterEngine || !settings.shieldsEnabled) return;
  const host = hostOf(url);
  const s = shieldsByTab.get(tabId) || { blocked: 0, allowed: 0, log: [] };
  const blocked = filterEngine.check(url, '', 'document');
  blocked ? s.blocked++ : s.allowed++;
  s.log.unshift({ url, blocked, main: true, host });
  s.log = s.log.slice(0, 60);
  shieldsByTab.set(tabId, s);
  renderShieldsBadge();
}

// ---------------- Rendering ----------------

function applyTheme() {
  const app = $('#app');
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  app.classList.toggle('theme-dark', dark);
  app.classList.toggle('theme-light', !dark);
  app.classList.toggle('sidebar-right', settings.sidebarPosition === 'right');
  app.classList.toggle('sidebar-hidden', !settings.sidebarVisible);
  const sp = activeSpaceObj();
  app.style.setProperty('--space-hue', sp ? sp.hue : settings.accentHue);
}

function tabRowHtml(tab) {
  const isActive = tab.id === state.activeTab;
  const inSplit = state.split.includes(tab.id) && state.split.length > 1;
  return `<button class="tab-row${isActive ? ' active' : ''}" draggable="true" data-tab="${tab.id}" title="${esc(tab.title || tab.url)}">
    ${tab.loading ? '<span class="tab-spinner"></span>' : `<span class="tab-favicon">${faviconHtml(tab)}</span>`}
    <span class="tab-title">${esc(tab.title || prettyUrl(tab.url))}</span>
    ${inSplit ? '<span class="split-dot" title="In split view"></span>' : ''}
    <span class="tab-close" data-close="${tab.id}" title="Archive tab">✕</span>
  </button>`;
}

function prettyUrl(url) {
  if (url.startsWith('phantom://')) return url.replace('phantom://', 'Phantom · ').replace('newtab', 'New Tab').replace('settings', 'Settings');
  try { const u = new URL(url); return (u.hostname + (u.pathname !== '/' ? u.pathname : '')).slice(0, 42); }
  catch { return url.slice(0, 42); }
}

function renderSidebar() {
  const sp = activeSpaceObj();
  const favs = sp ? sp.tabs.filter((t) => t.zone === 'favorite') : [];
  const pinned = sp ? sp.tabs.filter((t) => t.zone === 'pinned') : [];
  const today = sp ? sp.tabs.filter((t) => t.zone === 'today') : [];

  $('#favorites').innerHTML = favs.map((t) => `
    <button class="fav-tile${t.id === state.activeTab ? ' active' : ''}" data-tab="${t.id}" draggable="true" title="${esc(t.title || t.url)}">
      ${faviconHtml(t, 'fav-letter')}
    </button>`).join('');
  $('#pinned-label').style.display = pinned.length ? '' : 'none';
  $('#pinned-list').innerHTML = pinned.map(tabRowHtml).join('');
  $('#today-list').innerHTML = today.map(tabRowHtml).join('');
  $('#today-hint').textContent = settings.archiveAfterMinutes > 0
    ? `auto-archives after ${formatMinutes(settings.archiveAfterMinutes)}`
    : 'kept until closed';

  $('#spaces-strip').innerHTML = state.spaces.map((s) => `
    <button class="space-chip${s.id === state.activeSpace ? ' active' : ''}" data-space="${s.id}" title="${esc(s.name)} — isolated cookies & storage">
      <span class="space-dot" style="background:hsl(${s.hue} 75% 62%)"></span>${esc(s.name)}
    </button>`).join('') + `<button class="space-chip space-add" id="btn-space-add" title="New Space">+</button>`;

  const at = activeTab();
  $('#url-text').textContent = at ? prettyUrl(at.url) : 'phantom://newtab';
  $('#url-lock').textContent = !at || at.url.startsWith('phantom://') ? '◐' : (at.url.startsWith('https://') ? '🔒' : '⚠');
  renderShieldsBadge();
  bindTabEvents();
}

function formatMinutes(m) {
  if (m >= 1440) return `${Math.round(m / 1440)}d`;
  if (m >= 60) return `${Math.round(m / 60)}h`;
  return `${m}m`;
}

function renderShieldsBadge() {
  const at = activeTab();
  const s = at ? shieldsByTab.get(at.id) : null;
  $('#shields-count').textContent = settings.shieldsEnabled ? String(s?.blocked ?? 0) : 'off';
}

function renderPanes() {
  const wrap = $('#panes');
  const ids = (state.split.length ? state.split : (state.activeTab != null ? [state.activeTab] : []));
  wrap.className = ids.length === 4 ? 'grid-2x2' : '';
  if (!ids.length) {
    wrap.innerHTML = `<section class="pane"><div class="internal">${newTabHtml(null)}</div></section>`;
    bindInternalEvents(wrap);
    return;
  }
  // Preserve iframes across re-renders so pages don't reload on every keystroke of state.
  const existing = new Map();
  wrap.querySelectorAll('.pane').forEach((p) => existing.set(Number(p.dataset.tab), p));
  const next = [];
  for (const id of ids) {
    const tab = tabById(id);
    if (!tab) continue;
    let pane = existing.get(id);
    const isInternal = tab.url.startsWith('phantom://') || blockedHttpByTab.has(id);
    if (pane && pane.dataset.url === tab.url && pane.dataset.internal === String(isInternal)) {
      // keep as-is (iframe state preserved)
    } else {
      pane = buildPane(tab, ids.length > 1);
    }
    pane.classList.toggle('focused', tab.id === state.activeTab);
    pane.querySelector('.pane-head')?.remove();
    if (ids.length > 1) pane.prepend(paneHead(tab));
    next.push(pane);
  }
  wrap.replaceChildren(...next);
  bindInternalEvents(wrap);
  sendLayout();
}

function paneHead(tab) {
  const head = document.createElement('div');
  head.className = 'pane-head';
  head.innerHTML = `<span class="tab-favicon">${faviconHtml(tab)}</span>
    <span class="pane-title">${esc(tab.title || prettyUrl(tab.url))}</span>
    <button class="icon-btn sm" data-unsplit="${tab.id}" title="Remove from split">✕</button>`;
  head.querySelector('[data-unsplit]').onclick = () => backend.toggleSplit(tab.id);
  head.onclick = (e) => { if (!e.target.closest('button[data-unsplit]')) backend.activateTab(tab.id); };
  return head;
}

function buildPane(tab) {
  const pane = document.createElement('section');
  pane.className = 'pane';
  pane.dataset.tab = tab.id;
  pane.dataset.url = tab.url;
  const blockedInfo = blockedHttpByTab.get(tab.id);
  if (blockedInfo) {
    pane.dataset.internal = 'true';
    pane.innerHTML = `<div class="internal">${interstitialHtml(tab, blockedInfo)}</div>`;
    return pane;
  }
  if (tab.url.startsWith('phantom://')) {
    pane.dataset.internal = 'true';
    const page = tab.url.replace('phantom://', '').split(/[?#]/)[0];
    const html = page === 'settings' ? settingsHtml(tab) : newTabHtml(tab);
    pane.innerHTML = `<div class="internal">${html}</div>`;
    return pane;
  }
  pane.dataset.internal = 'false';
  if (NATIVE) {
    pane.innerHTML = '<div class="pane-hole"></div>';
    return pane;
  }
  const frame = document.createElement('iframe');
  frame.src = tab.url;
  frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
  frame.addEventListener('load', () => {
    let title = '';
    try { title = frame.contentDocument?.title || ''; } catch { /* cross-origin: title stays hostname-derived */ }
    backend.setTabInfo(tab.id, { loading: false, title: title || tab.title });
  });
  pane.appendChild(frame);
  const host = hostOf(tab.url);
  if (FRAME_BLOCKING_HOSTS.includes(host)) {
    const note = document.createElement('div');
    note.className = 'pane-blocked-note';
    note.innerHTML = `<span>${esc(host)} refuses to be embedded in this preview. It loads normally in desktop Phantom.</span>
      <a href="${esc(tab.url)}" target="_blank" rel="noreferrer">Open externally ↗</a>`;
    pane.appendChild(note);
  }
  return pane;
}

function sendLayout() {
  if (!NATIVE || !state) return;
  requestAnimationFrame(() => {
    const panes = $$('#panes .pane').filter((p) => p.dataset.internal !== 'true').map((p) => {
      const r = p.getBoundingClientRect();
      const head = p.querySelector('.pane-head');
      const headH = head ? head.getBoundingClientRect().height : 0;
      return { tab: Number(p.dataset.tab), x: r.left, y: r.top + headH, w: r.width, h: r.height - headH };
    });
    backend.send({ t: 'layout', panes });
  });
}

function render() {
  if (!state) return;
  applyTheme();
  renderSidebar();
  renderPanes();
}

// ---------------- Internal pages ----------------

function newTabHtml(tab) {
  const sp = activeSpaceObj();
  const quick = sp ? sp.tabs.filter((t) => t.zone !== 'today' || t !== tab) : [];
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const e = filterEngine?.stats;
  return `
    <div class="newtab-clock">${esc(time)}</div>
    <div class="newtab-date">${esc(date)} · ${esc(sp?.name || '')} Space</div>
    <h1><span class="newtab-mark">◐</span></h1>
    <p>Press <kbd>${modKey()}+T</kbd> and type — a tab, a URL, or a search. Everything else is optional.</p>
    ${quick.length ? `<h2>In this Space</h2><div class="quick-grid">${quick.map((t) => `
      <button class="quick-card" data-open-tab="${t.id}">
        <div class="qc-title">${esc(t.title || prettyUrl(t.url))}</div>
        <div class="qc-url">${esc(prettyUrl(t.url))}</div>
      </button>`).join('')}</div>` : ''}
    <div class="privacy-strip">
      <span class="privacy-chip">Telemetry <b>none · ever</b></span>
      <span class="privacy-chip">Filter rules <b>${e ? (e.network + e.cosmetic).toLocaleString() : '…'}</b></span>
      <span class="privacy-chip">History <b>${settings.historyEnabled ? 'on (your choice)' : 'off'}</b></span>
      <span class="privacy-chip">HTTPS-Only <b>${settings.httpsMode === 'only' ? 'on' : settings.httpsMode}</b></span>
      <span class="privacy-chip">Fingerprint defense <b>${settings.fingerprint}</b></span>
      <span class="privacy-chip">DNS <b>${settings.dohUrl ? 'DoH (your resolver)' : 'system'}</b></span>
    </div>
    <h2>Keyboard</h2>
    <p>${Object.entries(settings.keybindings).slice(0, 8).map(([k, v]) => `<kbd>${esc(prettyBinding(v))}</kbd> ${esc(k.replace(/([A-Z])/g, ' $1').toLowerCase())}`).join(' &nbsp;·&nbsp; ')}</p>
    <p style="margin-top:10px">Verify Phantom's defenses yourself:
      <a href="#" data-open-url="https://coveryourtracks.eff.org">coveryourtracks.eff.org</a> ·
      <a href="#" data-open-url="https://browserleaks.com">browserleaks.com</a></p>`;
}

function interstitialHtml(tab, info) {
  const host = hostOf(info.url);
  return `<div class="interstitial">
    <div class="int-ico">⛨</div>
    <h1>HTTP blocked</h1>
    <p style="margin-top:10px">Phantom stopped a cleartext connection. Anything sent to
    <span class="mono">${esc(info.url)}</span> — passwords, cookies, page contents —
    could be read or modified by anyone between you and the site.</p>
    <div class="int-actions">
      <button class="btn primary" data-https-go="${tab.id}">Continue to HTTPS version</button>
      <button class="btn" data-http-once="${tab.id}">Proceed over HTTP once</button>
      <button class="btn danger" data-http-always="${tab.id}">Always allow ${esc(host)}</button>
    </div>
    <p style="margin-top:16px;font-size:12px">HTTPS-Only mode is on. Manage exceptions in
    <a href="#" data-open-url="phantom://settings">Settings › Privacy</a>.</p>
  </div>`;
}

let settingsSection = 'privacy';
function settingsHtml() {
  const nav = [['privacy', 'Privacy & Shields'], ['appearance', 'Appearance'], ['search', 'Search & DNS'], ['filters', 'Filter lists'], ['keybindings', 'Keybindings'], ['data', 'Data']]
    .map(([id, label]) => `<button data-settings-nav="${id}" class="${settingsSection === id ? 'active' : ''}">${label}</button>`).join('');
  return `<h1>Settings</h1>
    <p style="margin:6px 0 22px">Stored locally on this machine. Nothing here is synced, reported, or analyzed.</p>
    <div class="settings-layout">
      <div class="settings-nav">${nav}</div>
      <div class="settings-main">${settingsSectionHtml()}</div>
    </div>`;
}

function toggleRow(key, title, desc) {
  return `<div class="setting-row"><div class="sr-text"><div class="sr-title">${title}</div><div class="sr-desc">${desc}</div></div>
    <label class="toggle"><input type="checkbox" data-setting="${key}" ${settings[key] ? 'checked' : ''}><span class="track"></span></label></div>`;
}
function selectRow(key, title, desc, options) {
  return `<div class="setting-row"><div class="sr-text"><div class="sr-title">${title}</div><div class="sr-desc">${desc}</div></div>
    <select data-setting="${key}">${options.map(([v, l]) => `<option value="${esc(v)}" ${settings[key] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
}

function settingsSectionHtml() {
  if (settingsSection === 'privacy') {
    return `
      ${toggleRow('shieldsEnabled', 'Phantom Shields', 'Block ads, trackers, and annoyances with the built-in filter engine. No extension, nothing leaves the machine.')}
      ${selectRow('httpsMode', 'HTTPS mode', 'Only: block cleartext HTTP with a warning. Upgrade: silently rewrite to HTTPS. Off: allow HTTP.', [['only', 'HTTPS-Only'], ['upgrade', 'Upgrade automatically'], ['off', 'Off']])}
      <div class="setting-row"><div class="sr-text"><div class="sr-title">HTTP exceptions</div>
      <div class="sr-desc">Hosts allowed over cleartext HTTP. One per line. Currently: ${settings.httpsExceptions.length ? esc(settings.httpsExceptions.join(', ')) : 'none'}.</div></div>
      <button class="btn" data-action="edit-exceptions">Edit…</button></div>
      ${selectRow('fingerprint', 'Fingerprinting defense', 'Randomize: per-site seeded noise for canvas/audio/WebGL (Brave-style). Uniform: identical values for every Phantom user (Mullvad-style). Off: not recommended.', [['randomize', 'Randomize per site'], ['uniform', 'Uniform for all users'], ['off', 'Off']])}
      ${selectRow('webrtc', 'WebRTC', 'Prevents WebRTC from leaking your local/public IP around a VPN. “No non-proxied UDP” keeps calls working over VPNs/Tor transports.', [['no-non-proxied-udp', 'No non-proxied UDP'], ['disabled', 'Disabled entirely'], ['default', 'Default (may leak IP)']])}
      ${toggleRow('blockThirdPartyCookies', 'Block third-party cookies', 'Cookies are also isolated per Space — your Work login can’t see your Personal sites.')}
      ${toggleRow('historyEnabled', 'Save browsing history', 'Off by default, forever opt-in. History only ever lives in the local database and powers command-bar suggestions.')}
      <div class="setting-row"><div class="sr-text"><div class="sr-title">Auto-archive Today tabs</div>
      <div class="sr-desc">Today tabs you haven’t touched move to the archive (restorable, never deleted silently).</div></div>
      <select data-setting="archiveAfterMinutes">${[[0, 'Never'], [60, 'After 1 hour'], [720, 'After 12 hours'], [1440, 'After 24 hours'], [10080, 'After 7 days']].map(([v, l]) => `<option value="${v}" ${Number(settings.archiveAfterMinutes) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
  }
  if (settingsSection === 'appearance') {
    const sp = activeSpaceObj();
    const hues = [262, 222, 190, 150, 95, 45, 20, 340, 300];
    return `
      ${selectRow('theme', 'Theme', 'Phantom ships designed dark and light themes. System follows your OS appearance live.', [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']])}
      ${selectRow('sidebarPosition', 'Sidebar position', 'Left is the classic Phantom layout; right suits some tiling setups.', [['left', 'Left'], ['right', 'Right']])}
      <div class="setting-row"><div class="sr-text"><div class="sr-title">“${esc(sp?.name || '')}” Space color</div>
      <div class="sr-desc">Each Space tints the whole window so you always know where you are.</div></div>
      <div class="hue-row">${hues.map((h) => `<button class="hue-dot${sp?.hue === h ? ' selected' : ''}" data-hue="${h}" style="background:hsl(${h} 75% 60%)" title="Hue ${h}"></button>`).join('')}</div></div>
      <div class="setting-row"><div class="sr-text"><div class="sr-title">Rename Space</div><div class="sr-desc">Spaces are containers: separate cookies, storage, and tabs.</div></div>
      <input type="text" class="field" id="space-name-field" value="${esc(sp?.name || '')}" style="width:150px">
      <button class="btn" data-action="rename-space">Rename</button></div>
      <div class="setting-row"><div class="sr-text"><div class="sr-title">Delete this Space</div><div class="sr-desc">Its tabs close; pinned/favorite URLs are moved to the archive first.</div></div>
      <button class="btn danger" data-action="delete-space">Delete Space</button></div>`;
  }
  if (settingsSection === 'search') {
    return `
      <div class="setting-row"><div class="sr-text"><div class="sr-title">Search engine</div>
      <div class="sr-desc">Used when the command bar input isn’t a URL. No suggestions are fetched as you type — that would leak keystrokes.</div></div>
      <select data-setting="searchTemplate">${SEARCH_ENGINES.map((e) => `<option value="${esc(e.template)}" ${settings.searchTemplate === e.template ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></div>
      <div class="setting-row"><div class="sr-text"><div class="sr-title">DNS-over-HTTPS resolver</div>
      <div class="sr-desc">Empty = your system resolver. Phantom has no hardcoded provider; whatever you enter is the only resolver used.</div></div>
      <input type="url" class="field" data-setting="dohUrl" value="${esc(settings.dohUrl)}" placeholder="https://dns.example/dns-query" style="width:260px"></div>`;
  }
  if (settingsSection === 'filters') {
    const e = filterEngine?.stats;
    return `<p style="margin-bottom:8px">Active engine: <b>${e ? e.network.toLocaleString() : 0}</b> network rules,
      <b>${e ? e.cosmetic.toLocaleString() : 0}</b> cosmetic rules. Lists are downloaded only when you press Update — never on a schedule.</p>
      ${settings.filterLists.map((l, i) => `
      <div class="filter-list-row">
        <label class="toggle"><input type="checkbox" data-filter-toggle="${i}" ${l.enabled ? 'checked' : ''}><span class="track"></span></label>
        <div class="fl-name">${esc(l.name)}<div class="fl-url">${esc(l.url)}</div></div>
        ${l.url.startsWith('bundled://') ? '' : `<button class="btn" data-filter-update="${i}">Update</button>
        <button class="btn danger" data-filter-remove="${i}">Remove</button>`}
      </div>`).join('')}
      <div class="setting-row"><div class="sr-text"><div class="sr-title">Add custom list</div>
      <div class="sr-desc">Any ABP/uBlock-syntax list URL.</div></div>
      <input type="text" class="field" id="fl-new-name" placeholder="Name" style="width:120px">
      <input type="url" class="field" id="fl-new-url" placeholder="https://…" style="width:200px">
      <button class="btn" data-action="add-filter-list">Add</button></div>
      <div class="setting-row"><div class="sr-text"><div class="sr-title">Test the engine</div>
      <div class="sr-desc">Check any URL against the active rules right now.</div></div>
      <input type="url" class="field" id="fl-test-url" placeholder="https://tracker.example/pixel" style="width:240px">
      <input type="text" class="field" id="fl-test-src" placeholder="from site (optional)" style="width:150px">
      <button class="btn" data-action="test-filter">Test</button>
      <span id="fl-test-result"></span></div>`;
  }
  if (settingsSection === 'keybindings') {
    const labels = { commandBar: 'Command bar / new tab', toggleSidebar: 'Toggle sidebar', shields: 'Shields panel', closeTab: 'Archive tab', reopenTab: 'Reopen archived tab', split: 'Split with next tab', littlePhantom: 'Little Phantom window', reload: 'Reload', focusUrl: 'Edit URL', nextSpace: 'Next Space', prevSpace: 'Previous Space', nextTab: 'Next tab', prevTab: 'Previous tab', settings: 'Settings', pinTab: 'Pin / unpin tab', find: 'Find in page' };
    return `<p style="margin-bottom:10px">Click a binding, then press the new key combination. “Mod” is ⌘ on macOS, Ctrl elsewhere.</p>
      <table class="kb-table">${Object.entries(settings.keybindings).map(([k, v]) => `
        <tr><td>${esc(labels[k] || k)}</td><td><button class="kb-capture" data-kb="${k}">${esc(prettyBinding(v))}</button></td></tr>`).join('')}
      </table>
      <div style="margin-top:14px"><button class="btn" data-action="reset-keybindings">Reset to defaults</button></div>`;
  }
  // data
  return `
    <div class="setting-row"><div class="sr-text"><div class="sr-title">Export settings</div><div class="sr-desc">A JSON file you can move between machines yourself. No cloud involved.</div></div>
    <button class="btn" data-action="export-settings">Export</button></div>
    <div class="setting-row"><div class="sr-text"><div class="sr-title">Import settings</div><div class="sr-desc">Replace current settings with a previously exported file.</div></div>
    <button class="btn" data-action="import-settings">Import…</button></div>
    <div class="setting-row"><div class="sr-text"><div class="sr-title">Export bookmarks</div><div class="sr-desc">Favorites and pinned tabs across all Spaces, as a standard HTML bookmark file.</div></div>
    <button class="btn" data-action="export-bookmarks">Export</button></div>
    <div class="setting-row"><div class="sr-text"><div class="sr-title">Import bookmarks</div><div class="sr-desc">From a Firefox / Chrome / Brave HTML export. Imported as pinned tabs in this Space.</div></div>
    <button class="btn" data-action="import-bookmarks">Import…</button></div>
    <div class="setting-row"><div class="sr-text"><div class="sr-title">Clear archive</div><div class="sr-desc">${state.archive.length} archived tab(s). Closing a tab archives it; this actually forgets them.</div></div>
    <button class="btn danger" data-action="clear-archive">Clear</button></div>
    <div class="setting-row"><div class="sr-text"><div class="sr-title">Reset Phantom</div><div class="sr-desc">Spaces, tabs, settings — everything returns to first-run state.</div></div>
    <button class="btn danger" data-action="reset-all">Reset everything</button></div>`;
}

function modKey() { return navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'; }
function prettyBinding(b) { return b.replace('Mod', modKey()).replace('Shift', navigator.platform.includes('Mac') ? '⇧' : 'Shift'); }

// ---------------- Internal page events ----------------

function bindInternalEvents(root) {
  root.querySelectorAll('[data-open-tab]').forEach((el) => {
    el.onclick = () => backend.activateTab(Number(el.dataset.openTab));
  });
  root.querySelectorAll('[data-open-url]').forEach((el) => {
    el.onclick = (e) => { e.preventDefault(); openInput(el.dataset.openUrl); };
  });
  root.querySelectorAll('[data-https-go]').forEach((el) => {
    el.onclick = () => { const id = Number(el.dataset.httpsGo); const info = blockedHttpByTab.get(id); blockedHttpByTab.delete(id); if (info) backend.navigateTab(id, info.httpsUrl); };
  });
  root.querySelectorAll('[data-http-once]').forEach((el) => {
    el.onclick = () => { const id = Number(el.dataset.httpOnce); const info = blockedHttpByTab.get(id); blockedHttpByTab.delete(id); if (info) backend.navigateTab(id, info.url); };
  });
  root.querySelectorAll('[data-http-always]').forEach((el) => {
    el.onclick = () => {
      const id = Number(el.dataset.httpAlways); const info = blockedHttpByTab.get(id);
      if (info) { settings.httpsExceptions.push(hostOf(info.url)); saveSettings(); blockedHttpByTab.delete(id); backend.navigateTab(id, info.url); }
    };
  });
  root.querySelectorAll('[data-settings-nav]').forEach((el) => {
    el.onclick = () => { settingsSection = el.dataset.settingsNav; rerenderSettingsPanes(); };
  });
  root.querySelectorAll('[data-setting]').forEach((el) => {
    const key = el.dataset.setting;
    el.onchange = () => {
      let val = el.type === 'checkbox' ? el.checked : el.value;
      if (key === 'archiveAfterMinutes') val = Number(val);
      settings[key] = val;
      saveSettings();
      applyTheme();
      if (['shieldsEnabled'].includes(key)) renderShieldsBadge();
      if (key === 'archiveAfterMinutes') renderSidebar();
    };
  });
  root.querySelectorAll('[data-hue]').forEach((el) => {
    el.onclick = () => { const sp = activeSpaceObj(); if (sp) { backend.renameSpace(sp.id, null, Number(el.dataset.hue)); } };
  });
  root.querySelectorAll('[data-filter-toggle]').forEach((el) => {
    el.onchange = async () => {
      const list = settings.filterLists[Number(el.dataset.filterToggle)];
      list.enabled = el.checked;
      if (list.enabled && !filterListTexts[list.url]) await fetchFilterList(list, false);
      rebuildFilterEngine(); saveSettings(); rerenderSettingsPanes();
    };
  });
  root.querySelectorAll('[data-filter-update]').forEach((el) => {
    el.onclick = async () => {
      const list = settings.filterLists[Number(el.dataset.filterUpdate)];
      await fetchFilterList(list, true);
      rebuildFilterEngine(); rerenderSettingsPanes();
    };
  });
  root.querySelectorAll('[data-filter-remove]').forEach((el) => {
    el.onclick = () => { settings.filterLists.splice(Number(el.dataset.filterRemove), 1); rebuildFilterEngine(); saveSettings(); rerenderSettingsPanes(); };
  });
  root.querySelectorAll('[data-kb]').forEach((el) => {
    el.onclick = () => captureKeybinding(el);
  });
  root.querySelectorAll('[data-action]').forEach((el) => {
    el.onclick = () => handleSettingsAction(el.dataset.action, root);
  });
}

function rerenderSettingsPanes() {
  // Rebuild only settings panes (cheap; they're DOM).
  $$('#panes .pane').forEach((p) => {
    const tab = tabById(Number(p.dataset.tab));
    if (tab?.url === 'phantom://settings') { p.dataset.url = ''; }
  });
  renderPanes();
}

function saveSettings() { backend.saveSettings(); }

async function fetchFilterList(list, force) {
  if (list.url.startsWith('bundled://')) return;
  if (filterListTexts[list.url] && !force) return;
  try {
    const res = await fetch(list.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    filterListTexts[list.url] = await res.text();
    try { localStorage.setItem('phantom.filter.' + list.url, filterListTexts[list.url]); } catch {}
    toast(`${list.name} updated`);
  } catch (e) {
    toast(`Couldn't fetch ${list.name}: ${e.message}`);
  }
}

function rebuildFilterEngine() {
  const texts = settings.filterLists.filter((l) => l.enabled).map((l) => filterListTexts[l.url]).filter(Boolean);
  filterEngine = FILTERS.createEngine(texts);
}

function handleSettingsAction(action, root) {
  const sp = activeSpaceObj();
  switch (action) {
    case 'rename-space': {
      const name = root.querySelector('#space-name-field')?.value.trim();
      if (sp && name) backend.renameSpace(sp.id, name);
      break;
    }
    case 'delete-space': if (sp) { backend.removeSpace(sp.id); toast('Space deleted'); } break;
    case 'edit-exceptions': {
      const next = prompt('Hosts allowed over HTTP (one per line):', settings.httpsExceptions.join('\n'));
      if (next !== null) { settings.httpsExceptions = next.split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean); saveSettings(); rerenderSettingsPanes(); }
      break;
    }
    case 'add-filter-list': {
      const name = root.querySelector('#fl-new-name')?.value.trim();
      const url = root.querySelector('#fl-new-url')?.value.trim();
      if (url) { settings.filterLists.push({ name: name || url, url, enabled: true }); saveSettings(); fetchFilterList(settings.filterLists.at(-1), true).then(() => { rebuildFilterEngine(); rerenderSettingsPanes(); }); }
      break;
    }
    case 'test-filter': {
      const url = root.querySelector('#fl-test-url')?.value.trim();
      const src = root.querySelector('#fl-test-src')?.value.trim() || '';
      const out = root.querySelector('#fl-test-result');
      if (!url || !out) break;
      const blocked = filterEngine?.check(url, src, 'script');
      out.textContent = blocked ? '⛨ Blocked' : 'Allowed';
      out.style.color = blocked ? 'var(--ok)' : 'var(--text-dim)';
      break;
    }
    case 'reset-keybindings':
      settings.keybindings = deepClone(DEFAULT_SETTINGS.keybindings);
      saveSettings(); rerenderSettingsPanes(); break;
    case 'export-settings': download('phantom-settings.json', JSON.stringify(settings, null, 2), 'application/json'); break;
    case 'import-settings': pickFile(async (text) => {
      try { Object.assign(settings, JSON.parse(text)); saveSettings(); rebuildFilterEngine(); render(); toast('Settings imported'); }
      catch { toast('That file isn’t a Phantom settings export'); }
    }); break;
    case 'export-bookmarks': {
      const items = [];
      for (const s of state.spaces) for (const t of s.tabs) {
        if (t.zone !== 'today' && !t.url.startsWith('phantom://')) items.push(`<DT><A HREF="${esc(t.url)}">${esc(t.title || t.url)}</A>`);
      }
      download('phantom-bookmarks.html', `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<TITLE>Phantom Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${items.join('\n')}\n</DL><p>\n`, 'text/html');
      break;
    }
    case 'import-bookmarks': pickFile((text) => {
      const re = /href="([^"]+)"[^>]*>([^<]*)</gi;
      let m, count = 0;
      while ((m = re.exec(text))) {
        if (/^https?:\/\//.test(m[1])) { backend.openTab(m[1], 'pinned', false); count++; }
      }
      toast(count ? `Imported ${count} bookmark(s) as pinned tabs` : 'No bookmarks found in that file');
    }); break;
    case 'clear-archive':
      if (!NATIVE) { backend.model.archive = []; backend.emit(); }
      toast('Archive cleared'); break;
    case 'reset-all':
      if (confirm('Reset Phantom completely? Spaces, tabs, and settings will be gone.')) {
        localStorage.removeItem(STORE_MODEL); localStorage.removeItem(STORE_SETTINGS);
        location.reload();
      } break;
  }
}

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function pickFile(cb) {
  const input = document.createElement('input');
  input.type = 'file';
  input.onchange = async () => { const f = input.files[0]; if (f) cb(await f.text()); };
  input.click();
}

// ---------------- Sidebar events ----------------

let previewTimer = null;
function bindTabEvents() {
  $$('#sidebar [data-tab]').forEach((el) => {
    const id = Number(el.dataset.tab);
    el.onclick = (e) => {
      if (e.target.closest('[data-close]')) return;
      backend.activateTab(id);
      hidePreview();
    };
    el.oncontextmenu = (e) => { e.preventDefault(); showTabContextMenu(id, e.clientX, e.clientY); };
    el.addEventListener('mouseenter', () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => showPreview(id, el), 500);
    });
    el.addEventListener('mouseleave', () => { clearTimeout(previewTimer); hidePreview(); });
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/phantom-tab', String(id));
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
      hidePreview();
    });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); $$('.tab-row').forEach((r) => r.classList.remove('drop-above', 'drop-below')); });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const above = e.clientY < rect.top + rect.height / 2;
      el.classList.toggle('drop-above', above);
      el.classList.toggle('drop-below', !above);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-above', 'drop-below'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const draggedId = Number(e.dataTransfer.getData('text/phantom-tab'));
      if (!draggedId || draggedId === id) return;
      const targetList = el.closest('#pinned-list') ? 'pinned' : el.closest('#favorites') ? 'favorite' : 'today';
      const sp = activeSpaceObj();
      const rect = el.getBoundingClientRect();
      const above = e.clientY < rect.top + rect.height / 2;
      const targetIdx = sp.tabs.findIndex((t) => t.id === id) + (above ? 0 : 1);
      backend.setZone(draggedId, targetList);
      backend.reorderTab(draggedId, targetIdx);
    });
  });
  $$('#sidebar [data-close]').forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); archiveTabWithToast(Number(el.dataset.close)); };
  });
  $$('#spaces-strip [data-space]').forEach((el) => {
    const sid = Number(el.dataset.space);
    el.onclick = () => backend.switchSpace(sid);
    el.ondragover = (e) => e.preventDefault();
    el.ondrop = (e) => {
      e.preventDefault();
      const draggedId = Number(e.dataTransfer.getData('text/phantom-tab'));
      if (draggedId) { backend.moveTab(draggedId, sid, Number.MAX_SAFE_INTEGER); toast(`Moved to ${tabSpaceName(sid)}`); }
    };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Rename Space…', run: () => { const n = prompt('Space name:', tabSpaceName(sid)); if (n) backend.renameSpace(sid, n); } },
        { label: 'Space settings…', run: () => { backend.switchSpace(sid); openInput('phantom://settings'); settingsSection = 'appearance'; } },
        { sep: true },
        { label: 'Delete Space', danger: true, run: () => backend.removeSpace(sid) },
      ]);
    };
  });
  const addSpace = $('#btn-space-add');
  if (addSpace) addSpace.onclick = () => {
    const name = prompt('Name the new Space (it gets its own cookies & storage):', 'New Space');
    if (name) { const hues = [262, 222, 190, 150, 95, 45, 20, 340]; backend.addSpace(name, hues[state.spaces.length % hues.length]); }
  };
}

function tabSpaceName(sid) { return state.spaces.find((s) => s.id === sid)?.name || ''; }

function archiveTabWithToast(id) {
  const t = tabById(id);
  backend.closeTab(id);
  if (t && t.zone !== 'favorite') toast(`Archived “${(t.title || prettyUrl(t.url)).slice(0, 34)}”`, 'Undo', () => backend.restoreArchived());
}

// ---------------- Preview & context menus ----------------

function showPreview(id, anchor) {
  const tab = tabById(id);
  if (!tab || tab.id === state.activeTab) return;
  const pv = $('#tab-preview');
  const onRight = settings.sidebarPosition === 'right';
  const r = anchor.getBoundingClientRect();
  pv.innerHTML = `
    ${!NATIVE && !tab.url.startsWith('phantom://') ? `<div class="tp-frame"><iframe src="${esc(tab.url)}" tabindex="-1"></iframe></div>` : ''}
    <div class="tp-meta"><div class="tp-title">${esc(tab.title || prettyUrl(tab.url))}</div><div class="tp-url">${esc(tab.url)}</div></div>`;
  pv.hidden = false;
  pv.style.top = Math.min(r.top, innerHeight - 280) + 'px';
  if (onRight) { pv.style.right = '276px'; pv.style.left = 'auto'; }
  else { pv.style.left = '276px'; pv.style.right = 'auto'; }
}
function hidePreview() { $('#tab-preview').hidden = true; }

function showContextMenu(x, y, items) {
  const menu = $('#context-menu');
  menu.innerHTML = items.map((it, i) => it.sep ? '<div class="cm-sep"></div>'
    : `<button data-cm="${i}" class="${it.danger ? 'danger' : ''}"><span>${esc(it.label)}</span>${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ''}</button>`).join('');
  menu.hidden = false;
  menu.style.left = Math.min(x, innerWidth - 230) + 'px';
  menu.style.top = Math.min(y, innerHeight - items.length * 34 - 20) + 'px';
  menu.querySelectorAll('[data-cm]').forEach((b) => {
    b.onclick = () => { menu.hidden = true; items[Number(b.dataset.cm)].run(); };
  });
}

function showTabContextMenu(id, x, y) {
  const tab = tabById(id);
  if (!tab) return;
  const items = [
    { label: tab.zone === 'pinned' ? 'Unpin tab' : 'Pin tab', hint: prettyBinding(settings.keybindings.pinTab), run: () => backend.setZone(id, tab.zone === 'pinned' ? 'today' : 'pinned') },
    { label: tab.zone === 'favorite' ? 'Remove from Favorites' : 'Add to Favorites', run: () => backend.setZone(id, tab.zone === 'favorite' ? 'today' : 'favorite') },
    { label: state.split.includes(id) ? 'Remove from split' : 'Add to split view', run: () => backend.toggleSplit(id) },
    { label: 'Open in Little Phantom', run: () => openLittle(tab.url) },
    { sep: true },
    ...state.spaces.filter((s) => s.id !== state.activeSpace || !s.tabs.includes(tab)).map((s) => ({
      label: `Move to ${s.name}`, run: () => backend.moveTab(id, s.id, Number.MAX_SAFE_INTEGER),
    })),
    { sep: true },
    { label: 'Copy URL', run: () => navigator.clipboard?.writeText(tab.url).then(() => toast('URL copied')) },
    { label: 'Reload', run: () => reloadTab(id) },
    { label: 'Archive tab', hint: prettyBinding(settings.keybindings.closeTab), danger: true, run: () => archiveTabWithToast(id) },
  ];
  showContextMenu(x, y, items);
}

function reloadTab(id) {
  if (NATIVE) { backend.send({ t: 'reload', tab: id }); return; }
  const pane = $(`#panes .pane[data-tab="${id}"] iframe`);
  if (pane) { const src = pane.src; pane.src = src; backend.setTabInfo(id, { loading: true }); }
  else backend.navigateTab(id, tabById(id)?.url || '');
}
function navHistory(id, dir) {
  if (NATIVE) { backend.send({ t: dir < 0 ? 'back' : 'forward', tab: id }); return; }
  const frame = $(`#panes .pane[data-tab="${id}"] iframe`);
  try { dir < 0 ? frame.contentWindow.history.back() : frame.contentWindow.history.forward(); } catch { toast('History navigation needs the desktop build for cross-origin pages'); }
}

// ---------------- Command bar ----------------

let cbSelection = 0;
let cbItems = [];

const COMMANDS = [
  { title: 'New Tab', kind: 'Action', run: () => openInput('phantom://newtab') },
  { title: 'New Space…', kind: 'Action', run: () => $('#btn-space-add')?.click() },
  { title: 'Open Settings', kind: 'Action', run: () => openInput('phantom://settings') },
  { title: 'Toggle Sidebar', kind: 'Action', run: () => { settings.sidebarVisible = !settings.sidebarVisible; saveSettings(); applyTheme(); } },
  { title: 'Toggle Theme (Dark / Light)', kind: 'Action', run: () => { settings.theme = settings.theme === 'dark' ? 'light' : 'dark'; saveSettings(); applyTheme(); } },
  { title: 'Reopen Last Archived Tab', kind: 'Action', run: () => backend.restoreArchived() },
  { title: 'Little Phantom Window', kind: 'Action', run: () => openLittle(activeTab()?.url || 'https://example.org') },
  { title: 'Clear All Today Tabs', kind: 'Action', run: clearTodayTabs },
];

function clearTodayTabs() {
  const sp = activeSpaceObj();
  if (!sp) return;
  const ids = sp.tabs.filter((t) => t.zone === 'today' && t.id !== state.activeTab).map((t) => t.id);
  ids.forEach((id) => backend.closeTab(id));
  toast(`Archived ${ids.length} Today tab(s)`);
}

function openCommandBar(initial = '') {
  const overlay = $('#command-overlay');
  overlay.hidden = false;
  const input = $('#cb-input');
  input.value = initial;
  updateCommandResults();
  requestAnimationFrame(() => { input.focus(); input.select(); });
}
function closeCommandBar() {
  $('#command-overlay').hidden = true;
  $('#cb-input').blur(); // don't leave focus trapped in a hidden field
}

function markedTitle(title, positions) {
  if (!positions?.length) return esc(title);
  const set = new Set(positions);
  return [...title].map((c, i) => set.has(i) ? `<mark>${esc(c)}</mark>` : esc(c)).join('');
}

function updateCommandResults() {
  const q = $('#cb-input').value.trim();
  const wrap = $('#cb-results');
  cbItems = [];
  let html = '';

  const surface = backend.searchSurface();
  const ranked = q ? FUZZY.rank(q, surface, (e) => `${e.title} ${e.url}`) : surface.map((item) => ({ item, hit: null }));
  const openTabs = ranked.filter((r) => r.item.tab != null).slice(0, 8);
  const archived = ranked.filter((r) => r.item.tab == null).slice(0, 4);
  const commands = q ? FUZZY.rank(q, COMMANDS, (c) => c.title) : COMMANDS.map((item) => ({ item, hit: null }));

  const addSection = (label, rows) => {
    if (!rows.length) return;
    html += `<div class="cb-section">${label}</div>`;
    for (const r of rows) {
      const idx = cbItems.length;
      cbItems.push(r.item);
      html += `<button class="cb-row" data-cb="${idx}">
        <span class="cb-title">${r.hit ? markedTitle(r.item.title, r.hit.positions.filter((p) => p < r.item.title.length)) : esc(r.item.title)}</span>
        ${r.item.url ? `<span class="cb-url">${esc(prettyUrl(r.item.url))}</span>` : ''}
        <span class="cb-kind">${esc(r.item.spaceName || r.item.kind || 'Tab')}</span>
      </button>`;
    }
  };
  addSection('Tabs', openTabs);
  addSection('Archive', archived);
  addSection('Actions', commands.slice(0, 5));

  if (q) {
    const outcome = resolveInput(q, settings);
    const label = looksLikeUrl(q) ? `Go to ${q}` : `Search for “${q}”`;
    const idx = cbItems.length;
    cbItems.push({ title: label, url: outcome.kind === 'blocked-http' ? outcome.url : outcome.url, goTo: q });
    html += `<div class="cb-section">Navigate</div>
      <button class="cb-row" data-cb="${idx}"><span class="cb-title">↵ ${esc(label)}</span><span class="cb-kind">Web</span></button>`;
  }

  wrap.innerHTML = html || '<div class="cb-section">No matches</div>';
  cbSelection = Math.min(cbSelection, Math.max(0, cbItems.length - 1));
  paintCbSelection();
  wrap.querySelectorAll('[data-cb]').forEach((el) => {
    el.onmouseenter = () => { cbSelection = Number(el.dataset.cb); paintCbSelection(); };
    el.onclick = (e) => runCbItem(cbItems[Number(el.dataset.cb)], e);
  });
}

function paintCbSelection() {
  $$('#cb-results .cb-row').forEach((el) => el.classList.toggle('selected', Number(el.dataset.cb) === cbSelection));
  $(`#cb-results [data-cb="${cbSelection}"]`)?.scrollIntoView({ block: 'nearest' });
}

function runCbItem(item, e = {}) {
  if (!item) return;
  closeCommandBar();
  if (item.run) { item.run(); return; }
  if (item.goTo !== undefined) {
    if (e.shiftKey) openLittle(resolveInput(item.goTo, settings).url);
    else openInput(item.goTo);
    return;
  }
  if (item.tab != null && !(e.metaKey || e.ctrlKey)) backend.activateTab(item.tab);
  else if (item.url) openInput(item.url);
}

// ---------------- Shields & archive popovers ----------------

function renderShieldsPopover() {
  const at = activeTab();
  const pop = $('#shields-popover');
  const s = at ? (shieldsByTab.get(at.id) || { blocked: 0, allowed: 0, log: [] }) : { blocked: 0, allowed: 0, log: [] };
  const host = at ? (hostOf(at.url) || at.url) : '—';
  const e = filterEngine?.stats;
  pop.innerHTML = `
    <h3>⛨ Phantom Shields</h3>
    <div class="sub">For <b>${esc(host)}</b> · ${settings.shieldsEnabled ? 'up — blocking with the built-in engine' : 'DOWN — you turned Shields off'}</div>
    <div class="shield-stats">
      <div class="shield-stat"><div class="n">${s.blocked}</div><div class="l">Blocked</div></div>
      <div class="shield-stat"><div class="n">${s.allowed}</div><div class="l">Allowed</div></div>
      <div class="shield-stat"><div class="n">${e ? (e.network + e.cosmetic).toLocaleString() : 0}</div><div class="l">Rules armed</div></div>
    </div>
    <div class="sub">
      Fingerprinting: <b>${esc(settings.fingerprint)}</b> · WebRTC: <b>${esc(settings.webrtc)}</b> ·
      3p cookies: <b>${settings.blockThirdPartyCookies ? 'blocked' : 'allowed'}</b> ·
      Space container: <b>${esc(activeSpaceObj()?.name || '')}</b>
    </div>
    ${s.log.length ? `<div class="shield-list">${s.log.slice(0, 14).map((r) => `
      <div class="shield-item"><span class="dot" style="background:${r.blocked ? 'var(--ok)' : 'rgba(150,150,165,.5)'}"></span>
      <span class="u">${r.blocked ? 'Blocked' : 'Allowed'} · ${esc(r.url.slice(0, 90))}</span></div>`).join('')}</div>`
    : `<div class="sub" style="margin-top:8px">No requests judged yet on this tab.${NATIVE ? '' : ' Subresource-level reporting runs in the desktop build; here the engine judges navigations (try the tester in Settings › Filter lists).'}</div>`}
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn" id="shields-settings">Shields settings…</button>
      <button class="btn" id="shields-toggle">${settings.shieldsEnabled ? 'Lower Shields' : 'Raise Shields'}</button>
    </div>`;
  pop.querySelector('#shields-toggle').onclick = () => {
    settings.shieldsEnabled = !settings.shieldsEnabled;
    saveSettings(); renderShieldsBadge(); renderShieldsPopover();
  };
  pop.querySelector('#shields-settings').onclick = () => {
    pop.hidden = true; settingsSection = 'privacy'; openInput('phantom://settings');
  };
}

function toggleShieldsPopover() {
  const pop = $('#shields-popover');
  if (!pop.hidden) { pop.hidden = true; return; }
  renderShieldsPopover();
  const pill = $('#url-pill').getBoundingClientRect();
  pop.hidden = false;
  if (settings.sidebarPosition === 'right') { pop.style.right = '14px'; pop.style.left = 'auto'; }
  else { pop.style.left = '14px'; pop.style.right = 'auto'; }
  pop.style.top = (pill.bottom + 8) + 'px';
}

function toggleArchivePopover() {
  const pop = $('#archive-popover');
  if (!pop.hidden) { pop.hidden = true; return; }
  pop.innerHTML = `<h3>🗄 Archived tabs</h3>
    <div class="sub">Closing never deletes — it archives. Click to restore.</div>
    ${state.archive.length ? `<div class="shield-list">${state.archive.slice(0, 30).map((a, i) => `
      <div class="shield-item"><span class="u" style="flex:1">${esc(a.title || a.url)}</span>
      <button class="btn" data-restore="${i}">Restore</button></div>`).join('')}</div>`
    : '<div class="sub" style="margin-top:8px">Nothing archived yet.</div>'}`;
  pop.hidden = false;
  pop.style.left = settings.sidebarPosition === 'right' ? 'auto' : '14px';
  pop.style.right = settings.sidebarPosition === 'right' ? '14px' : 'auto';
  pop.style.bottom = '64px'; pop.style.top = 'auto';
  pop.querySelectorAll('[data-restore]').forEach((b) => {
    b.onclick = () => {
      const a = state.archive[Number(b.dataset.restore)];
      if (!a) return;
      if (!NATIVE) { backend.model.archive.splice(Number(b.dataset.restore), 1); }
      openInput(a.url);
      pop.hidden = true;
    };
  });
}

// ---------------- Little Phantom ----------------

let littleZ = 55;
function openLittle(url) {
  const outcome = resolveInput(url, settings);
  const finalUrl = outcome.kind === 'blocked-http' ? outcome.httpsUrl : outcome.url;
  if (NATIVE) { backend.send({ t: 'little', url: finalUrl }); toast('Little Phantom opened'); return; }
  const layer = $('#little-layer');
  const win = document.createElement('div');
  win.className = 'little-win';
  const offset = (layer.children.length % 5) * 26;
  win.style.left = (innerWidth - 440 - offset) + 'px';
  win.style.top = (70 + offset) + 'px';
  win.style.zIndex = ++littleZ;
  win.innerHTML = `
    <div class="little-head">
      <span style="color:var(--accent)">◐</span>
      <span class="little-title">${esc(prettyUrl(finalUrl))} · ephemeral</span>
      <button class="icon-btn sm" data-little-promote title="Keep as a Today tab">↗</button>
      <button class="icon-btn sm" data-little-close title="Close (nothing is kept)">✕</button>
    </div>
    <iframe src="${esc(finalUrl)}" referrerpolicy="no-referrer"></iframe>`;
  win.querySelector('[data-little-close]').onclick = () => win.remove();
  win.querySelector('[data-little-promote]').onclick = () => { openInput(finalUrl); win.remove(); toast('Kept as a Today tab'); };
  win.onmousedown = () => { win.style.zIndex = ++littleZ; };
  const head = win.querySelector('.little-head');
  head.onmousedown = (e) => {
    if (e.target.closest('button')) return;
    const startX = e.clientX - win.offsetLeft, startY = e.clientY - win.offsetTop;
    const move = (ev) => { win.style.left = (ev.clientX - startX) + 'px'; win.style.top = (ev.clientY - startY) + 'px'; };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  };
  layer.appendChild(win);
}

// ---------------- Keyboard ----------------

function bindingFromEvent(e) {
  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = e.key;
  if (key === ' ') key = 'Space';
  if (key.length === 1) key = key.toUpperCase();
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(key)) return null;
  parts.push(key);
  return parts.join('+');
}

function captureKeybinding(el) {
  const action = el.dataset.kb;
  el.classList.add('listening');
  el.textContent = 'press keys…';
  const handler = (e) => {
    e.preventDefault(); e.stopPropagation();
    const b = bindingFromEvent(e);
    if (!b) return;
    // Evict duplicates so every binding stays unique.
    for (const k of Object.keys(settings.keybindings)) if (settings.keybindings[k] === b) settings.keybindings[k] = '';
    settings.keybindings[action] = b;
    saveSettings();
    el.classList.remove('listening');
    el.textContent = prettyBinding(b);
    removeEventListener('keydown', handler, true);
  };
  addEventListener('keydown', handler, true);
  setTimeout(() => { removeEventListener('keydown', handler, true); el.classList.remove('listening'); if (el.textContent === 'press keys…') el.textContent = prettyBinding(settings.keybindings[action]); }, 6000);
}

const ACTIONS = {
  commandBar: () => openCommandBar(),
  toggleSidebar: () => { settings.sidebarVisible = !settings.sidebarVisible; saveSettings(); applyTheme(); },
  shields: () => toggleShieldsPopover(),
  closeTab: () => { if (state.activeTab != null) archiveTabWithToast(state.activeTab); },
  reopenTab: () => backend.restoreArchived(),
  split: () => {
    const sp = activeSpaceObj(); if (!sp) return;
    const next = sp.tabs.find((t) => t.id !== state.activeTab && !state.split.includes(t.id));
    if (next) backend.toggleSplit(next.id);
    else if (state.split.length > 1) backend.toggleSplit(state.split[state.split.length - 1]);
  },
  littlePhantom: () => openLittle(activeTab()?.url || 'https://example.org'),
  reload: () => { if (state.activeTab != null) reloadTab(state.activeTab); },
  focusUrl: () => startUrlEdit(),
  nextSpace: () => cycleSpace(1),
  prevSpace: () => cycleSpace(-1),
  nextTab: () => cycleTab(1),
  prevTab: () => cycleTab(-1),
  settings: () => openInput('phantom://settings'),
  pinTab: () => { const t = activeTab(); if (t) backend.setZone(t.id, t.zone === 'pinned' ? 'today' : 'pinned'); },
  find: () => { $('#find-bar').hidden = false; $('#find-input').focus(); $('#find-input').select(); },
};

function cycleSpace(dir) {
  const i = state.spaces.findIndex((s) => s.id === state.activeSpace);
  const next = state.spaces[(i + dir + state.spaces.length) % state.spaces.length];
  backend.switchSpace(next.id);
}
function cycleTab(dir) {
  const sp = activeSpaceObj(); if (!sp?.tabs.length) return;
  const i = sp.tabs.findIndex((t) => t.id === state.activeTab);
  backend.activateTab(sp.tabs[(i + dir + sp.tabs.length) % sp.tabs.length].id);
}

function onGlobalKeydown(e) {
  if (!$('#command-overlay').hidden) {
    if (e.key === 'Escape') closeCommandBar();
    else if (e.key === 'ArrowDown') { e.preventDefault(); cbSelection = Math.min(cbSelection + 1, cbItems.length - 1); paintCbSelection(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cbSelection = Math.max(cbSelection - 1, 0); paintCbSelection(); }
    else if (e.key === 'Enter') { e.preventDefault(); runCbItem(cbItems[cbSelection], e); }
    else if (e.key === 'Tab') { e.preventDefault(); cbSelection = (cbSelection + (e.shiftKey ? -1 : 1) + cbItems.length) % cbItems.length; paintCbSelection(); }
    return;
  }
  if (e.key === 'Escape') {
    $('#context-menu').hidden = true;
    $('#shields-popover').hidden = true;
    $('#archive-popover').hidden = true;
    $('#find-bar').hidden = true;
    hidePreview();
    return;
  }
  if (e.altKey && e.key === 'ArrowLeft' && state.activeTab != null) { navHistory(state.activeTab, -1); return; }
  if (e.altKey && e.key === 'ArrowRight' && state.activeTab != null) { navHistory(state.activeTab, 1); return; }
  if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
    const sp = activeSpaceObj();
    const t = sp?.tabs[Number(e.key) - 1];
    if (t) { e.preventDefault(); backend.activateTab(t.id); }
    return;
  }
  const b = bindingFromEvent(e);
  if (!b) return;
  for (const [action, binding] of Object.entries(settings.keybindings)) {
    if (binding && binding === b) {
      // Don't hijack browser-default editing keys inside text fields,
      // but command bar / sidebar toggles must work from anywhere.
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
      if (inField && !['commandBar', 'toggleSidebar', 'find'].includes(action)) return;
      e.preventDefault();
      ACTIONS[action]?.();
      return;
    }
  }
}

// ---------------- URL pill ----------------

function startUrlEdit() {
  const at = activeTab(); if (!at) return;
  const pill = $('#url-pill');
  if (pill.querySelector('.url-input')) return;
  const textEl = $('#url-text');
  const input = document.createElement('input');
  input.className = 'url-input';
  input.value = at.url.startsWith('phantom://') ? '' : at.url;
  input.placeholder = 'Search or enter URL';
  textEl.replaceWith(input);
  input.focus(); input.select();
  const finish = (commit) => {
    const value = input.value.trim();
    const span = document.createElement('span');
    span.id = 'url-text'; span.className = 'url-text';
    input.replaceWith(span);
    if (commit && value) navigateInput(at.id, value);
    renderSidebar();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  };
  input.onblur = () => { if (document.body.contains(input)) finish(false); };
}

// ---------------- Find ----------------

function doFind() {
  const term = $('#find-input').value;
  const countEl = $('#find-count');
  if (!term) { countEl.textContent = ''; return; }
  const pane = $(`#panes .pane.focused`) || $('#panes .pane');
  const internal = pane?.querySelector('.internal');
  if (internal) {
    const matches = (internal.innerText.toLowerCase().split(term.toLowerCase()).length - 1);
    countEl.textContent = `${matches} match${matches === 1 ? '' : 'es'}`;
    window.find?.(term, false, false, true);
    return;
  }
  const frame = pane?.querySelector('iframe');
  try {
    const found = frame.contentWindow.find(term, false, false, true);
    countEl.textContent = found ? 'found' : 'not found';
  } catch { countEl.textContent = NATIVE ? '' : 'preview: n/a'; }
}

// ---------------- Boot ----------------

function initFilterEngine() {
  const bundled = window.__PHANTOM_FILTERS__ || '||doubleclick.net^\n||google-analytics.com^\n||googlesyndication.com^\n||connect.facebook.net^$third-party\n##.cookie-banner\n##.adsbygoogle\n';
  filterListTexts['bundled://base'] = bundled;
  for (const l of settings.filterLists) {
    if (l.url.startsWith('bundled://')) continue;
    try { const cached = localStorage.getItem('phantom.filter.' + l.url); if (cached) filterListTexts[l.url] = cached; } catch {}
  }
  rebuildFilterEngine();
}

function init() {
  initBackend();
  initFilterEngine();
  render();

  $('#btn-newtab').onclick = () => openCommandBar();
  $('#btn-add-today').onclick = () => openCommandBar();
  $('#btn-little').onclick = () => openLittle(activeTab()?.url || 'https://example.org');
  $('#btn-settings').onclick = () => openInput('phantom://settings');
  $('#btn-archive').onclick = () => toggleArchivePopover();
  $('#btn-shields').onclick = (e) => { e.stopPropagation(); toggleShieldsPopover(); };
  $('#btn-back').onclick = () => state.activeTab != null && navHistory(state.activeTab, -1);
  $('#btn-forward').onclick = () => state.activeTab != null && navHistory(state.activeTab, 1);
  $('#btn-reload').onclick = () => state.activeTab != null && reloadTab(state.activeTab);
  $('#url-pill').onclick = (e) => { if (!e.target.closest('#btn-shields')) startUrlEdit(); };
  $('#sidebar-edge').onclick = () => { settings.sidebarVisible = true; saveSettings(); applyTheme(); };
  $('#cb-input').addEventListener('input', () => { cbSelection = 0; updateCommandResults(); });
  $('#command-overlay').addEventListener('mousedown', (e) => { if (e.target.id === 'command-overlay') closeCommandBar(); });
  $('#find-close').onclick = () => { $('#find-bar').hidden = true; };
  $('#find-input').addEventListener('input', doFind);
  $('#find-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doFind(); e.stopPropagation(); });

  document.addEventListener('keydown', onGlobalKeydown);
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#context-menu')) $('#context-menu').hidden = true;
    if (!e.target.closest('#shields-popover') && !e.target.closest('#btn-shields')) $('#shields-popover').hidden = true;
    if (!e.target.closest('#archive-popover') && !e.target.closest('#btn-archive')) $('#archive-popover').hidden = true;
  });
  addEventListener('resize', sendLayout);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (settings.theme === 'system') applyTheme(); });

  // Auto-archive sweep (preview model; Rust does this natively on desktop).
  if (!NATIVE) setInterval(() => backend.sweepArchive?.(), 60_000);

  // First run: the DNS choice Phantom refuses to make for you.
  if (!settings.dohChoiceMade) {
    $('#firstrun-overlay').hidden = false;
    $$('.doh-option').forEach((btn) => {
      btn.onclick = () => {
        const v = btn.dataset.doh;
        settings.dohChoiceMade = true;
        if (v === 'custom') { settingsSection = 'search'; openInput('phantom://settings'); }
        else settings.dohUrl = v;
        saveSettings();
        $('#firstrun-overlay').hidden = true;
        toast(v ? 'DoH resolver set — change it anytime in Settings' : 'Using your system resolver');
      };
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
