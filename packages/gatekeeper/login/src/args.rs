//! The command line.
#![forbid(unsafe_code)]

use std::net::IpAddr;
use std::path::PathBuf;

pub const USAGE: &str = "Usage: nebula-login [options]

The nebula service: started as root, it binds the port, starts the web process as an unprivileged user and signs
users in with PAM (service \"nebula\", /etc/pam.d/nebula), starting each user's desktop as that user.

  --bind-ip <ip>             address to listen on (default 0.0.0.0)
  --bind-port <port>         port to listen on (default 8443)
                             (both ignored when systemd passes the socket: LISTEN_FDS, see packages/gatekeeper/systemd/)
  --web-user <name>          unprivileged user the web process runs as (default nebula-web)
  --runtime-dir <dir>        login.sock and the desktops' users/<uid>/ directories (default /run/nebula)
  --session-dir <dir>        the built session: session-process.js, and the page in ../static and ../../viewer/dist,
                             readable by the web user (default: packages/session/dist next to this binary's
                             packages/gatekeeper)
  --node <path>              the node to run the desktops with, executable by every user (default: node from PATH)
  --site-config <file>       site settings file the desktops read (default /etc/nebula/nebula.conf; see
                             packages/session/src/site-settings.ts for its format)
  --encoder <auto|none|nvh264|vaapih264>
                             video encoder, overriding the site settings file (default there: auto)
  --render-device <path>     GPU render node, overriding the site settings file (default /dev/dri/renderD128)
  --min-uid <uid>            the lowest uid that may sign in (default: UID_MIN from /etc/login.defs, else 1000);
                             root never may
  --allow-any-shell          let users sign in whatever their login shell (default: only shells listed in
                             /etc/shells, so accounts with e.g. /usr/sbin/nologin can't)

Passed on to the web process:
  --cert <file> --key <file> TLS certificate and key, readable by the web user (default: a self-signed one in the
                             state dir)
  --state-dir <dir>          where the generated certificate is kept, owned by the web user (default /var/lib/nebula;
                             created if missing)
  --hide-hostname            don't show the host name on the sign-in page
  --allowed-origin <origin>  additionally accepted Origin (repeatable), e.g. https://desktop.example.com
";

#[derive(Debug, PartialEq)]
pub struct Args {
    pub bind_ip: IpAddr,
    pub bind_port: u16,
    pub web_user: String,
    pub runtime_dir: PathBuf,
    pub session_dir: Option<PathBuf>,
    pub node: Option<PathBuf>,
    pub site_config: Option<PathBuf>,
    pub encoder: Option<String>,
    pub render_device: Option<String>,
    /// None: UID_MIN from /etc/login.defs
    pub min_uid: Option<libc::uid_t>,
    pub allow_any_shell: bool,
    /// (certificate, key)
    pub tls: Option<(PathBuf, PathBuf)>,
    pub state_dir: PathBuf,
    pub hide_hostname: bool,
    pub allowed_origins: Vec<String>,
}

#[derive(Debug, PartialEq)]
pub enum Parsed {
    Help,
    Run(Args),
}

/// Parse the options (without the program name). Relative paths are made absolute.
pub fn parse(arguments: impl IntoIterator<Item = String>) -> Result<Parsed, String> {
    let mut bind_ip = "0.0.0.0".to_string();
    let mut bind_port = "8443".to_string();
    let mut web_user = "nebula-web".to_string();
    let mut runtime_dir = "/run/nebula".to_string();
    let mut session_dir = None;
    let mut node = None;
    let mut site_config = None;
    let mut encoder = None;
    let mut render_device = None;
    let mut min_uid = None;
    let mut allow_any_shell = false;
    let mut cert = None;
    let mut key = None;
    let mut state_dir = "/var/lib/nebula".to_string();
    let mut hide_hostname = false;
    let mut allowed_origins = Vec::new();

    let mut arguments = arguments.into_iter();
    while let Some(argument) = arguments.next() {
        let (name, inline) = match argument.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name.to_string(), Some(value.to_string())),
            _ => (argument.clone(), None),
        };
        match name.as_str() {
            "--help" | "-h" => return Ok(Parsed::Help),
            "--hide-hostname" => {
                hide_hostname = true;
                continue;
            }
            "--allow-any-shell" => {
                allow_any_shell = true;
                continue;
            }
            _ if name.starts_with("--dev-") => {
                return Err(format!("{name}: the --dev-* options belong to the dev login helper (nebula-dev-login)"))
            }
            _ => {}
        }
        let mut value = || inline.clone().or_else(|| arguments.next()).ok_or_else(|| format!("{name} needs a value"));
        match name.as_str() {
            "--bind-ip" => bind_ip = value()?,
            "--bind-port" => bind_port = value()?,
            "--web-user" => web_user = value()?,
            "--runtime-dir" => runtime_dir = value()?,
            "--session-dir" => session_dir = Some(value()?),
            "--node" => node = Some(value()?),
            "--site-config" => site_config = Some(value()?),
            "--encoder" => encoder = Some(value()?),
            "--render-device" => render_device = Some(value()?),
            "--min-uid" => min_uid = Some(value()?),
            "--cert" => cert = Some(value()?),
            "--key" => key = Some(value()?),
            "--state-dir" => state_dir = value()?,
            "--allowed-origin" => allowed_origins.push(value()?),
            _ => return Err(format!("unknown option {argument}")),
        }
    }

    let bind_ip: IpAddr = bind_ip.parse().map_err(|_| "--bind-ip must be an IP address".to_string())?;
    let bind_port: u16 = match bind_port.parse() {
        Ok(port) if port > 0 => port,
        _ => return Err("invalid --bind-port".into()),
    };
    if web_user.is_empty() || web_user == "root" {
        return Err("--web-user must be an unprivileged user".into());
    }
    if let Some(encoder) = &encoder {
        if !["auto", "none", "nvh264", "vaapih264"].contains(&encoder.as_str()) {
            return Err("invalid --encoder (use auto, none, nvh264 or vaapih264)".into());
        }
    }
    if render_device.as_deref() == Some("") {
        return Err("empty --render-device".into());
    }
    let min_uid = match min_uid.map(|uid| uid.parse::<libc::uid_t>()) {
        None => None,
        Some(Ok(uid)) => Some(uid),
        Some(Err(_)) => return Err("--min-uid must be a number".into()),
    };
    let tls = match (cert, key) {
        (Some(cert), Some(key)) => Some((absolute(&cert), absolute(&key))),
        (None, None) => None,
        _ => return Err("--cert and --key must be given together".into()),
    };
    Ok(Parsed::Run(Args {
        bind_ip,
        bind_port,
        web_user,
        runtime_dir: absolute(&runtime_dir),
        session_dir: session_dir.map(|dir| absolute(&dir)),
        node: node.map(PathBuf::from),
        site_config: site_config.map(|path| absolute(&path)),
        encoder,
        render_device,
        min_uid,
        allow_any_shell,
        tls,
        state_dir: absolute(&state_dir),
        hide_hostname,
        allowed_origins,
    }))
}

