mod commands;
mod engine;
mod paths;
mod util;

use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::Instant;

use engine::api::Controller;
use engine::manager::CoreManager;
use image::{imageops::FilterType, DynamicImage, ImageFormat};
use serde_json::Value;
use tauri::{
    Emitter,
    image::Image as TauriImage,
    menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::TrayIconBuilder,
    Manager, Wry,
};

const TRAY_ID: &str = "fk-surge-tray";
const TRAY_DASHBOARD: &str = "tray_dashboard";
const TRAY_SHOW_MAIN: &str = "tray_show_main";
const TRAY_REFRESH: &str = "tray_refresh";
const TRAY_TEST_LATENCY: &str = "tray_test_latency";
const TRAY_MODE_DIRECT: &str = "tray_mode_direct";
const TRAY_MODE_GLOBAL: &str = "tray_mode_global";
const TRAY_MODE_RULE: &str = "tray_mode_rule";
const TRAY_SYSTEM_PROXY: &str = "tray_system_proxy";
const TRAY_QUIT: &str = "tray_quit";
const TRAY_POLICY_PREFIX: &str = "tray_policy";
const COMMON_POLICY_LIMIT: usize = 5;
const MAX_TOP_CLIENTS: usize = 5;

#[derive(Default)]
struct AppLifecycleState {
    quitting: AtomicBool,
    cleanup_done: AtomicBool,
}

impl AppLifecycleState {
    fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    fn mark_quitting(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }

    fn begin_cleanup(&self) -> bool {
        self.cleanup_done
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
}

#[derive(Clone, Debug)]
struct TrayPolicyGroup {
    name: String,
    now: Option<String>,
    nodes: Vec<String>,
}

#[derive(Default)]
struct TrayRuntimeState {
    delays: Mutex<HashMap<String, Option<u32>>>,
    latency_testing: AtomicBool,
    client_snapshot: Mutex<Option<ClientSnapshot>>,
    menu_sync_pending: AtomicBool,
}

#[derive(Clone, Debug)]
struct TrayConnectionSummary {
    quality: Option<u32>,
    clients: Vec<TrayClient>,
}

#[derive(Clone, Debug)]
struct TrayMenuSnapshot {
    mode: String,
    proxy_enabled: bool,
    policy_groups: Vec<TrayPolicyGroup>,
    delays: HashMap<String, Option<u32>>,
    connection_summary: TrayConnectionSummary,
    latency_testing: bool,
}

#[derive(Clone, Debug)]
struct TrayClient {
    name: String,
    rate_bps: u64,
}

struct ClientSnapshot {
    captured_at: Instant,
    totals: HashMap<String, u64>,
}

fn show_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window not found")?;
    let _ = window.unminimize();
    window
        .show()
        .map_err(|e| format!("show main window: {e}"))?;
    window
        .set_focus()
        .map_err(|e| format!("focus main window: {e}"))?;
    Ok(())
}

fn load_tray_icon() -> Option<TauriImage<'static>> {
    const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-icon.png");

    let source = image::load_from_memory(TRAY_ICON_BYTES).ok()?.into_rgba8();
    let (width, height) = source.dimensions();
    let mut left = width;
    let mut top = height;
    let mut right = 0;
    let mut bottom = 0;
    let mut found = false;

    for y in 0..height {
        for x in 0..width {
            if source.get_pixel(x, y).0[3] > 8 {
                left = left.min(x);
                top = top.min(y);
                right = right.max(x);
                bottom = bottom.max(y);
                found = true;
            }
        }
    }

    let cropped = if found {
        let crop_width = right - left + 1;
        let crop_height = bottom - top + 1;
        let pad_x = ((crop_width as f32) * 0.12).round() as u32;
        let pad_y = ((crop_height as f32) * 0.12).round() as u32;
        let left = left.saturating_sub(pad_x);
        let top = top.saturating_sub(pad_y);
        let right = (right + pad_x).min(width.saturating_sub(1));
        let bottom = (bottom + pad_y).min(height.saturating_sub(1));
        image::imageops::crop_imm(&source, left, top, right - left + 1, bottom - top + 1).to_image()
    } else {
        source
    };

    let max_side = 34.0f32;
    let scale = (max_side / cropped.width() as f32).min(max_side / cropped.height() as f32);
    let target_width = ((cropped.width() as f32) * scale).round().max(1.0) as u32;
    let target_height = ((cropped.height() as f32) * scale).round().max(1.0) as u32;
    let resized =
        image::imageops::resize(&cropped, target_width, target_height, FilterType::Lanczos3);
    let mut canvas = image::RgbaImage::new(40, 40);
    let offset_x = ((40 - resized.width()) / 2) as i64;
    let offset_y = ((40 - resized.height()) / 2) as i64;
    image::imageops::overlay(&mut canvas, &resized, offset_x, offset_y);

    let mut out = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(canvas)
        .write_to(&mut out, ImageFormat::Png)
        .ok()?;
    TauriImage::from_bytes(out.get_ref()).ok()
}

