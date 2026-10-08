//! The listener and its workers as processes: a worker per connection, the client's address written to the helper
//! first, workers not dumpable and sandboxed, and a worker's exit closing its helper connection. (The sign-in and the
//! relay are covered end to end by scripts/e2e: auth.sh and desktop.sh.) Needs curl and openssl.
use nebula_login_common::spawn::spawn_with_fds;
use nebula_login_protocol::{decode, Record};
use std::io::{ErrorKind, Read};
use std::net::{TcpListener, TcpStream};
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

struct Listener {
    child: Child,
    dir: PathBuf,
    port: u16,
}

impl Drop for Listener {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn start(name: &str) -> (Listener, UnixListener) {
    let dir = std::env::temp_dir().join(format!("nebula-web-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("viewer/assets")).unwrap();
    std::fs::create_dir_all(dir.join("static")).unwrap();
    std::fs::write(dir.join("viewer/index.html"), "<html><p><!--hostname--></p></html>").unwrap();
    std::fs::write(dir.join("viewer/assets/index.js"), "console.log(1)").unwrap();
    std::fs::write(dir.join("static/theme.css"), "body {}").unwrap();
    let helper = UnixListener::bind(dir.join("login.sock")).unwrap();
    let tcp = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = tcp.local_addr().unwrap().port();
    let mut command = Command::new(env!("CARGO_BIN_EXE_nebula-web"));
    command
        .args(["--listen-fd", "3", "--login-socket"])
        .arg(dir.join("login.sock"))
        .arg("--viewer-dir")
        .arg(dir.join("viewer"))
        .arg("--static-dir")
        .arg(dir.join("static"))
        .arg("--state-dir")
        .arg(dir.join("state"))
        .args(["--hide-hostname"])
        .stdout(Stdio::null());
    let child = spawn_with_fds(&mut command, vec![(OwnedFd::from(tcp), 3)], None).unwrap();
    (Listener { child, dir, port }, helper)
}

fn curl(port: u16, path: &str) -> (String, String) {
    let output = Command::new("curl")
        .args(["-sk", "--retry", "50", "--retry-connrefused", "--retry-delay", "0", "-w", "\n%{http_code}"])
        .arg(format!("https://127.0.0.1:{port}{path}"))
        .output()
        .expect("curl");
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let (body, status) = text.rsplit_once('\n').unwrap_or(("", ""));
    (status.to_string(), body.to_string())
}

/// The listener's workers (not, say, the openssl it runs to make a certificate first).
fn children(pid: u32) -> Vec<u32> {
    std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children"))
        .unwrap_or_default()
        .split_whitespace()
        .filter_map(|pid| pid.parse().ok())
        .filter(|pid| {
            std::fs::read_to_string(format!("/proc/{pid}/comm")).is_ok_and(|comm| comm.trim() == "nebula-web-work")
        })
        .collect()
}

fn read_all_with_timeout(stream: &mut std::os::unix::net::UnixStream) -> Vec<u8> {
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).expect("the helper connection to close");
    bytes
}

#[test]
fn serves_the_page_with_a_worker_per_connection() {
    let (listener, helper) = start("page");
    let (status, body) = curl(listener.port, "/");
    assert_eq!(status, "200");
    assert_eq!(body, "<html><p>&nbsp;</p></html>");
    assert_eq!(curl(listener.port, "/assets/index.js"), ("200".into(), "console.log(1)".into()));
    assert_eq!(curl(listener.port, "/static/nothing.css").0, "404");

    // a helper connection for each connection served, starting with the client's address; each closed once its worker
    // exited (curl closed its connection)
    for _ in 0..3 {
        let (mut connection, _) = helper.accept().unwrap();
        let bytes = read_all_with_timeout(&mut connection);
        let (record, size) = decode(&bytes).unwrap().unwrap();
        assert_eq!(record, Record::ClientAddress("127.0.0.1".parse().unwrap()));
        assert_eq!(size, bytes.len());
    }
    wait_until("the workers to exit", || children(listener.child.id()).is_empty());
}

#[test]
fn workers_are_not_dumpable() {
    let (listener, _helper) = start("dumpable");
    // (a connection that sends nothing: its worker waits for the TLS handshake)
    let connection = loop {
        if let Ok(connection) = TcpStream::connect(("127.0.0.1", listener.port)) {
            break connection;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let mut worker = 0;
    wait_until("a worker", || {
        worker = children(listener.child.id()).first().copied().unwrap_or(0);
        worker != 0
    });
    // our own process's files are readable; the worker's (same user) stop being so once it marked itself
    assert!(std::fs::read(format!("/proc/{}/environ", std::process::id())).is_ok());
    wait_until("the worker to be not dumpable", || {
        matches!(std::fs::read(format!("/proc/{worker}/environ")), Err(e) if e.kind() == ErrorKind::PermissionDenied)
    });
    drop(connection);
    wait_until("the worker to exit", || !Path::new(&format!("/proc/{worker}")).exists() || is_zombie(worker));
}

#[test]
fn workers_are_sandboxed() {
    let (listener, _helper) = start("sandbox");
    let connection = loop {
        if let Ok(connection) = TcpStream::connect(("127.0.0.1", listener.port)) {
            break connection;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let mut worker = 0;
    wait_until("a worker", || {
        worker = children(listener.child.id()).first().copied().unwrap_or(0);
        worker != 0
    });
    // (both files are readable although the worker is not dumpable) seccomp filter mode, no_new_privs, the rlimits
    let field = |file: &str, name: &str| {
        let text = std::fs::read_to_string(format!("/proc/{worker}/{file}")).unwrap_or_default();
        let line = text.lines().find(|line| line.starts_with(name)).unwrap_or_default().to_string();
        line[name.len().min(line.len())..].split_whitespace().collect::<Vec<_>>().join(" ")
    };
    wait_until("the worker's sandbox", || field("status", "Seccomp:") == "2");
    assert_eq!(field("status", "NoNewPrivs:"), "1");
    assert_eq!(field("limits", "Max open files"), "8 8 files");
    assert_eq!(field("limits", "Max processes"), "0 0 processes");
    assert_eq!(field("limits", "Max core file size"), "0 0 bytes");
    // (the forbidden calls themselves: the sandbox tests in src/sys.rs)
    drop(connection);
    wait_until("the worker to exit", || !Path::new(&format!("/proc/{worker}")).exists() || is_zombie(worker));
}

fn is_zombie(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .map(|stat| stat.rsplit_once(')').is_some_and(|(_, rest)| rest.trim_start().starts_with('Z')))
        .unwrap_or(true)
}
