//! The system calls the web front needs beyond nebula_login_common::sys: sealed memfds and read-only mappings of them,
//! polling many fds, packet socket pairs, socket tuning, not being dumpable. Everything unsafe in this crate is in
//! this module.
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
/// newer frames can still overtake older ones (see ViewerTransport in compositor-proxy).
pub fn tune_tcp(fd: RawFd, not_sent_low_water: libc::c_int) -> io::Result<()> {
    set_int_option(fd, libc::IPPROTO_TCP, libc::TCP_NODELAY, 1)?;
    set_int_option(fd, libc::IPPROTO_TCP, libc::TCP_NOTSENT_LOWAT, not_sent_low_water)
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

    #[test]
    fn unsealed_memfds_are_refused() {
        let fd = check(unsafe { libc::memfd_create(c"test".as_ptr(), libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING) })
            .unwrap();
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        assert!(Mapping::sealed(fd.as_raw_fd()).is_err());
    }
}
