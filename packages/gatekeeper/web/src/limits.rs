//! The listener's bookkeeping: workers alive per client IP against the caps, and the per-IP throttle of failed
//! sign-ins (until the login helper does it, step 10 of SIGNIN-ROADMAP.md).
use std::collections::HashMap;
use std::net::IpAddr;
use std::time::{Duration, Instant};

/// Counts the workers alive, in all and per client IP, against the caps.
pub struct WorkerCount {
    max: usize,
    max_per_ip: usize,
    total: usize,
    per_ip: HashMap<IpAddr, usize>,
}

impl WorkerCount {
    pub fn new(max: usize, max_per_ip: usize) -> WorkerCount {
        WorkerCount { max, max_per_ip, total: 0, per_ip: HashMap::new() }
    }

    /// Count one more worker for `ip`, unless that's over a cap: whether it was counted.
    pub fn add(&mut self, ip: IpAddr) -> bool {
        let for_ip = self.per_ip.get(&ip).copied().unwrap_or(0);
        if self.total >= self.max || for_ip >= self.max_per_ip {
            return false;
        }
        self.total += 1;
        self.per_ip.insert(ip, for_ip + 1);
        true
    }

    pub fn remove(&mut self, ip: IpAddr) {
        match self.per_ip.get(&ip).copied() {
            None | Some(0) => return,
            Some(1) => {
                self.per_ip.remove(&ip);
            }
            Some(n) => {
                self.per_ip.insert(ip, n - 1);
            }
        }
        self.total -= 1;
    }

    pub fn size(&self) -> usize {
        self.total
    }
}

const WINDOW: Duration = Duration::from_secs(15 * 60);
const BASE_BLOCK: Duration = Duration::from_secs(30);
const MAX_BLOCK: Duration = Duration::from_secs(15 * 60);
const MAX_KEYS: usize = 100_000;

struct Entry {
    failures: u32,
    first_failure: Instant,
    blocked_until: Option<Instant>,
}

/// Failed sign-in throttling per client IP (per-account lockout is PAM's job). After `free_failures` failures inside
/// 15 minutes, an IP is blocked for a time that doubles with each further failure (30 s up to 15 minutes). Never
/// cleared by a success: many users may share an address (NAT).
pub struct RateLimiter {
    free_failures: u32,
    entries: HashMap<IpAddr, Entry>,
}

impl RateLimiter {
    pub fn new(free_failures: u32) -> RateLimiter {
        RateLimiter { free_failures, entries: HashMap::new() }
    }

    pub fn blocked(&self, ip: IpAddr, now: Instant) -> bool {
        self.entries.get(&ip).and_then(|entry| entry.blocked_until).is_some_and(|until| until > now)
    }

    pub fn fail(&mut self, ip: IpAddr, now: Instant) {
        let fresh = self.entries.get(&ip).is_none_or(|entry| now.duration_since(entry.first_failure) > WINDOW);
        if fresh {
            self.entries.insert(ip, Entry { failures: 0, first_failure: now, blocked_until: None });
            self.prune(now);
        }
        let free_failures = self.free_failures;
        let Some(entry) = self.entries.get_mut(&ip) else { return };
        entry.failures += 1;
        if entry.failures >= free_failures {
            let doublings = (entry.failures - free_failures).min(16);
            entry.blocked_until = Some(now + (BASE_BLOCK * (1 << doublings)).min(MAX_BLOCK));
        }
    }

    fn prune(&mut self, now: Instant) {
        if self.entries.len() <= MAX_KEYS {
            return;
        }
        self.entries.retain(|_, entry| {
            now.duration_since(entry.first_failure) <= WINDOW || entry.blocked_until.is_some_and(|until| until >= now)
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn connection_caps_in_all_and_per_ip() {
        let (a, b, c, d, e) = (ip("10.0.0.1"), ip("10.0.0.2"), ip("10.0.0.3"), ip("10.0.0.4"), ip("10.0.0.5"));
        let mut count = WorkerCount::new(3, 2);
        assert!(count.add(a));
        assert!(count.add(a));
        assert!(!count.add(a), "over the per-IP cap");
        assert!(count.add(b));
        assert!(!count.add(c), "over the total cap");
        count.remove(a);
        assert!(count.add(c), "room again");
        assert!(!count.add(d));
        count.remove(ip("10.9.9.9"));
        assert_eq!(count.size(), 3);
        count.remove(b);
        assert!(count.add(b));
        assert!(!count.add(e), "full again");
    }

    #[test]
    fn throttles_after_the_free_failures() {
        let mut limiter = RateLimiter::new(3);
        let now = Instant::now();
        let (a, b) = (ip("192.0.2.1"), ip("::1"));
        limiter.fail(a, now);
        limiter.fail(a, now);
        assert!(!limiter.blocked(a, now));
        limiter.fail(a, now);
        assert!(limiter.blocked(a, now));
        assert!(!limiter.blocked(b, now), "per IP");
        assert!(limiter.blocked(a, now + Duration::from_secs(29)));
        assert!(!limiter.blocked(a, now + Duration::from_secs(31)));
        // the block doubles with each further failure
        limiter.fail(a, now + Duration::from_secs(40));
        assert!(limiter.blocked(a, now + Duration::from_secs(40 + 59)));
        assert!(!limiter.blocked(a, now + Duration::from_secs(40 + 61)));
        // a new window starts afresh
        let later = now + WINDOW + Duration::from_secs(1);
        limiter.fail(a, later);
        assert!(!limiter.blocked(a, later));
    }
}