pub(crate) fn request_tray_menu_sync(app: &tauri::AppHandle) {
    let state = app.state::<TrayRuntimeState>();
    if state.menu_sync_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let snapshot = collect_tray_menu_snapshot(&handle).await;
        let apply_handle = handle.clone();
        if let Err(err) = handle.run_on_main_thread(move || {
            if let Err(err) = apply_tray_menu_snapshot(&apply_handle, &snapshot) {
                eprintln!("[fk_surge] apply tray menu snapshot failed: {err}");
            }
            apply_handle
                .state::<TrayRuntimeState>()
                .menu_sync_pending
                .store(false, Ordering::SeqCst);
        }) {
            eprintln!("[fk_surge] request tray menu sync failed: {err}");
            handle
                .state::<TrayRuntimeState>()
                .menu_sync_pending
                .store(false, Ordering::SeqCst);
        }
    });
}

async fn collect_tray_menu_snapshot(app: &tauri::AppHandle) -> TrayMenuSnapshot {
    let manager = app.state::<CoreManager>();
    let mode = manager
        .params()
        .map(|params| params.mode)
        .unwrap_or_else(|| engine::settings::load_mode(app));
    let proxy_enabled = engine::system_proxy::status(&commands::proxy_target(&manager))
        .map(|status| status.enabled)
        .unwrap_or(false);
    let policy_groups = load_tray_policy_groups(app).await;
    ensure_selected_policy_delays(app, &policy_groups).await;
    let delays = tray_delays_snapshot(app);
    let connection_summary = load_connection_summary(app, &policy_groups, &delays).await;
    TrayMenuSnapshot {
        mode,
        proxy_enabled,
        policy_groups,
        delays,
        connection_summary,
        latency_testing: tray_latency_testing(app),
    }
}

fn apply_tray_menu_snapshot(app: &tauri::AppHandle, snapshot: &TrayMenuSnapshot) -> Result<(), String> {
    let tray = app.tray_by_id(TRAY_ID).ok_or("tray not found")?;
    let menu = build_tray_menu(
        app,
        &snapshot.mode,
        snapshot.proxy_enabled,
        &snapshot.policy_groups,
        &snapshot.delays,
        &snapshot.connection_summary,
        snapshot.latency_testing,
    )
    .map_err(|e| format!("build tray menu: {e}"))?;
    tray.set_menu(Some(menu))
        .map_err(|e| format!("set tray menu: {e}"))?;
    Ok(())
}

fn tray_delays_snapshot(app: &tauri::AppHandle) -> HashMap<String, Option<u32>> {
    app.state::<TrayRuntimeState>()
        .delays
        .lock()
        .unwrap()
        .clone()
}

fn merge_tray_delays(app: &tauri::AppHandle, updates: HashMap<String, Option<u32>>) {
    if updates.is_empty() {
        return;
    }
    let state = app.state::<TrayRuntimeState>();
    let mut delays = state.delays.lock().unwrap();
    for (name, delay) in updates {
        delays.insert(name, delay);
    }
}

fn set_latency_testing(app: &tauri::AppHandle, value: bool) {
    app.state::<TrayRuntimeState>()
        .latency_testing
        .store(value, Ordering::SeqCst);
}

fn tray_latency_testing(app: &tauri::AppHandle) -> bool {
    app.state::<TrayRuntimeState>()
        .latency_testing
        .load(Ordering::SeqCst)
}

fn controller_for_app(app: &tauri::AppHandle) -> Option<Controller> {
    let manager = app.state::<CoreManager>();
    let params = manager.params()?;
    Some(Controller::new(&params.controller_addr, &params.secret))
}

