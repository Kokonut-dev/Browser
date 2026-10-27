// State layer. Two backends, one shape (the shape phantom-app sends):
// { spaces, activeSpace, activeTab, split, archive }.
//  - NativeBackend: window.ipc exists (desktop build) — Rust owns the model.
//  - LocalBackend:  standalone chrome — this file mirrors model.rs semantics.
'use strict';

const deepClone = typeof structuredClone === 'function' ? structuredClone : (o) => JSON.parse(JSON.stringify(o));

const NATIVE = typeof window !== 'undefined' && !!window.ipc;

const SEARCH_ENGINES = [
  { name: 'DuckDuckGo (HTML)', template: 'https://html.duckduckgo.com/html/?q={query}' },
  { name: 'Startpage', template: 'https://www.startpage.com/sp/search?query={query}' },
  { name: 'Mojeek', template: 'https://www.mojeek.com/search?q={query}' },
  { name: 'Kagi', template: 'https://kagi.com/search?q={query}' },
  { name: 'Brave Search', template: 'https://search.brave.com/search?q={query}' },
];

const DEFAULT_SETTINGS = {
  theme: 'dark',           // dark | light | system
  accentHue: 262,
  sidebarPosition: 'left', // left | right
  sidebarVisible: true,
  httpsMode: 'only',       // only | upgrade | off
  httpsExceptions: [],
  webrtc: 'no-non-proxied-udp',
  fingerprint: 'randomize', // randomize | uniform | off
  blockThirdPartyCookies: true,
  shieldsEnabled: true,
  historyEnabled: false,
  archiveAfterMinutes: 720,
  dohUrl: '',               // '' = system resolver (user's first-run choice)
  dohChoiceMade: false,
  searchTemplate: SEARCH_ENGINES[0].template,
  filterLists: [
    { name: 'Phantom Base (bundled)', url: 'bundled://base', enabled: true },
    { name: 'EasyList', url: 'https://easylist.to/easylist/easylist.txt', enabled: false },
    { name: 'EasyPrivacy', url: 'https://easylist.to/easylist/easyprivacy.txt', enabled: false },
    { name: "Peter Lowe's Ad server list", url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&mimetype=plaintext', enabled: false },
  ],
  keybindings: {
    commandBar: 'Mod+T', toggleSidebar: 'Mod+S', shields: 'Mod+Shift+S',
    closeTab: 'Mod+W', reopenTab: 'Mod+Shift+T', split: 'Mod+\\',
    littlePhantom: 'Mod+Shift+N', reload: 'Mod+R', focusUrl: 'Mod+L',
    nextSpace: 'Mod+Shift+]', prevSpace: 'Mod+Shift+[',
    nextTab: 'Mod+]', prevTab: 'Mod+[', settings: 'Mod+,',
    pinTab: 'Mod+Shift+P', find: 'Mod+F',
  },
};

const STORE_MODEL = 'phantom.model.v1';
const STORE_SETTINGS = 'phantom.settings.v1';

function seedModel() {
  let nextId = 1;
  const id = () => nextId++;
  const mk = (url, title, zone) => ({ id: id(), url, title, zone, loading: false });
  const personal = { id: id(), name: 'Personal', icon: '◐', hue: 262, tabs: [
    mk('https://html.duckduckgo.com/html/', 'DuckDuckGo', 'favorite'),
    mk('https://en.wikipedia.org/wiki/Special:Random', 'Wikipedia', 'favorite'),
    mk('https://www.openstreetmap.org/export/embed.html', 'OpenStreetMap', 'pinned'),
    mk('https://example.org', 'Example Domain', 'today'),
    mk('phantom://newtab', 'New Tab', 'today'),
  ]};
  const work = { id: id(), name: 'Work', icon: '◆', hue: 210, tabs: [
    mk('https://developer.mozilla.org', 'MDN Web Docs', 'favorite'),
    mk('https://github.com', 'GitHub', 'pinned'),
    mk('phantom://newtab', 'New Tab', 'today'),
  ]};
  const reading = { id: id(), name: 'Reading', icon: '☷', hue: 150, tabs: [
    mk('https://info.cern.ch', 'info.cern.ch — the first website', 'today'),
  ]};
  const activeTab = personal.tabs[personal.tabs.length - 1].id;
  return {
    _nextId: nextId,
    spaces: [personal, work, reading],
    activeSpace: personal.id, activeTab, split: [activeTab],
    archive: [{ url: 'https://coveryourtracks.eff.org', title: 'Cover Your Tracks (EFF)' }],
  };
}

class LocalBackend {
  constructor(onState) {
    this.onState = onState;
    try {
      const raw = localStorage.getItem(STORE_MODEL);
      this.model = raw ? JSON.parse(raw) : seedModel();
    } catch { this.model = seedModel(); }
    try {
      const raw = localStorage.getItem(STORE_SETTINGS);
      this.settings = raw ? { ...deepClone(DEFAULT_SETTINGS), ...JSON.parse(raw) } : deepClone(DEFAULT_SETTINGS);
    } catch { this.settings = deepClone(DEFAULT_SETTINGS); }
  }
  emit() {
    try { localStorage.setItem(STORE_MODEL, JSON.stringify(this.model)); } catch {}
    this.onState(deepClone(this.model));
  }
  saveSettings() {
    try { localStorage.setItem(STORE_SETTINGS, JSON.stringify(this.settings)); } catch {}
  }
  alloc() { return this.model._nextId++; }
  space(id) { return this.model.spaces.find((s) => s.id === id); }
  tab(id) {
    for (const s of this.model.spaces) { const t = s.tabs.find((t) => t.id === id); if (t) return t; }
    return null;
  }
  openTab(url, zone = 'today', activate = true, spaceId = this.model.activeSpace) {
    const sp = this.space(spaceId); if (!sp) return null;
    const tab = { id: this.alloc(), url, title: '', zone, loading: true };
    const zoneRank = { favorite: 0, pinned: 1, today: 2 };
    let pos = sp.tabs.findIndex((t) => zoneRank[t.zone] > zoneRank[zone]);
    if (pos < 0) pos = sp.tabs.length;
    sp.tabs.splice(pos, 0, tab);
    if (activate) this.activateTab(tab.id, false);
    this.emit();
    return tab.id;
  }
  activateTab(id, emit = true) {
    const t = this.tab(id); if (!t) return;
    t.touchedAt = Date.now();
    const sp = this.model.spaces.find((s) => s.tabs.includes(t));
    if (sp) this.model.activeSpace = sp.id;
    this.model.activeTab = id;
    if (!this.model.split.includes(id)) this.model.split = [id];
    if (emit) this.emit();
  }
  navigateTab(id, url) {
    const t = this.tab(id); if (!t) return;
    t.url = url; t.loading = true;
    this.emit();
  }
  setTabInfo(id, { title, url, loading }) {
    const t = this.tab(id); if (!t) return;
    if (title !== undefined) t.title = title;
    if (url !== undefined) t.url = url;
    if (loading !== undefined) t.loading = loading;
    this.emit();
  }
  closeTab(id) {
    const t = this.tab(id); if (!t) return;
    const sp = this.model.spaces.find((s) => s.tabs.includes(t));
    sp.tabs = sp.tabs.filter((x) => x.id !== id);
    this.model.split = this.model.split.filter((x) => x !== id);
    if (t.zone !== 'favorite' && !t.url.startsWith('phantom://')) {
      this.model.archive.unshift({ url: t.url, title: t.title || t.url });
      this.model.archive = this.model.archive.slice(0, 200);
    }
    if (this.model.activeTab === id) {
      const next = sp.tabs[sp.tabs.length - 1];
      this.model.activeTab = next ? next.id : null;
      if (!this.model.split.length && next) this.model.split = [next.id];
    }
    this.emit();
  }
  setZone(id, zone) {
    const t = this.tab(id); if (!t) return;
    t.zone = zone;
    const sp = this.model.spaces.find((s) => s.tabs.includes(t));
    const zoneRank = { favorite: 0, pinned: 1, today: 2 };
    sp.tabs.sort((a, b) => zoneRank[a.zone] - zoneRank[b.zone]); // stable in JS engines
    this.emit();
  }
  moveTab(id, toSpaceId, index) {
    const t = this.tab(id); if (!t) return;
    const from = this.model.spaces.find((s) => s.tabs.includes(t));
    from.tabs = from.tabs.filter((x) => x.id !== id);
    const to = this.space(toSpaceId);
    to.tabs.splice(Math.min(index, to.tabs.length), 0, t);
    this.emit();
  }
  reorderTab(id, toIndex) {
    const t = this.tab(id); if (!t) return;
    const sp = this.model.spaces.find((s) => s.tabs.includes(t));
    sp.tabs = sp.tabs.filter((x) => x.id !== id);
    sp.tabs.splice(Math.min(toIndex, sp.tabs.length), 0, t);
    this.emit();
  }
  toggleSplit(id) {
    const s = this.model.split;
    const at = s.indexOf(id);
    if (at >= 0) { if (s.length > 1) s.splice(at, 1); }
    else if (s.length < 4) s.push(id);
    this.emit();
  }
  addSpace(name, hue) {
    const sp = { id: this.alloc(), name, icon: '●', hue, tabs: [] };
    this.model.spaces.push(sp);
    this.model.activeSpace = sp.id;
    this.model.activeTab = null; this.model.split = [];
    this.emit();
    return sp.id;
  }
  renameSpace(id, name, hue) {
    const sp = this.space(id); if (!sp) return;
    if (name) sp.name = name;
    if (hue !== undefined) sp.hue = hue;
    this.emit();
  }
  removeSpace(id) {
    if (this.model.spaces.length <= 1) return;
    const doomedSpace = this.space(id);
    if (doomedSpace) {
      for (const t of doomedSpace.tabs) {
        if (!t.url.startsWith('phantom://')) this.model.archive.unshift({ url: t.url, title: t.title || t.url });
      }
    }
    this.model.spaces = this.model.spaces.filter((s) => s.id !== id);
    if (this.model.activeSpace === id) {
      const first = this.model.spaces[0];
      this.model.activeSpace = first.id;
      const last = first.tabs[first.tabs.length - 1];
      this.model.activeTab = last ? last.id : null;
      this.model.split = last ? [last.id] : [];
    }
    this.emit();
  }
  switchSpace(id) {
    const sp = this.space(id); if (!sp) return;
    this.model.activeSpace = id;
    const last = sp.tabs[sp.tabs.length - 1];
    this.model.activeTab = last ? last.id : null;
    this.model.split = last ? [last.id] : [];
    this.emit();
  }
  sweepArchive() {
    const minutes = this.settings.archiveAfterMinutes;
    if (!minutes) return;
    const cutoff = Date.now() - minutes * 60_000;
    const doomed = [];
    for (const sp of this.model.spaces) {
      for (const t of sp.tabs) {
        if (t.zone === 'today' && (t.touchedAt || 0) < cutoff && t.id !== this.model.activeTab && !this.model.split.includes(t.id)) doomed.push(t.id);
      }
    }
    doomed.forEach((id) => this.closeTab(id));
  }
  restoreArchived() {
    const a = this.model.archive.shift();
    if (a) this.openTab(a.url, 'today', true);
  }
  searchSurface() {
    const out = [];
    for (const sp of this.model.spaces) {
      for (const t of sp.tabs) out.push({ title: t.title || t.url, url: t.url, tab: t.id, spaceName: sp.name });
    }
    for (const a of this.model.archive.slice(0, 50)) out.push({ title: a.title || a.url, url: a.url, tab: null, spaceName: 'Archive' });
    return out;
  }
}

class NativeBackend {
  constructor(onState) {
    this.onState = onState;
    // Chrome-side settings cache so first-run choices and preferences survive
    // relaunches; Rust also persists them in SQLite via the settings IPC.
    try {
      const raw = localStorage.getItem(STORE_SETTINGS);
      this.settings = raw ? { ...deepClone(DEFAULT_SETTINGS), ...JSON.parse(raw) } : deepClone(DEFAULT_SETTINGS);
    } catch { this.settings = deepClone(DEFAULT_SETTINGS); }
    this.model = null;
  }
  send(msg) { window.ipc.postMessage(JSON.stringify(msg)); }
  receive(msg) {
    if (msg.t === 'state') {
      this.model = msg;
      this.onState(msg);
    }
  }
  openTab(url, zone = 'today', activate = true, spaceId) {
    this.send({ t: 'open', url, zone, activate, space: spaceId ?? this.model?.activeSpace });
  }
  activateTab(id) { this.send({ t: 'activate', tab: id }); }
  navigateTab(id, url) { this.send({ t: 'navigate', tab: id, url }); }
  setTabInfo() { /* content webviews report directly to Rust */ }
  closeTab(id) { this.send({ t: 'close', tab: id }); }
  setZone(id, zone) { this.send({ t: 'zone', tab: id, zone }); }
  moveTab() { /* drag between spaces is sent as activate+open in native v1 */ }
  reorderTab() {}
  toggleSplit(id) { this.send({ t: 'split', tab: id }); }
  addSpace(name, hue) { this.send({ t: 'space-new', name, hue }); }
  renameSpace() {}
  removeSpace() {}
  switchSpace(id) { this.send({ t: 'space-switch', space: id }); }
  restoreArchived() { this.send({ t: 'restore' }); }
  saveSettings() {
    try { localStorage.setItem(STORE_SETTINGS, JSON.stringify(this.settings)); } catch {}
    this.send({ t: 'settings', settings: this.settings });
  }
  searchSurface() {
    if (!this.model) return [];
    const out = [];
    for (const sp of this.model.spaces) {
      for (const t of sp.tabs) out.push({ title: t.title || t.url, url: t.url, tab: t.id, spaceName: sp.name });
    }
    for (const a of this.model.archive || []) out.push({ title: a.title || a.url, url: a.url, tab: null, spaceName: 'Archive' });
    return out;
  }
  tab(id) {
    if (!this.model) return null;
    for (const s of this.model.spaces) { const t = s.tabs.find((t) => t.id === id); if (t) return t; }
    return null;
  }
  space(id) { return this.model?.spaces.find((s) => s.id === id) || null; }
}

// --- Shared policy helpers (mirror policy.rs) ---

function looksLikeUrl(input) {
  if (/\s/.test(input)) return false;
  if (input.includes('://')) return true;
  if (/^localhost([:/]|$)/.test(input)) return true;
  const host = input.split('/')[0].split(':')[0];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  const tld = host.split('.').pop();
  return host.includes('.') && tld.length >= 2 && /^[a-z]+$/i.test(tld);
}

function resolveInput(input, settings) {
  const value = input.trim();
  if (/^(phantom|about|data):/.test(value)) return { kind: 'allow', url: value };
  if (/^(javascript|vbscript|file):/i.test(value) || !looksLikeUrl(value)) {
    return { kind: 'search', url: settings.searchTemplate.replace('{query}', encodeURIComponent(value).replace(/%20/g, '+')) };
  }
  const withScheme = value.includes('://') ? value : 'https://' + value;
  return applyHttpsPolicy(withScheme, settings);
}

function applyHttpsPolicy(url, settings) {
  if (!url.startsWith('http://')) return { kind: 'allow', url };
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  const local = host === 'localhost' || host.endsWith('.local') || /^(127\.|192\.168\.|10\.)/.test(host);
  const excepted = (settings.httpsExceptions || []).includes(host);
  if (local || excepted || settings.httpsMode === 'off') return { kind: 'allow', url };
  const httpsUrl = 'https://' + url.slice('http://'.length);
  if (settings.httpsMode === 'upgrade') return { kind: 'allow', url: httpsUrl };
  return { kind: 'blocked-http', url, httpsUrl };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveInput, applyHttpsPolicy, looksLikeUrl, DEFAULT_SETTINGS, SEARCH_ENGINES };
}
