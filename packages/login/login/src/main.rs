//! nebula-login: the production login helper and the nebula service's entry point. Runs as root.
//!
//! What it does (see SIGNIN-ROADMAP.md, steps 4 and 5, and packages/login/README.md):
//!   - binds the TCP port (or, started by a systemd socket unit, uses the socket systemd passes: LISTEN_FDS) and starts the web process (`node web.js --listen-fd 3 --login-socket <runtime>/login.sock`)
//!     as the unprivileged web user (`--web-user`, default nebula-web), with the listening socket as fd 3;
//!   - accepts the web process's connections on `<runtime>/login.sock` (only from the web user: SO_PEERCRED; the
//!     listener opens one for every TCP connection, most never become a sign-in), at most MAX_ATTEMPTS at a time, and
//!     forks a child for each;
//!   - the child runs PAM with one handle (service "nebula"): pam_authenticate and pam_acct_mgmt with PAM's prompts
//!     relayed to the page (relay.rs), PAM_RHOST set to the client's address and PAM_TTY to "nebula"; refuses root;
//!     failures take at least 3 s from the last answer;
//!   - on success it attaches to the user's running desktop, or opens the PAM session on the same handle
//!     (pam_setcred, pam_open_session), starts the desktop as the user (groups, gid, uid dropped and verified, the
//!     PAM environment, the listening socket inherited, PR_SET_PDEATHSIG) and stays as its PAM parent: it waits for
//!     the desktop to exit, then closes the PAM session;
//!   - SIGTERM / SIGINT stop the web process and the desktops (they end their apps first).
//!
//! It contains no dev code: the dev helper is a separate binary (dev-login).
#![deny(unsafe_code)]

mod activation;
mod args;
mod attempt;
mod pam;
mod relay;

use args::{Parsed, USAGE};
use attempt::{Host, Limits};
use nebula_login_common::desktop;
use nebula_login_common::session_config::{session_config, SESSION_CONFIG_FD, SESSION_LISTEN_FD};
use nebula_login_common::spawn::{spawn_as, wait_passing_terminate};
use nebula_login_common::{log, sys};
use relay::Relay;
use std::fs;
use std::io::{self, PipeWriter, Write};
use std::net::{IpAddr, TcpListener};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The PAM service (/etc/pam.d/nebula; an example is packages/login/pam/nebula).
const PAM_SERVICE: &str = "nebula";
/// PAM_TTY: there is no terminal; modules like pam_access and pam_systemd see this name.
const PAM_TTY_NAME: &str = "nebula";
const LIMITS: Limits = Limits {
    // the web process sends the address and the user name right after connecting
    begin_timeout: Duration::from_secs(10),
    // the page answers a prompt within 60 s (the web process enforces it); a little more here
    answer_timeout: Duration::from_secs(75),
    min_failure: Duration::from_secs(3),
};
/// login.sock connections in progress at once (before Begin, and attempts until they are over); more are closed at
/// once (the web process tells the page signing in is not possible). The web listener opens one for every TCP
/// connection, and caps those at the same number (MAX_WORKERS in packages/gateway/src/web.ts).
const MAX_ATTEMPTS: usize = 256;
/// A sign-in child that hasn't finished its attempt by then (PAM stuck, or a page answering very slowly) is ended.
const ATTEMPT_TIMEOUT_SECONDS: u32 = 180;
/// How long a stopping helper waits for its desktops (they give their apps 5 s to quit, then kill them).
const DESKTOP_EXIT_TIMEOUT: Duration = Duration::from_secs(8);
/// The web process's listening TCP socket.
const WEB_LISTEN_FD: i32 = 3;
/// The desktops' PATH (PAM's environment may override it).
const SESSION_PATH: &str = "/usr/local/bin:/usr/bin:/bin";

struct Config {
    args: args::Args,
    web: sys::User,
    gateway_dir: PathBuf,
    node: PathBuf,
    /// the site settings file the desktops read, if not their default
    site_settings: Option<PathBuf>,
    lang: String,
}

fn usage_error(message: &str) -> ! {
    eprintln!("nebula-login: {message}\n\n{USAGE}");
    std::process::exit(2);
}