async fn load_tray_policy_groups(app: &tauri::AppHandle) -> Vec<TrayPolicyGroup> {
    let Some(controller) = controller_for_app(app) else {
        return Vec::new();
    };

    let Ok(data) = controller.proxies().await else {
        return Vec::new();
    };

    parse_policy_groups(&data)
}

fn parse_policy_groups(data: &Value) -> Vec<TrayPolicyGroup> {
    let Some(proxies) = data.get("proxies").and_then(|value| value.as_object()) else {
        return Vec::new();
    };

    proxies
        .iter()
        .filter_map(|(name, node)| {
            let nodes = node
                .get("all")
                .and_then(|value| value.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(ToOwned::to_owned))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if nodes.is_empty() {
                return None;
            }

            Some(TrayPolicyGroup {
                name: name.clone(),
                now: node
                    .get("now")
                    .and_then(|value| value.as_str())
                    .map(ToOwned::to_owned),
                nodes,
            })
        })
        .collect()
}

fn split_policy_groups(groups: &[TrayPolicyGroup]) -> (Vec<TrayPolicyGroup>, Vec<TrayPolicyGroup>) {
    let mut ranked = groups.iter().cloned().enumerate().collect::<Vec<_>>();
    ranked.sort_by_key(|(index, group)| (policy_group_priority(&group.name), *index));

    let common_names = ranked
        .iter()
        .take(COMMON_POLICY_LIMIT)
        .map(|(_, group)| group.name.clone())
        .collect::<Vec<_>>();
    if common_names.is_empty() {
        return (Vec::new(), Vec::new());
    }

    let common_set = common_names.iter().cloned().collect::<HashSet<_>>();
    let mut common = Vec::new();
    let mut more = Vec::new();
    for group in groups {
        if common_set.contains(&group.name) {
            common.push(group.clone());
        } else {
            more.push(group.clone());
        }
    }

    common.sort_by_key(|group| {
        common_names
            .iter()
            .position(|name| name == &group.name)
            .unwrap_or(common_names.len())
    });

    (common, more)
}

fn policy_group_priority(name: &str) -> usize {
    let lower = name.to_ascii_lowercase();
    let keywords = [
        "proxy",
        "default",
        "select",
        "final",
        "fallback",
        "auto",
        "global",
        "direct",
        "节点选择",
        "代理",
        "最终选择",
        "漏网之鱼",
        "自动选择",
        "默认",
        "直连",
        "全局",
    ];

    keywords
        .iter()
        .position(|keyword| lower.contains(&keyword.to_ascii_lowercase()))
        .unwrap_or(keywords.len() + 10)
}

fn collect_selected_nodes(groups: &[TrayPolicyGroup]) -> Vec<String> {
    groups
        .iter()
        .filter_map(|group| group.now.clone())
        .collect()
}

fn collect_latency_targets(groups: &[TrayPolicyGroup]) -> Vec<String> {
    let (common, more) = split_policy_groups(groups);
    let mut targets = common
        .iter()
        .flat_map(|group| group.nodes.iter().cloned())
        .collect::<Vec<_>>();
    targets.extend(collect_selected_nodes(&more));
    dedup_names(&targets)
}

fn dedup_names(names: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for name in names {
        if seen.insert(name.clone()) {
            out.push(name.clone());
        }
    }
    out
}

async fn ensure_selected_policy_delays(app: &tauri::AppHandle, groups: &[TrayPolicyGroup]) {
    let delays = tray_delays_snapshot(app);
    let missing = collect_selected_nodes(groups)
        .into_iter()
        .filter(|name| !delays.contains_key(name))
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return;
    }
    let measured = measure_delay_nodes(app, &missing).await;
    merge_tray_delays(app, measured);
}

async fn measure_delay_nodes(
    app: &tauri::AppHandle,
    names: &[String],
) -> HashMap<String, Option<u32>> {
    let Some(controller) = controller_for_app(app) else {
        return HashMap::new();
    };

    controller
        .proxy_delay_many(
            &dedup_names(names),
            "https://www.gstatic.com/generate_204",
            2500,
            16,
        )
        .await
}

