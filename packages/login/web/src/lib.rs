//! The web front (see SIGNIN-ROADMAP.md, "Target architecture"): the listener `nebula-web` (src/bin/listener.rs)
//! accepts TCP connections and starts a fresh worker `nebula-web-worker` (src/bin/worker.rs) for each, which does
//! everything network-facing for that one connection.
//!
//! # How the listener starts a worker
//!
//! fork + exec of `nebula-web-worker` (next to `nebula-web`), with a minimal environment and these fds:
//!
//! ```text
//!   3  the accepted TCP connection, not read yet
//!   4  a connection to the login helper's login.sock, on which the listener has written the client's address
//!      (ClientAddress); only with `--sign-in helper`
//!   5  the report socket (a Unix stream socket pair's other end is the listener's): the worker writes one byte,
//!      REPORT_REFUSED, when the helper refused its sign-in; its EOF tells the listener the worker is gone
//!   6  the page bundle: a sealed read-only memfd (layout in assets.rs)
//!   7  the TLS certificate chain and key, PEM, in a sealed read-only memfd
//! ```
//!
//! and these arguments (nothing secret: they are visible in /proc):
//!
//! ```text
//!   --sign-in helper|blocked|unavailable   helper: fd 4 is the login helper; blocked: the client's IP is throttled
//!                                          (any sign-in fails without asking the helper); unavailable: the helper
//!                                          can't be reached
//!   --allowed-origin <origin>              additionally accepted WebSocket Origin (repeatable)
//! ```
//!
//! The worker is started with PR_SET_PDEATHSIG = SIGTERM (it ends with the listener).
pub mod assets;
pub mod conn;
pub mod helper;
pub mod http;
pub mod limits;
pub mod sys;
pub mod tls;
pub mod websocket;

pub const WORKER_TCP_FD: i32 = 3;
pub const WORKER_HELPER_FD: i32 = 4;
pub const WORKER_REPORT_FD: i32 = 5;
pub const WORKER_ASSETS_FD: i32 = 6;
pub const WORKER_TLS_FD: i32 = 7;
/// The worker's report: the helper refused its sign-in (counted at most once per worker).
pub const REPORT_REFUSED: u8 = 1;
pub const WORKER_BINARY: &str = "nebula-web-worker";

/// A client's address as the protocol and the logs use it: IPv4 without the IPv6 mapping.
pub fn client_ip(ip: std::net::IpAddr) -> std::net::IpAddr {
    match ip {
        std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped().map(std::net::IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn client_ips_without_the_ipv6_mapping() {
        let ip = |text: &str| super::client_ip(text.parse().unwrap()).to_string();
        assert_eq!(ip("::ffff:192.0.2.1"), "192.0.2.1");
        assert_eq!(ip("::1"), "::1");
        assert_eq!(ip("2001:db8::ffff:1"), "2001:db8::ffff:1");
        assert_eq!(ip("192.0.2.1"), "192.0.2.1");
    }
}