fn fatal(message: String) -> ! {
    log::error(&message);
    std::process::exit(1);
}

/// `node` from PATH, as an absolute path (desktops and the web process run it with environments of their own).
fn find_node() -> Option<PathBuf> {
    let path = std::env::var("PATH").unwrap_or_else(|_| SESSION_PATH.into());
    std::env::split_paths(&path).map(|dir| dir.join("node")).find(|file| file.is_file())
}

fn configure() -> Config {
    let args = match args::parse(std::env::args().skip(1)) {
        Ok(Parsed::Help) => {
            print!("{USAGE}");
            std::process::exit(0);
        }
        Ok(Parsed::Run(args)) => args,
        Err(message) => usage_error(&message),
    };
    if sys::geteuid() != 0 || sys::getuid() != 0 {
        usage_error("nebula-login must be started as root (it drops privileges itself). For development use the dev login helper (nebula-dev-login).");
    }
    let web = match sys::user_by_name(&args.web_user) {
        Ok(user) if user.uid != 0 => user,
        Ok(_) => usage_error("the web user must not be root"),
        Err(e) => fatal(format!(
            "Web user \"{0}\" not usable ({e}). Create it, e.g.: useradd --system --no-create-home --shell /usr/sbin/nologin {0}",
            args.web_user
        )),
    };
    let gateway_dir = args.gateway_dir.clone().unwrap_or_else(|| {
        // <repo>/packages/login/target/release/nebula-login -> <repo>/packages/gateway/dist
        let exe = std::env::current_exe().unwrap_or_else(|e| fatal(format!("Where am I? {e}")));
        exe.ancestors().nth(4).unwrap_or(Path::new("/")).join("gateway/dist")
    });
    if !gateway_dir.join("web.js").is_file() || !gateway_dir.join("session-process.js").is_file() {
        usage_error(&format!("no built gateway in {} (yarn build, or --gateway-dir)", gateway_dir.display()));
    }
    let node = args.node.clone().or_else(find_node).unwrap_or_else(|| usage_error("no node in PATH (--node)"));
    let node = std::path::absolute(&node).unwrap_or(node);
    if !Path::new(&format!("/etc/pam.d/{PAM_SERVICE}")).exists() {
        log::warn(&format!(
            "/etc/pam.d/{PAM_SERVICE} is missing; PAM falls back to the \"other\" service. See packages/login/pam/."
        ));
    }
    Config {
        args,
        web,
        gateway_dir,
        node,
        site_settings: None,
        lang: std::env::var("LANG").unwrap_or_else(|_| "C.UTF-8".into()),
    }
}

/// A directory owned by root with `mode`, created if needed; never a symlink.
fn root_dir(path: &Path, mode: u32) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_dir() => {
            return Err(io::Error::other(format!("{} is not a directory", path.display())))
        }
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => fs::create_dir(path)?,
        Err(e) => return Err(e),
    }
    std::os::unix::fs::chown(path, Some(0), Some(0))?;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

/// The runtime directory (root's, traversable): users/ for the desktops, and login.sock, bound afresh, which only the
/// web user's group may connect to (and the peer check lets in only the web user).
fn prepare_runtime_dir(config: &Config) -> io::Result<UnixListener> {
    let runtime = &config.args.runtime_dir;
    if let Some(parent) = runtime.parent() {
        fs::create_dir_all(parent)?;
    }
    root_dir(runtime, 0o755)?;
    root_dir(&runtime.join("users"), 0o755)?;
    let socket_path = runtime.join("login.sock");
    match fs::remove_file(&socket_path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let listener = UnixListener::bind(&socket_path)?;
    std::os::unix::fs::chown(&socket_path, Some(0), Some(config.web.gid))?;
    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o660))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

