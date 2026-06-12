//! Filesystem layout for the app's runtime data.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

const LEGACY_APP_DATA_DIRS: &[&str] = &["com.fksurge.desktop"];

/// Root application data directory, e.g.
/// `~/Library/Application Support/com.jlms.desktop`.
pub fn app_data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("failed to resolve app data dir")
}

/// On first launch after the app rename, migrate persisted runtime data from the
/// legacy bundle identifier directory into the new JLMS directory.
pub fn migrate_legacy_app_data(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let current = app_data_dir(app);
    std::fs::create_dir_all(&current).map_err(|e| format!("create app data dir: {e}"))?;

    let Some(parent) = current.parent() else {
        return Ok(None);
    };

    for legacy_name in LEGACY_APP_DATA_DIRS {
        let legacy = parent.join(legacy_name);
        if !has_runtime_data(&legacy) {
            continue;
        }
        copy_dir_recursive(&legacy, &current)?;
        return Ok(Some(legacy));
    }

    Ok(None)
}

pub fn legacy_app_data_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let current = app_data_dir(app);
    let Some(parent) = current.parent() else {
        return Vec::new();
    };
    LEGACY_APP_DATA_DIRS
        .iter()
        .map(|name| parent.join(name))
        .filter(|path| path.exists())
        .collect()
}

/// Working/home directory handed to the mihomo core via `-d`. Holds
/// `config.yaml`, the cache db and (later) the geo databases.
pub fn core_home_dir(app: &AppHandle) -> PathBuf {
    app_data_dir(app)
}

/// Path of the generated mihomo configuration file.
pub fn core_config_path(app: &AppHandle) -> PathBuf {
    core_home_dir(app).join("config.yaml")
}

/// Path of the persisted external-controller secret.
pub fn controller_secret_path(app: &AppHandle) -> PathBuf {
    app_data_dir(app).join("controller-secret")
}

/// Path of persisted UI/runtime settings.
pub fn settings_path(app: &AppHandle) -> PathBuf {
    app_data_dir(app).join("settings.json")
}

fn has_runtime_data(dir: &Path) -> bool {
    dir.join("profiles").join("index.json").exists()
        || dir.join("settings.json").exists()
        || dir.join("config.yaml").exists()
        || dir.join("controller-secret").exists()
}

fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("create dir {}: {e}", to.display()))?;
    for entry in std::fs::read_dir(from).map_err(|e| format!("read dir {}: {e}", from.display()))? {
        let entry = entry.map_err(|e| format!("read dir entry {}: {e}", from.display()))?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        let ty = entry
            .file_type()
            .map_err(|e| format!("read file type {}: {e}", source.display()))?;
        if ty.is_dir() {
            copy_dir_recursive(&source, &target)?;
        } else if ty.is_file() && !target.exists() {
            std::fs::copy(&source, &target)
                .map_err(|e| format!("copy {} -> {}: {e}", source.display(), target.display()))?;
        }
    }
    Ok(())
}
