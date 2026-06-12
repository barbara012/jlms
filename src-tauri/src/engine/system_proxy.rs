use std::process::Command;

use serde::Serialize;

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Foundation::ERROR_FILE_NOT_FOUND,
    Networking::WinInet::{
        InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
    },
    System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_QUERY_VALUE, KEY_SET_VALUE, REG_DWORD, REG_EXPAND_SZ, REG_SZ,
    },
};

#[derive(Clone, Debug)]
pub struct ProxyTarget {
    pub host: String,
    pub port: u16,
}

#[derive(Serialize)]
pub struct SystemProxyStatus {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub services: Vec<String>,
    pub primary_service: Option<String>,
    pub primary_hardware_port: Option<String>,
}

#[derive(Serialize)]
pub struct NetworkDiagnostics {
    pub router_ms: Option<u32>,
    pub dns_ms: Option<u32>,
    pub gateway: Option<String>,
    pub dns_server: Option<String>,
    pub primary_service: Option<String>,
}

#[cfg(target_os = "windows")]
const WINDOWS_INTERNET_SETTINGS: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

#[derive(Debug, PartialEq, Eq)]
struct ProxyInfo {
    enabled: bool,
    server: Option<String>,
    port: Option<u16>,
}

pub fn status(target: &ProxyTarget) -> Result<SystemProxyStatus, String> {
    #[cfg(target_os = "windows")]
    {
        return windows_status(target);
    }

    let active = list_active_services()?;
    let service_order = list_service_order()?;
    let services = list_network_services()?;
    let mut matched = Vec::new();

    for service in services {
        if service_matches_target(&service, target)? {
            matched.push(service);
        }
    }

    let primary_service = active
        .iter()
        .find(|service| matched.iter().any(|item| item == *service))
        .cloned()
        .or_else(|| matched.first().cloned());
    let primary_hardware_port = primary_service.as_ref().and_then(|service| {
        service_order
            .iter()
            .find(|item| item.name == *service)
            .map(|item| item.hardware_port.clone())
    });

    Ok(SystemProxyStatus {
        enabled: !matched.is_empty(),
        host: target.host.clone(),
        port: target.port,
        services: matched,
        primary_service,
        primary_hardware_port,
    })
}

pub fn enable(target: &ProxyTarget) -> Result<SystemProxyStatus, String> {
    #[cfg(target_os = "windows")]
    {
        return windows_enable(target);
    }

    let active = list_active_services()?;
    let services = if active.is_empty() {
        list_network_services()?
    } else {
        active
    };
    if services.is_empty() {
        return Err("no network services found".to_string());
    }

    for service in &services {
        enable_service(service, target)?;
    }

    status(target)
}

pub fn disable(
    target: &ProxyTarget,
    preferred_services: &[String],
) -> Result<SystemProxyStatus, String> {
    #[cfg(target_os = "windows")]
    {
        let _ = preferred_services;
        return windows_disable(target);
    }

    let mut services = known_services(preferred_services)?;
    if services.is_empty() {
        services = matched_services(target)?;
    }

    for service in &services {
        disable_service(service)?;
    }

    status(target)
}

pub fn network_diagnostics() -> Result<NetworkDiagnostics, String> {
    let route = run_command(["route", "-n", "get", "default"])?;
    let gateway = parse_default_gateway(&route);
    let primary_service = list_active_services()?.into_iter().next();
    let dns_server = primary_service
        .as_deref()
        .and_then(|service| dns_servers_for_service(service).ok())
        .and_then(|servers| servers.into_iter().next());

    let router_ms = gateway
        .as_deref()
        .and_then(|host| measure_ping_latency(host).ok());
    let dns_ms = dns_server
        .as_deref()
        .and_then(|server| measure_dns_latency(server).ok());

    Ok(NetworkDiagnostics {
        router_ms,
        dns_ms,
        gateway,
        dns_server,
        primary_service,
    })
}

fn matched_services(target: &ProxyTarget) -> Result<Vec<String>, String> {
    let services = list_network_services()?;
    let mut matched = Vec::new();
    for service in services {
        if service_matches_target(&service, target)? {
            matched.push(service);
        }
    }
    Ok(matched)
}

fn known_services(services: &[String]) -> Result<Vec<String>, String> {
    let known = list_network_services()?;
    let mut resolved = Vec::new();
    for service in services {
        if known.iter().any(|name| name == service) && !resolved.contains(service) {
            resolved.push(service.clone());
        }
    }
    Ok(resolved)
}

