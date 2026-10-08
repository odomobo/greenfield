//! nebula-web: the web listener. Accepts TCP connections and starts a fresh worker process (nebula-web-worker) for
//! each, which does everything network-facing for that one connection (TLS, the page, the sign-in, the relay to the
//! desktop) and exits when it closes. The listener never reads network data: connections are handed over as they are.
//! So an exploit in the network-facing code reaches only the attacker's own connection.
//!
//! Started by a login helper (the production nebula-login, as the web user, or the dev helper) with the listening TCP
//! socket as an inherited fd and where the helper's login.sock is (see USAGE). At startup it loads the TLS certificate
//! and key (or generates a self-signed pair) and the page with its files. The certificate chain and the page go into
//! sealed read-only memfds that every worker maps; the key stays here: each worker signs its TLS handshake through its
//! signing channel to us, once (src/signing.rs). For each connection the listener:
//!
//!   - refuses it if it's over the connection caps (in all, and per client IP);
//!   - connects to login.sock and writes the client's address (the login protocol's ClientAddress record, from the
//!     accepted socket's peer address): the worker can't choose the IP that the helper (PAM, the takeover message)
//!     sees. Not when the IP is throttled (the worker then refuses any sign-in without asking the helper);
//!   - starts the worker (fork + exec, so each gets a fresh memory layout) with the TCP connection, the helper
//!     connection, a report socket, the two memfds and a signing channel at fixed fd numbers (see the crate
//!     documentation, src/lib.rs).
//!
//! Failed sign-ins are throttled per IP here (until the helper does it, step 10), generously, since many users may
//! share an address (NAT): workers report a refused sign-in on their report socket. No per-user throttling:
//! per-account lockout is PAM's job (pam_faillock).
//!
//! Every TCP connection costs a worker process and a forked child in the helper, waiting for the Begin record that
//! comes only if the connection becomes a sign-in. A page load opens a few connections (the page and its files, then
//! the WebSocket).
use nebula_login_common::{log, spawn::spawn_with_fds, sys as common_sys};
use nebula_login_protocol::Record;
use nebula_web::assets::{self, Builder};
use nebula_web::limits::{RateLimiter, WorkerCount};
use nebula_web::signing::{self, Served};
use nebula_web::{client_ip, http, sys, tls};
use nebula_web::{WORKER_ASSETS_FD, WORKER_BINARY, WORKER_HELPER_FD, WORKER_REPORT_FD, WORKER_TCP_FD};
use nebula_web::{WORKER_SIGNING_FD, WORKER_TLS_FD};
use std::io::{self, Read};
use std::net::{IpAddr, TcpListener};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// workers alive at once, in all and per client IP (a browser opens about 6 connections per site); the production
/// login helper caps its connections at MAX_WORKERS too, since there is one per worker
const MAX_WORKERS: usize = 256;
const MAX_WORKERS_PER_IP: usize = 32;
/// failed sign-ins an IP has before it is throttled
const FREE_FAILURES: u32 = 20;

const USAGE: &str = "Usage: nebula-web --listen-fd <fd> --login-socket <path> --viewer-dir <dir> --static-dir <dir> [options]

Started by a login helper (packages/gatekeeper), which passes these on from its own command line:
  --listen-fd <fd>           the listening TCP socket, inherited
  --login-socket <path>      the login helper's socket
  --viewer-dir <dir>         the built viewer (index.html, assets/)
  --static-dir <dir>         the public static files (served under /static/)
  --cert <file> --key <file> TLS certificate and key (default: generate a self-signed one in the state dir)
  --state-dir <dir>          where the generated certificate is kept (default /var/lib/nebula)
  --hide-hostname            don't show the host name on the sign-in page
  --allowed-origin <origin>  additionally accepted Origin (repeatable), e.g. https://desktop.example.com
";

struct Args {
    listen_fd: i32,
    login_socket: PathBuf,
    viewer_dir: PathBuf,
    static_dir: PathBuf,
    tls_files: Option<(PathBuf, PathBuf)>,
    state_dir: PathBuf,
    hide_hostname: bool,
    allowed_origins: Vec<String>,
}

