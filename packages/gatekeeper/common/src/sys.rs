//! The system calls std doesn't wrap: fd passing, socket pairs, peer credentials, flock, poll, signals, fork and
//! waitpid, the passwd and group databases, changing to another user. Everything unsafe in the helpers is in this
//! module, apart from the production helper's PAM bindings (login/src/pam.rs) and `pre_exec` in spawn.rs.
use std::ffi::{CStr, CString};
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

fn check(result: libc::c_int) -> io::Result<libc::c_int> {
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result)
    }
}

/// Send all of `bytes` on a stream socket, with `pass` (if any) as an SCM_RIGHTS message on the first byte.
pub fn send_with_fd(socket: RawFd, bytes: &[u8], pass: Option<RawFd>) -> io::Result<()> {
    let mut sent = 0;
    let mut pass = pass;
    while sent < bytes.len() {
        let rest = &bytes[sent..];
        let mut iov = libc::iovec { iov_base: rest.as_ptr() as *mut libc::c_void, iov_len: rest.len() };
        // room for one fd, aligned for cmsghdr
        let mut control = [0u64; 4];
        let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
        message.msg_iov = &mut iov;
        message.msg_iovlen = 1;
        if let Some(fd) = pass {
            let space = unsafe { libc::CMSG_SPACE(std::mem::size_of::<RawFd>() as u32) } as usize;
            assert!(space <= std::mem::size_of_val(&control));
            message.msg_control = control.as_mut_ptr() as *mut libc::c_void;
            message.msg_controllen = space as _;
            unsafe {
                let header = libc::CMSG_FIRSTHDR(&message);
                (*header).cmsg_level = libc::SOL_SOCKET;
                (*header).cmsg_type = libc::SCM_RIGHTS;
                (*header).cmsg_len = libc::CMSG_LEN(std::mem::size_of::<RawFd>() as u32) as _;
                std::ptr::write_unaligned(libc::CMSG_DATA(header) as *mut RawFd, fd);
            }
        }
        let result = unsafe { libc::sendmsg(socket, &message, libc::MSG_NOSIGNAL) };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        sent += result as usize;
        pass = None;
    }
    Ok(())
}

/// Receive what is there (at most `buffer.len()` bytes) and any fds that came with it (close-on-exec). 0 bytes: EOF.
pub fn recv_with_fds(socket: RawFd, buffer: &mut [u8]) -> io::Result<(usize, Vec<OwnedFd>)> {
    let mut iov = libc::iovec { iov_base: buffer.as_mut_ptr() as *mut libc::c_void, iov_len: buffer.len() };
    let mut control = [0u64; 16];
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr() as *mut libc::c_void;
    message.msg_controllen = std::mem::size_of_val(&control) as _;
    let result = loop {
        let result = unsafe { libc::recvmsg(socket, &mut message, libc::MSG_CMSG_CLOEXEC) };
        if result < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        }
        break result;
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut fds = Vec::new();
    unsafe {
        let mut header = libc::CMSG_FIRSTHDR(&message);
        while !header.is_null() {
            if (*header).cmsg_level == libc::SOL_SOCKET && (*header).cmsg_type == libc::SCM_RIGHTS {
                let data = libc::CMSG_DATA(header) as *const RawFd;
                let count = ((*header).cmsg_len as usize - libc::CMSG_LEN(0) as usize) / std::mem::size_of::<RawFd>();
                for i in 0..count {
                    fds.push(OwnedFd::from_raw_fd(std::ptr::read_unaligned(data.add(i))));
                }
            }
            header = libc::CMSG_NXTHDR(&message, header);
        }
    }
    if message.msg_flags & libc::MSG_CTRUNC != 0 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "too many fds passed"));
    }
    Ok((result as usize, fds))
}

/// Wait until `fd` is readable (or hung up): false if `timeout` passed first. Returns early (true) when interrupted by
/// a signal, so callers check their flags.
pub fn poll_readable(fd: RawFd, timeout: Duration) -> io::Result<bool> {
    let mut entry = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
    let millis = timeout.as_millis().min(i32::MAX as u128) as libc::c_int;
    let result = unsafe { libc::poll(&mut entry, 1, millis) };
    if result < 0 {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            return Ok(false);
        }
        return Err(error);
    }
    Ok(result > 0)
}

/// A connected pair of Unix stream sockets (close-on-exec).
pub fn socket_pair() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0 as RawFd; 2];
    check(unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0, fds.as_mut_ptr()) })?;
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

/// Take an exclusive flock on the file (waiting for it); released when the file is closed.
pub fn lock_exclusive(file: &File) -> io::Result<()> {
    loop {
        match check(unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) }) {
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            other => return other.map(|_| ()),
        }
    }
}

