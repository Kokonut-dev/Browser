// Phantom shell: one tao window, a privileged chrome webview (the UI in
// ui/), and one child content webview per visible pane. WebKit provides the
// engine, sandboxing, and site isolation; phantom-core provides every
// privacy decision. The shell makes no network requests of its own.

mod content_script;
mod store;

use phantom_core::filter::{FilterEngine, Request as FilterRequest, ResourceType, Verdict};
use phantom_core::model::{BrowserModel, TabId, Zone};
use phantom_core::policy::{self, NavDecision, Settings};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tao::dpi::{LogicalPosition, LogicalSize};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::{Window, WindowBuilder, WindowId};
use wry::{Rect, WebView, WebViewBuilder};

#[derive(Debug)]
enum UserEvent {
    ChromeIpc(String),
    ContentIpc(TabId, String),
    SpawnLittle(String),
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn bundled_filter_lists() -> FilterEngine {
    // A starter ruleset ships in-tree so protection works offline on first run.
    // Full EasyList/EasyPrivacy are fetched only when the user presses Update
    // in Settings › Filter lists (no unsolicited connections, ever).
    FilterEngine::from_lists(&[include_str!("../../../assets/filters/base.txt")])
}

struct ContentView {
    view: WebView,
    blocked: u32,
    allowed: u32,
}

struct App {
    model: BrowserModel,
    settings: Settings,
    filters: FilterEngine,
    blocked_hosts_json: String,
    store: store::Store,
    chrome: WebView,
    content: HashMap<TabId, ContentView>,
    little_windows: HashMap<WindowId, (Window, WebView)>,
    session_key: u64,
}

impl App {
    fn push_chrome(&self, payload: Value) {
        let script = format!("window.__phantomReceive && window.__phantomReceive({});", payload);
        let _ = self.chrome.evaluate_script(&script);
    }

    fn state_payload(&self) -> Value {
        let spaces: Vec<Value> = self.model.spaces.iter().map(|s| json!({
            "id": s.id, "name": s.name, "icon": s.icon, "hue": s.hue,
            "tabs": s.tabs.iter().filter_map(|id| self.model.tabs.get(id)).map(|t| json!({
                "id": t.id, "url": t.url, "title": t.title,
                "zone": match t.zone { Zone::Favorite => "favorite", Zone::Pinned => "pinned", Zone::Today => "today" },
                "loading": t.loading,
            })).collect::<Vec<_>>(),
        })).collect();
        json!({
            "t": "state",
            "spaces": spaces,
            "activeSpace": self.model.active_space,
            "activeTab": self.model.active_tab,
            "split": self.model.split,
            "archive": self.model.archive.iter().rev().take(50)
                .map(|a| json!({"url": a.url, "title": a.title})).collect::<Vec<_>>(),
        })
    }

    fn sync_chrome(&self) { let p = self.state_payload(); self.push_chrome(p); }

    fn create_content(&mut self, window: &Window, tab: TabId, proxy: &EventLoopProxy<UserEvent>) {
        let Some(t) = self.model.tabs.get(&tab) else { return };
        let url = t.url.clone();
        let origin = url.split('/').take(3).collect::<Vec<_>>().join("/");
        let seed = policy::origin_seed(self.session_key, &origin);
        let shim = policy::fingerprint_shim_js(self.settings.fingerprint, seed);
        let bridge = content_script::bridge_js(&self.blocked_hosts_json);
        let p = proxy.clone();
        let host = phantom_core::policy::apply_https_policy(&url, &self.settings);
        let final_url = match host {
            NavDecision::Allow(u) | NavDecision::Search(u) => u,
            NavDecision::BlockHttp { https_url } => {
                self.push_chrome(json!({"t": "https-blocked", "tab": tab, "httpsUrl": https_url, "url": url}));
                "about:blank".to_string()
            }
        };
        let builder = WebViewBuilder::new_as_child(window)
            .with_bounds(Rect { position: LogicalPosition::new(0.0, 0.0).into(), size: LogicalSize::new(10.0, 10.0).into() })
            .with_url(&final_url)
            .with_initialization_script(&shim)
            .with_initialization_script(&bridge)
            .with_ipc_handler(move |req: wry::http::Request<String>| { let _ = p.send_event(UserEvent::ContentIpc(tab, req.body().clone())); });
        if let Ok(view) = builder.build() {
            self.content.insert(tab, ContentView { view, blocked: 0, allowed: 0 });
        }
    }

