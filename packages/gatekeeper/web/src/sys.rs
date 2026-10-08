//! The system calls the web front needs beyond nebula_login_common::sys: sealed memfds and read-only mappings of them,
//! polling many fds, packet socket pairs, socket tuning, not being dumpable, the worker's sandbox (no_new_privs,
//! rlimits, installing a seccomp filter; the filter itself is built in sandbox.rs). Everything unsafe in this crate is
//! in this module.
use std::ffi::CStr;
use std::io::{self, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::time::Duration;

fn check(result: libc::c_int) -> io::Result<libc::c_int> {
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result)
    }
}

/// The seals a page or TLS memfd has before it is handed to a worker: nobody can change, shrink or grow it, nor the
/// seals.
const SEALS: libc::c_int = libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE;

/// A memfd holding `bytes`, sealed read-only (close-on-exec).
pub fn sealed_memfd(name: &CStr, bytes: &[u8]) -> io::Result<OwnedFd> {
    let fd = check(unsafe { libc::memfd_create(name.as_ptr(), libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING) })?;
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let mut file = std::fs::File::from(fd);
    file.write_all(bytes)?;
    check(unsafe { libc::fcntl(file.as_raw_fd(), libc::F_ADD_SEALS, SEALS) })?;
    Ok(OwnedFd::from(file))
}

/// A read-only mapping of a whole sealed memfd (see `sealed_memfd`).
pub struct Mapping {
    address: *mut libc::c_void,
    length: usize,
}

impl Mapping {
    /// Map `fd`, which must be a memfd with all of `sealed_memfd`'s seals (so it can't change or shrink under us).
    pub fn sealed(fd: RawFd) -> io::Result<Mapping> {
        let seals = check(unsafe { libc::fcntl(fd, libc::F_GET_SEALS) })?;
        if seals & SEALS != SEALS {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "the memfd is not sealed"));
        }
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        check(unsafe { libc::fstat(fd, &mut stat) })?;
        let length = stat.st_size as usize;
        if length == 0 {
            return Ok(Mapping { address: std::ptr::null_mut(), length: 0 });
        }
        let address = unsafe { libc::mmap(std::ptr::null_mut(), length, libc::PROT_READ, libc::MAP_SHARED, fd, 0) };
        if address == libc::MAP_FAILED {
            return Err(io::Error::last_os_error());
        }
        Ok(Mapping { address, length })
    }

    pub fn bytes(&self) -> &[u8] {
        if self.length == 0 {
            return &[];
        }
        unsafe { std::slice::from_raw_parts(self.address as *const u8, self.length) }
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        if self.length > 0 {
            unsafe { libc::munmap(self.address, self.length) };
        }
    }
}

/// Mark this process not dumpable (PR_SET_DUMPABLE 0): no core dumps, and other processes of the same user can't
/// ptrace it or read its /proc files (memory, environment, fds). An exec resets it, so each worker does it itself.
pub fn set_not_dumpable() -> io::Result<()> {
    check(unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) }).map(|_| ())
}

pub fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    let flags = check(unsafe { libc::fcntl(fd, libc::F_GETFL) })?;
    check(unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) }).map(|_| ())
}

pub fn set_cloexec(fd: RawFd) -> io::Result<()> {
    let flags = check(unsafe { libc::fcntl(fd, libc::F_GETFD) })?;
    check(unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) }).map(|_| ())
}

/// A connected pair of Unix SOCK_SEQPACKET sockets (close-on-exec): each write arrives as one packet.
pub fn seqpacket_pair() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0 as RawFd; 2];
    check(unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC, 0, fds.as_mut_ptr()) })?;
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

/// Whether `fd` is open.
pub fn is_open(fd: RawFd) -> bool {
    unsafe { libc::fcntl(fd, libc::F_GETFD) >= 0 }
}

fn set_int_option(fd: RawFd, level: libc::c_int, name: libc::c_int, value: libc::c_int) -> io::Result<()> {
    check(unsafe {
        libc::setsockopt(
            fd,
            level,
            name,
            &value as *const libc::c_int as *const libc::c_void,
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        )
    })
    .map(|_| ())
}

