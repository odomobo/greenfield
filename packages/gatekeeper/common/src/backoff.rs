//! Per-IP failure backoff (the sign-in design): a fixed-size table in the helper's main loop, fed by
//! fixed-size reports from its own sign-in children over their per-attempt pipes.
//!
//! - A sign-in child writes one `Report` {address, signed in or not} when its attempt is decided, before it tells the
//!   web process the outcome (so the page's next attempt finds the table up to date). Attempts refused by the table
//!   itself aren't reported: a block isn't extended by attempts made while it lasts.
//! - The main loop reads the reports (`drain`) before it forks the next child. The child decides with its own copy of
//!   the table, the one it was forked with (`Table::blocked`): no query back to the parent. The cost: attempts already
//!   forked when a block starts (at most the connections open at that time) still get through.
//! - A blocked attempt gets the normal failure: the same prompt, message and minimum time as a wrong password.
//!
//! The policy (`Policy`): `free_failures` failures from an address are free; each one from then on blocks it for
//! `base_block`, doubling with every further failure, at most `max_block`. An address with no failure for
//! `forget_after` (counted from the end of its block) is forgotten. A successful sign-in changes nothing: many users
//! may share an address, and an attacker with an account of their own must not be able to reset their count.
//! Addresses are counted by IPv4 address, and by /64 prefix for IPv6 (one host usually has a whole /64);
//! IPv4-mapped IPv6 addresses count as IPv4.
//!
//! Per-account lockout is not done here: that is PAM's job (pam_faillock, see packages/gatekeeper/README.md).
use crate::{log, sys};
use std::io::{self, PipeReader, Read};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::os::fd::AsRawFd;
use std::time::{Duration, Instant};

/// Entries in the table. When it is full, a new address replaces the least relevant entry (see `Table::slot_for`).
pub const CAPACITY: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Policy {
    pub free_failures: u32,
    pub base_block: Duration,
    pub max_block: Duration,
    pub forget_after: Duration,
}

impl Policy {
    /// The production policy (the dev helper divides the times by its time scale).
    pub const DEFAULT: Policy = Policy {
        free_failures: 10,
        base_block: Duration::from_secs(30),
        max_block: Duration::from_secs(15 * 60),
        forget_after: Duration::from_secs(15 * 60),
    };

    /// The same policy with every time divided by `scale` (the dev helper's --dev-time-scale).
    pub fn scaled(&self, scale: f64) -> Policy {
        Policy {
            free_failures: self.free_failures,
            base_block: self.base_block.div_f64(scale),
            max_block: self.max_block.div_f64(scale),
            forget_after: self.forget_after.div_f64(scale),
        }
    }

    /// How long the `failures`-th failure blocks for (none while they are free).
    fn block_for(&self, failures: u32) -> Option<Duration> {
        let beyond = failures.checked_sub(self.free_failures)?;
        // 2^beyond, without overflowing: anything past 2^20 is past every sensible maximum anyway
        let factor = 1u32 << beyond.min(20);
        Some(self.base_block.saturating_mul(factor).min(self.max_block))
    }
}

/// What a sign-in child tells the main loop when its attempt is decided. On the pipe: 18 bytes, u8 family (4 or 6),
/// u8 outcome (0 failed, 1 signed in), 16 bytes address (IPv4 in the first 4, the rest 0). Smaller than PIPE_BUF, so
/// a write is atomic.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Report {
    pub ip: IpAddr,
    pub ok: bool,
}

pub const REPORT_LEN: usize = 18;

impl Report {
    pub fn encode(&self) -> [u8; REPORT_LEN] {
        let mut bytes = [0u8; REPORT_LEN];
        bytes[1] = self.ok as u8;
        match self.ip {
            IpAddr::V4(v4) => {
                bytes[0] = 4;
                bytes[2..6].copy_from_slice(&v4.octets());
            }
            IpAddr::V6(v6) => {
                bytes[0] = 6;
                bytes[2..].copy_from_slice(&v6.octets());
            }
        }
        bytes
    }