    fn handle_chrome_ipc(&mut self, window: &Window, raw: &str, proxy: &EventLoopProxy<UserEvent>) {
        let Ok(msg) = serde_json::from_str::<Value>(raw) else { return };
        let now = now_unix();
        match msg["t"].as_str().unwrap_or("") {
            "ready" => self.sync_chrome(),
            "open" => {
                let url = msg["url"].as_str().unwrap_or("").to_string();
                match policy::resolve_input(&url, &self.settings) {
                    NavDecision::Allow(u) | NavDecision::Search(u) => {
                        let zone = match msg["zone"].as_str() { Some("pinned") => Zone::Pinned, Some("favorite") => Zone::Favorite, _ => Zone::Today };
                        let space = msg["space"].as_u64().unwrap_or(self.model.active_space);
                        let id = self.model.open_tab(space, &u, zone, now, msg["activate"].as_bool().unwrap_or(true));
                        self.create_content(window, id, proxy);
                        self.sync_chrome();
                    }
                    NavDecision::BlockHttp { https_url } => {
                        self.push_chrome(json!({"t": "https-blocked-new", "httpsUrl": https_url, "url": url}));
                    }
                }
            }
            "navigate" => {
                let (Some(tab), Some(input)) = (msg["tab"].as_u64(), msg["url"].as_str()) else { return };
                match policy::resolve_input(input, &self.settings) {
                    NavDecision::Allow(u) | NavDecision::Search(u) => {
                        if let Some(t) = self.model.tabs.get_mut(&tab) { t.url = u.clone(); t.loading = true; }
                        if let Some(cv) = self.content.get(&tab) { let _ = cv.view.load_url(&u); }
                        self.sync_chrome();
                    }
                    NavDecision::BlockHttp { https_url } => {
                        self.push_chrome(json!({"t": "https-blocked", "tab": tab, "httpsUrl": https_url, "url": input}));
                    }
                }
            }
            "activate" => {
                if let Some(tab) = msg["tab"].as_u64() {
                    self.model.activate(tab, now);
                    if !self.content.contains_key(&tab) { self.create_content(window, tab, proxy); }
                    self.sync_chrome();
                }
            }
            "close" => {
                if let Some(tab) = msg["tab"].as_u64() {
                    self.content.remove(&tab);
                    self.model.close_tab(tab, now);
                    self.sync_chrome();
                }
            }
            "zone" => {
                if let (Some(tab), Some(z)) = (msg["tab"].as_u64(), msg["zone"].as_str()) {
                    let zone = match z { "pinned" => Zone::Pinned, "favorite" => Zone::Favorite, _ => Zone::Today };
                    self.model.set_zone(tab, zone);
                    self.sync_chrome();
                }
            }
            "split" => {
                if let Some(tab) = msg["tab"].as_u64() {
                    self.model.toggle_split(tab);
                    if !self.content.contains_key(&tab) { self.create_content(window, tab, proxy); }
                    self.sync_chrome();
                }
            }
            "space-new" => {
                let name = msg["name"].as_str().unwrap_or("Space");
                let hue = msg["hue"].as_u64().unwrap_or(262) as u16;
                let id = self.model.add_space(name, hue);
                self.model.active_space = id;
                self.sync_chrome();
            }
            "space-switch" => {
                if let Some(id) = msg["space"].as_u64() {
                    self.model.active_space = id;
                    self.model.active_tab = self.model.spaces.iter().find(|s| s.id == id)
                        .and_then(|s| s.tabs.last().copied());
                    self.model.split = self.model.active_tab.map(|t| vec![t]).unwrap_or_default();
                    if let Some(tab) = self.model.active_tab {
                        if !self.content.contains_key(&tab) { self.create_content(window, tab, proxy); }
                    }
                    self.sync_chrome();
                }
            }
            "restore" => {
                if let Some(id) = self.model.restore_last_archived(now) {
                    self.create_content(window, id, proxy);
                    self.sync_chrome();
                }
            }
            "back" | "forward" | "reload" => {
                if let Some(tab) = msg["tab"].as_u64() {
                    if let Some(cv) = self.content.get(&tab) {
                        let js = match msg["t"].as_str().unwrap() {
                            "back" => "history.back()", "forward" => "history.forward()", _ => "location.reload()",
                        };
                        let _ = cv.view.evaluate_script(js);
                    }
                }
            }
            "layout" => {
                // Chrome owns geometry; content webviews are positioned over panes.
                let visible: Vec<TabId> = msg["panes"].as_array().map(|a| a.iter().filter_map(|p| p["tab"].as_u64()).collect()).unwrap_or_default();
                if let Some(panes) = msg["panes"].as_array() {
                    for pane in panes {
                        let Some(tab) = pane["tab"].as_u64() else { continue };
                        if let Some(cv) = self.content.get(&tab) {
                            let _ = cv.view.set_bounds(Rect {
                                position: LogicalPosition::new(pane["x"].as_f64().unwrap_or(0.0), pane["y"].as_f64().unwrap_or(0.0)).into(),
                                size: LogicalSize::new(pane["w"].as_f64().unwrap_or(10.0).max(10.0), pane["h"].as_f64().unwrap_or(10.0).max(10.0)).into(),
                            });
                            let _ = cv.view.set_visible(true);
                        }
                    }
                }
                for (tab, cv) in &self.content {
                    if !visible.contains(tab) { let _ = cv.view.set_visible(false); }
                }
            }
            "little" => {
                if let Some(url) = msg["url"].as_str() {
                    let _ = proxy.send_event(UserEvent::SpawnLittle(url.to_string()));
                }
            }
            "command-search" => {
                let query = msg["query"].as_str().unwrap_or("");
                let surface = self.model.search_surface();
                let ranked = phantom_core::fuzzy::rank(query, &surface, |e| e.0.as_str());
                let results: Vec<Value> = ranked.iter().take(12).map(|(e, hit)| json!({
                    "title": e.0, "url": e.1, "tab": e.2, "score": hit.score, "positions": hit.positions,
                })).collect();
                self.push_chrome(json!({"t": "command-results", "query": query, "results": results}));
            }
            "settings" => {
                if let Some(obj) = msg["settings"].as_object() {
                    for (k, v) in obj { let _ = self.store.set_setting(k, &v.to_string()); }
                    self.settings = load_settings(&self.store);
                }
            }
            "export-bookmarks" => {
                let Path = store::data_dir().join("bookmarks.html");
                let _ = std::fs::write(&Path, self.store.export_bookmarks_html());
                self.push_chrome(json!({"t": "exported", "Path": Path.display().to_string()}));
            }
            "clear-history" => { let _ = self.store.clear_history(); }
            _ => {}
        }
    }