fn enable_service(service: &str, target: &ProxyTarget) -> Result<(), String> {
    let port = target.port.to_string();
    run_networksetup(["-setwebproxy", service, &target.host, &port])?;
    run_networksetup(["-setwebproxystate", service, "on"])?;
    run_networksetup(["-setsecurewebproxy", service, &target.host, &port])?;
    run_networksetup(["-setsecurewebproxystate", service, "on"])?;
    run_networksetup(["-setsocksfirewallproxy", service, &target.host, &port])?;
    run_networksetup(["-setsocksfirewallproxystate", service, "on"])?;
    Ok(())
}

fn disable_service(service: &str) -> Result<(), String> {
    run_networksetup(["-setwebproxystate", service, "off"])?;
    run_networksetup(["-setsecurewebproxystate", service, "off"])?;
    run_networksetup(["-setsocksfirewallproxystate", service, "off"])?;
    Ok(())
}

fn service_matches_target(service: &str, target: &ProxyTarget) -> Result<bool, String> {
    let web = proxy_info(["-getwebproxy", service])?;
    let secure = proxy_info(["-getsecurewebproxy", service])?;
    let socks = proxy_info(["-getsocksfirewallproxy", service])?;

    Ok(matches_target(&web, target)
        && matches_target(&secure, target)
        && matches_target(&socks, target))
}

fn matches_target(info: &ProxyInfo, target: &ProxyTarget) -> bool {
    info.enabled
        && info.server.as_deref() == Some(target.host.as_str())
        && info.port == Some(target.port)
}

fn proxy_info<const N: usize>(args: [&str; N]) -> Result<ProxyInfo, String> {
    let output = run_networksetup(args)?;
    parse_proxy_info(&output)
}

fn list_network_services() -> Result<Vec<String>, String> {
    let output = run_networksetup(["-listallnetworkservices"])?;
    Ok(parse_network_services(&output))
}

fn list_active_services() -> Result<Vec<String>, String> {
    let route = run_command(["route", "-n", "get", "default"])?;
    let Some(device) = parse_default_interface(&route) else {
        return Ok(Vec::new());
    };
    Ok(list_service_order()?
        .into_iter()
        .filter(|service| service.device == device && !service.disabled)
        .map(|service| service.name)
        .collect())
}

fn list_service_order() -> Result<Vec<ServiceOrderItem>, String> {
    let order = run_networksetup(["-listnetworkserviceorder"])?;
    Ok(parse_service_order(&order))
}

fn dns_servers_for_service(service: &str) -> Result<Vec<String>, String> {
    let output = run_networksetup(["-getdnsservers", service])?;
    Ok(parse_dns_servers(&output))
}

fn run_networksetup<const N: usize>(args: [&str; N]) -> Result<String, String> {
    run_command_with_program("networksetup", &args)
}

fn run_command<const N: usize>(args: [&str; N]) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        if args.is_empty() {
            return Err("empty command".to_string());
        }
        let (program, rest) = args.split_first().expect("checked not empty");
        run_command_with_program(program, rest)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = args;
        Err("network diagnostics are not implemented on this platform yet".to_string())
    }
}

fn run_command_with_program(program: &str, args: &[&str]) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new(program)
            .args(args)
            .output()
            .map_err(|e| format!("run {program}: {e}"))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if err.is_empty() {
                Err(format!("{program} {:?}: exit {}", args, output.status))
            } else {
                Err(format!("{program} {:?}: {}", args, err))
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (program, args);
        Err("command execution is not implemented on this platform yet".to_string())
    }
}

#[cfg(target_os = "windows")]
fn windows_status(target: &ProxyTarget) -> Result<SystemProxyStatus, String> {
    let enabled = windows_query_dword("ProxyEnable")?.unwrap_or(0) != 0;
    let proxy_server = windows_query_string("ProxyServer")?;
    let matched = enabled
        && proxy_server
            .as_deref()
            .map(|value| windows_proxy_matches_target(value, target))
            .unwrap_or(false);

    Ok(SystemProxyStatus {
        enabled: matched,
        host: target.host.clone(),
        port: target.port,
        services: if matched {
            vec!["Windows".to_string()]
        } else {
            Vec::new()
        },
        primary_service: matched.then(|| "Windows System Proxy".to_string()),
        primary_hardware_port: None,
    })
}

#[cfg(target_os = "windows")]
fn windows_enable(target: &ProxyTarget) -> Result<SystemProxyStatus, String> {
    let value = format!(
        "http={host}:{port};https={host}:{port};socks={host}:{port}",
        host = target.host,
        port = target.port
    );
    windows_set_string("ProxyServer", &value)?;
    windows_set_dword("ProxyEnable", 1)?;
    windows_notify_proxy_changed()?;
    windows_status(target)
}

