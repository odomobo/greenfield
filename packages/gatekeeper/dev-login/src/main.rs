//! nebula-dev-login: the development login helper, the dev entry point of nebula. DEVELOPMENT ONLY.
//!
//! It is started like the production helper (the sign-in design) and speaks the same protocol, without PAM
//! and without privileges: the only user is the current one, signing in with the password from
//! $GREENFIELD_DEV_PASSWORD, from loopback addresses only, and desktops run as the current user. It owns the `--dev-*`
//! options (they go to the desktops in SessionConfig.devFlags; the web process takes none).
//!
//! What it does:
//!   - binds the TCP port and starts the web front (`nebula-web`, the listener, next to this binary) with the
//!     listening socket as fd 3, telling it where `login.sock` is;
//!   - accepts the web process's connections on `<runtime>/login.sock` (the listener opens one for every TCP
//!     connection and hands it to that connection's worker) and forks a child for each, which reads the client's
//!     address (from the listener) and the user name (from the worker; a connection that never becomes a sign-in just
//!     closes), asks for the password, and on success attaches to or creates the user's desktop (see
//!     nebula_login_common::desktop) and passes the worker its end of the connection;
//!   - with --dev-expired-password every sign-in finds the password expired and goes through the conversation
//!     nebula-login relays from pam_chauthtok (pam_unix's prompts and messages), so the page's side of a password
//!     change can be tested; the new password isn't kept;
//!   - a child that started a desktop stays as its parent until it exits (the PAM parent, in production);
//!   - the per-IP failure backoff, as in production (nebula_login_common::backoff), its times divided by
//!     --dev-time-scale: each child reports its attempt's outcome on a per-attempt pipe, and a child forked while its
//!     client's address is blocked fails the attempt like a wrong password;
//!   - SIGTERM / SIGINT stop the web process and the desktops (they end their apps first).
use nebula_login_common::backoff::{self, Policy, Report, Table};
use nebula_login_common::desktop::{self, Desktop};
use nebula_login_common::session_config::{self, json_string, SESSION_CONFIG_FD, SESSION_LISTEN_FD};
use nebula_login_common::spawn::{spawn_with_fds, wait_passing_terminate, without_capabilities};
use nebula_login_common::web::{web_binary, web_command, WEB_LISTEN_FD};
use nebula_login_common::{channel::Channel, log, sys};
use nebula_login_protocol::{is_loopback, Outcome, PromptStyle, Record};
use std::fs;
use std::io::{self, PipeReader, PipeWriter, Write};
use std::net::{IpAddr, TcpListener};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const USAGE: &str = "Usage: nebula-dev-login [options]

DEVELOPMENT ONLY: no PAM, no privilege separation. Desktops run as the current user, who signs in with the password
from $GREENFIELD_DEV_PASSWORD (at least 8 characters). Loopback only; refuses to run as root.

  --bind-ip <ip>             loopback address to listen on (default 127.0.0.1)
  --bind-port <port>         port to listen on (default 8443)
  --runtime-dir <dir>        login.sock and the desktops' users/<uid>/ directories
                             (default $XDG_RUNTIME_DIR/nebula-dev-<port>)
  --session-dir <dir>        the built session: session-process.js, and the page in ../static and ../../viewer/dist
                             (default: packages/session/dist next to this binary's packages/gatekeeper)
  --node <path>              the node to run the desktops with (default: node from PATH)
  --site-config <file>       site settings file the desktops read (default /etc/nebula/nebula.conf)
  --encoder <auto|none|nvh264|vaapih264>
                             video encoder, overriding the site settings file
  --render-device <path>     GPU render node, overriding the site settings file
  --dev-time-scale <n>       divide the failed-sign-in delay (3 s), the per-IP backoff's times and the time apps get
                             to quit by n (1..100, tests)
  --dev-link-kbps <n>        desktops send to their viewer through a simulated link of n kbit/s (tests)
  --dev-patch-order <order>  oldest (default) or random: the order a window's queued patches are sent in
  --dev-patch-shape <shape>  bands (default) or tiles: how a window's large damage is split into patches
  --dev-expired-password     every sign-in finds the password expired and asks for a new one, with pam_unix's
                             prompts (the current password, then the new one twice; three tries); the new password
                             isn't kept (tests the page's side of a password change)

