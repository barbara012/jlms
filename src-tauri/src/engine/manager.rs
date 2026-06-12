//! Lifecycle management for the mihomo sidecar process.

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::engine::config::{render_config, CoreParams};
use crate::engine::profiles;
use crate::engine::settings;
use crate::paths;
use crate::util::random_hex;

/// Owns the running mihomo child and the parameters it was started with.
#[derive(Default)]
pub struct CoreManager {
    inner: Mutex<CoreState>,
}

#[derive(Default)]
struct CoreState {
    child: Option<CommandChild>,
    params: Option<CoreParams>,
}

impl CoreManager {
    pub fn is_running(&self) -> bool {
        self.inner.lock().unwrap().child.is_some()
    }

    pub fn params(&self) -> Option<CoreParams> {
        self.inner.lock().unwrap().params.clone()
    }

    /// Render the config (from the active profile, if any) and write it to disk.
    fn write_config(&self, app: &AppHandle, params: &CoreParams) -> Result<PathBuf, String> {
        let home = paths::core_home_dir(app);
        std::fs::create_dir_all(&home).map_err(|e| format!("create data dir: {e}"))?;
        let base = profiles::active_yaml(app);
        let config = render_config(params, base.as_deref())?;
        let config_path = paths::core_config_path(app);
        std::fs::write(&config_path, config).map_err(|e| format!("write config: {e}"))?;
        Ok(config_path)
    }

    /// Regenerate config.yaml using the current params (core must be running).
    /// Returns the config path so the caller can ask the core to reload it.
    pub fn rewrite_config(&self, app: &AppHandle) -> Result<PathBuf, String> {
        let params = self.params().ok_or("core not running")?;
        self.write_config(app, &params)
    }

    /// Write the config and spawn the core. No-op if already running.
    pub fn start(&self, app: &AppHandle) -> Result<(), String> {
        let mut state = self.inner.lock().unwrap();
        if state.child.is_some() {
            return Ok(());
        }

        let secret = load_or_create_secret(app)?;
        let params = CoreParams {
            mode: settings::load_mode(app),
            secret,
            ..CoreParams::default()
        };
        let config_path = self.write_config(app, &params)?;
        let home = paths::core_home_dir(app);

        let home_arg = home.to_string_lossy().to_string();
        let config_arg = config_path.to_string_lossy().to_string();

        let (mut rx, child) = app
            .shell()
            .sidecar("mihomo")
            .map_err(|e| format!("resolve sidecar: {e}"))?
            .args(["-d", home_arg.as_str(), "-f", config_arg.as_str()])
            .spawn()
            .map_err(|e| format!("spawn mihomo: {e}"))?;

        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                        let line = String::from_utf8_lossy(&bytes).trim_end().to_string();
                        if !line.is_empty() {
                            let _ = app_handle.emit("core://log", line);
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        let manager = app_handle.state::<CoreManager>();
                        let mut state = manager.inner.lock().unwrap();
                        state.child = None;
                        state.params = None;
                        let _ = app_handle.emit("core://exit", payload.code);
                        break;
                    }
                    _ => {}
                }
            }
        });

        state.child = Some(child);
        state.params = Some(params);
        Ok(())
    }

    /// Kill the running core, if any.
    pub fn stop(&self) -> Result<(), String> {
        let mut state = self.inner.lock().unwrap();
        if let Some(child) = state.child.take() {
            child.kill().map_err(|e| format!("kill mihomo: {e}"))?;
        }
        state.params = None;
        Ok(())
    }

    pub fn restart(&self, app: &AppHandle) -> Result<(), String> {
        self.stop()?;
        self.start(app)
    }

    /// Update the in-memory outbound mode after a live `PATCH /configs`.
    pub fn set_mode(&self, app: &AppHandle, mode: &str) -> Result<(), String> {
        let mut state = self.inner.lock().unwrap();
        if let Some(params) = state.params.as_mut() {
            params.mode = mode.to_string();
        }
        drop(state);
        settings::save_mode(app, mode)
    }
}

/// Load the persisted controller secret, generating one on first run.
fn load_or_create_secret(app: &AppHandle) -> Result<String, String> {
    let path = paths::controller_secret_path(app);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let secret = random_hex(16);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create data dir: {e}"))?;
    }
    std::fs::write(&path, &secret).map_err(|e| format!("write secret: {e}"))?;
    Ok(secret)
}
