//! Tauri command surface exposed to the frontend.

use serde::Serialize;
use serde_yaml::Value;
use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::task::JoinSet;

use crate::engine::api::Controller;
use crate::engine::manager::CoreManager;
use crate::engine::profiles::{self, Profile, ProfilesIndex};
use crate::engine::settings;
use crate::engine::system_proxy::{self, NetworkDiagnostics, ProxyTarget, SystemProxyStatus};
use crate::request_tray_menu_sync;

#[derive(Serialize)]
pub struct CoreStatus {
    pub running: bool,
    pub version: Option<String>,
    pub mixed_port: u16,
    pub controller: String,
    pub mode: String,
    pub default_group: String,
}

#[derive(Serialize)]
pub struct ControllerInfo {
    pub controller: String,
    pub secret: String,
}

#[derive(Serialize, Clone)]
struct ProxyDelayProgress {
    request_id: String,
    name: String,
    delay: Option<u32>,
}

#[derive(Serialize, Clone)]
struct ModeChangedPayload {
    mode: String,
    default_group: String,
}

#[derive(Serialize, Clone)]
struct ProxySelectionChangedPayload {
    group: String,
    name: String,
}

const CORE_STARTUP_ERROR_MESSAGE: &str =
    "内核未启动，代理不可用。请检查 mihomo sidecar 是否被系统拦截或损坏。";

fn emit_core_error(app: &AppHandle, message: &str) {
    let _ = app.emit("core://error", message);
}

pub fn proxy_target(manager: &CoreManager) -> ProxyTarget {
    let params = manager.params();
    ProxyTarget {
        host: "127.0.0.1".to_string(),
        port: params.as_ref().map(|p| p.mixed_port).unwrap_or(7890),
    }
}

pub async fn set_mode_with_handle(
    app: &AppHandle,
    manager: &CoreManager,
    mode: &str,
) -> Result<(), String> {
    let p = manager.params().ok_or("core not running")?;
    Controller::new(&p.controller_addr, &p.secret)
        .patch_mode(mode)
        .await?;
    manager.set_mode(app, mode)?;
    let _ = app.emit(
        "core://mode-changed",
        ModeChangedPayload {
            mode: mode.to_string(),
            default_group: resolve_default_group(app, mode),
        },
    );
    request_tray_menu_sync(app);
    Ok(())
}

pub async fn proxy_select_with_handle(
    app: &AppHandle,
    manager: &CoreManager,
    group: &str,
    name: &str,
) -> Result<(), String> {
    let p = manager.params().ok_or("core not running")?;
    Controller::new(&p.controller_addr, &p.secret)
        .select_proxy(group, name)
        .await?;
    persist_active_proxy_selection(app, group, name)?;
    let _ = app.emit(
        "proxy://selection-changed",
        ProxySelectionChangedPayload {
            group: group.to_string(),
            name: name.to_string(),
        },
    );
    request_tray_menu_sync(app);
    Ok(())
}

pub fn set_system_proxy_with_handle(
    app: &AppHandle,
    manager: &CoreManager,
    enabled: bool,
) -> Result<SystemProxyStatus, String> {
    let target = proxy_target(manager);
    let status = if enabled {
        let status = system_proxy::enable(&target)?;
        settings::save_proxy_services(app, &status.services)?;
        status
    } else {
        let services = settings::load_proxy_services(app);
        let status = system_proxy::disable(&target, &services)?;
        settings::save_proxy_services(app, &[])?;
        status
    };
    let _ = app.emit("system-proxy://changed", &status);
    request_tray_menu_sync(app);
    Ok(status)
}

pub fn cleanup_before_exit(
    app: &AppHandle,
    manager: &CoreManager,
) -> Result<SystemProxyStatus, String> {
    let target = proxy_target(manager);
    let services = settings::load_proxy_services(app);
    let status = system_proxy::disable(&target, &services)?;
    settings::save_proxy_services(app, &[])?;
    Ok(status)
}

