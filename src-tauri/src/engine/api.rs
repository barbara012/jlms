//! Thin client over the mihomo external controller (Clash-compatible REST API).

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::Value;
use tokio::task::JoinSet;

#[derive(Clone)]
pub struct Controller {
    base: String,
    secret: String,
    http: reqwest::Client,
}

#[derive(Deserialize)]
struct VersionResponse {
    version: String,
}

impl Controller {
    pub fn new(addr: &str, secret: &str) -> Self {
        Self {
            base: format!("http://{addr}"),
            secret: secret.to_string(),
            http: reqwest::Client::new(),
        }
    }

    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if self.secret.is_empty() {
            req
        } else {
            req.bearer_auth(&self.secret)
        }
    }

    /// `GET /version` — also serves as a readiness probe for the core.
    pub async fn version(&self) -> Result<String, String> {
        let resp = self
            .auth(self.http.get(format!("{}/version", self.base)))
            .send()
            .await
            .map_err(|e| format!("contact core: {e}"))?;
        let parsed: VersionResponse = resp
            .json()
            .await
            .map_err(|e| format!("parse version: {e}"))?;
        Ok(parsed.version)
    }

    /// `PUT /configs?force=true` — reload the core from a config file on disk.
    pub async fn reload_config(&self, path: &str) -> Result<(), String> {
        let resp = self
            .auth(self.http.put(format!("{}/configs?force=true", self.base)))
            .json(&serde_json::json!({ "path": path }))
            .send()
            .await
            .map_err(|e| format!("reload core: {e}"))?;
        ok_or_status(resp, "reload core").await
    }

    /// `GET /proxies` — all proxies and policy groups (raw JSON for the UI).
    pub async fn proxies(&self) -> Result<Value, String> {
        self.auth(self.http.get(format!("{}/proxies", self.base)))
            .send()
            .await
            .map_err(|e| format!("proxies: {e}"))?
            .json()
            .await
            .map_err(|e| format!("parse proxies: {e}"))
    }

    /// `GET /connections` — active connections snapshot (raw JSON for tray/status UI).
    pub async fn connections(&self) -> Result<Value, String> {
        self.auth(self.http.get(format!("{}/connections", self.base)))
            .send()
            .await
            .map_err(|e| format!("connections: {e}"))?
            .json()
            .await
            .map_err(|e| format!("parse connections: {e}"))
    }

    /// `PUT /proxies/{group}` — pick `name` as the group's current selection.
    pub async fn select_proxy(&self, group: &str, name: &str) -> Result<(), String> {
        let resp = self
            .auth(
                self.http
                    .put(format!("{}/proxies/{}", self.base, enc(group))),
            )
            .json(&serde_json::json!({ "name": name }))
            .send()
            .await
            .map_err(|e| format!("select proxy: {e}"))?;
        ok_or_status(resp, "select proxy").await
    }

    /// `GET /proxies/{name}/delay` — latency probe in milliseconds.
    pub async fn proxy_delay(
        &self,
        name: &str,
        test_url: &str,
        timeout: u32,
    ) -> Result<u32, String> {
        let url = format!(
            "{}/proxies/{}/delay?timeout={}&url={}",
            self.base,
            enc(name),
            timeout,
            enc(test_url)
        );
        let resp = self
            .auth(self.http.get(url))
            .send()
            .await
            .map_err(|e| format!("delay: {e}"))?;
        if !resp.status().is_success() {
            return Err("timeout".to_string());
        }
        let v: Value = resp.json().await.map_err(|e| format!("parse delay: {e}"))?;
        v.get("delay")
            .and_then(|d| d.as_u64())
            .map(|d| d as u32)
            .ok_or_else(|| "timeout".to_string())
    }

    pub async fn proxy_delay_many(
        &self,
        names: &[String],
        test_url: &str,
        timeout: u32,
        concurrency: usize,
    ) -> HashMap<String, Option<u32>> {
        let mut seen = HashSet::new();
        let unique = names
            .iter()
            .filter(|name| seen.insert((*name).clone()))
            .cloned()
            .collect::<Vec<_>>();
        if unique.is_empty() {
            return HashMap::new();
        }

        let test_url = test_url.to_string();
        let mut measured = HashMap::with_capacity(unique.len());
        let mut pending = unique.into_iter();
        let mut in_flight = JoinSet::new();
        let slots = concurrency.max(1);

        for _ in 0..slots {
            let Some(name) = pending.next() else {
                break;
            };
            let controller = self.clone();
            let url = test_url.clone();
            in_flight.spawn(async move {
                let delay = controller.proxy_delay(&name, &url, timeout).await.ok();
                (name, delay)
            });
        }

        while let Some(result) = in_flight.join_next().await {
            if let Ok((name, delay)) = result {
                measured.insert(name, delay);
            }

            if let Some(name) = pending.next() {
                let controller = self.clone();
                let url = test_url.clone();
                in_flight.spawn(async move {
                    let delay = controller.proxy_delay(&name, &url, timeout).await.ok();
                    (name, delay)
                });
            }
        }

        measured
    }

    /// `PATCH /configs` — change the outbound mode (`rule` | `global` | `direct`).
    pub async fn patch_mode(&self, mode: &str) -> Result<(), String> {
        let resp = self
            .auth(self.http.patch(format!("{}/configs", self.base)))
            .json(&serde_json::json!({ "mode": mode }))
            .send()
            .await
            .map_err(|e| format!("set mode: {e}"))?;
        ok_or_status(resp, "set mode").await
    }
}

async fn ok_or_status(resp: reqwest::Response, what: &str) -> Result<(), String> {
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("{what}: HTTP {}", resp.status()))
    }
}

/// Percent-encode a single URL path/query segment (names may contain spaces,
/// slashes or emoji, e.g. `♥ Twitter`).
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
