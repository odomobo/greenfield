//! nebula-web-worker: one per TCP connection, started by the listener (nebula-web) and exiting when its connection
//! closes. It does everything network-facing for that one connection, unprivileged: TLS, the page and its files,
//! Origin checks, the sign-in conversation on the page's WebSocket, and relaying that same WebSocket to the user's
//! desktop once signed in. An exploit here reaches only the attacker's own connection: other users' sessions and
//! passwords are in other workers, which can't inspect each other (each marks itself not dumpable first thing).
//!
//! What the listener hands it (fds and arguments): see the crate documentation (src/lib.rs).
//!
//! Signing in works like unlocking a screen: the page's one WebSocket (`/ws`) is the sign-in. The page signs in on it
//! (in-band, see "Sign-in" in libs/scene-protocol) and the same WebSocket then carries the desktop. There are no
//! tokens or cookies: when the WebSocket closes (tab closed, reloaded, network gone, another sign-in took the desktop
//! over), the page has to sign in again. The desktop behind it keeps running until the user logs out.
//!
//! Limits: the TLS handshake within 10 s; a request head of at most 16 KiB within 20 s (the first byte of a further
//! request on the connection within 5 s, keep-alive); each response written within 30 s; the WebSocket's `begin`
//! within 10 s, each answer within 60 s, the helper's next record within 90 s, the desktop's handshake within 60 s;
//! what is left when a closing connection ends, within 5 s. The relay has no idle limit (a desktop may send nothing for
//! hours); a browser that is gone without closing is noticed by TCP keepalive (probes after 60 s of silence, the
//! connection ends when probes or data stay unacknowledged for 120 s).
//!
//! Once set up (fds checked, memfds mapped, the TLS configuration built, the TCP socket tuned) the worker enters its
//! sandbox (src/sandbox.rs: no_new_privs, rlimits, a seccomp allowlist): it can then only use the fds it has.
use nebula_login_common::channel::Channel;
use nebula_login_common::log;
use nebula_login_protocol::{Outcome, PromptStyle, Record, MAX_ANSWER, MAX_USERNAME};
use nebula_web::assets::Assets;
use nebula_web::conn::{timed_out, wait, Tls};
use nebula_web::helper;
use nebula_web::http::{self, HeadError, Request, Response};
use nebula_web::websocket::{self, ClientMessage, ServerMessage, CLOSE_SIGN_IN_FAILED, MAX_FRAME};
use nebula_web::{sandbox, sys, *};
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const HEAD_TIMEOUT: Duration = Duration::from_secs(20);
const KEEP_ALIVE_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
/// the page sends its `begin` right after the upgrade
const BEGIN_TIMEOUT: Duration = Duration::from_secs(10);
/// a person answers each prompt (a password now, a one-time code later) within this time
const ANSWER_TIMEOUT: Duration = Duration::from_secs(60);
/// a login helper answers within its own limits (the failure delay, starting a desktop)
const HELPER_TIMEOUT: Duration = Duration::from_secs(90);
/// a desktop that is just starting accepts its first connection when it is ready
const DESKTOP_TIMEOUT: Duration = Duration::from_secs(60);
/// a connection with nothing sent either way for this long gets TCP keepalive probes, every KEEP_ALIVE_INTERVAL ...
const KEEP_ALIVE_IDLE: Duration = Duration::from_secs(60);
const KEEP_ALIVE_INTERVAL: Duration = Duration::from_secs(10);
/// ... and ends when probes or data stay unacknowledged this long
const UNACKNOWLEDGED_TIMEOUT: Duration = Duration::from_secs(120);
/// how long a closing connection may take to send what it still has
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
/// the desktop's handshake response
const MAX_DESKTOP_HEAD: usize = 8192;
/// what the worker buffers from the browser for the desktop
const MAX_PENDING: usize = 256 * 1024;
/// keep unsent data in the session's priority queue rather than in the kernel (see ViewerTransport)
const TCP_NOTSENT_LOWAT_BYTES: libc::c_int = 32 * 1024;
const TOO_MANY_FAILURES: &str = "Too many failed attempts. Try again in a few minutes.";
const NOT_POSSIBLE: &str = "Signing in is not possible right now.";
const NOT_COMPLETED: &str = "The sign-in could not be completed.";
/// the prompt the password is asked with when the listener refused the IP (nothing reaches the helper then)
const PASSWORD_PROMPT: &str = "Password: ";

#[derive(Clone, Copy, PartialEq, Eq)]
enum SignIn {
    Helper,
    Blocked,
    Unavailable,
}