    pub fn decode(bytes: &[u8; REPORT_LEN]) -> Option<Report> {
        let ok = match bytes[1] {
            0 => false,
            1 => true,
            _ => return None,
        };
        let ip = match bytes[0] {
            4 if bytes[6..].iter().all(|&b| b == 0) => IpAddr::V4(Ipv4Addr::new(bytes[2], bytes[3], bytes[4], bytes[5])),
            6 => IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(&bytes[2..]).ok()?)),
            _ => return None,
        };
        Some(Report { ip, ok })
    }
}

/// What the table counts an address as: IPv4 as is (also when IPv4-mapped), IPv6 by its /64.
pub fn key(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(_) => ip,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(Ipv6Addr::from(u128::from(v6) & !((1u128 << 64) - 1))),
        },
    }
}

#[derive(Clone, Copy, Debug)]
struct Entry {
    key: IpAddr,
    failures: u32,
    last_failure: Instant,
    blocked_until: Option<Instant>,
}

impl Entry {
    /// Forgotten: no failure for `forget_after` since the later of the last failure and the end of the block.
    fn stale(&self, policy: &Policy, now: Instant) -> bool {
        let quiet_since = self.blocked_until.map_or(self.last_failure, |until| until.max(self.last_failure));
        now.saturating_duration_since(quiet_since) >= policy.forget_after
    }

    fn blocked(&self, now: Instant) -> bool {
        self.blocked_until.is_some_and(|until| now < until)
    }
}

pub struct Table {
    policy: Policy,
    /// a fixed number of slots, allocated once
    entries: Box<[Option<Entry>]>,
}

impl Table {
    pub fn new(policy: Policy) -> Table {
        Table::with_capacity(policy, CAPACITY)
    }

    pub fn with_capacity(policy: Policy, capacity: usize) -> Table {
        Table { policy, entries: vec![None; capacity.max(1)].into_boxed_slice() }
    }

    fn find(&self, key: IpAddr, now: Instant) -> Option<&Entry> {
        self.entries.iter().flatten().find(|entry| entry.key == key && !entry.stale(&self.policy, now))
    }

    /// Whether sign-ins from `ip` are refused now.
    pub fn blocked(&self, ip: IpAddr, now: Instant) -> bool {
        self.find(key(ip), now).is_some_and(|entry| entry.blocked(now))
    }

    /// Count a report. Returns the block it started, if any (with the failures so far), for the log.
    pub fn report(&mut self, report: Report, now: Instant) -> Option<(Duration, u32)> {
        if report.ok {
            return None;
        }
        let key = key(report.ip);
        let policy = self.policy;
        let index = self.slot_for(key, now);
        let entry = match &mut self.entries[index] {
            Some(entry) if entry.key == key && !entry.stale(&policy, now) => entry,
            slot => slot.insert(Entry { key, failures: 0, last_failure: now, blocked_until: None }),
        };
        entry.failures = entry.failures.saturating_add(1);
        entry.last_failure = now;
        let block = policy.block_for(entry.failures)?;
        entry.blocked_until = Some(now + block);
        Some((block, entry.failures))
    }

    /// The slot for `key`: its own entry, else an empty or forgotten slot, else the least relevant entry: an unblocked
    /// one with the oldest last failure, or if all are blocked, the one whose block ends first.
    fn slot_for(&self, key: IpAddr, now: Instant) -> usize {
        let policy = &self.policy;
        let mut free = None;
        for (index, slot) in self.entries.iter().enumerate() {
            match slot {
                Some(entry) if entry.key == key && !entry.stale(policy, now) => return index,
                Some(entry) if !entry.stale(policy, now) => {}
                _ => free = free.or(Some(index)),
            }
        }
        if let Some(index) = free {
            return index;
        }
        let rank = |entry: &Entry| (entry.blocked(now), entry.blocked_until.unwrap_or(entry.last_failure).max(entry.last_failure));
        (0..self.entries.len())
            .min_by_key(|&index| self.entries[index].as_ref().map(rank))
            .unwrap_or(0)
    }
}

