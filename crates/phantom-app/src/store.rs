// Local persistence. One SQLite file in the per-user data dir; nothing here
// ever leaves the machine. History rows are only written when the user has
// explicitly enabled history in settings.

use rusqlite::{params, Connection};
use std::path::PathBuf;

pub struct Store {
    db: Connection,
}

pub fn data_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join("Library/Application Support/Phantom")
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
            PathBuf::from(xdg).join("phantom")
        } else {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            PathBuf::from(home).join(".local/share/phantom")
        }
    }
}

impl Store {
    pub fn open() -> rusqlite::Result<Store> {
        let dir = data_dir();
        std::fs::create_dir_all(&dir).ok();
        let db = Connection::open(dir.join("phantom.db"))?;
        db.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS bookmarks (
                 id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
                 created INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS history (
                 url TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
                 visits INTEGER NOT NULL DEFAULT 1, last_visit INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS site_exceptions (
                 host TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (host, kind));",
        )?;
        Ok(Store { db })
    }

    pub fn get_setting(&self, key: &str) -> Option<String> {
        self.db.query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| r.get(0)).ok()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.db.execute(
            "INSERT INTO kv(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn record_visit(&self, url: &str, title: &str, now: u64) -> rusqlite::Result<()> {
        self.db.execute(
            "INSERT INTO history(url, title, visits, last_visit) VALUES(?1, ?2, 1, ?3)
             ON CONFLICT(url) DO UPDATE SET title = ?2, visits = visits + 1, last_visit = ?3",
            params![url, title, now as i64],
        )?;
        Ok(())
    }

    pub fn history_surface(&self, limit: i64) -> Vec<(String, String)> {
        let mut stmt = match self.db.prepare(
            "SELECT title, url FROM history ORDER BY visits * 1000000 + last_visit DESC LIMIT ?1",
        ) { Ok(s) => s, Err(_) => return Vec::new() };
        let rows = stmt.query_map(params![limit], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)));
        match rows { Ok(it) => it.filter_map(|r| r.ok()).collect(), Err(_) => Vec::new() }
    }

    pub fn clear_history(&self) -> rusqlite::Result<()> {
        self.db.execute("DELETE FROM history", [])?;
        Ok(())
    }

    pub fn add_bookmark(&self, url: &str, title: &str, now: u64) -> rusqlite::Result<()> {
        self.db.execute("INSERT INTO bookmarks(url, title, created) VALUES(?1, ?2, ?3)", params![url, title, now as i64])?;
        Ok(())
    }

    pub fn bookmarks(&self) -> Vec<(String, String)> {
        let mut stmt = match self.db.prepare("SELECT title, url FROM bookmarks ORDER BY created DESC") {
            Ok(s) => s, Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)));
        match rows { Ok(it) => it.filter_map(|r| r.ok()).collect(), Err(_) => Vec::new() }
    }

    /// Netscape bookmark file format — understood by Firefox, Chrome, Brave.
    pub fn export_bookmarks_html(&self) -> String {
        let mut out = String::from(
            "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n",
        );
        for (title, url) in self.bookmarks() {
            let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('"', "&quot;");
            out.push_str(&format!("<DT><A HREF=\"{}\">{}</A>\n", esc(&url), esc(&title)));
        }
        out.push_str("</DL><p>\n");
        out
    }

    /// Import HREF/title pairs from a Netscape bookmark export (Firefox/Chrome/Brave).
    pub fn import_bookmarks_html(&self, html: &str, now: u64) -> usize {
        let mut count = 0;
        let lower = html.to_ascii_lowercase();
        let mut search_from = 0;
        while let Some(rel) = lower[search_from..].find("href=\"") {
            let start = search_from + rel + 6;
            let Some(end_rel) = html[start..].find('"') else { break };
            let url = &html[start..start + end_rel];
            let after = start + end_rel;
            let title = match (html[after..].find('>'), lower[after..].find("</a>")) {
                (Some(gt), Some(close)) if close > gt => html[after + gt + 1..after + close].trim().to_string(),
                _ => url.to_string(),
            };
            if (url.starts_with("http://") || url.starts_with("https://")) && self.add_bookmark(url, &title, now).is_ok() {
                count += 1;
            }
            search_from = after;
        }
        count
    }
}