    fn handle_content_ipc(&mut self, tab: TabId, raw: &str, proxy: &EventLoopProxy<UserEvent>) {
        let Ok(msg) = serde_json::from_str::<Value>(raw) else { return };
        match msg["t"].as_str().unwrap_or("") {
            "page" => {
                let url = msg["url"].as_str().unwrap_or("").to_string();
                let title = msg["title"].as_str().unwrap_or("").to_string();
                let mut changed = false;
                if let Some(t) = self.model.tabs.get_mut(&tab) {
                    if t.url != url || t.title != title { t.url = url.clone(); t.title = title.clone(); changed = true; }
                    t.loading = false;
                }
                if self.settings.history_enabled && !url.is_empty() {
                    let _ = self.store.record_visit(&url, &title, now_unix());
                }
                // Inject cosmetic CSS for this host.
                let host = url.split("://").nth(1).unwrap_or("").split('/').next().unwrap_or("").to_string();
                let css = self.filters.cosmetic_css(&host);
                if !css.is_empty() {
                    if let Some(cv) = self.content.get(&tab) {
                        let js = format!("(()=>{{const s=document.createElement('style');s.textContent={};document.documentElement.appendChild(s);}})();",
                            serde_json::to_string(&css).unwrap_or_default());
                        let _ = cv.view.evaluate_script(&js);
                    }
                }
                if changed { self.sync_chrome(); }
            }
            "resource" => {
                let url = msg["url"].as_str().unwrap_or("");
                let host = msg["host"].as_str().unwrap_or("");
                let kind_name = msg["kind"].as_str().unwrap_or("");
                let kind = if kind_name.contains("fetch") || kind_name.contains("xhr") { ResourceType::Xhr } else { ResourceType::Other };
                let verdict = self.filters.check(&FilterRequest { url, source_host: host, kind });
                if let Some(cv) = self.content.get_mut(&tab) {
                    match verdict { Verdict::Block => cv.blocked += 1, Verdict::Allow => cv.allowed += 1 }
                    let (b, a) = (cv.blocked, cv.allowed);
                    self.push_chrome(json!({"t": "shields", "tab": tab, "blocked": b, "allowed": a, "lastUrl": url, "lastBlocked": verdict == Verdict::Block}));
                }
            }
            "window-open" => {
                if let Some(url) = msg["url"].as_str() {
                    let _ = proxy.send_event(UserEvent::SpawnLittle(url.to_string()));
                }
            }
            _ => {}
        }
    }
}

fn load_settings(store: &store::Store) -> Settings {
    let mut s = Settings::default();
    if let Some(v) = store.get_setting("history_enabled") { s.history_enabled = v.trim_matches('"') == "true"; }
    if let Some(v) = store.get_setting("archive_after_minutes") { if let Ok(n) = v.trim_matches('"').parse() { s.archive_after_minutes = n; } }
    if let Some(v) = store.get_setting("search_template") { s.search_template = v.trim_matches('"').to_string(); }
    if let Some(v) = store.get_setting("doh_url") { let v = v.trim_matches('"'); s.doh_url = if v.is_empty() { None } else { Some(v.to_string()) }; }
    if let Some(v) = store.get_setting("https_exceptions") {
        s.https_exceptions = v.trim_matches(|c| c == '"' || c == '[' || c == ']').split(',').map(|h| h.trim_matches('"').trim().to_string()).filter(|h| !h.is_empty()).collect();
    }
    s
}

fn chrome_source() -> WebViewBuilder<'static> {
    // In a packaged build the UI lives next to the binary (ui/); in dev,
    // PHANTOM_UI_DIR or ./ui works. The files are also what the preview serves.
    let dir: PathBuf = std::env::var("PHANTOM_UI_DIR").map(PathBuf::from).unwrap_or_else(|_| {
        std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("ui")))
            .filter(|p| p.exists()).unwrap_or_else(|| PathBuf::from("ui"))
    });
    let index = dir.join("index.html");
    // Inline css/js so file:// module restrictions never bite across WebKit builds.
    let html = std::fs::read_to_string(&index).unwrap_or_else(|_| "<h1>Phantom UI missing — set PHANTOM_UI_DIR</h1>".into());
    let css = std::fs::read_to_string(dir.join("css/phantom.css")).unwrap_or_default();
    let mut js = format!(
        "window.__PHANTOM_FILTERS__ = {};\n",
        serde_json::to_string(include_str!("../../../assets/filters/base.txt")).unwrap_or_else(|_| "\"\"".into())
    );
    for f in ["js/fuzzy.js", "js/filters.js", "js/state.js", "js/app.js"] {
        if let Ok(src) = std::fs::read_to_string(dir.join(f)) { js.push_str(&src); js.push('\n'); }
    }
    let html = html.replace("/* __PHANTOM_CSS__ */", &css).replace("// __PHANTOM_JS__", &js);
    WebViewBuilder::new().with_html(html)
}