fn usage_error(message: &str) -> ! {
    eprintln!("nebula-web: {message}\n\n{USAGE}");
    std::process::exit(2);
}

fn fatal(message: &str) -> ! {
    log::error(message);
    std::process::exit(1);
}

fn parse_args() -> Args {
    let mut listen_fd = None;
    let mut login_socket = None;
    let mut viewer_dir = None;
    let mut static_dir = None;
    let mut cert = None;
    let mut key = None;
    let mut state_dir = PathBuf::from("/var/lib/nebula");
    let mut hide_hostname = false;
    let mut allowed_origins = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name.to_string(), Some(value.to_string())),
            _ => (arg.clone(), None),
        };
        match name.as_str() {
            "--help" | "-h" => {
                print!("{USAGE}");
                std::process::exit(0);
            }
            "--hide-hostname" => {
                hide_hostname = true;
                continue;
            }
            _ => {}
        }
        let mut value = || {
            inline.clone().or_else(|| args.next()).unwrap_or_else(|| usage_error(&format!("{name} needs a value")))
        };
        match name.as_str() {
            "--listen-fd" => listen_fd = Some(value()),
            "--login-socket" => login_socket = Some(PathBuf::from(value())),
            "--viewer-dir" => viewer_dir = Some(PathBuf::from(value())),
            "--static-dir" => static_dir = Some(PathBuf::from(value())),
            "--cert" => cert = Some(PathBuf::from(value())),
            "--key" => key = Some(PathBuf::from(value())),
            "--state-dir" => state_dir = PathBuf::from(value()),
            "--allowed-origin" => allowed_origins.push(value()),
            _ => usage_error(&format!("unknown option {arg}")),
        }
    }
    let listen_fd = match listen_fd.map(|fd| fd.parse::<i32>()) {
        Some(Ok(fd)) if fd >= 3 => fd,
        _ => usage_error("--listen-fd is required (a number from 3)"),
    };
    let required = |dir: Option<PathBuf>, name: &str| {
        let dir = dir.unwrap_or_else(|| usage_error(&format!("{name} is required")));
        std::path::absolute(&dir).unwrap_or(dir)
    };
    let tls_files = match (cert, key) {
        (Some(cert), Some(key)) => Some((cert, key)),
        (None, None) => None,
        _ => usage_error("--cert and --key must be given together"),
    };
    Args {
        listen_fd,
        login_socket: required(login_socket, "--login-socket"),
        viewer_dir: required(viewer_dir, "--viewer-dir"),
        static_dir: required(static_dir, "--static-dir"),
        tls_files,
        state_dir: std::path::absolute(&state_dir).unwrap_or(state_dir),
        hide_hostname,
        allowed_origins,
    }
}

/// The page bundle: the page (with the host name filled in: it is shown on the sign-in form without needing scripts
/// or a request), the viewer's files and our static files.
fn page_bundle(args: &Args) -> io::Result<Vec<u8>> {
    let page = std::fs::read_to_string(args.viewer_dir.join("index.html"))?;
    let host = if args.hide_hostname { String::new() } else { sys::hostname() };
    let host = if host.is_empty() { "&nbsp;".to_string() } else { http::escape_html(&host) };
    let mut builder = Builder::default();
    builder.add(assets::PAGE, page.replace("<!--hostname-->", &host).as_bytes())?;
    builder.add_dir("assets", &args.viewer_dir.join("assets"))?;
    builder.add_dir("static", &args.static_dir)?;
    Ok(builder.finish())
}

struct Settings {
    worker: PathBuf,
    login_socket: PathBuf,
    allowed_origins: Vec<String>,
    assets: OwnedFd,
    tls: OwnedFd,
}

/// A worker alive: its client's IP, our end of its report socket and of its signing channel.
struct Worker {
    ip: IpAddr,
    report: UnixStream,
    reported: bool,
    signing: signing::Channel,
}