/// Tune the browser's TCP connection: no Nagle delay, and at most `not_sent_low_water` bytes unsent in the kernel
/// before it reports the socket writable (TCP_NOTSENT_LOWAT): the session keeps the rest in its priority queue, where
/// newer frames can still overtake older ones (see ViewerTransport in session).
pub fn tune_tcp(fd: RawFd, not_sent_low_water: libc::c_int) -> io::Result<()> {
    set_int_option(fd, libc::IPPROTO_TCP, libc::TCP_NODELAY, 1)?;
    set_int_option(fd, libc::IPPROTO_TCP, libc::TCP_NOTSENT_LOWAT, not_sent_low_water)
}

/// Notice a browser that is gone without closing its connection (a dropped network, a suspended laptop) even when
/// nothing is being sent: TCP keepalive probes after `idle`, every `interval`, and the connection fails once data or
/// probes go unacknowledged for `give_up` (TCP_USER_TIMEOUT). Then the worker's next read, write or poll fails.
pub fn tcp_keep_alive(fd: RawFd, idle: Duration, interval: Duration, give_up: Duration) -> io::Result<()> {
    let seconds = |duration: Duration| duration.as_secs().clamp(1, i32::MAX as u64) as libc::c_int;
    set_int_option(fd, libc::SOL_SOCKET, libc::SO_KEEPALIVE, 1)?;
    set_int_option(fd, libc::IPPROTO_TCP, libc::TCP_KEEPIDLE, seconds(idle))?;
    set_int_option(fd, libc::IPPROTO_TCP, libc::TCP_KEEPINTVL, seconds(interval))?;
    let give_up = give_up.as_millis().min(i32::MAX as u128) as libc::c_int;
    set_int_option(fd, libc::IPPROTO_TCP, libc::TCP_USER_TIMEOUT, give_up)
}

/// poll(2) on `fds`: how many have events. `None` waits forever. Interrupted by a signal: Ok(0).
pub fn poll(fds: &mut [libc::pollfd], timeout: Option<Duration>) -> io::Result<usize> {
    let millis = match timeout {
        None => -1,
        // (rounded up: a deadline isn't reported as reached before it is)
        Some(timeout) => timeout.as_micros().div_ceil(1000).min(i32::MAX as u128) as libc::c_int,
    };
    let result = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, millis) };
    if result < 0 {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            return Ok(0);
        }
        return Err(error);
    }
    Ok(result as usize)
}

/// Fill `buffer` with random bytes from the kernel.
pub fn random_bytes(buffer: &mut [u8]) -> io::Result<()> {
    let mut filled = 0;
    while filled < buffer.len() {
        let rest = &mut buffer[filled..];
        let result = unsafe { libc::getrandom(rest.as_mut_ptr() as *mut libc::c_void, rest.len(), 0) };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        filled += result as usize;
    }
    Ok(())
}

/// Set no_new_privs: no exec can grant privileges any more (setuid bits, file capabilities), for this process and
/// everything it starts; a seccomp filter can then be installed without CAP_SYS_ADMIN. Can't be undone.
pub fn set_no_new_privs() -> io::Result<()> {
    check(unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) }).map(|_| ())
}

/// Set both the soft and the hard limit of `resource` to `value` (lowering the hard limit can't be undone without
/// CAP_SYS_RESOURCE).
pub fn set_limit(resource: libc::__rlimit_resource_t, value: u64) -> io::Result<()> {
    let limit = libc::rlimit { rlim_cur: value as libc::rlim_t, rlim_max: value as libc::rlim_t };
    check(unsafe { libc::setrlimit(resource, &limit) }).map(|_| ())
}

/// Install the seccomp-BPF filter `program` for this process (single-threaded: no TSYNC needed). Needs no_new_privs
/// (`set_no_new_privs`). Filters can't be removed, and every later one is applied too.
pub fn install_seccomp_filter(program: &[libc::sock_filter]) -> io::Result<()> {
    let length = libc::c_ushort::try_from(program.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "the filter is too long"))?;
    let program = libc::sock_fprog { len: length, filter: program.as_ptr() as *mut libc::sock_filter };
    let mode = libc::SECCOMP_MODE_FILTER as libc::c_ulong;
    check(unsafe { libc::prctl(libc::PR_SET_SECCOMP, mode, &program as *const libc::sock_fprog) }).map(|_| ())
}