// ---- core lifecycle ----

#[tauri::command]
pub async fn core_start(app: AppHandle, manager: State<'_, CoreManager>) -> Result<(), String> {
    if let Err(err) = manager.start(&app) {
        emit_core_error(&app, CORE_STARTUP_ERROR_MESSAGE);
        return Err(err);
    }
    if let Err(err) = restore_proxy_selections(&app, &manager).await {
        emit_core_error(&app, &format!("内核已启动，但恢复策略状态失败：{err}"));
        return Err(err);
    }
    Ok(())
}

#[tauri::command]
pub async fn core_stop(manager: State<'_, CoreManager>) -> Result<(), String> {
    manager.stop()
}

#[tauri::command]
pub async fn core_restart(app: AppHandle, manager: State<'_, CoreManager>) -> Result<(), String> {
    if let Err(err) = manager.restart(&app) {
        emit_core_error(&app, CORE_STARTUP_ERROR_MESSAGE);
        return Err(err);
    }
    if let Err(err) = restore_proxy_selections(&app, &manager).await {
        emit_core_error(&app, &format!("内核已启动，但恢复策略状态失败：{err}"));
        return Err(err);
    }
    Ok(())
}

#[tauri::command]
pub async fn core_status(
    app: AppHandle,
    manager: State<'_, CoreManager>,
) -> Result<CoreStatus, String> {
    let running = manager.is_running();
    let params = manager.params();
    let saved_mode = settings::load_mode(&app);

    let (mixed_port, controller, mode) = params
        .as_ref()
        .map(|p| (p.mixed_port, p.controller_addr.clone(), p.mode.clone()))
        .unwrap_or((7890, "127.0.0.1:9090".to_string(), saved_mode));

    let version = match (running, params) {
        (true, Some(p)) => Controller::new(&p.controller_addr, &p.secret)
            .version()
            .await
            .ok(),
        _ => None,
    };
    let default_group = resolve_default_group(&app, &mode);

    Ok(CoreStatus {
        running,
        version,
        mixed_port,
        controller,
        mode,
        default_group,
    })
}

fn resolve_default_group(app: &AppHandle, mode: &str) -> String {
    match mode {
        "direct" => "DIRECT".to_string(),
        "global" => "GLOBAL".to_string(),
        _ => default_group_from_rules(app).unwrap_or_else(|| "DIRECT".to_string()),
    }
}

fn default_group_from_rules(app: &AppHandle) -> Option<String> {
    let yaml = profiles::active_yaml(app)?;
    let root: Value = serde_yaml::from_str(&yaml).ok()?;
    let rules = root.get("rules")?.as_sequence()?;

    rules.iter()
        .rev()
        .filter_map(Value::as_str)
        .find_map(match_rule_target)
        .map(ToString::to_string)
}

fn match_rule_target(rule: &str) -> Option<&str> {
    let mut parts = rule.split(',').map(str::trim);
    let kind = parts.next()?;
    if !kind.eq_ignore_ascii_case("MATCH") {
        return None;
    }
    parts.next().filter(|target| !target.is_empty())
}

/// `GET /proxies` — all proxies and policy groups.
#[tauri::command]
pub async fn proxies_get(manager: State<'_, CoreManager>) -> Result<serde_json::Value, String> {
    let p = manager.params().ok_or("core not running")?;
    Controller::new(&p.controller_addr, &p.secret)
        .proxies()
        .await
}

/// Select `name` as the current node of policy group `group`.
#[tauri::command]
pub async fn proxy_select(
    app: AppHandle,
    manager: State<'_, CoreManager>,
    group: String,
    name: String,
) -> Result<(), String> {
    proxy_select_with_handle(&app, &manager, &group, &name).await
}

