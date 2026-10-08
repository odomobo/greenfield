//! Waiting for the login helper's next record while watching the browser's connection too.
use nebula_login_common::channel::Channel;
use nebula_login_protocol::Record;
use std::io;
use std::os::fd::{OwnedFd, RawFd};
use std::time::{Duration, Instant};

use crate::sys;

pub enum Next {
    /// the helper's next record (with its fd, if it carries one)
    Record(Record, Option<OwnedFd>),
    /// `other` became readable first (or hung up)
    Other,
}

/// The helper's next record on `channel` (whose socket is `helper_fd`), or `Other` if `other` (if any) becomes
/// readable first. Records the channel has buffered already come first: one read from the socket may bring several
/// (an error, an info and a prompt), and the socket isn't readable for those any more.
pub fn next_record(
    channel: &mut Channel,
    helper_fd: RawFd,
    other: Option<RawFd>,
    deadline: Instant,
) -> io::Result<Next> {
    loop {
        // (a zero timeout: only what is buffered, without reading the socket)
        match channel.read(Duration::ZERO) {
            Ok((record, fd)) => return Ok(Next::Record(record, fd)),
            Err(e) if e.kind() == io::ErrorKind::TimedOut => {}
            Err(e) => return Err(e),
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "timed out waiting for the login helper"));
        }
        let mut fds = [
            libc::pollfd { fd: helper_fd, events: libc::POLLIN, revents: 0 },
            libc::pollfd { fd: other.unwrap_or(-1), events: libc::POLLIN, revents: 0 },
        ];
        if sys::poll(&mut fds, Some(deadline - now))? == 0 {
            continue;
        }
        if fds[1].revents != 0 {
            return Ok(Next::Other);
        }
        if fds[0].revents != 0 {
            let (record, fd) = channel.read(deadline.saturating_duration_since(Instant::now()))?;
            return Ok(Next::Record(record, fd));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nebula_login_protocol::PromptStyle;
    use std::io::Write;
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;

    fn prompt(style: PromptStyle, text: &str) -> Record {
        Record::Prompt { style, text: text.into() }
    }

    /// pam_unix's password change: an error, an info and a prompt, sent at once (one read brings all three).
    #[test]
    fn records_that_came_together_are_delivered_without_waiting() {
        let (ours, mut helper) = UnixStream::pair().unwrap();
        let helper_fd = ours.as_raw_fd();
        let mut channel = Channel::new(ours);
        let records = [
            prompt(
                PromptStyle::Error,
                "You are required to change your password immediately (administrator enforced).",
            ),
            prompt(PromptStyle::Info, "Changing password for josh."),
            prompt(PromptStyle::EchoOff, "Current password: "),
        ];
        let bytes: Vec<u8> = records.iter().flat_map(|record| record.encode().unwrap()).collect();
        helper.write_all(&bytes).unwrap();
        let started = Instant::now();
        for expected in &records {
            match next_record(&mut channel, helper_fd, None, Instant::now() + Duration::from_secs(5)).unwrap() {
                Next::Record(record, None) => assert_eq!(&record, expected),
                _ => panic!("expected {expected:?}"),
            }
        }
        assert!(started.elapsed() < Duration::from_secs(1), "waited for records that were there");
        // nothing more: the deadline
        let error = next_record(&mut channel, helper_fd, None, Instant::now() + Duration::from_millis(20));
        assert!(matches!(error, Err(e) if e.kind() == io::ErrorKind::TimedOut));
    }

    #[test]
    fn the_other_side_becoming_readable_ends_the_wait() {
        let (ours, _helper) = UnixStream::pair().unwrap();
        let helper_fd = ours.as_raw_fd();
        let mut channel = Channel::new(ours);
        let (browser, mut peer) = UnixStream::pair().unwrap();
        peer.write_all(b"x").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let next = next_record(&mut channel, helper_fd, Some(browser.as_raw_fd()), deadline);
        assert!(matches!(next, Ok(Next::Other)));
    }
}