struct Worker<'a> {
    tls: Tls,
    assets: Assets<'a>,
    allowed_origins: Vec<String>,
    sign_in: SignIn,
    /// the browser's address, for the log
    ip: String,
}

fn fatal(message: &str) -> ! {
    log::error(message);
    std::process::exit(1);
}

fn main() {
    log::set_name("nebula-web-worker");
    // workers can't inspect each other (ptrace, /proc/<pid>/mem, environ, fds)
    if let Err(e) = sys::set_not_dumpable() {
        fatal(&format!("Can't mark the worker not dumpable: {e}"));
    }
    let mut sign_in = None;
    let mut allowed_origins = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let value = args.next().unwrap_or_else(|| fatal(&format!("{arg} needs a value")));
        match (arg.as_str(), value.as_str()) {
            ("--sign-in", "helper") => sign_in = Some(SignIn::Helper),
            ("--sign-in", "blocked") => sign_in = Some(SignIn::Blocked),
            ("--sign-in", "unavailable") => sign_in = Some(SignIn::Unavailable),
            ("--allowed-origin", _) => allowed_origins.push(value),
            _ => fatal(&format!("unknown option {arg} {value} (started by nebula-web only)")),
        }
    }
    let sign_in = sign_in.unwrap_or_else(|| fatal("--sign-in is required (started by nebula-web only)"));
    let fds = [WORKER_TCP_FD, WORKER_REPORT_FD, WORKER_ASSETS_FD, WORKER_TLS_FD];
    if fds.iter().any(|&fd| !sys::is_open(fd)) || (sign_in == SignIn::Helper) != sys::is_open(WORKER_HELPER_FD) {
        fatal("missing fds (started by nebula-web only)");
    }
    // (taking ownership: each is closed with its owner)
    let tcp = unsafe { TcpStream::from_raw_fd(WORKER_TCP_FD) };
    let report = unsafe { UnixStream::from_raw_fd(WORKER_REPORT_FD) };
    let assets_fd = unsafe { OwnedFd::from_raw_fd(WORKER_ASSETS_FD) };
    let tls_fd = unsafe { OwnedFd::from_raw_fd(WORKER_TLS_FD) };
    let helper = (sign_in == SignIn::Helper).then(|| unsafe { UnixStream::from_raw_fd(WORKER_HELPER_FD) });

    let bundle = sys::Mapping::sealed(assets_fd.as_raw_fd()).unwrap_or_else(|e| fatal(&format!("The page: {e}")));
    let assets = Assets::parse(bundle.bytes()).unwrap_or_else(|e| fatal(&format!("The page: {e}")));
    let config = sys::Mapping::sealed(tls_fd.as_raw_fd())
        .map_err(|e| e.to_string())
        .and_then(|pem| tls::server_config(pem.bytes()))
        .unwrap_or_else(|e| fatal(&format!("TLS: {e}")));
    drop((assets_fd, tls_fd));

    let ip = tcp.peer_addr().map(|address| client_ip(address.ip()).to_string()).unwrap_or_default();
    // tuning only
    let _ = sys::tune_tcp(tcp.as_raw_fd(), TCP_NOTSENT_LOWAT_BYTES);
    // the relay has no timeout of its own (a desktop may send nothing for hours): a vanished browser ends it this way
    if let Err(e) = sys::tcp_keep_alive(tcp.as_raw_fd(), KEEP_ALIVE_IDLE, KEEP_ALIVE_INTERVAL, UNACKNOWLEDGED_TIMEOUT) {
        fatal(&format!("Can't set up TCP keepalive: {e}"));
    }
    let tls = Tls::new(tcp, config).unwrap_or_else(|e| fatal(&format!("TLS: {e}")));

    // ---- The sandbox (sandbox.rs): from here on only the system calls in sandbox::ALLOWED, on the fds we have. ----
    if let Err(e) = sandbox::enter(bundle.bytes().len()) {
        fatal(&format!("Can't enter the sandbox: {e}"));
    }

    let mut worker = Worker { tls, assets, allowed_origins, sign_in, ip };
    worker.serve(helper, report);
}