/// Latency test for a single proxy (milliseconds).
#[tauri::command]
pub async fn proxy_delay(manager: State<'_, CoreManager>, name: String) -> Result<u32, String> {
    let p = manager.params().ok_or("core not running")?;
    Controller::new(&p.controller_addr, &p.secret)
        .proxy_delay(&name, "https://www.gstatic.com/generate_204", 2500)
        .await
}

#[tauri::command]
pub async fn proxy_delay_many(
    app: AppHandle,
    manager: State<'_, CoreManager>,
    names: Vec<String>,
    request_id: Option<String>,
) -> Result<HashMap<String, Option<u32>>, String> {
    let p = manager.params().ok_or("core not running")?;
    let controller = Controller::new(&p.controller_addr, &p.secret);
    let request_id = request_id.unwrap_or_default();

    let mut seen = std::collections::HashSet::new();
    let unique = names
        .into_iter()
        .filter(|name| seen.insert(name.clone()))
        .collect::<Vec<_>>();

    let mut measured = HashMap::with_capacity(unique.len());
    let mut pending = unique.into_iter();
    let mut in_flight = JoinSet::new();
    let slots = 32;

    for _ in 0..slots {
        let Some(name) = pending.next() else {
            break;
        };
        let controller = controller.clone();
        in_flight.spawn(async move {
            let delay = controller
                .proxy_delay(&name, "https://www.gstatic.com/generate_204", 2500)
                .await
                .ok();
            (name, delay)
        });
    }

    while let Some(result) = in_flight.join_next().await {
        if let Ok((name, delay)) = result {
            measured.insert(name.clone(), delay);
            if !request_id.is_empty() {
                let _ = app.emit(
                    "policy://delay-progress",
                    ProxyDelayProgress {
                        request_id: request_id.clone(),
                        name,
                        delay,
                    },
                );
            }
        }

        if let Some(name) = pending.next() {
            let controller = controller.clone();
            in_flight.spawn(async move {
                let delay = controller
                    .proxy_delay(&name, "https://www.gstatic.com/generate_204", 2500)
                    .await
                    .ok();
                (name, delay)
            });
        }
    }

    Ok(measured)
}

/// Change the outbound mode (`rule` | `global` | `direct`).
#[tauri::command]
pub async fn set_mode(
    app: AppHandle,
    manager: State<'_, CoreManager>,
    mode: String,
) -> Result<(), String> {
    set_mode_with_handle(&app, &manager, &mode).await
}

/// Controller address + secret, so the frontend can open the live WebSockets.
#[tauri::command]
pub fn controller_info(manager: State<'_, CoreManager>) -> Result<ControllerInfo, String> {
    let p = manager.params().ok_or("core not running")?;
    Ok(ControllerInfo {
        controller: p.controller_addr,
        secret: p.secret,
    })
}

#[tauri::command]
pub fn system_proxy_status(manager: State<'_, CoreManager>) -> Result<SystemProxyStatus, String> {
    system_proxy::status(&proxy_target(&manager))
}

#[tauri::command]
pub fn system_proxy_set(
    app: AppHandle,
    manager: State<'_, CoreManager>,
    enabled: bool,
) -> Result<SystemProxyStatus, String> {
    set_system_proxy_with_handle(&app, &manager, enabled)
}

#[tauri::command]
pub fn latency_diagnostics() -> Result<NetworkDiagnostics, String> {
    system_proxy::network_diagnostics()
}

// ---- profiles ----

#[tauri::command]
pub fn profiles_list(app: AppHandle) -> Result<ProfilesIndex, String> {
    Ok(profiles::load_index(&app))
}

#[tauri::command]
pub async fn profiles_import(
    app: AppHandle,
    manager: State<'_, CoreManager>,
    url: String,
    name: Option<String>,
) -> Result<Profile, String> {
    let profile = profiles::import_subscription(&app, url, name).await?;
    if profiles::load_index(&app).active.as_deref() == Some(profile.id.as_str()) {
        apply_active(&app, &manager).await?;
    }
    Ok(profile)
}