#[cfg(target_os = "windows")]
fn windows_disable(target: &ProxyTarget) -> Result<SystemProxyStatus, String> {
    windows_set_dword("ProxyEnable", 0)?;
    windows_notify_proxy_changed()?;
    windows_status(target)
}

#[cfg(target_os = "windows")]
fn windows_proxy_matches_target(proxy_server: &str, target: &ProxyTarget) -> bool {
    let expected = format!("{}:{}", target.host, target.port);
    proxy_server
        .split(';')
        .filter_map(|item| {
            let trimmed = item.trim();
            if trimmed.is_empty() {
                return None;
            }
            Some(
                trimmed
                    .split_once('=')
                    .map(|(_, value)| value.trim())
                    .unwrap_or(trimmed),
            )
        })
        .any(|value| value.eq_ignore_ascii_case(&expected))
}

#[cfg(target_os = "windows")]
fn windows_notify_proxy_changed() -> Result<(), String> {
    unsafe {
        if InternetSetOptionW(0, INTERNET_OPTION_SETTINGS_CHANGED, std::ptr::null_mut(), 0) == 0 {
            return Err("notify system proxy change failed".to_string());
        }
        if InternetSetOptionW(0, INTERNET_OPTION_REFRESH, std::ptr::null_mut(), 0) == 0 {
            return Err("refresh system proxy settings failed".to_string());
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_open_internet_settings() -> Result<HKEY, String> {
    let mut key: HKEY = std::ptr::null_mut();
    let path = windows_wide_null(WINDOWS_INTERNET_SETTINGS);
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            path.as_ptr(),
            0,
            KEY_QUERY_VALUE | KEY_SET_VALUE,
            &mut key,
        )
    };
    if status == 0 {
        Ok(key)
    } else {
        Err(format!("open Windows internet settings failed: {status}"))
    }
}

#[cfg(target_os = "windows")]
fn windows_query_dword(name: &str) -> Result<Option<u32>, String> {
    let key = windows_open_internet_settings()?;
    let value_name = windows_wide_null(name);
    let mut ty = 0u32;
    let mut value = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegQueryValueExW(
            key,
            value_name.as_ptr(),
            std::ptr::null_mut(),
            &mut ty,
            (&mut value as *mut u32).cast(),
            &mut size,
        )
    };
    unsafe {
        RegCloseKey(key);
    }
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if status != 0 {
        return Err(format!("query Windows registry value {name} failed: {status}"));
    }
    if ty != REG_DWORD {
        return Err(format!("unexpected registry type for {name}: {ty}"));
    }
    Ok(Some(value))
}