/// A duplicate of `fd` numbered at least `minimum`, close-on-exec.
pub fn duplicate_above(fd: RawFd, minimum: RawFd) -> io::Result<OwnedFd> {
    let new = check(unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, minimum) })?;
    Ok(unsafe { OwnedFd::from_raw_fd(new) })
}

/// Who a started process runs as (see `become_user`). Prepared before forking: the child only makes system calls.
#[derive(Clone, Debug)]
pub struct Credentials {
    pub uid: libc::uid_t,
    pub gid: libc::gid_t,
    /// the supplementary groups (`group_list`)
    pub groups: Vec<libc::gid_t>,
    /// the working directory to change to as that user ("/" if it can't)
    pub dir: CString,
}

impl Credentials {
    /// A user's credentials: their groups from the group database, their home directory.
    pub fn of(user: &User) -> io::Result<Credentials> {
        Ok(Credentials {
            uid: user.uid,
            gid: user.gid,
            groups: group_list(&user.name, user.gid)?,
            dir: CString::new(user.home.clone()).unwrap_or_else(|_| c"/".to_owned()),
        })
    }
}

/// For `pre_exec` (async-signal-safe): drop from root to `credentials` (groups, then gid, then uid), verify that root
/// can't be regained, and change to its directory. Never returns Ok with privileges left.
pub fn become_user(credentials: &Credentials) -> io::Result<()> {
    let Credentials { uid, gid, groups, dir } = credentials;
    check(unsafe { libc::setgroups(groups.len(), groups.as_ptr()) })?;
    check(unsafe { libc::setgid(*gid) })?;
    check(unsafe { libc::setuid(*uid) })?;
    // never continue with privileges that were supposed to be dropped
    let regained = *uid != 0 && unsafe { libc::setuid(0) } == 0;
    let ids_wrong = unsafe { libc::getuid() != *uid || libc::geteuid() != *uid || libc::getgid() != *gid || libc::getegid() != *gid };
    if regained || ids_wrong {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "privileges were not dropped"));
    }
    if unsafe { libc::chdir(dir.as_ptr()) } != 0 {
        check(unsafe { libc::chdir(c"/".as_ptr()) })?;
    }
    Ok(())
}

/// For `pre_exec` (async-signal-safe): put each source fd at its target number (without close-on-exec), become
/// `credentials` (if any), and have `parent_death_signal` sent to the child when its parent dies (unless the parent
/// `expected_parent` is gone already). The parent death signal is set last: changing credentials clears it.
pub fn child_setup(
    fds: &[(RawFd, RawFd)],
    credentials: Option<&Credentials>,
    parent_death_signal: Option<libc::c_int>,
    expected_parent: libc::pid_t,
) -> io::Result<()> {
    for &(source, target) in fds {
        check(unsafe { libc::dup2(source, target) })?;
    }
    if let Some(credentials) = credentials {
        become_user(credentials)?;
    }
    if let Some(signal) = parent_death_signal {
        check(unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, signal as libc::c_ulong, 0, 0, 0) })?;
        if unsafe { libc::getppid() } != expected_parent {
            return Err(io::Error::new(io::ErrorKind::Other, "parent exited"));
        }
    }
    Ok(())
}

#[repr(C)]
struct CapabilityHeader {
    version: u32,
    pid: libc::c_int,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CapabilityData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

/// _LINUX_CAPABILITY_VERSION_3: two CapabilityData (capabilities 0–31 and 32–63)
const CAPABILITY_VERSION_3: u32 = 0x2008_0522;

/// For `pre_exec` (async-signal-safe), for a process that must never hold or pass on a capability (the web front):
/// clear the inheritable and ambient capability sets and set no_new_privs, so nothing it execs can gain privileges
/// (setuid programs, file capabilities). A drop from root to another user (`become_user`) already clears the
/// permitted, effective and ambient sets, but not the inheritable one; a helper started without root normally has
/// none of them, and this changes nothing then.
pub fn drop_capabilities_for_good() -> io::Result<()> {
    let mut header = CapabilityHeader { version: CAPABILITY_VERSION_3, pid: 0 };
    let mut data = [CapabilityData::default(); 2];
    check(unsafe { libc::syscall(libc::SYS_capget, &mut header, data.as_mut_ptr()) } as libc::c_int)?;
    if data.iter().any(|set| set.inheritable != 0) {
        for set in &mut data {
            set.inheritable = 0;
        }
        check(unsafe { libc::syscall(libc::SYS_capset, &mut header, data.as_ptr()) } as libc::c_int)?;
    }
    // (EINVAL: a kernel before 4.3, without ambient capabilities)
    let cleared = unsafe { libc::prctl(libc::PR_CAP_AMBIENT, libc::PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) };
    if cleared < 0 && io::Error::last_os_error().raw_os_error() != Some(libc::EINVAL) {
        return Err(io::Error::last_os_error());
    }
    check(unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) }).map(|_| ())
}

