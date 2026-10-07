//! A connection that carries login records (see nebula-login-protocol), with the fds some of them carry.
use nebula_login_protocol::{decode, Record, MAX_RECORD};
use std::collections::VecDeque;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use crate::sys;

pub struct Channel {
    stream: UnixStream,
    buffer: Vec<u8>,
    fds: VecDeque<OwnedFd>,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

impl Channel {
    pub fn new(stream: UnixStream) -> Channel {
        Channel { stream, buffer: Vec::with_capacity(MAX_RECORD), fds: VecDeque::new() }
    }

    /// The next record, with its fd if it is a kind that carries one. Fails on a malformed record, a record without
    /// its fd, EOF, or when `timeout` passes first (TimedOut).
    pub fn read(&mut self, timeout: Duration) -> io::Result<(Record, Option<OwnedFd>)> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some((record, used)) = decode(&self.buffer).map_err(|e| invalid(e.to_string()))? {
                self.buffer.drain(..used);
                let fd = if record.carries_fd() {
                    Some(self.fds.pop_front().ok_or_else(|| invalid("a record without its fd"))?)
                } else {
                    None
                };
                return Ok((record, fd));
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "timed out waiting for a record"));
            }
            if !sys::poll_readable(self.stream.as_raw_fd(), deadline - now)? {
                continue;
            }
            // never more than the rest of one record: the buffer stays within MAX_RECORD
            let mut chunk = [0u8; MAX_RECORD];
            let room = MAX_RECORD - self.buffer.len();
            let (count, fds) = match sys::recv_with_fds(self.stream.as_raw_fd(), &mut chunk[..room]) {
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => continue,
                other => other?,
            };
            self.fds.extend(fds);
            if self.fds.len() > 1 {
                return Err(invalid("too many fds"));
            }
            if count == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed"));
            }
            self.buffer.extend_from_slice(&chunk[..count]);
        }
    }

    /// Send a record, with `fd` if it is a kind that carries one.
    pub fn write(&mut self, record: &Record, fd: Option<RawFd>) -> io::Result<()> {
        if record.carries_fd() != fd.is_some() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "fd doesn't match the record kind"));
        }
        let bytes = record.encode().map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
        sys::send_with_fd(self.stream.as_raw_fd(), &bytes, fd)
    }
}