fn main() {
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("Phantom")
        .with_inner_size(LogicalSize::new(1280.0, 832.0))
        .with_min_inner_size(LogicalSize::new(640.0, 420.0))
        .build(&event_loop)
        .expect("failed to create window");

    let store = store::Store::open().expect("failed to open Phantom data store");
    let settings = load_settings(&store);
    let filters = bundled_filter_lists();
    let blocked_hosts_json = serde_json::to_string(&filters.blocked_host_suffixes()).unwrap_or_else(|_| "[]".into());

    let p = proxy.clone();
    let chrome = chrome_source()
        .with_ipc_handler(move |req: wry::http::Request<String>| { let _ = p.send_event(UserEvent::ChromeIpc(req.body().clone())); })
        .build(&window)
        .expect("failed to create chrome webview");

    let mut model = BrowserModel::new(now_unix());
    // A URL passed on the command line (xdg-open, .desktop %u, macOS open-url)
    // becomes the first tab. With no argument we open the local new-tab page:
    // nothing is fetched at startup, ever.
    let space = model.active_space;
    let cli_url = std::env::args().nth(1).filter(|a| !a.starts_with('-'));
    let start_url = match cli_url {
        Some(raw) => match policy::resolve_input(&raw, &settings) {
            NavDecision::Allow(u) | NavDecision::Search(u) => u,
            NavDecision::BlockHttp { https_url } => https_url,
        },
        None => "phantom://newtab".to_string(),
    };
    model.open_tab(space, &start_url, Zone::Today, now_unix(), true);

    let mut app = App {
        model, settings, filters, blocked_hosts_json, store, chrome,
        content: HashMap::new(), little_windows: HashMap::new(),
        session_key: now_unix() ^ 0x9E3779B97F4A7C15,
    };
    if let Some(tab) = app.model.active_tab { app.create_content(&window, tab, &proxy); }

    let main_id = window.id();
    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::ChromeIpc(raw)) => app.handle_chrome_ipc(&window, &raw, &proxy),
            Event::UserEvent(UserEvent::ContentIpc(tab, raw)) => app.handle_content_ipc(tab, &raw, &proxy),
            Event::UserEvent(UserEvent::SpawnLittle(url)) => {
                // Little Phantom: a real, small, always-on-top OS window with
                // ephemeral storage — for the link you do not want to keep.
                if let Ok(win) = WindowBuilder::new()
                    .with_title("Little Phantom")
                    .with_inner_size(LogicalSize::new(480.0, 640.0))
                    .with_always_on_top(true)
                    .build(target)
                {
                    let seed = policy::origin_seed(app.session_key, &url);
                    let shim = policy::fingerprint_shim_js(app.settings.fingerprint, seed);
                    if let Ok(view) = WebViewBuilder::new()
                        .with_url(&url)
                        .with_initialization_script(&shim)
                        .with_incognito(true)
                        .build(&win)
                    {
                        app.little_windows.insert(win.id(), (win, view));
                    }
                }
            }
            Event::WindowEvent { window_id, event: WindowEvent::CloseRequested, .. } => {
                if window_id == main_id { *control_flow = ControlFlow::Exit; }
                else { app.little_windows.remove(&window_id); }
            }
            Event::WindowEvent { window_id, event: WindowEvent::Resized(_), .. } if window_id == main_id => {
                app.push_chrome(json!({"t": "relayout"}));
            }
            _ => {}
        }
    });
}
