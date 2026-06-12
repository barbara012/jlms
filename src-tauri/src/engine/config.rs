//! Generation of the mihomo `config.yaml`.
//!
//! When a profile is active its YAML is the base; we then force our
//! control-plane keys (controller, secret, ports, mode) on top so the shell
//! always keeps control regardless of what the subscription declares. With no
//! profile we emit a minimal all-DIRECT config.

use serde::Serialize;
use serde_yaml::{Mapping, Value};

/// Runtime parameters that control how the core is launched.
#[derive(Clone, Debug, Serialize)]
pub struct CoreParams {
    pub mixed_port: u16,
    pub controller_addr: String,
    pub secret: String,
    pub allow_lan: bool,
    /// `rule` | `global` | `direct`.
    pub mode: String,
    pub log_level: String,
}

impl Default for CoreParams {
    fn default() -> Self {
        Self {
            mixed_port: 7890,
            controller_addr: "127.0.0.1:9090".to_string(),
            secret: String::new(),
            allow_lan: false,
            mode: "rule".to_string(),
            log_level: "info".to_string(),
        }
    }
}

/// Render the YAML config, optionally on top of a base profile's YAML.
pub fn render_config(p: &CoreParams, base: Option<&str>) -> Result<String, String> {
    let mut root: Value = match base {
        Some(text) => serde_yaml::from_str(text).map_err(|e| format!("parse profile: {e}"))?,
        None => Value::Mapping(Mapping::new()),
    };

    let map = match &mut root {
        Value::Mapping(m) => m,
        _ => return Err("profile root is not a YAML mapping".into()),
    };

    // Control-plane keys — always ours.
    put(map, "mixed-port", p.mixed_port as u64);
    put(map, "port", 0_u64);
    put(map, "socks-port", 0_u64);
    put(map, "redir-port", 0_u64);
    put(map, "tproxy-port", 0_u64);
    put(map, "allow-lan", p.allow_lan);
    put(map, "mode", p.mode.as_str());
    put(map, "log-level", p.log_level.as_str());
    put(map, "external-controller", p.controller_addr.as_str());
    put(map, "secret", p.secret.as_str());

    // Persist the user's per-group selections across reloads/restarts.
    let mut profile = Mapping::new();
    profile.insert(Value::from("store-selected"), Value::from(true));
    put(map, "profile", Value::Mapping(profile));

    // Baseline when there is no profile: route everything DIRECT.
    if base.is_none() {
        put(map, "ipv6", false);
        put(
            map,
            "rules",
            Value::Sequence(vec![Value::from("MATCH,DIRECT")]),
        );
    }

    serde_yaml::to_string(&root).map_err(|e| format!("render config: {e}"))
}

fn put(map: &mut Mapping, key: &str, val: impl Into<Value>) {
    map.insert(Value::from(key), val.into());
}

#[cfg(test)]
mod tests {
    use super::{render_config, CoreParams};
    use serde_yaml::Value;

    #[test]
    fn forces_single_mixed_port_on_top_of_profile() {
        let base = r#"
port: 7891
socks-port: 7892
redir-port: 7893
tproxy-port: 7894
mixed-port: 9000
"#;

        let rendered = render_config(&CoreParams::default(), Some(base)).expect("render config");
        let parsed: Value = serde_yaml::from_str(&rendered).expect("parse rendered yaml");
        let map = parsed.as_mapping().expect("rendered root mapping");

        assert_eq!(
            map.get(Value::from("mixed-port")).and_then(Value::as_u64),
            Some(7890)
        );
        assert_eq!(
            map.get(Value::from("port")).and_then(Value::as_u64),
            Some(0)
        );
        assert_eq!(
            map.get(Value::from("socks-port")).and_then(Value::as_u64),
            Some(0)
        );
        assert_eq!(
            map.get(Value::from("redir-port")).and_then(Value::as_u64),
            Some(0)
        );
        assert_eq!(
            map.get(Value::from("tproxy-port")).and_then(Value::as_u64),
            Some(0)
        );
    }
}
