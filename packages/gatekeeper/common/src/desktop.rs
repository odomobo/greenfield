//! Attach or create: after a successful sign-in, connect the user's new connection to their running desktop, or start
//! one. A user's desktop lives in `<runtime>/users/<uid>/`, a directory the helper owns and the user can't write to:
//!
//!   - `lock`: taken (flock) for the whole attach-or-create, so two sign-ins of one user don't both start a desktop;
//!   - `desktop.sock`: the desktop's listening socket. The helper binds it and the desktop inherits the listening fd,
//!     so the desktop never creates a path. Whether a desktop is running is whether this socket accepts: a desktop
//!     that logs out closes it (the next sign-in can't connect and creates a new desktop), a desktop that died leaves
//!     a stale path that is replaced.
//!
//! The new connection is a socket pair: one end goes to the desktop in a Handover record (with the client's address,
//! for the takeover message), on a connection of its own to `desktop.sock`; the other end is returned, for the
//! helper to pass to the web process in its Result. A desktop that is still starting has these connections queue in
//! its listen backlog until it accepts them, so there is no separate ready signal.
use nebula_login_protocol::Record;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::net::IpAddr;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

use crate::channel::Channel;
use crate::sys;

pub const LOCK_FILE: &str = "lock";
pub const DESKTOP_SOCKET: &str = "desktop.sock";

/// `<runtime>/users/<uid>`.
pub fn user_dir(runtime_dir: &Path, uid: libc::uid_t) -> PathBuf {
    runtime_dir.join("users").join(uid.to_string())
}

/// What attach-or-create did.
pub enum Desktop<T> {
    /// the user's desktop was running: the connection was handed to it
    Attached,
    /// a desktop was started (`T` is what `start` returned, e.g. its process) and got the connection
    Created(T),
}

/// Attach to the desktop in `user_dir` (which must exist), or create one with `start`, which gets the listening socket
/// and must have the desktop inherit it (and close it here). Returns the web process's end of the new connection.
pub fn attach_or_create<T>(
    user_dir: &Path,
    client: IpAddr,
    start: impl FnOnce(OwnedFd) -> io::Result<T>,
) -> io::Result<(OwnedFd, Desktop<T>)> {
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(user_dir.join(LOCK_FILE))?;
    sys::lock_exclusive(&lock)?;
    let result = attach_or_create_locked(user_dir, client, start);
    // (closing the file releases the lock)
    drop::<File>(lock);
    result
}

fn attach_or_create_locked<T>(
    user_dir: &Path,
    client: IpAddr,
    start: impl FnOnce(OwnedFd) -> io::Result<T>,
) -> io::Result<(OwnedFd, Desktop<T>)> {
    let socket_path = user_dir.join(DESKTOP_SOCKET);
    let (connection, desktop) = match UnixStream::connect(&socket_path) {
        Ok(connection) => (connection, Desktop::Attached),
        Err(e) if e.kind() == io::ErrorKind::ConnectionRefused || e.kind() == io::ErrorKind::NotFound => {
            match fs::remove_file(&socket_path) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                _ => {}
            }
            let listener = UnixListener::bind(&socket_path)?;
            fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))?;
            let started = start(OwnedFd::from(listener))?;
            // the first connection queues in the new desktop's backlog until it accepts
            (UnixStream::connect(&socket_path)?, Desktop::Created(started))
        }
        Err(e) => return Err(e),
    };
    let (web_end, desktop_end) = sys::socket_pair()?;
    Channel::new(connection).write(&Record::Handover(client), Some(desktop_end.as_raw_fd()))?;
    Ok((web_end, desktop))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A desktop stand-in: the inherited listener; reads one handover from it.
    fn accept_handover(listener: &UnixListener) -> (IpAddr, OwnedFd) {
        let (connection, _) = listener.accept().unwrap();
        match Channel::new(connection).read(Duration::from_secs(5)).unwrap() {
            (Record::Handover(ip), Some(fd)) => (ip, fd),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn creates_attaches_and_recreates() {
        let dir = std::env::temp_dir().join(format!("nebula-login-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let client: IpAddr = "127.0.0.1".parse().unwrap();

        // nothing running: create, and the new desktop gets the first connection
        let (web_end, desktop) = attach_or_create(&dir, client, |fd| Ok(UnixListener::from(fd))).unwrap();
        let Desktop::Created(listener) = desktop else { panic!("not created") };
        let (ip, desktop_end) = accept_handover(&listener);
        assert_eq!(ip, client);
        // the two ends are connected
        let mut web = UnixStream::from(web_end);
        let mut desktop = UnixStream::from(desktop_end);
        std::io::Write::write_all(&mut web, b"hi").unwrap();
        let mut buffer = [0u8; 2];
        std::io::Read::read_exact(&mut desktop, &mut buffer).unwrap();
        assert_eq!(&buffer, b"hi");

        // running: attach
        let other: IpAddr = "::1".parse().unwrap();
        let (_web_end, desktop) =
            attach_or_create(&dir, other, |_| -> io::Result<()> { panic!("started a second desktop") }).unwrap();
        assert!(matches!(desktop, Desktop::Attached));
        assert_eq!(accept_handover(&listener).0, other);

        // logged out (listener closed): the next sign-in creates again
        drop(listener);
        let (_web_end, desktop) = attach_or_create(&dir, client, |fd| Ok(UnixListener::from(fd))).unwrap();
        let Desktop::Created(listener) = desktop else { panic!("not created again") };
        accept_handover(&listener);
        fs::remove_dir_all(&dir).unwrap();
    }
}