#[cfg(target_os = "windows")]
fn windows_query_string(name: &str) -> Result<Option<String>, String> {
    let key = windows_open_internet_settings()?;
    let value_name = windows_wide_null(name);
    let mut ty = 0u32;
    let mut size = 0u32;
    let status = unsafe {
        RegQueryValueExW(
            key,
            value_name.as_ptr(),
            std::ptr::null_mut(),
            &mut ty,
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        unsafe {
            RegCloseKey(key);
        }
        return Ok(None);
    }
    if status != 0 {
        unsafe {
            RegCloseKey(key);
        }
        return Err(format!("query Windows registry value {name} failed: {status}"));
    }
    if ty != REG_SZ && ty != REG_EXPAND_SZ {
        unsafe {
            RegCloseKey(key);
        }
        return Err(format!("unexpected registry type for {name}: {ty}"));
    }
    let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
    let status = unsafe {
        RegQueryValueExW(
            key,
            value_name.as_ptr(),
            std::ptr::null_mut(),
            &mut ty,
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    unsafe {
        RegCloseKey(key);
    }
    if status != 0 {
        return Err(format!("read Windows registry value {name} failed: {status}"));
    }
    let end = buffer.iter().position(|item| *item == 0).unwrap_or(buffer.len());
    let value = String::from_utf16_lossy(&buffer[..end]);
    if value.trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(value))
    }
}

#[cfg(target_os = "windows")]
fn windows_set_dword(name: &str, value: u32) -> Result<(), String> {
    let key = windows_open_internet_settings()?;
    let value_name = windows_wide_null(name);
    let bytes = value.to_le_bytes();
    let status = unsafe {
        RegSetValueExW(
            key,
            value_name.as_ptr(),
            0,
            REG_DWORD,
            bytes.as_ptr(),
            bytes.len() as u32,
        )
    };
    unsafe {
        RegCloseKey(key);
    }
    if status == 0 {
        Ok(())
    } else {
        Err(format!("set Windows registry value {name} failed: {status}"))
    }
}

#[cfg(target_os = "windows")]
fn windows_set_string(name: &str, value: &str) -> Result<(), String> {
    let key = windows_open_internet_settings()?;
    let value_name = windows_wide_null(name);
    let bytes = windows_wide_null(value);
    let status = unsafe {
        RegSetValueExW(
            key,
            value_name.as_ptr(),
            0,
            REG_SZ,
            bytes.as_ptr().cast(),
            (bytes.len() * std::mem::size_of::<u16>()) as u32,
        )
    };
    unsafe {
        RegCloseKey(key);
    }
    if status == 0 {
        Ok(())
    } else {
        Err(format!("set Windows registry value {name} failed: {status}"))
    }
}

#[cfg(target_os = "windows")]
fn windows_wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn measure_ping_latency(host: &str) -> Result<u32, String> {
    let output = run_command_with_program("ping", &["-n", "-c", "1", "-W", "1200", host])?;
    parse_ping_time_ms(&output).ok_or_else(|| format!("parse ping latency for {host}"))
}

fn measure_dns_latency(server: &str) -> Result<u32, String> {
    let output = run_command_with_program(
        "dig",
        &[
            &format!("@{server}"),
            "www.apple.com",
            "+tries=1",
            "+time=2",
            "+stats",
        ],
    )?;
    parse_dig_query_time_ms(&output)
        .or_else(|| parse_ping_time_ms(&output))
        .ok_or_else(|| format!("parse dns latency for {server}"))
        .or_else(|_| measure_ping_latency(server))
}

#[derive(Debug, PartialEq, Eq)]
struct ServiceOrderItem {
    name: String,
    hardware_port: String,
    device: String,
    disabled: bool,
}

fn parse_network_services(output: &str) -> Vec<String> {
    output
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            !trimmed.is_empty() && !trimmed.starts_with("An asterisk (*) denotes")
        })
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with('*') {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .collect()
}

fn parse_default_interface(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let trimmed = line.trim();
        let (key, value) = trimmed.split_once(':')?;
        if key.trim() == "interface" {
            Some(value.trim().to_string())
        } else {
            None
        }
    })
}

fn parse_default_gateway(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let trimmed = line.trim();
        let (key, value) = trimmed.split_once(':')?;
        if key.trim() == "gateway" {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        } else {
            None
        }
    })
}

fn parse_service_order(output: &str) -> Vec<ServiceOrderItem> {
    let mut items = Vec::new();
    let mut pending_name: Option<(String, bool)> = None;

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if trimmed.starts_with('(') && trimmed.contains(')') && !trimmed.contains("Hardware Port:")
        {
            let name = trimmed
                .split_once(')')
                .map(|(_, rest)| rest.trim().trim_start_matches('*').trim().to_string())
                .unwrap_or_default();
            let disabled = trimmed.contains('*');
            if !name.is_empty() {
                pending_name = Some((name, disabled));
            }
            continue;
        }

        if trimmed.starts_with("(Hardware Port:") {
            let Some((name, disabled)) = pending_name.take() else {
                continue;
            };
            let hardware_port = trimmed
                .strip_prefix("(Hardware Port:")
                .and_then(|rest| rest.split(", Device:").next())
                .map(|value| value.trim().to_string())
                .unwrap_or_default();
            let device = trimmed
                .split("Device:")
                .nth(1)
                .map(|rest| rest.trim().trim_end_matches(')').trim().to_string())
                .unwrap_or_default();
            if !device.is_empty() && !hardware_port.is_empty() {
                items.push(ServiceOrderItem {
                    name,
                    hardware_port,
                    device,
                    disabled,
                });
            }
        }
    }

    items
}

fn parse_dns_servers(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| !line.starts_with("There aren't any DNS Servers set on"))
        .map(ToString::to_string)
        .collect()
}

fn parse_proxy_info(output: &str) -> Result<ProxyInfo, String> {
    let mut enabled = None;
    let mut server = None;
    let mut port = None;

    for line in output.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        match key {
            "Enabled" => enabled = Some(matches!(value, "Yes" | "1")),
            "Server" => {
                if !value.is_empty() {
                    server = Some(value.to_string());
                }
            }
            "Port" => {
                if !value.is_empty() {
                    port = Some(
                        value
                            .parse::<u16>()
                            .map_err(|e| format!("parse proxy port: {e}"))?,
                    );
                }
            }
            _ => {}
        }
    }

    Ok(ProxyInfo {
        enabled: enabled.unwrap_or(false),
        server,
        port,
    })
}