/// The site settings file the desktops read: --site-config, or one written from --encoder / --render-device.
fn prepare_site_settings(config: &mut Config) -> io::Result<()> {
    let args = &config.args;
    config.site_settings = args.site_config.clone();
    if args.encoder.is_none() && args.render_device.is_none() {
        return Ok(());
    }
    // the format of packages/gateway/src/site-settings.ts; readable by every user (the desktops run as them)
    let file = args.runtime_dir.join("nebula.conf");
    let text = format!(
        "encoder = {}\nrender-device = {}\n",
        args.encoder.as_deref().unwrap_or("auto"),
        args.render_device.as_deref().unwrap_or("/dev/dri/renderD128")
    );
    let _ = fs::remove_file(&file);
    fs::write(&file, text)?;
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644))?;
    config.site_settings = Some(file);
    Ok(())
}

/// Without --cert/--key the web process generates a self-signed certificate in the state directory, so that must be
/// the web user's: created for it if missing, refused if it belongs to someone else.
fn prepare_state_dir(config: &Config) -> io::Result<()> {
    if config.args.tls.is_some() {
        return Ok(());
    }
    let dir = &config.args.state_dir;
    match fs::symlink_metadata(dir) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.uid() != config.web.uid {
                return Err(io::Error::other(format!(
                    "{} must be a directory owned by {} (chown {} {}), or give --cert and --key",
                    dir.display(),
                    config.web.name,
                    config.web.name,
                    dir.display()
                )));
            }
            Ok(())
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            if let Some(parent) = dir.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::create_dir(dir)?;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
            std::os::unix::fs::chown(dir, Some(config.web.uid), Some(config.web.gid))
        }
        Err(e) => Err(e),
    }
}

/// The TCP listening socket: the one systemd passed (socket activation; --bind-ip / --bind-port don't apply then), or
/// one bound here.
fn listening_socket(bind_ip: IpAddr, bind_port: u16) -> TcpListener {
    match activation::from_environment() {
        Ok(None) => TcpListener::bind((bind_ip, bind_port))
            .unwrap_or_else(|e| fatal(format!("Listening on {bind_ip}:{bind_port} failed: {e}"))),
        Ok(Some(1)) => {
            let listener = sys::adopt_tcp_listener(activation::LISTEN_FDS_START)
                .unwrap_or_else(|e| fatal(format!("The socket systemd passed is not usable: {e}")));
            match listener.local_addr() {
                Ok(address) => log::info(&format!("Using the socket passed by systemd, listening on {address}.")),
                Err(_) => log::info("Using the socket passed by systemd."),
            }
            listener
        }
        Ok(Some(count)) => {
            fatal(format!("systemd passed {count} sockets; nebula.socket must have exactly one ListenStream"))
        }
        Err(e) => fatal(format!("Bad socket activation environment: {e}")),
    }
}

/// The web process, as the web user, with the listening socket.
fn start_web(config: &Config, listener: TcpListener) -> io::Result<std::process::Child> {
    let mut command = Command::new(&config.node);
    command
        .arg(config.gateway_dir.join("web.js"))
        .arg("--listen-fd")
        .arg(WEB_LISTEN_FD.to_string())
        .arg("--login-socket")
        .arg(config.args.runtime_dir.join("login.sock"))
        .args(config.args.web_args())
        .env_clear()
        .env("PATH", SESSION_PATH)
        .env("LANG", &config.lang)
        .env("NODE_ENV", "production")
        .stdin(Stdio::null());
    let mut credentials = sys::Credentials::of(&config.web)?;
    credentials.dir = c"/".to_owned();
    spawn_as(&mut command, vec![(OwnedFd::from(listener), WEB_LISTEN_FD)], Some(credentials), Some(libc::SIGTERM))
}

/// What a sign-in child needs from the system: PAM, the passwd database, the users' directories, starting desktops.
struct System<'a> {
    config: &'a Config,
}

