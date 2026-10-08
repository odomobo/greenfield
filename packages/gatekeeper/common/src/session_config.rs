//! The desktop's SessionConfig record, which the helpers write to its fd 3 (the format is documented in
//! packages/session/src/session-config.ts).
use std::path::Path;

/// The fds a desktop is started with: its SessionConfig and its listening socket (`desktop.sock`).
pub const SESSION_CONFIG_FD: i32 = 3;
pub const SESSION_LISTEN_FD: i32 = 4;

/// A JSON string literal.
pub fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The record: the listening socket at SESSION_LISTEN_FD, the site settings file if not the default, and the dev
/// helper's `devFlags` object (JSON) if any.
pub fn session_config(site_settings: Option<&Path>, dev_flags: Option<&str>) -> String {
    let site = site_settings
        .map(|path| format!(",\"siteSettingsPath\":{}", json_string(&path.to_string_lossy())))
        .unwrap_or_default();
    let dev = dev_flags.map(|flags| format!(",\"devFlags\":{flags}")).unwrap_or_default();
    format!("{{\"version\":1,\"listenFd\":{SESSION_LISTEN_FD}{site}{dev}}}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records() {
        assert_eq!(session_config(None, None), r#"{"version":1,"listenFd":4}"#);
        assert_eq!(
            session_config(Some(Path::new("/run/nebula/nebula.conf")), Some(r#"{"timeScale":3}"#)),
            r#"{"version":1,"listenFd":4,"siteSettingsPath":"/run/nebula/nebula.conf","devFlags":{"timeScale":3}}"#
        );
        assert_eq!(json_string("a\"b\\c\n"), r#""a\"b\\c\u000a""#);
    }
}
