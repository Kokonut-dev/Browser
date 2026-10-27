// The browsing model: Spaces, tabs in three zones, and the archive.
// Pure state + transitions; persistence and webviews live in phantom-app.

use std::collections::HashMap;

pub type TabId = u64;
pub type SpaceId = u64;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Zone { Favorite, Pinned, Today }

#[derive(Debug, Clone)]
pub struct Tab {
    pub id: TabId,
    pub url: String,
    pub title: String,
    pub zone: Zone,
    pub space: SpaceId,
    pub last_active_unix: u64,
    pub loading: bool,
}

#[derive(Debug, Clone)]
pub struct Space {
    pub id: SpaceId,
    pub name: String,
    pub icon: String, // single emoji or ""
    pub hue: u16,     // 0-359, drives the sidebar tint
    pub tabs: Vec<TabId>, // sidebar order: favorites, pinned, then today
}

#[derive(Debug, Clone)]
pub struct ArchivedTab {
    pub url: String,
    pub title: String,
    pub space: SpaceId,
    pub archived_unix: u64,
}

#[derive(Debug, Default)]
pub struct BrowserModel {
    pub spaces: Vec<Space>,
    pub tabs: HashMap<TabId, Tab>,
    pub archive: Vec<ArchivedTab>,
    pub active_space: SpaceId,
    pub active_tab: Option<TabId>,
    /// Tabs currently shown as split panes (includes the active tab; 1 = no split).
    pub split: Vec<TabId>,
    next_id: u64,
}

impl BrowserModel {
    pub fn new() -> BrowserModel {
        let mut m = BrowserModel { next_id: 2, active_space: 1, ..Default::default() };
        m.spaces.push(Space { id: 1, name: "Personal".into(), icon: "◐".into(), hue: 262, tabs: Vec::new() });
        m
    }

    fn alloc(&mut self) -> u64 { let id = self.next_id; self.next_id += 1; id }

    pub fn add_space(&mut self, name: &str, hue: u16) -> SpaceId {
        let id = self.alloc();
        self.spaces.push(Space { id, name: name.into(), icon: String::new(), hue, tabs: Vec::new() });
        id
    }

    pub fn space_mut(&mut self, id: SpaceId) -> Option<&mut Space> {
        self.spaces.iter_mut().find(|s| s.id == id)
    }

    pub fn open_tab(&mut self, space: SpaceId, url: &str, zone: Zone, now: u64, activate: bool) -> TabId {
        let id = self.alloc();
        self.tabs.insert(id, Tab { id, url: url.into(), title: String::new(), zone, space, last_active_unix: now, loading: true });
        // Keep zones contiguous: favorites, then pinned, then today.
        // (Compute the position before taking the mutable Space borrow.)
        let existing_zones: Vec<Zone> = self.spaces.iter().find(|s| s.id == space)
            .map(|sp| sp.tabs.iter().filter_map(|t| self.tabs.get(t).map(|tab| tab.zone)).collect())
            .unwrap_or_default();
        let pos = match zone {
            Zone::Favorite => existing_zones.iter().take_while(|z| **z == Zone::Favorite).count(),
            Zone::Pinned => existing_zones.iter().take_while(|z| **z != Zone::Today).count(),
            Zone::Today => existing_zones.len(),
        };
        if let Some(sp) = self.space_mut(space) {
            sp.tabs.insert(pos, id);
        }
        if activate { self.activate(id, now); }
        id
    }

    pub fn activate(&mut self, id: TabId, now: u64) {
        if let Some(t) = self.tabs.get_mut(&id) {
            t.last_active_unix = now;
            self.active_space = t.space;
        }
        self.active_tab = Some(id);
        if !self.split.contains(&id) { self.split = vec![id]; }
    }

    /// Closing archives rather than destroys (except favorites, which just un-favorite).
    pub fn close_tab(&mut self, id: TabId, now: u64) {
        let Some(tab) = self.tabs.remove(&id) else { return };
        if let Some(sp) = self.space_mut(tab.space) { sp.tabs.retain(|t| *t != id); }
        self.split.retain(|t| *t != id);
        if tab.zone != Zone::Favorite {
            self.archive.push(ArchivedTab { url: tab.url, title: tab.title, space: tab.space, archived_unix: now });
        }
        if self.active_tab == Some(id) {
            self.active_tab = self.spaces.iter().find(|s| s.id == self.active_space)
                .and_then(|s| s.tabs.last().copied());
            if let Some(next) = self.active_tab { if self.split.is_empty() { self.split = vec![next]; } }
        }
    }

    pub fn set_zone(&mut self, id: TabId, zone: Zone) {
        let Some(space) = self.tabs.get(&id).map(|t| t.space) else { return };
        if let Some(t) = self.tabs.get_mut(&id) { t.zone = zone; }
        // Re-sort the space so zones stay contiguous while preserving in-zone order.
        let order = |z: Zone| match z { Zone::Favorite => 0u8, Zone::Pinned => 1, Zone::Today => 2 };
        let ranks: HashMap<TabId, u8> = self.spaces.iter().find(|s| s.id == space)
            .map(|sp| sp.tabs.iter().filter_map(|t| self.tabs.get(t).map(|tab| (*t, order(tab.zone)))).collect())
            .unwrap_or_default();
        if let Some(sp) = self.space_mut(space) {
            sp.tabs.sort_by_key(|t| ranks.get(t).copied().unwrap_or(2)); // sort_by_key is stable
        }
    }