impl Host for System<'_> {
    type Pam = pam::Handle;

    fn start_pam(&self, username: &str, client: IpAddr, relay: Relay) -> Result<pam::Handle, (Relay, String)> {
        pam::Handle::start(PAM_SERVICE, username, client, PAM_TTY_NAME, relay)
    }

    fn user(&self, name: &str) -> Option<sys::User> {
        sys::user_by_name(name).ok()
    }

    fn user_dir(&self, uid: libc::uid_t) -> io::Result<PathBuf> {
        // root's, so the user can't replace desktop.sock or the lock with something root would then use
        let dir = desktop::user_dir(&self.config.args.runtime_dir, uid);
        root_dir(&dir, 0o755)?;
        Ok(dir)
    }

    fn start_desktop(&self, user: &sys::User, environment: Vec<String>, listener: OwnedFd) -> io::Result<libc::pid_t> {
        let config = self.config;
        let (config_read, mut config_write) = io::pipe()?;
        let mut command = Command::new(&config.node);
        command
            .arg(config.gateway_dir.join("session-process.js"))
            .env_clear()
            .env("PATH", SESSION_PATH)
            .env("LANG", &config.lang);
        // the environment PAM set up (pam_systemd: XDG_RUNTIME_DIR and the like), then who the user is
        for variable in &environment {
            if let Some((name, value)) = variable.split_once('=') {
                command.env(name, value);
            }
        }
        command
            .env("HOME", &user.home)
            .env("USER", &user.name)
            .env("LOGNAME", &user.name)
            .env("SHELL", &user.shell)
            .stdin(Stdio::null());
        let child = spawn_as(
            &mut command,
            vec![(OwnedFd::from(config_read), SESSION_CONFIG_FD), (listener, SESSION_LISTEN_FD)],
            Some(sys::Credentials::of(user)?),
            // a desktop doesn't outlive its PAM parent (or its session would never be closed)
            Some(libc::SIGTERM),
        )?;
        let pid = child.id() as libc::pid_t;
        // (far below a pipe's buffer)
        let record = session_config(config.site_settings.as_deref(), None);
        if let Err(e) = config_write.write_all(record.as_bytes()) {
            sys::kill(pid, libc::SIGKILL);
            let _ = sys::wait_child(pid, true);
            return Err(e);
        }
        Ok(pid)
    }
}

/// A sign-in child, in the child: run the attempt, and if it started a desktop, be its PAM parent. The exit status.
fn sign_in_child(config: &Config, connection: UnixStream, attempt_over: PipeWriter) -> i32 {
    // a stuck attempt ends (SIGALRM's default action); a PAM parent has no time limit
    sys::alarm(ATTEMPT_TIMEOUT_SECONDS);
    let result = attempt::sign_in(&System { config }, &LIMITS, connection);
    sys::alarm(0);
    // the main loop counts this attempt as over (when the child exits, too)
    drop(attempt_over);
    match result {
        Ok(None) => 0,
        Ok(Some(mut started)) => {
            let status = match wait_passing_terminate(started.pid) {
                Ok(status) => {
                    let how = sys::describe_status(status);
                    log::info(&format!("Desktop {} of {} exited ({how}).", started.pid, started.username));
                    0
                }
                Err(e) => {
                    log::error(&format!("Waiting for desktop {} failed: {e}", started.pid));
                    1
                }
            };
            use attempt::Pam;
            started.pam.close_session();
            log::info(&format!("Closed the PAM session of {}.", started.username));
            drop(started);
            status
        }
        Err(e) => {
            log::info(&format!("Sign-in ended: {e}"));
            1
        }
    }
}

/// A forked sign-in child: its pid, and the read end of the pipe it closes when its attempt is over.
struct Child {
    pid: libc::pid_t,
    attempt: Option<OwnedFd>,
}

/// Sign-ins whose attempt is still going on (the pipe isn't closed yet).
fn attempts_in_progress(children: &mut [Child]) -> usize {
    for child in children.iter_mut() {
        if let Some(fd) = &child.attempt {
            // nothing is ever written: readable means closed
            if !matches!(sys::poll_readable(fd.as_raw_fd(), Duration::ZERO), Ok(false)) {
                child.attempt = None;
            }
        }
    }
    children.iter().filter(|child| child.attempt.is_some()).count()
}