/// Have `signal` sent to this process when its parent dies (fails if the parent `expected_parent` is gone already).
pub fn set_parent_death_signal(signal: libc::c_int, expected_parent: libc::pid_t) -> io::Result<()> {
    child_setup(&[], None, Some(signal), expected_parent)
}

/// The uid of the process at the other end of a connected Unix socket (SO_PEERCRED).
pub fn peer_uid(socket: RawFd) -> io::Result<libc::uid_t> {
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    check(unsafe {
        libc::getsockopt(
            socket,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut credentials as *mut libc::ucred as *mut libc::c_void,
            &mut length,
        )
    })?;
    Ok(credentials.uid)
}

/// A user's groups (the primary `gid` and the supplementary ones), from the group database.
pub fn group_list(name: &str, gid: libc::gid_t) -> io::Result<Vec<libc::gid_t>> {
    let name = CString::new(name).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid user name"))?;
    let mut groups: Vec<libc::gid_t> = vec![0; 64];
    loop {
        let mut count = groups.len() as libc::c_int;
        let result = unsafe { libc::getgrouplist(name.as_ptr(), gid, groups.as_mut_ptr(), &mut count) };
        if result >= 0 {
            groups.truncate(count.max(0) as usize);
            return Ok(groups);
        }
        // too small: count is how many there are
        if groups.len() >= 65536 {
            return Err(io::Error::new(io::ErrorKind::Other, "too many groups"));
        }
        groups.resize((count as usize).max(groups.len() * 2), 0);
    }
}

/// alarm(2): SIGALRM (by default ending the process) after `seconds`; 0 cancels.
pub fn alarm(seconds: u32) {
    unsafe {
        libc::alarm(seconds);
    }
}

/// Take over a listening TCP socket that systemd (socket activation) passed as `fd`. The descriptor is checked
/// (a stream socket that is listening) and marked close-on-exec; it is owned by the returned listener from then on.
pub fn adopt_tcp_listener(fd: RawFd) -> io::Result<std::net::TcpListener> {
    fn option(fd: RawFd, name: libc::c_int) -> io::Result<libc::c_int> {
        let mut value: libc::c_int = 0;
        let mut length = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
        check(unsafe {
            libc::getsockopt(fd, libc::SOL_SOCKET, name, (&mut value as *mut libc::c_int).cast(), &mut length)
        })?;
        Ok(value)
    }
    let not_usable = |what: &str| io::Error::other(format!("descriptor {fd} is not {what}"));
    if option(fd, libc::SO_TYPE)? != libc::SOCK_STREAM {
        return Err(not_usable("a stream socket"));
    }
    if option(fd, libc::SO_ACCEPTCONN)? == 0 {
        return Err(not_usable("a listening socket"));
    }
    let mut domain: libc::sockaddr_storage = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of::<libc::sockaddr_storage>() as libc::socklen_t;
    check(unsafe { libc::getsockname(fd, (&mut domain as *mut libc::sockaddr_storage).cast(), &mut length) })?;
    if domain.ss_family != libc::AF_INET as libc::sa_family_t && domain.ss_family != libc::AF_INET6 as libc::sa_family_t
    {
        return Err(not_usable("a TCP socket"));
    }
    check(unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) })?;
    // SAFETY: the descriptor was passed to us for this purpose and nothing else in the process owns it.
    Ok(unsafe { std::net::TcpListener::from_raw_fd(fd) })
}

pub fn getpid() -> libc::pid_t {
    unsafe { libc::getpid() }
}

pub fn getuid() -> libc::uid_t {
    unsafe { libc::getuid() }
}

pub fn geteuid() -> libc::uid_t {
    unsafe { libc::geteuid() }
}

pub enum Forked {
    Parent(libc::pid_t),
    Child,
}

/// fork(2). Only call it while the process has a single thread.
pub fn fork() -> io::Result<Forked> {
    let pid = check(unsafe { libc::fork() })?;
    Ok(if pid == 0 { Forked::Child } else { Forked::Parent(pid) })
}

pub fn kill(pid: libc::pid_t, signal: libc::c_int) {
    unsafe {
        libc::kill(pid, signal);
    }
}

/// The exit of one child: Some((pid, status)) if one exited, None if `block` is false and none did, or if a signal
/// interrupted the wait. Err(ECHILD) when there are no children.
pub fn wait_child(pid: libc::pid_t, block: bool) -> io::Result<Option<(libc::pid_t, libc::c_int)>> {
    let mut status = 0;
    let result = unsafe { libc::waitpid(pid, &mut status, if block { 0 } else { libc::WNOHANG }) };
    if result < 0 {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            return Ok(None);
        }
        return Err(error);
    }
    Ok(if result == 0 { None } else { Some((result, status)) })
}