Passed on to the web process:
  --cert <file> --key <file> TLS certificate and key (default: a self-signed one in the state dir)
  --state-dir <dir>          where the generated certificate is kept (default $XDG_STATE_HOME/greenfield-dev)
  --hide-hostname            don't show the host name on the sign-in page
  --allowed-origin <origin>  additionally accepted Origin (repeatable)
";

/// A failed sign-in takes at least this long from the last answer (divided by the time scale).
const MIN_FAILED_SIGN_IN: Duration = Duration::from_secs(3);
/// The web process sends the address and the user name right after connecting.
const BEGIN_TIMEOUT: Duration = Duration::from_secs(10);
/// The page answers a prompt within 60 s (the web process enforces it); a little more here.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(75);
/// How long a stopping helper waits for its desktops (they give their apps 5 s to quit, then kill them).
const DESKTOP_EXIT_TIMEOUT: Duration = Duration::from_secs(8);
const PASSWORD_VARIABLE: &str = "GREENFIELD_DEV_PASSWORD";
const WRONG: &str = "The username or password is incorrect.";
/// nebula-login's message for an expired password that wasn't changed (login/src/attempt.rs)
const NOT_CHANGED: &str = "The password has expired and was not changed.";

struct Config {
    bind_ip: IpAddr,
    bind_port: u16,
    runtime_dir: PathBuf,
    session_dir: PathBuf,
    web: PathBuf,
    node: PathBuf,
    site_config: Option<PathBuf>,
    encoder: Option<String>,
    render_device: Option<String>,
    time_scale: f64,
    link_kbps: f64,
    patch_order: String,
    patch_shape: String,
    expired_password: bool,
    web_args: Vec<String>,
    password: String,
    user: sys::User,
}

fn fail(message: &str) -> ! {
    eprintln!("nebula-dev-login: {message}\n\n{USAGE}");
    std::process::exit(2);
}