async fn load_connection_summary(
    app: &tauri::AppHandle,
    groups: &[TrayPolicyGroup],
    delays: &HashMap<String, Option<u32>>,
) -> TrayConnectionSummary {
    let quality = current_connectivity_quality(groups, delays);
    let Some(controller) = controller_for_app(app) else {
        return TrayConnectionSummary {
            quality,
            clients: Vec::new(),
        };
    };

    let Ok(data) = controller.connections().await else {
        return TrayConnectionSummary {
            quality,
            clients: Vec::new(),
        };
    };

    TrayConnectionSummary {
        quality,
        clients: parse_top_clients(app, &data),
    }
}

fn current_connectivity_quality(
    groups: &[TrayPolicyGroup],
    delays: &HashMap<String, Option<u32>>,
) -> Option<u32> {
    let values = collect_selected_nodes(groups)
        .into_iter()
        .filter_map(|name| delays.get(&name).copied().flatten())
        .collect::<Vec<_>>();
    if values.is_empty() {
        None
    } else {
        Some(values.iter().sum::<u32>() / values.len() as u32)
    }
}

fn parse_top_clients(app: &tauri::AppHandle, data: &Value) -> Vec<TrayClient> {
    let totals = parse_client_totals(data);
    let now = Instant::now();
    let state = app.state::<TrayRuntimeState>();
    let mut snapshot = state.client_snapshot.lock().unwrap();
    let previous = snapshot.take();

    let elapsed = previous
        .as_ref()
        .map(|sample| now.duration_since(sample.captured_at).as_secs_f64())
        .unwrap_or(0.0);

    let mut clients = totals
        .iter()
        .map(|(name, total)| {
            let previous_total = previous
                .as_ref()
                .and_then(|sample| sample.totals.get(name))
                .copied()
                .unwrap_or(*total);
            let rate_bps = if elapsed > 0.0 {
                ((*total).saturating_sub(previous_total) as f64 / elapsed).round() as u64
            } else {
                0
            };
            TrayClient {
                name: name.clone(),
                rate_bps,
            }
        })
        .collect::<Vec<_>>();

    clients.sort_by(|a, b| {
        b.rate_bps
            .cmp(&a.rate_bps)
            .then_with(|| a.name.cmp(&b.name))
    });
    clients.truncate(MAX_TOP_CLIENTS);

    *snapshot = Some(ClientSnapshot {
        captured_at: now,
        totals,
    });

    clients
}

fn parse_client_totals(data: &Value) -> HashMap<String, u64> {
    let Some(connections) = data.get("connections").and_then(|value| value.as_array()) else {
        return HashMap::new();
    };

    let mut totals = HashMap::<String, u64>::new();
    for connection in connections {
        let name = connection
            .get("metadata")
            .and_then(|value| value.as_object())
            .and_then(|meta| {
                meta.get("process")
                    .and_then(|value| value.as_str())
                    .or_else(|| meta.get("processPath").and_then(|value| value.as_str()))
            })
            .map(normalize_client_name)
            .unwrap_or_else(|| "Unknown Client".to_string());
        let upload = connection
            .get("upload")
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        let download = connection
            .get("download")
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        *totals.entry(name).or_insert(0) += upload + download;
    }
    totals
}

fn normalize_client_name(name: &str) -> String {
    let trimmed = name.rsplit('/').next().unwrap_or(name).trim();
    trimmed
        .strip_suffix(".app")
        .unwrap_or(trimmed)
        .strip_suffix(".exe")
        .unwrap_or(trimmed)
        .to_string()
}