impl Worker<'_> {
    /// Serve our one connection: TLS, any number of requests on it (keep-alive: the page and its files), or one
    /// WebSocket. Exits when it closes.
    fn serve(&mut self, helper: Option<UnixStream>, report: UnixStream) -> ! {
        let started = Instant::now();
        if self.tls.handshake(started + HANDSHAKE_TIMEOUT).is_err() {
            std::process::exit(0);
        }
        let mut first = true;
        loop {
            let first_byte = if first { started + HEAD_TIMEOUT } else { Instant::now() + KEEP_ALIVE_TIMEOUT };
            let request = match self.read_head(first_byte) {
                Ok(request) => request,
                Err(None) => self.close(),
                Err(Some(status)) => {
                    let response = Response::error(status).encode(false, true);
                    let _ = self.tls.write_all(&response, Instant::now() + WRITE_TIMEOUT);
                    self.close();
                }
            };
            first = false;
            if request.is_upgrade() {
                self.upgrade(&request, helper, report);
            }
            let served = matches!(request.method.as_str(), "GET" | "HEAD") && !request.has_body();
            let close = !served || !request.keep_alive();
            let response = http::route(&request, &self.assets).encode(request.method == "HEAD", close);
            if self.tls.write_all(&response, Instant::now() + WRITE_TIMEOUT).is_err() {
                std::process::exit(0);
            }
            if close {
                self.close();
            }
        }
    }

    /// The next request head: its first byte by `first_byte`, all of it within HEAD_TIMEOUT of that. Err(None): the
    /// connection closed or timed out; Err(Some(status)): a malformed (400) or too large (431) head.
    fn read_head(&mut self, first_byte: Instant) -> Result<Request, Option<u16>> {
        let mut begun = !self.tls.received.is_empty();
        let mut deadline = if begun { Instant::now() + HEAD_TIMEOUT } else { first_byte };
        loop {
            match http::parse_head(&self.tls.received) {
                Ok(Some((request, length))) => {
                    self.tls.received.drain(..length);
                    return Ok(request);
                }
                Ok(None) => {}
                Err(HeadError::Malformed) => return Err(Some(400)),
                Err(HeadError::TooLarge) => return Err(Some(431)),
            }
            match self.tls.fill(http::MAX_HEAD, deadline) {
                Ok(()) if !begun => {
                    begun = true;
                    deadline = Instant::now() + HEAD_TIMEOUT;
                }
                Ok(()) => {}
                Err(_) if self.tls.received.len() >= http::MAX_HEAD => return Err(Some(431)),
                Err(_) => return Err(None),
            }
        }
    }

    /// End the connection (close_notify) and exit.
    fn close(&mut self) -> ! {
        self.tls.close(Instant::now() + CLOSE_TIMEOUT);
        std::process::exit(0);
    }

    fn send(&mut self, bytes: &[u8]) -> bool {
        self.tls.write_all(bytes, Instant::now() + WRITE_TIMEOUT).is_ok()
    }

    /// Close the WebSocket after a failed sign-in, and exit.
    fn refuse(&mut self) -> ! {
        self.send(&websocket::close_frame(CLOSE_SIGN_IN_FAILED, "sign-in failed"));
        self.close();
    }

    fn failed(&mut self, message: &str) -> ! {
        self.send(&ServerMessage::Failed { message }.frame());
        self.refuse();
    }

    /// The page's next sign-in message, within `timeout`; None if it sent something else, went away or took too long.
    fn next_message(&mut self, timeout: Duration) -> Option<ClientMessage> {
        let deadline = Instant::now() + timeout;
        loop {
            match websocket::parse_text_frame(&self.tls.received) {
                Ok(Some((payload, size))) => {
                    self.tls.received.drain(..size);
                    return ClientMessage::parse(&payload);
                }
                Ok(None) => {}
                Err(()) => return None,
            }
            // a frame and a bit: the page sends one frame and waits for the answer
            self.tls.fill(2 * MAX_FRAME, deadline).ok()?;
        }
    }

    /// The page's WebSocket: complete the handshake, run the sign-in on it (prompts and answers, see "Sign-in" in
    /// libs/scene-protocol), then relay it to the desktop. Never returns.
    fn upgrade(&mut self, request: &Request, helper: Option<UnixStream>, report: UnixStream) -> ! {
        if let Err(status) = http::check_upgrade(request, &self.allowed_origins) {
            self.send(&http::refuse_upgrade(status));
            self.close();
        }
        let key = request.header("sec-websocket-key").unwrap_or_default();
        // no extensions or subprotocols: the bytes are relayed as they are
        let response = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
             Sec-WebSocket-Accept: {}\r\n\r\n",
            websocket::accept_key(key)
        );
        if !self.send(response.as_bytes()) {
            std::process::exit(0);
        }
        let Some(ClientMessage::Begin { username }) = self.next_message(BEGIN_TIMEOUT) else {
            self.refuse();
        };
        // (an unusable name is asked for its password like any other, and fails like a wrong password)
        let username = username.trim();
        match (self.sign_in, helper) {
            (SignIn::Helper, Some(helper)) => self.sign_in(username, helper, report),
            (SignIn::Blocked, _) => {
                // nothing reaches the helper (the page answers its password prompt first)
                self.send(&ServerMessage::Prompt { text: PASSWORD_PROMPT, echo: false }.frame());
                match self.next_message(ANSWER_TIMEOUT) {
                    Some(ClientMessage::Answer { .. }) => self.failed(TOO_MANY_FAILURES),
                    _ => self.refuse(),
                }
            }
            _ => self.failed(NOT_POSSIBLE),
        }
    }

    /// The sign-in through the login helper, on the connection to its login.sock the listener opened for us (fd 4; the
    /// listener has written the client's address): we write the user name, relay its prompts to the page and the
    /// page's answers back, and get the result, which on success carries our end of a connection to the user's
    /// desktop. The helper does everything else: the minimum failure time, attaching to or starting the desktop.
    fn sign_in(&mut self, username: &str, helper: UnixStream, mut report: UnixStream) -> ! {
        let helper_fd = helper.as_raw_fd();
        let mut channel = Channel::new(helper);
        // a name over the protocol's limit goes as an empty one: it fails like an unknown user
        let username = if username.len() <= MAX_USERNAME { username } else { "" };
        if channel.write(&Record::Begin { username: username.to_string() }, None).is_err() {
            self.failed(NOT_POSSIBLE);
        }
        loop {
            let (record, fd) = match self.helper_record(&mut channel, helper_fd) {
                Some(next) => next,
                None => self.failed(NOT_COMPLETED),
            };
            match record {
                Record::Prompt { style: PromptStyle::Info, text } => {
                    self.send(&ServerMessage::Info { text: &text }.frame());
                }
                Record::Prompt { style: PromptStyle::Error, text } => {
                    self.send(&ServerMessage::Error { text: &text }.frame());
                }
                Record::Prompt { style, text } => {
                    self.send(&ServerMessage::Prompt { text: &text, echo: style == PromptStyle::EchoOn }.frame());
                    let answer = match self.next_message(ANSWER_TIMEOUT) {
                        Some(ClientMessage::Answer { text }) if text.len() <= MAX_ANSWER => text,
                        _ => self.refuse(),
                    };
                    if channel.write(&Record::Answer { text: answer }, None).is_err() {
                        self.failed(NOT_COMPLETED);
                    }
                }
                Record::Result { outcome: Outcome::SignedIn, text } => match fd {
                    Some(fd) => {
                        drop(channel);
                        self.relay(UnixStream::from(fd), &text);
                    }
                    None => self.failed(NOT_COMPLETED),
                },
                Record::Result { outcome, text } => {
                    if outcome == Outcome::Refused {
                        // before the page hears of it: its next attempt must find the listener's throttle up to date
                        let _ = report.write_all(&[REPORT_REFUSED]);
                        log::info(&format!("Failed sign-in from {}.", self.ip));
                    }
                    self.failed(&text);
                }
                _ => {
                    log::error("The login helper sent something unexpected.");
                    self.failed(NOT_COMPLETED);
                }
            }
        }
    }

    /// The helper's next record (within HELPER_TIMEOUT), watching the browser meanwhile: if it goes away, so do we
    /// (which ends the helper's attempt too).
    fn helper_record(&mut self, channel: &mut Channel, helper_fd: i32) -> Option<(Record, Option<OwnedFd>)> {
        let deadline = Instant::now() + HELPER_TIMEOUT;
        loop {
            let watch_browser = (self.tls.received.len() < 2 * MAX_FRAME).then(|| self.tls.fd());
            match helper::next_record(channel, helper_fd, watch_browser, deadline).ok()? {
                helper::Next::Record(record, fd) => return Some((record, fd)),
                helper::Next::Other => match self.tls.read_available(2 * MAX_FRAME) {
                    Ok(_) if !self.tls.eof => {}
                    _ => std::process::exit(0),
                },
            }
        }
    }

    /// Connect the signed-in page to its desktop over `upstream` (the connection the helper's Result carried): a
    /// WebSocket handshake with the session, then the result frame, then bytes both ways.
    fn relay(&mut self, mut upstream: UnixStream, username: &str) -> ! {
        let head = match desktop_handshake(&mut upstream) {
            Ok(head) => head,
            Err(_) => self.failed("The desktop could not be reached."),
        };
        log::info(&format!("Signed in: {username} from {}.", self.ip));
        let _ = self.tls.conn.writer().write_all(&ServerMessage::SignedIn { username }.frame());
        // what the desktop sent after its handshake
        let _ = self.tls.conn.writer().write_all(&head);
        match relay_bytes(&mut self.tls, &mut upstream) {
            Ok(()) => self.close(),
            Err(_) => std::process::exit(0),
        }
    }
}