fn parse_config() -> Config {
    let mut bind_ip = "127.0.0.1".to_string();
    let mut bind_port = "8443".to_string();
    let mut runtime_dir = None;
    let mut session_dir = None;
    let mut node = None;
    let mut site_config = None;
    let mut encoder = None;
    let mut render_device = None;
    let mut time_scale = "1".to_string();
    let mut link_kbps = "0".to_string();
    let mut patch_order = "oldest".to_string();
    let mut patch_shape = "bands".to_string();
    let mut state_dir = None;
    let mut expired_password = false;
    let mut web_args = Vec::new();

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name.to_string(), Some(value.to_string())),
            _ => (arg.clone(), None),
        };
        if name == "--help" || name == "-h" {
            print!("{USAGE}");
            std::process::exit(0);
        }
        if name == "--hide-hostname" {
            web_args.push(name);
            continue;
        }
        if name == "--dev-expired-password" {
            expired_password = true;
            continue;
        }
        let mut value = || inline.clone().or_else(|| args.next()).unwrap_or_else(|| fail(&format!("{name} needs a value")));
        match name.as_str() {
            "--bind-ip" => bind_ip = value(),
            "--bind-port" => bind_port = value(),
            "--runtime-dir" => runtime_dir = Some(value()),
            "--session-dir" => session_dir = Some(value()),
            "--node" => node = Some(value()),
            "--site-config" => site_config = Some(value()),
            "--encoder" => encoder = Some(value()),
            "--render-device" => render_device = Some(value()),
            "--dev-time-scale" => time_scale = value(),
            "--dev-link-kbps" => link_kbps = value(),
            "--dev-patch-order" => patch_order = value(),
            "--dev-patch-shape" => patch_shape = value(),
            "--state-dir" => state_dir = Some(value()),
            "--cert" | "--key" | "--allowed-origin" => {
                let value = value();
                web_args.push(name);
                web_args.push(value);
            }
            _ => fail(&format!("unknown option {arg}")),
        }
    }

    if sys::geteuid() == 0 || sys::getuid() == 0 {
        fail("the dev login helper must not run as root");
    }
    let bind_ip: IpAddr = bind_ip.parse().unwrap_or_else(|_| fail("--bind-ip must be an IP address"));
    if !is_loopback(&bind_ip) {
        fail("the dev login helper only listens on loopback (e.g. --bind-ip 127.0.0.1)");
    }
    let bind_port: u16 = match bind_port.parse() {
        Ok(port) if port > 0 => port,
        _ => fail("invalid --bind-port"),
    };
    let password = std::env::var(PASSWORD_VARIABLE).unwrap_or_default();
    if password.chars().count() < 8 {
        fail("the dev login helper needs GREENFIELD_DEV_PASSWORD (at least 8 characters)");
    }
    let time_scale: f64 = time_scale.parse().unwrap_or(f64::NAN);
    if !(1.0..=100.0).contains(&time_scale) {
        fail("invalid --dev-time-scale (1..100)");
    }
    let link_kbps: f64 = link_kbps.parse().unwrap_or(f64::NAN);
    if !(link_kbps >= 0.0 && link_kbps.is_finite()) {
        fail("invalid --dev-link-kbps");
    }
    if patch_order != "oldest" && patch_order != "random" {
        fail("invalid --dev-patch-order (oldest or random)");
    }
    if patch_shape != "bands" && patch_shape != "tiles" {
        fail("invalid --dev-patch-shape (bands or tiles)");
    }
    if let Some(encoder) = &encoder {
        if !["auto", "none", "nvh264", "vaapih264"].contains(&encoder.as_str()) {
            fail("invalid --encoder (use auto, none, nvh264 or vaapih264)");
        }
    }
    if render_device.as_deref() == Some("") {
        fail("empty --render-device");
    }

    let user = sys::user_by_uid(sys::getuid()).unwrap_or_else(|e| fail(&format!("who am I? {e}")));
    let home = std::env::var("HOME").unwrap_or_else(|_| user.home.clone());
    let state_dir = state_dir.unwrap_or_else(|| {
        let state_home = std::env::var("XDG_STATE_HOME").unwrap_or_else(|_| format!("{home}/.local/state"));
        format!("{state_home}/greenfield-dev")
    });
    web_args.push("--state-dir".into());
    web_args.push(absolute(Path::new(&state_dir)).to_string_lossy().into_owned());
    let runtime_dir = runtime_dir.map(PathBuf::from).unwrap_or_else(|| {
        let base = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| format!("/tmp/nebula-dev-{}", user.uid));
        Path::new(&base).join(format!("nebula-dev-{bind_port}"))
    });
    let session_dir = session_dir.map(PathBuf::from).unwrap_or_else(|| {
        // <repo>/packages/gatekeeper/target/release/nebula-dev-login -> <repo>/packages/session/dist
        let exe = std::env::current_exe().unwrap_or_else(|e| fail(&format!("where am I? {e}")));
        exe.ancestors().nth(4).unwrap_or(Path::new("/")).join("session/dist")
    });
    if !session_dir.join("session-process.js").is_file() {
        fail(&format!("no built session in {} (make, or --session-dir)", session_dir.display()));
    }
    let web = web_binary().unwrap_or_else(|e| fail(&format!("no web front: {e} (make)")));

    Config {
        bind_ip,
        bind_port,
        runtime_dir: absolute(&runtime_dir),
        session_dir: absolute(&session_dir),
        web,
        node: node.map(PathBuf::from).unwrap_or_else(|| PathBuf::from("node")),
        site_config: site_config.map(|path| absolute(Path::new(&path))),
        encoder,
        render_device,
        time_scale,
        link_kbps,
        patch_order,
        patch_shape,
        expired_password,
        web_args,
        password,
        user,
    }
}