fn parse_ping_time_ms(output: &str) -> Option<u32> {
    output.lines().find_map(|line| {
        let marker = "time=";
        let start = line.find(marker)? + marker.len();
        let rest = &line[start..];
        let end = rest
            .find(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
            .unwrap_or(rest.len());
        let value = rest[..end].trim().parse::<f32>().ok()?;
        Some(value.round() as u32)
    })
}

fn parse_dig_query_time_ms(output: &str) -> Option<u32> {
    output.lines().find_map(|line| {
        let trimmed = line.trim();
        let value = trimmed.strip_prefix(";; Query time: ")?;
        let numeric = value.strip_suffix(" msec")?.trim();
        numeric.parse::<u32>().ok()
    })
}

#[cfg(test)]
mod tests {
    use super::{
        parse_default_gateway, parse_default_interface, parse_dig_query_time_ms, parse_dns_servers,
        parse_network_services, parse_ping_time_ms, parse_proxy_info, parse_service_order,
        ProxyInfo, ServiceOrderItem,
    };

    #[test]
    fn parses_network_services_and_skips_disabled() {
        let output = r#"An asterisk (*) denotes that a network service is disabled.
Wi-Fi
USB 10/100/1000 LAN
*Thunderbolt Bridge
"#;

        assert_eq!(
            parse_network_services(output),
            vec!["Wi-Fi".to_string(), "USB 10/100/1000 LAN".to_string()]
        );
    }

    #[test]
    fn parses_proxy_info_output() {
        let output = r#"Enabled: Yes
Server: 127.0.0.1
Port: 7890
Authenticated Proxy Enabled: 0
"#;

        assert_eq!(
            parse_proxy_info(output).expect("parse proxy info"),
            ProxyInfo {
                enabled: true,
                server: Some("127.0.0.1".to_string()),
                port: Some(7890),
            }
        );
    }

    #[test]
    fn parses_default_interface() {
        let output = r#"   route to: default
destination: default
       mask: default
    gateway: 192.168.1.1
  interface: en0
      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>
"#;

        assert_eq!(parse_default_interface(output), Some("en0".to_string()));
    }

    #[test]
    fn parses_default_gateway() {
        let output = r#"   route to: default
destination: default
       mask: default
    gateway: 192.168.1.1
  interface: en0
"#;

        assert_eq!(
            parse_default_gateway(output),
            Some("192.168.1.1".to_string())
        );
    }

    #[test]
    fn parses_service_order_output() {
        let output = r#"(1) Wi-Fi
(Hardware Port: Wi-Fi, Device: en0)

(2) USB 10/100/1000 LAN
(Hardware Port: USB 10/100/1000 LAN, Device: en7)

(3) *Thunderbolt Bridge
(Hardware Port: Thunderbolt Bridge, Device: bridge0)
"#;

        assert_eq!(
            parse_service_order(output),
            vec![
                ServiceOrderItem {
                    name: "Wi-Fi".to_string(),
                    hardware_port: "Wi-Fi".to_string(),
                    device: "en0".to_string(),
                    disabled: false,
                },
                ServiceOrderItem {
                    name: "USB 10/100/1000 LAN".to_string(),
                    hardware_port: "USB 10/100/1000 LAN".to_string(),
                    device: "en7".to_string(),
                    disabled: false,
                },
                ServiceOrderItem {
                    name: "Thunderbolt Bridge".to_string(),
                    hardware_port: "Thunderbolt Bridge".to_string(),
                    device: "bridge0".to_string(),
                    disabled: true,
                },
            ]
        );
    }

    #[test]
    fn parses_dns_servers_output() {
        let output = "8.8.8.8\n1.1.1.1\n";
        assert_eq!(
            parse_dns_servers(output),
            vec!["8.8.8.8".to_string(), "1.1.1.1".to_string()]
        );
    }

    #[test]
    fn parses_ping_time_output() {
        let output = "64 bytes from 192.168.1.1: icmp_seq=0 ttl=64 time=3.512 ms";
        assert_eq!(parse_ping_time_ms(output), Some(4));
    }

    #[test]
    fn parses_dig_query_time_output() {
        let output = ";; Query time: 14 msec";
        assert_eq!(parse_dig_query_time_ms(output), Some(14));
    }
}