/// Read the reports waiting on a child's per-attempt pipe into `table`, without blocking, logging any block that
/// starts. Sets `pipe` to None once the child has closed it (its attempt is over), or on anything malformed.
pub fn drain(pipe: &mut Option<PipeReader>, table: &mut Table) {
    let Some(reader) = pipe else { return };
    loop {
        match sys::poll_readable(reader.as_raw_fd(), Duration::ZERO) {
            Ok(true) => {}
            Ok(false) => return,
            Err(_) => break,
        }
        // writes are atomic: readable means a whole report, or EOF
        let mut bytes = [0u8; REPORT_LEN];
        match reader.read_exact(&mut bytes) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
        let Some(report) = Report::decode(&bytes) else {
            log::error("A sign-in child sent a malformed report.");
            break;
        };
        if let Some((block, failures)) = table.report(report, Instant::now()) {
            // fail2ban can match this line too (packages/gatekeeper/README.md)
            log::warn(&format!(
                "Blocking sign-ins from {} for {} s after {failures} failed attempts.",
                key(report.ip),
                block.as_secs_f64().ceil()
            ));
        }
    }
    *pipe = None;
}

/// The child's side: send its report on the per-attempt pipe (one atomic write).
pub fn send(pipe: &mut impl io::Write, report: Report) -> io::Result<()> {
    pipe.write_all(&report.encode())
}

#[cfg(test)]
mod tests {
    use super::*;

    const POLICY: Policy = Policy {
        free_failures: 3,
        base_block: Duration::from_secs(10),
        max_block: Duration::from_secs(60),
        forget_after: Duration::from_secs(100),
    };

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    fn fail(table: &mut Table, address: &str, now: Instant) -> Option<(Duration, u32)> {
        table.report(Report { ip: ip(address), ok: false }, now)
    }

    #[test]
    fn reports_round_trip_with_fixed_bytes() {
        let v4 = Report { ip: ip("192.0.2.7"), ok: false };
        let mut expected = [0u8; REPORT_LEN];
        expected[..6].copy_from_slice(&[4, 0, 192, 0, 2, 7]);
        assert_eq!(v4.encode(), expected);
        let v6 = Report { ip: ip("2001:db8::1"), ok: true };
        assert_eq!(&v6.encode()[..4], &[6, 1, 0x20, 0x01]);
        for report in [v4, v6] {
            assert_eq!(Report::decode(&report.encode()), Some(report));
        }
        // a bad family, outcome or IPv4 padding
        for (index, value) in [(0, 5), (1, 2), (10, 1)] {
            let mut bytes = v4.encode();
            bytes[index] = value;
            assert_eq!(Report::decode(&bytes), None);
        }
    }

    #[test]
    fn blocks_after_the_free_failures_doubling_up_to_the_maximum() {
        let mut table = Table::new(POLICY);
        let now = Instant::now();
        assert_eq!(fail(&mut table, "192.0.2.1", now), None);
        assert_eq!(fail(&mut table, "192.0.2.1", now), None);
        assert!(!table.blocked(ip("192.0.2.1"), now));
        assert_eq!(fail(&mut table, "192.0.2.1", now), Some((Duration::from_secs(10), 3)));
        assert!(table.blocked(ip("192.0.2.1"), now));
        assert!(table.blocked(ip("192.0.2.1"), now + Duration::from_secs(9)));
        assert!(!table.blocked(ip("192.0.2.1"), now + Duration::from_secs(10)));
        // other addresses are not affected
        assert!(!table.blocked(ip("192.0.2.2"), now));
        // each further failure doubles the block, up to the maximum
        let later = now + Duration::from_secs(10);
        assert_eq!(fail(&mut table, "192.0.2.1", later), Some((Duration::from_secs(20), 4)));
        assert_eq!(fail(&mut table, "192.0.2.1", later), Some((Duration::from_secs(40), 5)));
        assert_eq!(fail(&mut table, "192.0.2.1", later), Some((Duration::from_secs(60), 6)));
        for _ in 0..100 {
            fail(&mut table, "192.0.2.1", later);
        }
        assert_eq!(fail(&mut table, "192.0.2.1", later), Some((Duration::from_secs(60), 107)));
    }

    #[test]
    fn successes_change_nothing() {
        let mut table = Table::new(POLICY);
        let now = Instant::now();
        for _ in 0..3 {
            fail(&mut table, "192.0.2.1", now);
        }
        assert_eq!(table.report(Report { ip: ip("192.0.2.1"), ok: true }, now), None);
        assert!(table.blocked(ip("192.0.2.1"), now));
    }