fn absolute(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The runtime directory (ours only), its users/ directory and login.sock, bound afresh.
fn prepare_runtime_dir(config: &Config) -> io::Result<UnixListener> {
    let users = config.runtime_dir.join("users");
    fs::create_dir_all(&users)?;
    fs::set_permissions(&config.runtime_dir, fs::Permissions::from_mode(0o700))?;
    fs::set_permissions(&users, fs::Permissions::from_mode(0o700))?;
    let socket_path = config.runtime_dir.join("login.sock");
    match fs::remove_file(&socket_path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let listener = UnixListener::bind(&socket_path)?;
    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

/// The site settings file the desktops read: --site-config, or one written from --encoder / --render-device.
fn prepare_site_settings(config: &Config) -> io::Result<Option<PathBuf>> {
    if config.encoder.is_none() && config.render_device.is_none() {
        return Ok(config.site_config.clone());
    }
    // the format of packages/session/src/site-settings.ts
    let file = config.runtime_dir.join("nebula.conf");
    let text = format!(
        "encoder = {}\nrender-device = {}\n",
        config.encoder.as_deref().unwrap_or("auto"),
        config.render_device.as_deref().unwrap_or("/dev/dri/renderD128")
    );
    fs::write(&file, text)?;
    Ok(Some(file))
}

fn start_web(config: &Config, listener: TcpListener) -> io::Result<std::process::Child> {
    let mut command = web_command(&config.web, &config.session_dir, &config.runtime_dir.join("login.sock"));
    command
        .args(&config.web_args)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()))
        .env("LANG", std::env::var("LANG").unwrap_or_else(|_| "C.UTF-8".into()))
        .stdin(Stdio::null());
    // no capabilities it could pass on, no_new_privs (the workers add their sandbox, web/src/sandbox.rs)
    without_capabilities(&mut command);
    spawn_with_fds(&mut command, vec![(OwnedFd::from(listener), WEB_LISTEN_FD)], Some(libc::SIGTERM))
}

/// The desktop's SessionConfig record, with the dev flags.
fn session_config(config: &Config, site_settings: &Option<PathBuf>) -> String {
    let dev_flags = format!(
        "{{\"timeScale\":{},\"linkKbps\":{},\"patchOrder\":{},\"patchShape\":{}}}",
        config.time_scale,
        config.link_kbps,
        json_string(&config.patch_order),
        json_string(&config.patch_shape)
    );
    session_config::session_config(site_settings.as_deref(), Some(&dev_flags))
}

/// Start a desktop (as the current user) that inherits `listener`; its pid.
fn start_desktop(config: &Config, site_settings: &Option<PathBuf>, listener: OwnedFd) -> io::Result<libc::pid_t> {
    let (config_read, mut config_write) = io::pipe()?;
    let mut command = Command::new(&config.node);
    command
        .arg(config.session_dir.join("session-process.js"))
        // never hand the dev password down (it would stay readable in /proc/<pid>/environ)
        .env_remove(PASSWORD_VARIABLE)
        .current_dir(&config.user.home)
        .stdin(Stdio::null());
    let child = spawn_with_fds(
        &mut command,
        vec![(OwnedFd::from(config_read), SESSION_CONFIG_FD), (listener, SESSION_LISTEN_FD)],
        // a desktop doesn't outlive its parent (in production: the PAM session)
        Some(libc::SIGTERM),
    )?;
    // (far below a pipe's buffer)
    config_write.write_all(session_config(config, site_settings).as_bytes())?;
    drop(config_write);
    Ok(child.id() as libc::pid_t)
}

fn equal_constant_time(a: &[u8], b: &[u8]) -> bool {
    let mut difference = (a.len() != b.len()) as u8;
    for i in 0..a.len().max(b.len()) {
        difference |= a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0xff);
    }
    difference == 0
}