fn main() {
    log::set_name("nebula-web");
    let args = parse_args();
    // (ours only: workers get their connection at the same number instead)
    if let Err(e) = sys::set_cloexec(args.listen_fd) {
        fatal(&format!("--listen-fd {}: {e}", args.listen_fd));
    }
    let listener = unsafe { TcpListener::from_raw_fd(args.listen_fd) };
    listener.set_nonblocking(true).unwrap_or_else(|e| fatal(&format!("--listen-fd {}: {e}", args.listen_fd)));
    let address = listener.local_addr().unwrap_or_else(|e| fatal(&format!("--listen-fd {}: {e}", args.listen_fd)));

    let credentials = tls::load(args.tls_files.clone(), &args.state_dir).unwrap_or_else(|e| fatal(&e));
    // (the certificate chain only: the key stays here)
    let tls = sys::sealed_memfd(c"nebula-tls", &credentials.public()).unwrap_or_else(|e| fatal(&format!("TLS: {e}")));
    let key = signing::Key::new(credentials.key);
    let bundle = page_bundle(&args).unwrap_or_else(|e| {
        fatal(&format!("Loading the page from {} and {}: {e}", args.viewer_dir.display(), args.static_dir.display()))
    });
    let assets = sys::sealed_memfd(c"nebula-page", &bundle).unwrap_or_else(|e| fatal(&format!("The page: {e}")));
    log::info(&format!("The page and its files: {} KiB.", bundle.len() / 1024));
    drop(bundle);
    let worker = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(WORKER_BINARY)))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| fatal(&format!("{WORKER_BINARY} is not next to nebula-web")));
    let settings =
        Settings { worker, login_socket: args.login_socket, allowed_origins: args.allowed_origins, assets, tls };
    log::info(&format!("Listening on https://{address}"));
    listen(listener, &settings, &key);
}

