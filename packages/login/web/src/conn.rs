//! A TLS connection on the worker's non-blocking TCP socket: rustls driven by hand, with a deadline on every wait, so
//! the worker can also relay without threads (see the worker's `relay`).
use rustls::ServerConnection;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::os::fd::{AsRawFd, RawFd};
use std::sync::Arc;
use std::time::Instant;

use crate::sys;

pub struct Tls {
    pub tcp: TcpStream,
    pub conn: ServerConnection,
    /// plaintext received and not consumed yet
    pub received: Vec<u8>,
    /// the browser closed its side (TCP EOF or close_notify)
    pub eof: bool,
}

pub fn timed_out() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "timed out")
}

/// Wait until `fd` has one of `events`, or the deadline passes (TimedOut).
pub fn wait(fd: RawFd, events: libc::c_short, deadline: Instant) -> io::Result<()> {
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(timed_out());
        }
        let mut entry = [libc::pollfd { fd, events, revents: 0 }];
        if sys::poll(&mut entry, Some(deadline - now))? > 0 {
            return Ok(());
        }
    }
}

impl Tls {
    pub fn new(tcp: TcpStream, config: Arc<rustls::ServerConfig>) -> io::Result<Tls> {
        tcp.set_nonblocking(true)?;
        let mut conn = ServerConnection::new(config).map_err(io::Error::other)?;
        // the relay limits what it buffers itself (it only reads from the desktop when this is empty)
        conn.set_buffer_limit(None);
        Ok(Tls { tcp, conn, received: Vec::new(), eof: false })
    }

    pub fn fd(&self) -> RawFd {
        self.tcp.as_raw_fd()
    }

    /// Write what TLS has to send until the socket is full (non-blocking).
    pub fn flush_some(&mut self) -> io::Result<()> {
        while self.conn.wants_write() {
            match self.conn.write_tls(&mut self.tcp) {
                Ok(_) => {}
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(()),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    /// Write everything TLS has to send, waiting for room until `deadline`.
    pub fn flush(&mut self, deadline: Instant) -> io::Result<()> {
        loop {
            self.flush_some()?;
            if !self.conn.wants_write() {
                return Ok(());
            }
            wait(self.fd(), libc::POLLOUT, deadline)?;
        }
    }

    /// Send `bytes` (as plaintext), waiting for room until `deadline`.
    pub fn write_all(&mut self, bytes: &[u8], deadline: Instant) -> io::Result<()> {
        self.conn.writer().write_all(bytes)?;
        self.flush(deadline)
    }

    /// Read what has arrived (non-blocking) into `received`, as long as it holds less than `limit` bytes; whether
    /// anything new came (data or EOF). Answers what TLS has to answer (the handshake, alerts) on the way.
    pub fn read_available(&mut self, limit: usize) -> io::Result<bool> {
        let mut progress = false;
        let mut chunk = [0u8; 16 * 1024];
        loop {
            while self.received.len() < limit {
                let room = (limit - self.received.len()).min(chunk.len());
                match self.conn.reader().read(&mut chunk[..room]) {
                    Ok(0) => {
                        // close_notify
                        progress |= !self.eof;
                        self.eof = true;
                        break;
                    }
                    Ok(n) => {
                        self.received.extend_from_slice(&chunk[..n]);
                        progress = true;
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                    // the TCP connection closed without close_notify
                    Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => {
                        progress |= !self.eof;
                        self.eof = true;
                        break;
                    }
                    Err(e) => return Err(e),
                }
            }
            if self.eof || self.received.len() >= limit || !self.conn.wants_read() {
                break;
            }
            match self.conn.read_tls(&mut self.tcp) {
                // nothing more will come: the reader reports EOF once what rustls holds is read
                Ok(0) => self.process()?,
                Ok(_) => self.process()?,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        self.flush_some()?;
        Ok(progress)
    }

    fn process(&mut self) -> io::Result<()> {
        if let Err(e) = self.conn.process_new_packets() {
            // (try to tell the browser why: the alert is queued)
            let _ = self.flush_some();
            return Err(io::Error::new(io::ErrorKind::InvalidData, e));
        }
        Ok(())
    }

    /// Wait until `received` has grown (or the browser closed: UnexpectedEof), up to `limit` bytes, until `deadline`.
    pub fn fill(&mut self, limit: usize, deadline: Instant) -> io::Result<()> {
        loop {
            let before = self.received.len();
            if self.eof {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed"));
            }
            if self.read_available(limit)? && self.received.len() > before {
                return Ok(());
            }
            if self.eof {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed"));
            }
            if self.received.len() >= limit {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "too much data"));
            }
            self.flush(deadline)?;
            wait(self.fd(), libc::POLLIN, deadline)?;
        }
    }

    /// Complete the TLS handshake by `deadline`.
    pub fn handshake(&mut self, deadline: Instant) -> io::Result<()> {
        while self.conn.is_handshaking() {
            self.flush(deadline)?;
            if !self.conn.is_handshaking() {
                break;
            }
            if self.eof {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed"));
            }
            if !self.read_available(crate::http::MAX_HEAD)? && self.conn.is_handshaking() {
                wait(self.fd(), libc::POLLIN, deadline)?;
            }
        }
        self.flush(deadline)
    }

    /// End TLS cleanly (close_notify), waiting for it to be sent until `deadline`; errors don't matter any more.
    pub fn close(&mut self, deadline: Instant) {
        self.conn.send_close_notify();
        let _ = self.flush(deadline);
        let _ = self.tcp.shutdown(std::net::Shutdown::Write);
    }
}