    pub fn move_tab(&mut self, id: TabId, to_space: SpaceId, index: usize) {
        let Some(from) = self.tabs.get(&id).map(|t| t.space) else { return };
        if let Some(sp) = self.space_mut(from) { sp.tabs.retain(|t| *t != id); }
        if let Some(t) = self.tabs.get_mut(&id) { t.space = to_space; }
        if let Some(sp) = self.space_mut(to_space) {
            let idx = index.min(sp.tabs.len());
            sp.tabs.insert(idx, id);
        }
    }

    /// Archive Today tabs idle longer than `after_minutes`. Returns archived ids.
    pub fn sweep_archive(&mut self, now: u64, after_minutes: u64) -> Vec<TabId> {
        if after_minutes == 0 { return Vec::new(); }
        let cutoff = now.saturating_sub(after_minutes * 60);
        let doomed: Vec<TabId> = self.tabs.values()
            .filter(|t| t.zone == Zone::Today && t.last_active_unix < cutoff && Some(t.id) != self.active_tab && !self.split.contains(&t.id))
            .map(|t| t.id).collect();
        for id in &doomed { self.close_tab(*id, now); }
        doomed
    }

    pub fn restore_last_archived(&mut self, now: u64) -> Option<TabId> {
        let a = self.archive.pop()?;
        let space = if self.spaces.iter().any(|s| s.id == a.space) { a.space } else { self.active_space };
        let id = self.open_tab(space, &a.url, Zone::Today, now, true);
        if let Some(t) = self.tabs.get_mut(&id) { t.title = a.title; }
        Some(id)
    }

    pub fn toggle_split(&mut self, id: TabId) {
        if let Some(pos) = self.split.iter().position(|t| *t == id) {
            if self.split.len() > 1 { self.split.remove(pos); }
        } else if self.split.len() < 4 {
            self.split.push(id);
        }
    }

    /// Every searchable surface for the command bar: (title, url, tab id if open).
    pub fn search_surface(&self) -> Vec<(String, String, Option<TabId>)> {
        let mut out = Vec::new();
        for sp in &self.spaces {
            for id in &sp.tabs {
                if let Some(t) = self.tabs.get(id) {
                    let label = if t.title.is_empty() { t.url.clone() } else { t.title.clone() };
                    out.push((label, t.url.clone(), Some(*id)));
                }
            }
        }
        for a in self.archive.iter().rev().take(200) {
            out.push((if a.title.is_empty() { a.url.clone() } else { a.title.clone() }, a.url.clone(), None));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zones_stay_contiguous() {
        let mut m = BrowserModel::new();
        let s = m.active_space;
        let t1 = m.open_tab(s, "https://a.test", Zone::Today, 0, false);
        let f1 = m.open_tab(s, "https://fav.test", Zone::Favorite, 0, false);
        let p1 = m.open_tab(s, "https://pin.test", Zone::Pinned, 0, false);
        assert_eq!(m.spaces[0].tabs, vec![f1, p1, t1]);
        m.set_zone(t1, Zone::Pinned);
        assert_eq!(m.spaces[0].tabs, vec![f1, p1, t1]);
        assert_eq!(m.tabs[&t1].zone, Zone::Pinned);
    }

    #[test]
    fn close_archives_and_restore_round_trips() {
        let mut m = BrowserModel::new();
        let s = m.active_space;
        let t = m.open_tab(s, "https://a.test/page", Zone::Today, 10, true);
        m.tabs.get_mut(&t).unwrap().title = "A page".into();
        m.close_tab(t, 20);
        assert_eq!(m.archive.len(), 1);
        let restored = m.restore_last_archived(30).unwrap();
        assert_eq!(m.tabs[&restored].url, "https://a.test/page");
        assert_eq!(m.tabs[&restored].title, "A page");
    }

    #[test]
    fn sweep_archives_only_idle_today_tabs() {
        let mut m = BrowserModel::new();
        let s = m.active_space;
        m.open_tab(s, "https://old.test", Zone::Today, 0, false);
        m.open_tab(s, "https://pin.test", Zone::Pinned, 0, false);
        let fresh = m.open_tab(s, "https://new.test", Zone::Today, 100_000, true);
        let gone = m.sweep_archive(100_001, 12 * 60);
        assert_eq!(gone.len(), 1);
        assert!(m.tabs.contains_key(&fresh));
        assert_eq!(m.tabs.len(), 2);
    }

    #[test]
    fn split_caps_at_four_and_never_empties() {
        let mut m = BrowserModel::new();
        let s = m.active_space;
        let ids: Vec<TabId> = (0..6).map(|i| m.open_tab(s, &format!("https://t{i}.test"), Zone::Today, 0, i == 0)).collect();
        for id in &ids { m.toggle_split(*id); }
        assert!(m.split.len() <= 4);
        let only = m.split[0];
        m.split = vec![only];
        m.toggle_split(only);
        assert_eq!(m.split.len(), 1);
    }

    #[test]
    fn move_between_spaces() {
        let mut m = BrowserModel::new();
        let s1 = m.active_space;
        let s2 = m.add_space("Work", 210);
        let t = m.open_tab(s1, "https://a.test", Zone::Today, 0, false);
        m.move_tab(t, s2, 0);
        assert_eq!(m.tabs[&t].space, s2);
        assert!(m.spaces.iter().find(|s| s.id == s1).unwrap().tabs.is_empty());
        let surface = m.search_surface();
        assert_eq!(surface.len(), 1);
    }
}