#[tauri::command]
pub async fn profiles_import_file(
    app: AppHandle,
    manager: State<'_, CoreManager>,
    path: String,
    name: Option<String>,
) -> Result<Profile, String> {
    let profile = profiles::import_local_file(&app, &path, name)?;
    if profiles::load_index(&app).active.as_deref() == Some(profile.id.as_str()) {
        apply_active(&app, &manager).await?;
    }
    Ok(profile)
}

#[tauri::command]
pub async fn profiles_select(
    app: AppHandle,
    manager: State<'_, CoreManager>,
    id: String,
) -> Result<(), String> {
    profiles::set_active(&app, &id)?;
    apply_active(&app, &manager).await
}

#[tauri::command]
pub async fn profiles_update(
    app: AppHandle,
    manager: State<'_, CoreManager>,
    id: String,
) -> Result<Profile, String> {
    let profile = profiles::update(&app, &id).await?;
    if profiles::load_index(&app).active.as_deref() == Some(id.as_str()) {
        apply_active(&app, &manager).await?;
    }
    Ok(profile)
}

#[tauri::command]
pub async fn profiles_delete(
    app: AppHandle,
    manager: State<'_, CoreManager>,
    id: String,
) -> Result<(), String> {
    let was_active = profiles::load_index(&app).active.as_deref() == Some(id.as_str());
    profiles::delete(&app, &id)?;
    settings::delete_selected_proxies(&app, &id)?;
    if was_active {
        apply_active(&app, &manager).await?;
    }
    Ok(())
}

/// Regenerate the config from the active profile and make the core pick it up:
/// hot-reload if running, otherwise start it.
async fn apply_active(app: &AppHandle, manager: &CoreManager) -> Result<(), String> {
    if manager.is_running() {
        let path = manager.rewrite_config(app)?;
        let p = manager.params().ok_or("core not running")?;
        let controller = Controller::new(&p.controller_addr, &p.secret);
        match controller.reload_config(&path.to_string_lossy()).await {
            Ok(()) => restore_proxy_selections(app, manager).await,
            Err(_) => {
                // When deleting the last active profile, the old controller may
                // already be unavailable. Fall back to a clean restart so the
                // core comes back with the newly rendered minimal config.
                manager.restart(app)?;
                restore_proxy_selections(app, manager).await
            }
        }
    } else {
        manager.start(app)?;
        restore_proxy_selections(app, manager).await
    }
}

pub async fn restore_proxy_selections(
    app: &AppHandle,
    manager: &CoreManager,
) -> Result<(), String> {
    let Some(profile_id) = profiles::load_index(app).active else {
        return Ok(());
    };
    let selections = settings::load_selected_proxies(app, &profile_id);
    if selections.is_empty() {
        return Ok(());
    }

    let p = manager.params().ok_or("core not running")?;
    let controller = Controller::new(&p.controller_addr, &p.secret);
    wait_for_controller_ready(&controller).await?;
    for (group, proxy) in selections {
        if let Err(err) = controller.select_proxy(&group, &proxy).await {
            eprintln!(
                "[fk_surge] restore proxy selection failed for profile {profile_id}, group {group}, proxy {proxy}: {err}"
            );
        }
    }
    Ok(())
}

fn persist_active_proxy_selection(app: &AppHandle, group: &str, name: &str) -> Result<(), String> {
    let Some(profile_id) = profiles::load_index(app).active else {
        return Ok(());
    };
    settings::save_selected_proxy(app, &profile_id, group, name)
}

async fn wait_for_controller_ready(controller: &Controller) -> Result<(), String> {
    let mut last_err = None;
    for _ in 0..20 {
        match controller.proxies().await {
            Ok(_) => return Ok(()),
            Err(err) => {
                last_err = Some(err);
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
    }
    Err(format!(
        "controller not ready before restoring proxy selections: {}",
        last_err.unwrap_or_else(|| "unknown error".to_string())
    ))
}