fn main() {
    log::set_name("nebula-login");
    let mut config = configure();
    let login_listener = prepare_runtime_dir(&config)
        .unwrap_or_else(|e| fatal(format!("Preparing {} failed: {e}", config.args.runtime_dir.display())));
    prepare_site_settings(&mut config).unwrap_or_else(|e| fatal(format!("Writing the site settings failed: {e}")));
    prepare_state_dir(&config).unwrap_or_else(|e| fatal(format!("Preparing the state directory failed: {e}")));
    let (bind_ip, bind_port) = (config.args.bind_ip, config.args.bind_port);
    let tcp = listening_socket(bind_ip, bind_port);
    if let Err(e) = sys::catch_terminate() {
        fatal(format!("Can't handle signals: {e}"));
    }
    // the web process owns the listening socket from now on
    let web = start_web(&config, tcp).unwrap_or_else(|e| fatal(format!("Starting the web process failed: {e}")));
    let web_pid = web.id() as libc::pid_t;
    log::info(&format!(
        "Web process {web_pid} runs as {}; signing in at {} (PAM service {PAM_SERVICE}).",
        config.web.name,
        config.args.runtime_dir.join("login.sock").display()
    ));

    let parent = sys::getpid();
    let mut children: Vec<Child> = Vec::new();
    loop {
        if sys::terminate_requested() {
            shutdown(&config, web_pid, children, 0);
        }
        // reap: sign-in children (and the PAM parents among them), and the web process, which we can't do without
        loop {
            match sys::wait_child(-1, false) {
                Ok(Some((pid, status))) if pid == web_pid => {
                    log::error(&format!("The web process exited ({}). Shutting down.", sys::describe_status(status)));
                    shutdown(&config, web_pid, children, 1);
                }
                Ok(Some((pid, _))) => children.retain(|child| child.pid != pid),
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
        match sys::peer_uid(connection.as_raw_fd()) {
            Ok(uid) if uid == config.web.uid => {}
            Ok(uid) => {
                log::warn(&format!("Refused a login.sock connection from uid {uid} (not the web user)."));
                continue;
            }
            Err(e) => {
                log::error(&format!("Checking a sign-in's peer failed: {e}"));
                continue;
            }
        }
        if attempts_in_progress(&mut children) >= MAX_ATTEMPTS {
            // closing the connection: the web process tells the page signing in didn't work
            log::warn(&format!("Turned a login.sock connection away: {MAX_ATTEMPTS} are in progress."));
            continue;
        }
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
        // one child per sign-in: it keeps no state here (whether a desktop runs is whether its socket accepts)
        match sys::fork() {
            Ok(sys::Forked::Child) => {
                drop(login_listener);
                drop(attempt_read);
                drop(children);
                sys::default_terminate();
                // a stopping helper ends its sign-ins and PAM parents; if it is killed, they follow
                if sys::set_parent_death_signal(libc::SIGTERM, parent).is_err() {
                    std::process::exit(1);
                }
                std::process::exit(sign_in_child(&config, connection, attempt_write));
            }
            Ok(sys::Forked::Parent(pid)) => {
                drop(attempt_write);
                children.push(Child { pid, attempt: Some(OwnedFd::from(attempt_read)) });
            }
            Err(e) => log::error(&format!("Forking for a sign-in failed: {e}")),
        }
    }
}

/// Stop the web process and the children (the PAM parents pass it on to their desktops, which end their apps, then
/// close their sessions), wait for them within reason, and exit.
fn shutdown(config: &Config, web_pid: libc::pid_t, children: Vec<Child>, code: i32) -> ! {
    log::info("Stopping the web process and the desktops.");
    sys::kill(web_pid, libc::SIGTERM);
    for child in &children {
        sys::kill(child.pid, libc::SIGTERM);
    }
    let deadline = Instant::now() + DESKTOP_EXIT_TIMEOUT;
    let mut left: Vec<libc::pid_t> = children.iter().map(|child| child.pid).chain([web_pid]).collect();
    while !left.is_empty() && Instant::now() < deadline {
        left.retain(|&pid| matches!(sys::wait_child(pid, false), Ok(None)));
        std::thread::sleep(Duration::from_millis(50));
    }
    for pid in left {
        sys::kill(pid, libc::SIGKILL);
    }
    let _ = fs::remove_file(config.args.runtime_dir.join("login.sock"));
    std::process::exit(code);
}