fn build_tray_menu<M: Manager<Wry>>(
    app: &M,
    mode: &str,
    proxy_enabled: bool,
    policy_groups: &[TrayPolicyGroup],
    delays: &HashMap<String, Option<u32>>,
    connection_summary: &TrayConnectionSummary,
    latency_testing: bool,
) -> tauri::Result<Menu<Wry>> {
    let dashboard = MenuItemBuilder::with_id(TRAY_DASHBOARD, "Dashboard...")
        .accelerator("CmdOrCtrl+D")
        .build(app)?;
    let show_main = MenuItemBuilder::with_id(TRAY_SHOW_MAIN, "Show Main Window")
        .accelerator("CmdOrCtrl+M")
        .build(app)?;
    let refresh = MenuItemBuilder::with_id(TRAY_REFRESH, "Refresh Policies").build(app)?;
    let test_latency = MenuItemBuilder::with_id(
        TRAY_TEST_LATENCY,
        if latency_testing {
            "Testing Latency..."
        } else {
            "Test Latency"
        },
    )
    .enabled(!latency_testing)
    .build(app)?;
    let mode_direct = CheckMenuItemBuilder::with_id(TRAY_MODE_DIRECT, "Direct Outbound")
        .checked(mode == "direct")
        .build(app)?;
    let mode_global = CheckMenuItemBuilder::with_id(TRAY_MODE_GLOBAL, "Global Proxy")
        .checked(mode == "global")
        .build(app)?;
    let mode_rule = CheckMenuItemBuilder::with_id(TRAY_MODE_RULE, "Rule-Based Proxy")
        .checked(mode == "rule")
        .build(app)?;
    let outbound_mode = SubmenuBuilder::new(app, "Outbound Mode")
        .item(&mode_rule)
        .item(&mode_global)
        .item(&mode_direct)
        .build()?;
    let policies = build_policy_submenu(app, policy_groups, delays)?;
    let connectivity = MenuItemBuilder::with_id(
        "tray_connectivity",
        &format!(
            "Connectivity Quality    {}",
            format_delay_badge(connection_summary.quality)
        ),
    )
    .enabled(false)
    .build(app)?;
    let top_clients = build_top_clients_submenu(app, &connection_summary.clients)?;
    let system_proxy = CheckMenuItemBuilder::with_id(TRAY_SYSTEM_PROXY, "System Proxy")
        .checked(proxy_enabled)
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let quit = MenuItemBuilder::with_id(TRAY_QUIT, "Quit")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    MenuBuilder::new(app)
        .item(&dashboard)
        .item(&show_main)
        .separator()
        .item(&outbound_mode)
        .item(&policies)
        .item(&test_latency)
        .item(&refresh)
        .separator()
        .item(&connectivity)
        .item(&top_clients)
        .separator()
        .item(&system_proxy)
        .separator()
        .item(&quit)
        .build()
}

fn build_policy_submenu<M: Manager<Wry>>(
    app: &M,
    groups: &[TrayPolicyGroup],
    delays: &HashMap<String, Option<u32>>,
) -> tauri::Result<tauri::menu::Submenu<Wry>> {
    if groups.is_empty() {
        let empty = MenuItemBuilder::with_id("tray_policy_empty", "No Policy Groups").build(app)?;
        return SubmenuBuilder::new(app, "Proxy").item(&empty).build();
    }

    let (common, more) = split_policy_groups(groups);
    let mut builder = SubmenuBuilder::new(app, "Proxy");
    for group in &common {
        let group_menu = build_policy_group_submenu(app, group, delays)?;
        builder = builder.item(&group_menu);
    }
    if !more.is_empty() {
        let more_menu = build_more_policy_submenu(app, &more, delays)?;
        builder = builder.item(&more_menu);
    }
    builder.build()
}

fn build_policy_group_submenu(
    app: &impl Manager<Wry>,
    group: &TrayPolicyGroup,
    delays: &HashMap<String, Option<u32>>,
) -> tauri::Result<tauri::menu::Submenu<Wry>> {
    let mut builder = SubmenuBuilder::new(app, policy_group_label(group));
    for node in &group.nodes {
        let item = CheckMenuItemBuilder::with_id(
            policy_item_id(&group.name, node),
            policy_node_label(node, delays.get(node).copied().flatten()),
        )
        .checked(group.now.as_deref() == Some(node.as_str()))
        .build(app)?;
        builder = builder.item(&item);
    }
    builder.build()
}

fn build_more_policy_submenu(
    app: &impl Manager<Wry>,
    groups: &[TrayPolicyGroup],
    delays: &HashMap<String, Option<u32>>,
) -> tauri::Result<tauri::menu::Submenu<Wry>> {
    let mut builder = SubmenuBuilder::new(app, "More");
    for group in groups {
        let group_menu = build_policy_group_submenu(app, group, delays)?;
        builder = builder.item(&group_menu);
    }
    builder.build()
}