/// How a child ended, for the log: "exit 0", "signal 15".
pub fn describe_status(status: libc::c_int) -> String {
    if libc::WIFEXITED(status) {
        format!("exit {}", libc::WEXITSTATUS(status))
    } else if libc::WIFSIGNALED(status) {
        format!("signal {}", libc::WTERMSIG(status))
    } else {
        format!("status {status}")
    }
}

static TERMINATE: AtomicBool = AtomicBool::new(false);

extern "C" fn on_terminate(_signal: libc::c_int) {
    TERMINATE.store(true, Ordering::SeqCst);
}

/// SIGTERM and SIGINT set a flag (see `terminate_requested`) and interrupt blocking calls (no SA_RESTART).
pub fn catch_terminate() -> io::Result<()> {
    for signal in [libc::SIGTERM, libc::SIGINT] {
        let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
        action.sa_sigaction = on_terminate as usize;
        action.sa_flags = 0;
        unsafe { libc::sigemptyset(&mut action.sa_mask) };
        check(unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) })?;
    }
    Ok(())
}

/// SIGTERM and SIGINT back to their default (a forked child that isn't ready to handle them).
pub fn default_terminate() {
    unsafe {
        libc::signal(libc::SIGTERM, libc::SIG_DFL);
        libc::signal(libc::SIGINT, libc::SIG_DFL);
    }
    TERMINATE.store(false, Ordering::SeqCst);
}

pub fn terminate_requested() -> bool {
    TERMINATE.load(Ordering::SeqCst)
}

/// A user from the passwd database.
#[derive(Clone, Debug)]
pub struct User {
    pub name: String,
    pub uid: libc::uid_t,
    pub gid: libc::gid_t,
    pub home: String,
    pub shell: String,
}

fn user_from(entry: &libc::passwd) -> User {
    let text = |pointer: *const libc::c_char| {
        if pointer.is_null() {
            String::new()
        } else {
            unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned()
        }
    };
    User { name: text(entry.pw_name), uid: entry.pw_uid, gid: entry.pw_gid, home: text(entry.pw_dir), shell: text(entry.pw_shell) }
}

/// The passwd entry of a uid.
pub fn user_by_uid(uid: libc::uid_t) -> io::Result<User> {
    lookup(|entry, buffer, result| unsafe {
        libc::getpwuid_r(uid, entry, buffer.as_mut_ptr(), buffer.len(), result)
    })
}

/// The passwd entry of a user name.
pub fn user_by_name(name: &str) -> io::Result<User> {
    let name = CString::new(name).map_err(|_| io::Error::new(io::ErrorKind::NotFound, "no such user"))?;
    lookup(|entry, buffer, result| unsafe {
        libc::getpwnam_r(name.as_ptr(), entry, buffer.as_mut_ptr(), buffer.len(), result)
    })
}

fn lookup(
    call: impl Fn(&mut libc::passwd, &mut Vec<libc::c_char>, &mut *mut libc::passwd) -> libc::c_int,
) -> io::Result<User> {
    let mut buffer: Vec<libc::c_char> = vec![0; 4096];
    loop {
        let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        let error = call(&mut entry, &mut buffer, &mut result);
        if error == libc::ERANGE && buffer.len() < 1 << 20 {
            buffer.resize(buffer.len() * 2, 0);
            continue;
        }
        if error != 0 {
            return Err(io::Error::from_raw_os_error(error));
        }
        if result.is_null() {
            return Err(io::Error::new(io::ErrorKind::NotFound, "no such user"));
        }
        return Ok(user_from(&entry));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adopts_only_listening_tcp_sockets() {
        let original = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = original.local_addr().unwrap();
        let fd = std::os::fd::IntoRawFd::into_raw_fd(duplicate_above(original.as_raw_fd(), 10).unwrap());
        let adopted = adopt_tcp_listener(fd).unwrap(); // owns it now
        assert_eq!(adopted.local_addr().unwrap(), address);
        assert!(std::net::TcpStream::connect(address).is_ok());

        let (a, _b) = socket_pair().unwrap();
        assert!(adopt_tcp_listener(a.as_raw_fd()).is_err()); // a Unix socket, not listening
        let plain = std::net::UdpSocket::bind(("127.0.0.1", 0)).unwrap();
        assert!(adopt_tcp_listener(plain.as_raw_fd()).is_err());
    }

    #[test]
    fn peer_uid_of_a_socket_pair() {
        let (a, _b) = socket_pair().unwrap();
        assert_eq!(peer_uid(a.as_raw_fd()).unwrap(), getuid());
    }

    #[test]
    fn groups_include_the_primary_group() {
        let user = user_by_uid(getuid()).unwrap();
        assert!(group_list(&user.name, user.gid).unwrap().contains(&user.gid));
    }
}