fn absolute(path: &str) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| PathBuf::from(path))
}

impl Args {
    /// The web process's options, after `--listen-fd` and `--login-socket` (the interface the dev helper uses too).
    pub fn web_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some((cert, key)) = &self.tls {
            args.extend(["--cert".into(), cert.to_string_lossy().into_owned()]);
            args.extend(["--key".into(), key.to_string_lossy().into_owned()]);
        }
        args.extend(["--state-dir".into(), self.state_dir.to_string_lossy().into_owned()]);
        if self.hide_hostname {
            args.push("--hide-hostname".into());
        }
        for origin in &self.allowed_origins {
            args.extend(["--allowed-origin".into(), origin.clone()]);
        }
        args
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(arguments: &[&str]) -> Result<Args, String> {
        match parse(arguments.iter().map(|s| s.to_string()))? {
            Parsed::Run(args) => Ok(args),
            Parsed::Help => panic!("help"),
        }
    }

    #[test]
    fn defaults() {
        let args = run(&[]).unwrap();
        assert_eq!(args.bind_ip, "0.0.0.0".parse::<IpAddr>().unwrap());
        assert_eq!(args.bind_port, 8443);
        assert_eq!(args.web_user, "nebula-web");
        assert_eq!(args.runtime_dir, PathBuf::from("/run/nebula"));
        assert_eq!(args.state_dir, PathBuf::from("/var/lib/nebula"));
        assert_eq!(args.min_uid, None);
        assert!(!args.allow_any_shell);
        assert_eq!(args.web_args(), ["--state-dir", "/var/lib/nebula"]);
        assert_eq!(parse(["--help".to_string()]), Ok(Parsed::Help));
    }

    #[test]
    fn options() {
        let args = run(&[
            "--bind-ip=::",
            "--bind-port",
            "443",
            "--web-user",
            "www",
            "--cert",
            "/etc/c.pem",
            "--key=/etc/k.pem",
            "--hide-hostname",
            "--allowed-origin",
            "https://a.example",
            "--allowed-origin",
            "https://b.example",
            "--encoder",
            "none",
            "--render-device",
            "/dev/dri/renderD129",
            "--site-config",
            "/etc/x.conf",
            "--min-uid=500",
            "--allow-any-shell",
        ])
        .unwrap();
        assert_eq!(args.min_uid, Some(500));
        assert!(args.allow_any_shell);
        assert_eq!(args.bind_port, 443);
        assert_eq!(args.web_user, "www");
        assert_eq!(args.encoder.as_deref(), Some("none"));
        assert_eq!(args.site_config, Some(PathBuf::from("/etc/x.conf")));
        assert_eq!(
            args.web_args(),
            [
                "--cert",
                "/etc/c.pem",
                "--key",
                "/etc/k.pem",
                "--state-dir",
                "/var/lib/nebula",
                "--hide-hostname",
                "--allowed-origin",
                "https://a.example",
                "--allowed-origin",
                "https://b.example"
            ]
        );
    }

    #[test]
    fn refusals() {
        for (arguments, message) in [
            (&["--dev-time-scale", "3"][..], "dev login helper"),
            (&["--insecure-plaintext"][..], "unknown option"),
            (&["--bind-ip", "localhost"][..], "IP address"),
            (&["--bind-port", "0"][..], "--bind-port"),
            (&["--bind-port", "70000"][..], "--bind-port"),
            (&["--cert", "/c"][..], "together"),
            (&["--encoder", "x264"][..], "--encoder"),
            (&["--web-user", "root"][..], "unprivileged"),
            (&["--min-uid", "-1"][..], "--min-uid"),
            (&["--min-uid", "1000x"][..], "--min-uid"),
            (&["--bind-port"][..], "needs a value"),
            (&["extra"][..], "unknown option"),
        ] {
            let error = run(arguments).unwrap_err();
            assert!(error.contains(message), "{arguments:?}: {error}");
        }
    }
}