/// The relay's own WebSocket handshake with the desktop (the session expects one); what the desktop sent after its
/// response.
fn desktop_handshake(upstream: &mut UnixStream) -> io::Result<Vec<u8>> {
    // (fcntl: std's set_nonblocking uses ioctl, which the sandbox doesn't allow)
    sys::set_nonblocking(upstream.as_raw_fd())?;
    let deadline = Instant::now() + DESKTOP_TIMEOUT;
    let mut key = [0u8; 16];
    sys::random_bytes(&mut key)?;
    let request = format!(
        "GET /viewer HTTP/1.1\r\nHost: session\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {}\r\n\r\n",
        websocket::base64(&key)
    );
    write_all(upstream, request.as_bytes(), deadline)?;
    let mut response = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(end) = response.windows(4).position(|window| window == b"\r\n\r\n") {
            if !response.starts_with(b"HTTP/1.1 101") {
                return Err(io::Error::other("the desktop refused the connection"));
            }
            return Ok(response.split_off(end + 4));
        }
        if response.len() > MAX_DESKTOP_HEAD {
            return Err(io::Error::other("the desktop's response is too long"));
        }
        match upstream.read(&mut chunk) {
            Ok(0) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the desktop closed the connection")),
            Ok(n) => response.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => wait(upstream.as_raw_fd(), libc::POLLIN, deadline)?,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
}

fn write_all(stream: &mut UnixStream, mut bytes: &[u8], deadline: Instant) -> io::Result<()> {
    while !bytes.is_empty() {
        match stream.write(bytes) {
            Ok(n) => bytes = &bytes[n..],
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => wait(stream.as_raw_fd(), libc::POLLOUT, deadline)?,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Relay bytes between the browser (TLS) and the desktop until either closes: Ok when the desktop closed (and what it
/// sent last reached the browser), Err otherwise. Reads from the desktop only once TLS has sent everything, so data
/// waits in the desktop's queue, not here (with TCP_NOTSENT_LOWAT, not in the kernel either).
fn relay_bytes(tls: &mut Tls, upstream: &mut UnixStream) -> io::Result<()> {
    let mut chunk = vec![0u8; 64 * 1024];
    let mut desktop_closed: Option<Instant> = None;
    loop {
        // browser -> desktop
        if !tls.eof {
            tls.read_available(MAX_PENDING)?;
        }
        while !tls.received.is_empty() {
            match upstream.write(&tls.received) {
                Ok(n) => {
                    tls.received.drain(..n);
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        if tls.eof && tls.received.is_empty() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the browser closed the connection"));
        }
        // desktop -> browser
        if desktop_closed.is_none() && !tls.conn.wants_write() {
            match upstream.read(&mut chunk) {
                Ok(0) => desktop_closed = Some(Instant::now() + CLOSE_TIMEOUT),
                Ok(n) => tls.conn.writer().write_all(&chunk[..n])?,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        tls.flush_some()?;
        if desktop_closed.is_some() && !tls.conn.wants_write() {
            return Ok(());
        }
        let browser_events = (if !tls.eof && tls.received.len() < MAX_PENDING { libc::POLLIN } else { 0 })
            | (if tls.conn.wants_write() { libc::POLLOUT } else { 0 });
        let upstream_events = (if desktop_closed.is_none() && !tls.conn.wants_write() { libc::POLLIN } else { 0 })
            | (if !tls.received.is_empty() { libc::POLLOUT } else { 0 });
        let mut fds = [
            libc::pollfd { fd: if browser_events != 0 { tls.fd() } else { -1 }, events: browser_events, revents: 0 },
            libc::pollfd {
                fd: if upstream_events != 0 { upstream.as_raw_fd() } else { -1 },
                events: upstream_events,
                revents: 0,
            },
        ];
        let timeout = desktop_closed.map(|deadline| deadline.saturating_duration_since(Instant::now()));
        if timeout == Some(Duration::ZERO) {
            return Err(timed_out());
        }
        sys::poll(&mut fds, timeout)?;
    }
}