/// This machine's host name.
pub fn hostname() -> String {
    let mut buffer = [0u8; 256];
    if unsafe { libc::gethostname(buffer.as_mut_ptr() as *mut libc::c_char, buffer.len()) } != 0 {
        return String::new();
    }
    let end = buffer.iter().position(|&b| b == 0).unwrap_or(buffer.len());
    String::from_utf8_lossy(&buffer[..end]).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_memfds_are_mapped_read_only() {
        let fd = sealed_memfd(c"test", b"hello").unwrap();
        let mapping = Mapping::sealed(fd.as_raw_fd()).unwrap();
        assert_eq!(mapping.bytes(), b"hello");
        // nobody can write to it any more
        let mut file = std::fs::File::from(fd.try_clone().unwrap());
        assert!(file.write_all(b"x").is_err());
        assert!(file.set_len(1).is_err());
    }

    /// How a forked child that entered the worker's sandbox and then ran `body` ended (its exit code is `body`'s
    /// result). The child makes only system calls: the test harness has other threads (malloc's lock may be held).
    fn sandboxed(body: fn() -> i32) -> libc::c_int {
        let program = crate::sandbox::filter(crate::sandbox::ALLOWED).unwrap();
        // (the address space limit as if the worker had mapped 1 TiB: the test process with its threads is larger)
        let limits = crate::sandbox::limits(1 << 40);
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            let code = if crate::sandbox::apply(&program, &limits).is_ok() { body() } else { 99 };
            unsafe { libc::_exit(code) };
        }
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
        status
    }

    fn anonymous_mapping(protection: libc::c_int) -> *mut libc::c_void {
        let flags = libc::MAP_PRIVATE | libc::MAP_ANONYMOUS;
        unsafe { libc::mmap(std::ptr::null_mut(), 4096, protection, flags, -1, 0) }
    }

    fn exited(status: libc::c_int) -> Option<libc::c_int> {
        libc::WIFEXITED(status).then(|| libc::WEXITSTATUS(status))
    }

    fn killed_by_the_filter(status: libc::c_int) -> bool {
        libc::WIFSIGNALED(status) && libc::WTERMSIG(status) == libc::SIGSYS
    }

    #[test]
    fn the_sandbox_allows_what_the_worker_does() {
        let status = sandboxed(|| {
            let mut random = [0u8; 16];
            let mut entry = libc::pollfd { fd: 1, events: libc::POLLOUT, revents: 0 };
            let ok = unsafe {
                libc::getrandom(random.as_mut_ptr().cast(), random.len(), 0) == 16
                    && libc::poll(&mut entry, 1, 0) >= 0
                    && libc::write(2, c"".as_ptr().cast(), 0) == 0
                    && libc::fcntl(1, libc::F_GETFL) >= 0
                    && anonymous_mapping(libc::PROT_READ | libc::PROT_WRITE) != libc::MAP_FAILED
            };
            if ok { 0 } else { 1 }
        });
        assert_eq!(exited(status), Some(0), "status {status}");
    }

    #[test]
    fn the_sandbox_kills_a_worker_that_opens_a_file() {
        assert!(killed_by_the_filter(sandboxed(|| unsafe { libc::open(c"/etc/hostname".as_ptr(), libc::O_RDONLY) })));
        assert!(killed_by_the_filter(sandboxed(|| unsafe {
            libc::syscall(libc::SYS_openat, libc::AT_FDCWD, c"/etc/hostname".as_ptr(), libc::O_RDONLY) as i32
        })));
    }

    #[test]
    fn the_sandbox_kills_a_worker_that_does_anything_else() {
        // a new socket, a process, executable memory, a duplicated fd, a call through the x32 ABI (x86_64)
        let forbidden: &[fn() -> i32] = &[
            || unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) },
            || unsafe { libc::syscall(libc::SYS_clone, libc::SIGCHLD, 0, 0, 0, 0) as i32 },
            || anonymous_mapping(libc::PROT_READ | libc::PROT_EXEC) as usize as i32,
            || unsafe { libc::fcntl(1, libc::F_DUPFD, 0) },
            #[cfg(target_arch = "x86_64")]
            || unsafe { libc::syscall(libc::SYS_getpid | 0x4000_0000) as i32 },
        ];
        for (i, &body) in forbidden.iter().enumerate() {
            let status = sandboxed(body);
            assert!(killed_by_the_filter(status), "forbidden call {i}: status {status}");
        }
    }

    #[test]
    fn unsealed_memfds_are_refused() {
        let fd = check(unsafe { libc::memfd_create(c"test".as_ptr(), libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING) })
            .unwrap();
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        assert!(Mapping::sealed(fd.as_raw_fd()).is_err());
    }
}