/// One sign-in, in a child of its own: returns the exit status. `backoff` is the table as it was when the child was
/// forked; the attempt's outcome goes back to the main loop on `attempt_over`, which is closed when the attempt is over.
fn sign_in(
    config: &Config,
    site_settings: &Option<PathBuf>,
    backoff: &Table,
    connection: UnixStream,
    attempt_over: PipeWriter,
) -> i32 {
    let mut channel = Channel::new(connection);
    let report = |client: IpAddr, ok: bool| {
        if let Err(e) = backoff::send(&mut &attempt_over, Report { ip: client, ok }) {
            log::error(&format!("Reporting a sign-in to the main loop failed: {e}"));
        }
    };
    let result = (|| -> io::Result<Option<libc::pid_t>> {
        let client = match channel.read(BEGIN_TIMEOUT)? {
            (Record::ClientAddress(ip), _) => ip,
            _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "expected the client address")),
        };
        let username = match channel.read(BEGIN_TIMEOUT) {
            Ok((Record::Begin { username }, _)) => username,
            // the web listener opens a connection for every TCP connection, and most never become a sign-in (the page's
            // files): its worker exits without writing Begin
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
            Ok(_) => return Err(io::Error::new(io::ErrorKind::InvalidData, "expected Begin")),
            Err(e) => return Err(e),
        };
        if !is_loopback(&client) {
            log::warn(&format!("Refused a sign-in from {client}: the dev login helper accepts loopback only."));
            let text = "Signing in is only possible on this computer.".to_string();
            channel.write(&Record::Result { outcome: Outcome::Refused, text }, None)?;
            return Ok(None);
        }
        channel.write(&Record::Prompt { style: PromptStyle::EchoOff, text: "Password: ".into() }, None)?;
        let answer = match channel.read(ANSWER_TIMEOUT)? {
            (Record::Answer { text }, _) => text,
            _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "expected Answer")),
        };
        // a monotonic clock: wall clock adjustments mustn't shorten the minimum failure time
        let answered_at = Instant::now();
        let password_ok = equal_constant_time(answer.as_bytes(), config.password.as_bytes());
        // an address the backoff blocks fails like a wrong password (and isn't reported: that would extend the block)
        let throttled = backoff.blocked(client, Instant::now());
        if throttled || !(password_ok && username == config.user.name) {
            if throttled {
                log::info(&format!("Refused a sign-in from {client}: too many failed attempts from this address."));
            } else {
                log::info(&format!("Failed sign-in from {client}."));
                report(client, false);
            }
            // unknown users, wrong passwords and blocked addresses take the same minimum time
            let minimum = MIN_FAILED_SIGN_IN.div_f64(config.time_scale);
            std::thread::sleep(minimum.saturating_sub(answered_at.elapsed()));
            channel.write(&Record::Result { outcome: Outcome::Refused, text: WRONG.into() }, None)?;
            return Ok(None);
        }
        if config.expired_password {
            let mut last_answer = answered_at;
            if !change_expired_password(&mut channel, config, &username, &mut last_answer)? {
                let minimum = MIN_FAILED_SIGN_IN.div_f64(config.time_scale);
                std::thread::sleep(minimum.saturating_sub(last_answer.elapsed()));
                // not reported to the backoff: the password was right
                log::info(&format!("Failed sign-in from {client}: the expired password was not changed."));
                channel.write(&Record::Result { outcome: Outcome::Refused, text: NOT_CHANGED.into() }, None)?;
                return Ok(None);
            }
            log::info("Changed the (dev) expired password; the new one isn't kept.");
        }

        report(client, true);
        let user_dir = desktop::user_dir(&config.runtime_dir, config.user.uid);
        fs::create_dir_all(&user_dir)?;
        fs::set_permissions(&user_dir, fs::Permissions::from_mode(0o700))?;
        let attached = desktop::attach_or_create(&user_dir, client, |listener| {
            start_desktop(config, site_settings, listener)
        });
        let (web_end, desktop) = match attached {
            Ok(attached) => attached,
            Err(e) => {
                log::error(&format!("Attaching to or starting the desktop of {username} failed: {e}"));
                let text = "The desktop could not be started.".to_string();
                channel.write(&Record::Result { outcome: Outcome::Failed, text }, None)?;
                return Ok(None);
            }
        };
        let started = match desktop {
            Desktop::Attached => {
                log::info(&format!("Signed in: {username} from {client}, attached to the running desktop."));
                None
            }
            Desktop::Created(pid) => {
                log::info(&format!("Signed in: {username} from {client}, started a desktop ({pid})."));
                Some(pid)
            }
        };
        channel.write(&Record::Result { outcome: Outcome::SignedIn, text: username }, Some(web_end.as_raw_fd()))?;
        Ok(started)
    })();
    drop(channel);
    // the main loop counts this attempt as over
    drop(attempt_over);
    match result {
        Ok(Some(desktop)) => wait_desktop(config, desktop),
        Ok(None) => 0,
        Err(e) => {
            log::info(&format!("Sign-in ended: {e}"));
            1
        }
    }
}