fn listen(listener: TcpListener, settings: &Settings, key: &signing::Key) -> ! {
    let mut throttle = RateLimiter::new(FREE_FAILURES);
    let mut count = WorkerCount::new(MAX_WORKERS, MAX_WORKERS_PER_IP);
    let mut workers: Vec<Worker> = Vec::new();
    // (warnings at most once a second: a flood mustn't flood the log too)
    let mut warned_at: Option<Instant> = None;
    let mut warn = |message: String| {
        if warned_at.is_none_or(|at| at.elapsed() > Duration::from_secs(1)) {
            warned_at = Some(Instant::now());
            log::warn(&message);
        }
    };
    loop {
        // the listening socket, then each worker's report socket and signing channel (-1, ignored, once used)
        let mut fds: Vec<libc::pollfd> = std::iter::once(listener.as_raw_fd())
            .chain(workers.iter().flat_map(|worker| {
                [worker.report.as_raw_fd(), worker.signing.stream().map_or(-1, |stream| stream.as_raw_fd())]
            }))
            .map(|fd| libc::pollfd { fd, events: libc::POLLIN, revents: 0 })
            .collect();
        // (a timeout only to retry accepting after running out of fds)
        if let Err(e) = sys::poll(&mut fds, Some(Duration::from_secs(1))) {
            fatal(&format!("Listening failed: {e}"));
        }
        // reports and exits first: they make room
        let mut ended = vec![false; workers.len()];
        for ((worker, fds), ended) in workers.iter_mut().zip(fds[1..].chunks(2)).zip(ended.iter_mut()) {
            // signing inline: it takes well under a millisecond (ECDSA) to a few (RSA), once per worker
            if fds[1].revents != 0 {
                if let Served::Refused(why) = worker.signing.serve(key) {
                    log::warn(&format!("Refused to sign for a worker (client {}): {why}.", worker.ip));
                }
            }
            let fd = &fds[0];
            if fd.revents == 0 {
                continue;
            }
            let mut bytes = [0u8; 16];
            match worker.report.read(&mut bytes) {
                // the worker exited
                Ok(0) => *ended = true,
                Ok(n) => {
                    // one sign-in per worker, so at most one failure: a worker can't throttle anyone but its own IP
                    if bytes[..n].contains(&nebula_web::REPORT_REFUSED) && !worker.reported {
                        worker.reported = true;
                        throttle.fail(worker.ip, Instant::now());
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => *ended = true,
            }
        }
        if ended.contains(&true) {
            let mut ended = ended.into_iter();
            workers.retain(|worker| {
                let alive = !ended.next().unwrap_or(false);
                if !alive {
                    count.remove(worker.ip);
                }
                alive
            });
        }
        // reap the workers that exited (on every round: a worker's report socket closes just before it can be reaped);
        // one killed by a signal crashed, or its sandbox stopped it (SIGSYS)
        while let Ok(Some((_, status))) = common_sys::wait_child(-1, false) {
            if libc::WIFSIGNALED(status) {
                let sandbox = libc::WTERMSIG(status) == libc::SIGSYS;
                let why = if sandbox { " (a system call its sandbox forbids)" } else { "" };
                warn(format!("A worker ended with {}{why}.", common_sys::describe_status(status)));
            }
        }
        if fds[0].revents == 0 {
            continue;
        }
        loop {
            let (tcp, peer) = match listener.accept() {
                Ok(accepted) => accepted,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::Interrupted => break,
                Err(e) => {
                    // e.g. out of fds: try again on the next round
                    warn(format!("Accepting a connection failed: {e}"));
                    break;
                }
            };
            let ip = client_ip(peer.ip());
            if !count.add(ip) {
                drop(tcp);
                warn(format!("Too many connections ({} in all); refused one from {ip}.", count.size()));
                continue;
            }
            match start_worker(OwnedFd::from(tcp), ip, settings, &throttle) {
                Ok((report, signing)) => workers.push(Worker { ip, report, reported: false, signing }),
                Err(e) => {
                    count.remove(ip);
                    log::error(&format!("Starting a worker failed: {e}"));
                }
            }
        }
    }
}

/// Connect to the login helper and write the client's address: the worker's helper connection.
fn connect_helper(path: &Path, ip: IpAddr) -> io::Result<UnixStream> {
    let stream = UnixStream::connect(path)?;
    let record = Record::ClientAddress(ip).encode().map_err(io::Error::other)?;
    // (a fresh socket: a record fits in its buffer)
    common_sys::send_with_fd(stream.as_raw_fd(), &record, None)?;
    Ok(stream)
}

/// Start a worker for the accepted (unread) connection `tcp`: open its helper connection and write the client's
/// address to it, and hand it both (our copies are closed here). Our ends of its report socket and signing channel.
fn start_worker(
    tcp: OwnedFd,
    ip: IpAddr,
    settings: &Settings,
    throttle: &RateLimiter,
) -> io::Result<(UnixStream, signing::Channel)> {
    let mut fds = vec![(tcp, WORKER_TCP_FD)];
    let sign_in = if throttle.blocked(ip, Instant::now()) {
        "blocked"
    } else {
        match connect_helper(&settings.login_socket, ip) {
            Ok(helper) => {
                fds.push((OwnedFd::from(helper), WORKER_HELPER_FD));
                "helper"
            }
            Err(e) => {
                log::error(&format!("Connecting to the login helper failed: {e}"));
                "unavailable"
            }
        }
    };
    let (ours, theirs) = common_sys::socket_pair()?;
    fds.push((theirs, WORKER_REPORT_FD));
    fds.push((settings.assets.try_clone()?, WORKER_ASSETS_FD));
    fds.push((settings.tls.try_clone()?, WORKER_TLS_FD));
    let (signing_ours, signing_theirs) = sys::seqpacket_pair()?;
    fds.push((signing_theirs, WORKER_SIGNING_FD));
    let mut command = Command::new(&settings.worker);
    command.arg("--sign-in").arg(sign_in);
    for origin in &settings.allowed_origins {
        command.arg("--allowed-origin").arg(origin);
    }
    command.env_clear().stdin(Stdio::null());
    // (the worker ends with us)
    spawn_with_fds(&mut command, fds, Some(libc::SIGTERM))?;
    let report = UnixStream::from(ours);
    report.set_nonblocking(true)?;
    let signing = UnixStream::from(signing_ours);
    signing.set_nonblocking(true)?;
    Ok((report, signing::Channel::new(signing)))
}