fn build_top_clients_submenu(
    app: &impl Manager<Wry>,
    clients: &[TrayClient],
) -> tauri::Result<tauri::menu::Submenu<Wry>> {
    if clients.is_empty() {
        let empty = MenuItemBuilder::with_id("tray_clients_empty", "No Active Clients")
            .enabled(false)
            .build(app)?;
        return SubmenuBuilder::new(app, "Top Clients").item(&empty).build();
    }

    let mut builder = SubmenuBuilder::new(app, "Top Clients");
    for client in clients {
        let item = MenuItemBuilder::with_id(
            format!("tray_client:{}", encode_id_part(&client.name)),
            format!("{}    {}/s", client.name, fmt_bytes(client.rate_bps)),
        )
        .enabled(false)
        .build(app)?;
        builder = builder.item(&item);
    }
    builder.build()
}

fn policy_group_label(group: &TrayPolicyGroup) -> String {
    match group.now.as_deref() {
        Some(now) if !now.is_empty() => format!("{}  ·  {}", group.name, now),
        _ => group.name.clone(),
    }
}

fn policy_node_label(name: &str, delay: Option<u32>) -> String {
    format!(
        "{} {}    {}",
        delay_marker(delay),
        name,
        format_delay_text(delay)
    )
}

fn delay_marker(delay: Option<u32>) -> &'static str {
    match delay {
        Some(value) if value < 200 => "🟢",
        Some(value) if value < 800 => "🟡",
        Some(_) => "🔴",
        None => "⚪",
    }
}

fn format_delay_text(delay: Option<u32>) -> String {
    delay
        .map(|value| format!("{value} ms"))
        .unwrap_or_else(|| "--".to_string())
}

fn format_delay_badge(delay: Option<u32>) -> String {
    format!("{} {}", delay_marker(delay), format_delay_text(delay))
}

fn fmt_bytes(n: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = n as f64;
    let mut index = 0;
    while value >= 1024.0 && index < units.len() - 1 {
        value /= 1024.0;
        index += 1;
    }
    if index == 0 || value >= 100.0 {
        format!("{} {}", value.round() as u64, units[index])
    } else {
        format!("{value:.1} {}", units[index])
    }
}

fn policy_item_id(group: &str, node: &str) -> String {
    format!(
        "{TRAY_POLICY_PREFIX}:{}:{}",
        encode_id_part(group),
        encode_id_part(node)
    )
}

fn parse_policy_item_id(id: &str) -> Option<(String, String)> {
    let rest = id.strip_prefix(&format!("{TRAY_POLICY_PREFIX}:"))?;
    let (group, node) = rest.split_once(':')?;
    Some((decode_id_part(group)?, decode_id_part(node)?))
}

fn encode_id_part(value: &str) -> String {
    let mut out = String::with_capacity(value.len() * 2);
    for byte in value.as_bytes() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn decode_id_part(value: &str) -> Option<String> {
    if value.len() % 2 != 0 {
        return None;
    }

    let mut bytes = Vec::with_capacity(value.len() / 2);
    let chars = value.as_bytes().chunks_exact(2);
    for pair in chars {
        let hex = std::str::from_utf8(pair).ok()?;
        let byte = u8::from_str_radix(hex, 16).ok()?;
        bytes.push(byte);
    }
    String::from_utf8(bytes).ok()
}

fn cleanup_before_exit(app: &tauri::AppHandle) {
    let lifecycle = app.state::<AppLifecycleState>();
    if !lifecycle.begin_cleanup() {
        return;
    }

    let manager = app.state::<CoreManager>();
    if let Err(err) = commands::cleanup_before_exit(app, &manager) {
        eprintln!("[fk_surge] cleanup system proxy failed: {err}");
    }
    if let Err(err) = manager.stop() {
        eprintln!("[fk_surge] stop core failed during exit: {err}");
    }
}

fn install_close_behavior(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            if handle.state::<AppLifecycleState>().is_quitting() {
                return;
            }
            api.prevent_close();
            if let Some(main_window) = handle.get_webview_window("main") {
                let _ = main_window.hide();
            }
        }
    });
}