/// Send a prompt; for a question, its answer (and when it came).
fn ask(channel: &mut Channel, style: PromptStyle, text: &str, last_answer: &mut Instant) -> io::Result<Option<String>> {
    channel.write(&Record::Prompt { style, text: text.into() }, None)?;
    if style != PromptStyle::EchoOff && style != PromptStyle::EchoOn {
        return Ok(None);
    }
    match channel.read(ANSWER_TIMEOUT)? {
        (Record::Answer { text }, _) => {
            *last_answer = Instant::now();
            Ok(Some(text))
        }
        _ => Err(io::Error::new(io::ErrorKind::InvalidData, "expected Answer")),
    }
}

/// --dev-expired-password: the conversation of an expired password as nebula-login relays it from PAM (pam_unix's
/// account check, then pam_chauthtok: the current password, the new one twice, three tries). Whether it was changed.
fn change_expired_password(
    channel: &mut Channel,
    config: &Config,
    username: &str,
    last_answer: &mut Instant,
) -> io::Result<bool> {
    use PromptStyle::{EchoOff, Error, Info};
    let notice = "You are required to change your password immediately (administrator enforced).";
    ask(channel, Error, notice, last_answer)?;
    ask(channel, Info, &format!("Changing password for {username}."), last_answer)?;
    let current = ask(channel, EchoOff, "Current password: ", last_answer)?.unwrap_or_default();
    if !equal_constant_time(current.as_bytes(), config.password.as_bytes()) {
        ask(channel, Error, "passwd: Authentication token manipulation error", last_answer)?;
        return Ok(false);
    }
    for _ in 0..3 {
        let new = ask(channel, EchoOff, "New password: ", last_answer)?.unwrap_or_default();
        if new.is_empty() {
            ask(channel, Error, "No password has been supplied.", last_answer)?;
            continue;
        }
        let again = ask(channel, EchoOff, "Retype new password: ", last_answer)?.unwrap_or_default();
        if new == again {
            return Ok(true);
        }
        ask(channel, Error, "Sorry, passwords do not match.", last_answer)?;
    }
    ask(channel, Error, "passwd: Have exhausted maximum number of retries for service", last_answer)?;
    Ok(false)
}

/// As a desktop's parent: wait for it to exit; SIGTERM / SIGINT are passed on to it.
fn wait_desktop(config: &Config, pid: libc::pid_t) -> i32 {
    match wait_passing_terminate(pid) {
        Ok(status) => {
            log::info(&format!("Desktop {pid} of {} exited ({}).", config.user.name, sys::describe_status(status)));
            0
        }
        Err(e) => {
            log::error(&format!("Waiting for desktop {pid} failed: {e}"));
            1
        }
    }
}

