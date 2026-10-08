//! Starting the web front (packages/gatekeeper/web: the listener `nebula-web`, which starts a worker per connection),
//! the same way from both helpers.
use std::io;
use std::os::fd::RawFd;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The web listener's listening TCP socket.
pub const WEB_LISTEN_FD: RawFd = 3;
pub const WEB_BINARY: &str = "nebula-web";

/// The web listener: `nebula-web`, next to the running helper (both are built into the same target directory).
pub fn web_binary() -> io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let web = exe.parent().unwrap_or(Path::new("/")).join(WEB_BINARY);
    if !web.is_file() {
        return Err(io::Error::new(io::ErrorKind::NotFound, format!("{} is missing", web.display())));
    }
    Ok(web)
}

/// The command that starts the web listener with the listening socket at WEB_LISTEN_FD, `login_socket`, and the page
/// of the built session in `session_dir` (packages/session/dist: its static files are in ../static, the viewer is
/// ../../viewer/dist); the caller adds the options it passes on, the environment, and starts it.
pub fn web_command(web: &Path, session_dir: &Path, login_socket: &Path) -> Command {
    let packages = session_dir.parent().and_then(Path::parent).unwrap_or(Path::new("/"));
    let mut command = Command::new(web);
    command
        .arg("--listen-fd")
        .arg(WEB_LISTEN_FD.to_string())
        .arg("--login-socket")
        .arg(login_socket)
        .arg("--viewer-dir")
        .arg(packages.join("viewer/dist"))
        .arg("--static-dir")
        .arg(session_dir.parent().unwrap_or(Path::new("/")).join("static"));
    command
}
