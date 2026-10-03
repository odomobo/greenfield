/**
 * Failed-login throttling per key (an IP or a username). The same rules apply to every username string, existing
 * or not, so throttling reveals nothing about which accounts exist.
 *
 * After `freeFailures` failures inside WINDOW_MS, a key is blocked for a time that doubles with each further
 * failure, up to MAX_BLOCK_MS. A successful login clears the key.
 */
const WINDOW_MS = 15 * 60 * 1000
const BASE_BLOCK_MS = 30 * 1000
const MAX_BLOCK_MS = 15 * 60 * 1000
const MAX_KEYS = 100_000

type Entry = { failures: number; firstFailure: number; blockedUntil: number }

export class RateLimiter {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly freeFailures: number) {}

  blocked(key: string): boolean {
    const entry = this.entries.get(key)
    return entry !== undefined && entry.blockedUntil > Date.now()
  }

  fail(key: string) {
    const now = Date.now()
    let entry = this.entries.get(key)
    if (entry === undefined || now - entry.firstFailure > WINDOW_MS) {
      entry = { failures: 0, firstFailure: now, blockedUntil: 0 }
      this.entries.set(key, entry)
      this.prune(now)
    }
    entry.failures++
    if (entry.failures >= this.freeFailures) {
      const block = Math.min(BASE_BLOCK_MS * 2 ** (entry.failures - this.freeFailures), MAX_BLOCK_MS)
      entry.blockedUntil = now + block
    }
  }

  succeed(key: string) {
    this.entries.delete(key)
  }

  private prune(now: number) {
    if (this.entries.size <= MAX_KEYS) {
      return
    }
    for (const [key, entry] of this.entries) {
      if (now - entry.firstFailure > WINDOW_MS && entry.blockedUntil < now) {
        this.entries.delete(key)
      }
    }
  }
}