fn main() {
    log::set_name("nebula-dev-login");
    let config = parse_config();
    let fatal = |message: String| -> ! {
        log::error(&message);
        std::process::exit(1);
    };
    let login_listener = prepare_runtime_dir(&config)
        .unwrap_or_else(|e| fatal(format!("Preparing {} failed: {e}", config.runtime_dir.display())));
    let site_settings = prepare_site_settings(&config).unwrap_or_else(|e| fatal(format!("Writing the site settings failed: {e}")));
    let tcp = TcpListener::bind((config.bind_ip, config.bind_port))
        .unwrap_or_else(|e| fatal(format!("Listening on {}:{} failed: {e}", config.bind_ip, config.bind_port)));
    if let Err(e) = sys::catch_terminate() {
        fatal(format!("Can't handle signals: {e}"));
    }
    // the web process owns the listening socket from now on
    let web = start_web(&config, tcp).unwrap_or_else(|e| fatal(format!("Starting the web process failed: {e}")));
    let web_pid = web.id() as libc::pid_t;
    log::warn("!!! DEV LOGIN HELPER: no PAM, desktops run as the current user. Never use this outside development. !!!");
    log::info(&format!("Signing in at {}", config.runtime_dir.join("login.sock").display()));

    let parent = sys::getpid();
    // each child with the read end of its per-attempt pipe (closed when its attempt is over)
    let mut children: Vec<(libc::pid_t, Option<PipeReader>)> = Vec::new();
    let mut table = Table::new(Policy::DEFAULT.scaled(config.time_scale));
    loop {
        if sys::terminate_requested() {
            shutdown(&config, web_pid, children, 0);
        }
        // reap: sign-in children (and the desktop parents among them), and the web process, which we can't do without
        loop {
            match sys::wait_child(-1, false) {
                Ok(Some((pid, status))) if pid == web_pid => {
                    log::error(&format!("The web process exited ({}). Shutting down.", sys::describe_status(status)));
                    shutdown(&config, web_pid, children, 1);
                }
                Ok(Some((pid, _))) => {
                    // (its report may still be in the pipe)
                    for (_, attempt) in children.iter_mut().filter(|(child, _)| *child == pid) {
                        backoff::drain(attempt, &mut table);
                    }
                    children.retain(|(child, _)| *child != pid);
                }
                _ => break,
            }
        }
        match sys::poll_readable(login_listener.as_raw_fd(), Duration::from_secs(1)) {
            Ok(true) => {}
            Ok(false) => continue,
            Err(e) => fatal(format!("Waiting for sign-ins failed: {e}")),
        }
        let connection = match login_listener.accept() {
            Ok((connection, _)) => connection,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => {
                log::error(&format!("Accepting a sign-in failed: {e}"));
                continue;
            }
        };
        if let Err(e) = connection.set_nonblocking(false) {
            log::error(&format!("Setting up a sign-in failed: {e}"));
            continue;
        }
        let (attempt_read, attempt_write) = match io::pipe() {
            Ok(pipe) => pipe,
            Err(e) => {
                log::error(&format!("Setting up a sign-in failed: {e}"));
                continue;
            }
        };
        // the reports the latest attempts sent before their result: the child about to be forked decides with them
        for (_, attempt) in children.iter_mut() {
            backoff::drain(attempt, &mut table);
        }
        // one child per sign-in: it keeps no state here (whether a desktop runs is whether its socket accepts)
        match sys::fork() {
            Ok(sys::Forked::Child) => {
                drop(login_listener);
                drop(attempt_read);
                drop(children);
                sys::default_terminate();
                // a stopping helper ends its sign-ins and desktops; if it is killed, they follow
                if sys::set_parent_death_signal(libc::SIGTERM, parent).is_err() {
                    std::process::exit(1);
                }
                std::process::exit(sign_in(&config, &site_settings, &table, connection, attempt_write));
            }
            Ok(sys::Forked::Parent(pid)) => {
                drop(attempt_write);
                children.push((pid, Some(attempt_read)));
            }
            Err(e) => log::error(&format!("Forking for a sign-in failed: {e}")),
        }
    }
}

/// Stop the web process and the children (the desktops' parents pass it on to their desktops, which end their apps),
/// wait for them within reason, and exit.
fn shutdown(config: &Config, web_pid: libc::pid_t, children: Vec<(libc::pid_t, Option<PipeReader>)>, code: i32) -> ! {
    log::info("Stopping the web process and the desktops.");
    sys::kill(web_pid, libc::SIGTERM);
    for &(pid, _) in &children {
        sys::kill(pid, libc::SIGTERM);
    }
    let deadline = Instant::now() + DESKTOP_EXIT_TIMEOUT.div_f64(config.time_scale);
    let mut left: Vec<libc::pid_t> = children.into_iter().map(|(pid, _)| pid).chain([web_pid]).collect();
    while !left.is_empty() && Instant::now() < deadline {
        left.retain(|&pid| matches!(sys::wait_child(pid, false), Ok(None)));
        std::thread::sleep(Duration::from_millis(50));
    }
    for pid in left {
        sys::kill(pid, libc::SIGKILL);
    }
    let _ = fs::remove_file(config.runtime_dir.join("login.sock"));
    std::process::exit(code);
}