fn install_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let menu = build_tray_menu(
        app,
        "rule",
        false,
        &[],
        &HashMap::new(),
        &TrayConnectionSummary {
            quality: None,
            clients: Vec::new(),
        },
        false,
    )?;

    let tray_icon = load_tray_icon().unwrap_or_else(|| {
        TauriImage::from_bytes(include_bytes!("../icons/tray-icon.png"))
            .expect("tray icon bytes must be valid png")
    });

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_icon)
        .icon_as_template(true)
        .tooltip("JLMS")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .build(app)?;

    app.on_menu_event(|app, event| match event.id().as_ref() {
        TRAY_DASHBOARD | TRAY_SHOW_MAIN => {
            let _ = show_main_window(app);
        }
        TRAY_REFRESH => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                request_tray_menu_sync(&handle);
            });
        }
        TRAY_TEST_LATENCY => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                set_latency_testing(&handle, true);
                let groups = load_tray_policy_groups(&handle).await;
                let measured =
                    measure_delay_nodes(&handle, &collect_latency_targets(&groups)).await;
                merge_tray_delays(&handle, measured);
                set_latency_testing(&handle, false);
                request_tray_menu_sync(&handle);
            });
        }
        TRAY_MODE_DIRECT | TRAY_MODE_GLOBAL | TRAY_MODE_RULE => {
            let mode = match event.id().as_ref() {
                TRAY_MODE_DIRECT => "direct",
                TRAY_MODE_GLOBAL => "global",
                _ => "rule",
            }
            .to_string();
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let manager = handle.state::<CoreManager>();
                if let Err(err) = commands::set_mode_with_handle(&handle, &manager, &mode).await {
                    eprintln!("[fk_surge] tray set mode failed: {err}");
                }
            });
        }
        TRAY_SYSTEM_PROXY => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let manager = handle.state::<CoreManager>();
                let current = engine::system_proxy::status(&commands::proxy_target(&manager))
                    .map(|status| status.enabled)
                    .unwrap_or(false);
                if let Err(err) =
                    commands::set_system_proxy_with_handle(&handle, &manager, !current)
                {
                    eprintln!("[fk_surge] tray toggle system proxy failed: {err}");
                }
            });
        }
        TRAY_QUIT => {
            app.state::<AppLifecycleState>().mark_quitting();
            cleanup_before_exit(app);
            app.exit(0);
        }
        id if id.starts_with(&format!("{TRAY_POLICY_PREFIX}:")) => {
            let Some((group, node)) = parse_policy_item_id(id) else {
                return;
            };
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let manager = handle.state::<CoreManager>();
                if let Err(err) =
                    commands::proxy_select_with_handle(&handle, &manager, &group, &node).await
                {
                    eprintln!("[fk_surge] tray select policy failed: {err}");
                }
                let has_cached_delay = tray_delays_snapshot(&handle).contains_key(&node);
                if !has_cached_delay {
                    let measured = measure_delay_nodes(&handle, &[node.clone()]).await;
                    if !measured.is_empty() {
                        merge_tray_delays(&handle, measured);
                        request_tray_menu_sync(&handle);
                    }
                }
            });
        }
        _ => {}
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(CoreManager::default())
        .manage(AppLifecycleState::default())
        .manage(TrayRuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            commands::core_start,
            commands::core_stop,
            commands::core_restart,
            commands::core_status,
            commands::controller_info,
            commands::system_proxy_status,
            commands::system_proxy_set,
            commands::latency_diagnostics,
            commands::proxies_get,
            commands::proxy_select,
            commands::proxy_delay,
            commands::proxy_delay_many,
            commands::set_mode,
            commands::profiles_list,
            commands::profiles_import,
            commands::profiles_import_file,
            commands::profiles_select,
            commands::profiles_update,
            commands::profiles_delete,
        ])
        .setup(|app| {
            if let Err(err) = paths::migrate_legacy_app_data(app.handle()) {
                eprintln!("[jlms] migrate legacy app data failed: {err}");
            }
            // Auto-start the core (with the active profile, if any) on launch.
            let handle = app.handle().clone();
            if let Err(err) = app.state::<CoreManager>().start(&handle) {
                eprintln!("[fk_surge] core auto-start failed: {err}");
                let _ = handle.emit(
                    "core://error",
                    "内核未启动，代理不可用。请检查 mihomo sidecar 是否被系统拦截或损坏。",
                );
            } else {
                let restore_handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let manager = restore_handle.state::<CoreManager>();
                    if let Err(err) =
                        commands::restore_proxy_selections(&restore_handle, &manager).await
                    {
                        eprintln!("[fk_surge] restore proxy selections failed: {err}");
                    }
                });
            }
            install_tray(app)?;
            install_close_behavior(&handle);
            request_tray_menu_sync(&handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            app_handle.state::<AppLifecycleState>().mark_quitting();
            cleanup_before_exit(app_handle);
        }
    });
}
