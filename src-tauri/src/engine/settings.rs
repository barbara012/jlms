use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::paths;

const DEFAULT_MODE: &str = "rule";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppSettings {
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub proxy_services: Vec<String>,
    #[serde(default)]
    pub selected_proxies: HashMap<String, HashMap<String, String>>,
}

pub fn load(app: &AppHandle) -> AppSettings {
    let path = paths::settings_path(app);
    let Ok(text) = std::fs::read_to_string(path) else {
        return AppSettings::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = paths::settings_path(app);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create settings dir: {e}"))?;
    }
    let text =
        serde_json::to_string_pretty(settings).map_err(|e| format!("serialize settings: {e}"))?;
    std::fs::write(path, text).map_err(|e| format!("write settings: {e}"))
}

pub fn load_mode(app: &AppHandle) -> String {
    normalize_mode(load(app).mode.as_deref())
}

pub fn save_mode(app: &AppHandle, mode: &str) -> Result<(), String> {
    let mut settings = load(app);
    settings.mode = Some(normalize_mode(Some(mode)));
    save(app, &settings)
}

pub fn save_proxy_services(app: &AppHandle, services: &[String]) -> Result<(), String> {
    let mut settings = load(app);
    settings.proxy_services = services.to_vec();
    save(app, &settings)
}

pub fn load_proxy_services(app: &AppHandle) -> Vec<String> {
    load(app).proxy_services
}

pub fn save_selected_proxy(
    app: &AppHandle,
    profile_id: &str,
    group: &str,
    proxy: &str,
) -> Result<(), String> {
    let mut settings = load(app);
    settings
        .selected_proxies
        .entry(profile_id.to_string())
        .or_default()
        .insert(group.to_string(), proxy.to_string());
    save(app, &settings)
}

pub fn load_selected_proxies(app: &AppHandle, profile_id: &str) -> HashMap<String, String> {
    load(app)
        .selected_proxies
        .get(profile_id)
        .cloned()
        .unwrap_or_default()
}

pub fn delete_selected_proxies(app: &AppHandle, profile_id: &str) -> Result<(), String> {
    let mut settings = load(app);
    settings.selected_proxies.remove(profile_id);
    save(app, &settings)
}

fn normalize_mode(mode: Option<&str>) -> String {
    match mode.unwrap_or(DEFAULT_MODE) {
        "direct" | "global" | "rule" => mode.unwrap_or(DEFAULT_MODE).to_string(),
        _ => DEFAULT_MODE.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_mode;

    #[test]
    fn invalid_mode_falls_back_to_rule() {
        assert_eq!(normalize_mode(Some("rule")), "rule");
        assert_eq!(normalize_mode(Some("global")), "global");
        assert_eq!(normalize_mode(Some("direct")), "direct");
        assert_eq!(normalize_mode(Some("unknown")), "rule");
        assert_eq!(normalize_mode(None), "rule");
    }
}
