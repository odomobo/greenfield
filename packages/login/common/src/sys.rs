//! The system calls std doesn't wrap: fd passing, socket pairs, flock, poll, signals, fork and waitpid, the passwd
//! database. Everything unsafe in the helpers is in this module.
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

/// For `pre_exec` (async-signal-safe): put each source fd at its target number (without close-on-exec), and have
/// `parent_death_signal` sent to the child when its parent dies (unless the parent `expected_parent` is gone already).
pub fn child_setup(fds: &[(RawFd, RawFd)], parent_death_signal: Option<libc::c_int>, expected_parent: libc::pid_t) -> io::Result<()> {
    for &(source, target) in fds {
        check(unsafe { libc::dup2(source, target) })?;
    }
    if let Some(signal) = parent_death_signal {
        check(unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, signal as libc::c_ulong, 0, 0, 0) })?;
        if unsafe { libc::getppid() } != expected_parent {
            return Err(io::Error::new(io::ErrorKind::Other, "parent exited"));
        }
    }
    Ok(())
}

/// Have `signal` sent to this process when its parent dies (fails if the parent `expected_parent` is gone already).
pub fn set_parent_death_signal(signal: libc::c_int, expected_parent: libc::pid_t) -> io::Result<()> {
    child_setup(&[], Some(signal), expected_parent)
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
}

fn user_from(entry: &libc::passwd) -> User {
    let text = |pointer: *const libc::c_char| {
        if pointer.is_null() {
            String::new()
        } else {
            unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned()
        }
    };
    User { name: text(entry.pw_name), uid: entry.pw_uid, gid: entry.pw_gid, home: text(entry.pw_dir) }
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
