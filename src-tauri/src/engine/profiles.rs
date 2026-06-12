//! Profiles: imported Clash/mihomo configs (from a subscription URL or a local
//! file).
//!
//! Each profile's raw YAML is stored verbatim at `profiles/<id>.yaml`; an
//! `index.json` tracks the list and which one is active. The active profile's
//! YAML becomes the base the core config is generated from (see `config.rs`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::paths::{app_data_dir, legacy_app_data_dirs};
use crate::util::{now_unix, random_hex};

#[derive(Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    /// `subscription` | `local`.
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<u64>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct ProfilesIndex {
    #[serde(default)]
    pub active: Option<String>,
    #[serde(default)]
    pub profiles: Vec<Profile>,
}

fn profiles_dir(app: &AppHandle) -> PathBuf {
    app_data_dir(app).join("profiles")
}

fn index_path(app: &AppHandle) -> PathBuf {
    profiles_dir(app).join("index.json")
}

pub fn profile_path(app: &AppHandle, id: &str) -> PathBuf {
    profiles_dir(app).join(format!("{id}.yaml"))
}

pub fn load_index(app: &AppHandle) -> ProfilesIndex {
    load_index_from_path(&index_path(app))
        .or_else(|| {
            legacy_app_data_dirs(app)
                .into_iter()
                .find_map(|dir| load_index_from_path(&dir.join("profiles").join("index.json")))
        })
        .unwrap_or_default()
}

fn save_index(app: &AppHandle, index: &ProfilesIndex) -> Result<(), String> {
    std::fs::create_dir_all(profiles_dir(app)).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    std::fs::write(index_path(app), json).map_err(|e| e.to_string())
}

/// Raw YAML of the active profile, if one is set.
pub fn active_yaml(app: &AppHandle) -> Option<String> {
    let id = load_index(app).active?;
    std::fs::read_to_string(profile_path(app, &id))
        .ok()
        .or_else(|| {
            legacy_app_data_dirs(app).into_iter().find_map(|dir| {
                std::fs::read_to_string(dir.join("profiles").join(format!("{id}.yaml"))).ok()
            })
        })
}

/// Fetch a subscription URL, validate, and register a new profile.
pub async fn import_subscription(
    app: &AppHandle,
    url: String,
    name: Option<String>,
) -> Result<Profile, String> {
    let body = fetch(&url).await?;
    let name = name.unwrap_or_else(|| default_name(&url));
    store_profile(app, &body, "subscription", Some(url), name)
}

/// Import a profile from a local Clash/mihomo YAML file.
pub fn import_local_file(
    app: &AppHandle,
    path: &str,
    name: Option<String>,
) -> Result<Profile, String> {
    let content = std::fs::read_to_string(path).map_err(|e| format!("read file: {e}"))?;
    let name = name.unwrap_or_else(|| file_stem(path));
    store_profile(app, &content, "local", None, name)
}

/// Validate and persist a new profile from raw YAML content.
fn store_profile(
    app: &AppHandle,
    content: &str,
    kind: &str,
    url: Option<String>,
    name: String,
) -> Result<Profile, String> {
    validate_clash_yaml(content)?;

    let id = random_hex(6);
    std::fs::create_dir_all(profiles_dir(app)).map_err(|e| e.to_string())?;
    std::fs::write(profile_path(app, &id), content).map_err(|e| e.to_string())?;

    let profile = Profile {
        id: id.clone(),
        name,
        kind: kind.into(),
        url,
        updated_at: Some(now_unix()),
    };

    let mut index = load_index(app);
    index.profiles.push(profile.clone());
    if index.active.is_none() {
        index.active = Some(id);
    }
    save_index(app, &index)?;
    Ok(profile)
}

/// Re-download a subscription profile's content.
pub async fn update(app: &AppHandle, id: &str) -> Result<Profile, String> {
    let mut index = load_index(app);
    let profile = index
        .profiles
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or("profile not found")?;
    let url = profile.url.clone().ok_or("profile has no url")?;

    let body = fetch(&url).await?;
    validate_clash_yaml(&body)?;
    std::fs::write(profile_path(app, id), &body).map_err(|e| e.to_string())?;

    if let Some(p) = index.profiles.iter_mut().find(|p| p.id == id) {
        p.updated_at = Some(now_unix());
    }
    save_index(app, &index)?;
    Ok(profile)
}

pub fn set_active(app: &AppHandle, id: &str) -> Result<(), String> {
    let mut index = load_index(app);
    if !index.profiles.iter().any(|p| p.id == id) {
        return Err("profile not found".into());
    }
    index.active = Some(id.to_string());
    save_index(app, &index)
}

pub fn delete(app: &AppHandle, id: &str) -> Result<(), String> {
    let mut index = load_index(app);
    index.profiles.retain(|p| p.id != id);
    if index.active.as_deref() == Some(id) {
        index.active = index.profiles.first().map(|p| p.id.clone());
    }
    let _ = std::fs::remove_file(profile_path(app, id));
    save_index(app, &index)
}

async fn fetch(url: &str) -> Result<String, String> {
    // A clash-family UA makes most panels return Clash YAML. Avoid "surge" in the
    // UA — some panels serve a Surge .conf when they see it.
    let client = reqwest::Client::builder()
        .user_agent("clash.meta")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("fetch: {e}"))?
        .error_for_status()
        .map_err(|e| format!("fetch: {e}"))?;
    resp.text().await.map_err(|e| format!("read body: {e}"))
}

fn validate_clash_yaml(text: &str) -> Result<(), String> {
    let value: serde_yaml::Value =
        serde_yaml::from_str(text).map_err(|e| format!("not valid YAML: {e}"))?;
    if !value.is_mapping() {
        return Err("config is not a YAML mapping (is the link a base64/SS-style sub?)".into());
    }
    if value.get("proxies").is_none() && value.get("proxy-providers").is_none() {
        return Err("config has no `proxies` or `proxy-providers`".into());
    }
    Ok(())
}

fn default_name(url: &str) -> String {
    url.split('/').nth(2).unwrap_or("订阅").to_string()
}

fn file_stem(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("本地配置")
        .to_string()
}

fn load_index_from_path(path: &Path) -> Option<ProfilesIndex> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}
