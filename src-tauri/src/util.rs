//! Small shared helpers.

/// Current Unix time in seconds (0 if the clock is before the epoch).
pub fn now_unix() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Hex string from `len` random bytes (read from `/dev/urandom`).
pub fn random_hex(len: usize) -> String {
    use std::io::Read;
    let mut buf = vec![0u8; len];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut buf);
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}
