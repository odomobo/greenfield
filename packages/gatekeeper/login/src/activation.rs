//! Socket activation by systemd (the sd_listen_fds protocol, by hand: no libsystemd). When started from a socket
//! unit, systemd passes the listening socket as descriptor 3 and sets LISTEN_PID (our pid) and LISTEN_FDS (how many).
#![forbid(unsafe_code)]

/// The first descriptor systemd passes (SD_LISTEN_FDS_START).
pub const LISTEN_FDS_START: i32 = 3;

/// How many descriptors systemd passed to this process: `Ok(None)` when it did not start us through socket
/// activation (no LISTEN_PID / LISTEN_FDS, or meant for another process, e.g. inherited from a parent), `Ok(Some(n))`
/// for n >= 1 descriptors from LISTEN_FDS_START on, an error for values that make no sense.
pub fn parse(listen_pid: Option<&str>, listen_fds: Option<&str>, own_pid: u32) -> Result<Option<usize>, String> {
    let (Some(listen_pid), Some(listen_fds)) = (listen_pid, listen_fds) else {
        return Ok(None);
    };
    match listen_pid.parse::<u32>() {
        Ok(pid) if pid == own_pid => {}
        Ok(_) => return Ok(None),
        Err(_) => return Err(format!("LISTEN_PID is not a number: {listen_pid:?}")),
    }
    match listen_fds.parse::<usize>() {
        Ok(0) => Ok(None),
        Ok(count) if count <= 1024 => Ok(Some(count)),
        _ => Err(format!("LISTEN_FDS is not a sensible count: {listen_fds:?}")),
    }
}

/// `parse` on this process's environment.
pub fn from_environment() -> Result<Option<usize>, String> {
    parse(
        std::env::var("LISTEN_PID").ok().as_deref(),
        std::env::var("LISTEN_FDS").ok().as_deref(),
        std::process::id(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_activated() {
        assert_eq!(parse(None, None, 10), Ok(None));
        assert_eq!(parse(Some("10"), None, 10), Ok(None));
        assert_eq!(parse(None, Some("1"), 10), Ok(None));
        // meant for another process (inherited environment)
        assert_eq!(parse(Some("11"), Some("1"), 10), Ok(None));
        assert_eq!(parse(Some("10"), Some("0"), 10), Ok(None));
    }

    #[test]
    fn activated() {
        assert_eq!(parse(Some("10"), Some("1"), 10), Ok(Some(1)));
        assert_eq!(parse(Some("10"), Some("2"), 10), Ok(Some(2)));
    }

    #[test]
    fn nonsense() {
        for (pid, fds) in [("x", "1"), ("", "1"), ("-1", "1"), ("10", "x"), ("10", "-1"), ("10", ""), ("10", "99999")] {
            assert!(parse(Some(pid), Some(fds), 10).is_err(), "{pid:?} {fds:?}");
        }
    }
}