    #[test]
    fn a_quiet_address_is_forgotten() {
        let mut table = Table::new(POLICY);
        let now = Instant::now();
        fail(&mut table, "192.0.2.1", now);
        fail(&mut table, "192.0.2.1", now);
        // not yet: the count goes on
        assert!(fail(&mut table, "192.0.2.1", now + Duration::from_secs(99)).is_some());
        // forget_after counts from the end of the block
        let unblocked = now + Duration::from_secs(99 + 10);
        assert!(fail(&mut table, "192.0.2.1", unblocked + Duration::from_secs(99)).is_some());
        let quiet = unblocked + Duration::from_secs(99) + Duration::from_secs(20 + 100);
        assert_eq!(fail(&mut table, "192.0.2.1", quiet), None);
        assert!(!table.blocked(ip("192.0.2.1"), quiet));
    }

    #[test]
    fn ipv6_counts_by_prefix_and_mapped_ipv4_as_ipv4() {
        let mut table = Table::new(POLICY);
        let now = Instant::now();
        fail(&mut table, "2001:db8:1:2::1", now);
        fail(&mut table, "2001:db8:1:2:ffff::9", now);
        fail(&mut table, "2001:db8:1:2:abcd:1:2:3", now);
        assert!(table.blocked(ip("2001:db8:1:2::77"), now));
        assert!(!table.blocked(ip("2001:db8:1:3::1"), now));
        fail(&mut table, "::ffff:192.0.2.9", now);
        fail(&mut table, "192.0.2.9", now);
        fail(&mut table, "::ffff:192.0.2.9", now);
        assert!(table.blocked(ip("192.0.2.9"), now));
        assert_eq!(key(ip("2001:db8:1:2:3:4:5:6")), ip("2001:db8:1:2::"));
    }

    #[test]
    fn a_full_table_replaces_the_least_relevant_entry() {
        let mut table = Table::with_capacity(POLICY, 3);
        let now = Instant::now();
        // .1 blocked, .2 and .3 one failure each (.2 the older)
        for _ in 0..3 {
            fail(&mut table, "192.0.2.1", now);
        }
        fail(&mut table, "192.0.2.2", now);
        fail(&mut table, "192.0.2.3", now + Duration::from_secs(1));
        // a new address takes .2's place, not the blocked one's
        fail(&mut table, "192.0.2.4", now + Duration::from_secs(2));
        assert!(table.blocked(ip("192.0.2.1"), now + Duration::from_secs(2)));
        assert!(table.find(ip("192.0.2.2"), now + Duration::from_secs(2)).is_none());
        assert!(table.find(ip("192.0.2.3"), now + Duration::from_secs(2)).is_some());
        // all blocked: the block that ends first goes
        let mut table = Table::with_capacity(POLICY, 2);
        for address in ["192.0.2.1", "192.0.2.1", "192.0.2.1", "192.0.2.1", "192.0.2.2", "192.0.2.2", "192.0.2.2"] {
            fail(&mut table, address, now);
        }
        for _ in 0..3 {
            fail(&mut table, "192.0.2.3", now);
        }
        assert!(table.blocked(ip("192.0.2.1"), now));
        assert!(!table.blocked(ip("192.0.2.2"), now));
        assert!(table.blocked(ip("192.0.2.3"), now));
    }

    #[test]
    fn the_policy_scales() {
        let scaled = POLICY.scaled(10.0);
        assert_eq!(scaled.free_failures, 3);
        assert_eq!(scaled.base_block, Duration::from_secs(1));
        assert_eq!(scaled.max_block, Duration::from_secs(6));
        assert_eq!(scaled.forget_after, Duration::from_secs(10));
    }

    #[test]
    fn reports_travel_over_a_pipe() {
        let mut table = Table::new(POLICY);
        let (reader, mut writer) = io::pipe().unwrap();
        let mut pipe = Some(reader);
        for _ in 0..3 {
            send(&mut writer, Report { ip: ip("192.0.2.1"), ok: false }).unwrap();
        }
        drain(&mut pipe, &mut table);
        // still open: the child may have more to say
        assert!(pipe.is_some());
        assert!(table.blocked(ip("192.0.2.1"), Instant::now()));
        drop(writer);
        drain(&mut pipe, &mut table);
        assert!(pipe.is_none());
    }
}
