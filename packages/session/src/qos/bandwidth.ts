/**
 * Whether the link to the viewer is short of bandwidth, for the streaming class's encoding (see "QOI patches, and lossy
 * encoding only when bandwidth is short" in ARCHITECTURE.md): while it is, streaming surfaces are sent as JPEG patches (or
 * lower-quality video). Their lossy areas are settled (sent again losslessly) at the lowest priority whenever they
 * have no damage to send.
 *
 * Limited when either
 * - **the link is saturated**: LIMITED_PERIODS fixed, back-to-back periods (BANDWIDTH_PERIOD_MS) in a row in which
 *   streaming items waited in the transport and the congestion controller (or the socket's buffer) held them back at
 *   least LIMITED_HELD_FRACTION of the time. With pacing, a queued item waits until the link has room for it, so this is
 *   about the share of the link's capacity the waiting data wants. One period isn't enough: the controller's own
 *   Startup and ProbeRTT hold data back for a while on a link that is busy but keeps up. Or
 * - **the predicted backlog** (the caller's: the surfaces' unsent damage, at their lossless bytes per pixel, except
 *   settling) would take the link more than BURST_MS, at once. Only once the link was saturated on this connection:
 *   the bandwidth (the controller's max_bw) is remembered from its saturated periods (or the controller's estimate if
 *   higher); an estimate of a link that was never full is only a lower bound.
 * It ends only when both are quiet, at the end of a period held back under RECOVERED_HELD_FRACTION, with the predicted
 * backlog under BURST_MS, at least MIN_LIMITED_MS after it began. Lossy output is smaller than lossless, so judging by
 * the held measure alone, a link just too slow for lossless would flap between the two every period; the predicted
 * backlog is counted losslessly.
 *
 * Pure: no I/O and no clock of its own, the caller passes the time (ms) to every call.
 */
import { BURST_MS } from '../encoding/policy.js'

export const BANDWIDTH_PERIOD_MS = 1000
/** Limited at the end of LIMITED_PERIODS periods in a row in which streaming items were held back at least this share of the time. */
export const LIMITED_HELD_FRACTION = 0.8
export const LIMITED_PERIODS = 2
/** Recovered only at the end of a period held back less than this share of the time... */
export const RECOVERED_HELD_FRACTION = 0.5
/** ...with the predicted backlog under BURST_MS, and at least this long after becoming limited. */
export const MIN_LIMITED_MS = 2000

export type LimitedReason = { held: number; backlogMs: number }

export class BandwidthMonitor {
  private periodStart: number
  private heldSince?: number
  private heldMs = 0
  private _limited = false
  private limitedSince = 0
  /** periods in a row held back at least LIMITED_HELD_FRACTION */
  private heldPeriods = 0
  private _linkBandwidth?: number

  /**
   * `capacity`: the controller's bandwidth estimate in bytes per ms (0 while unknown). `backlogBytes`: the predicted
   * backlog. `onChange` is called when the state changes, with the measures that decided it.
   */
  constructor(
    now: number,
    private readonly capacity: () => number,
    private readonly backlogBytes: () => number,
    private readonly onChange?: (limited: boolean, reason: LimitedReason) => void,
    private readonly periodMs = BANDWIDTH_PERIOD_MS,
  ) {
    this.periodStart = now
  }

  /** Whether the link is short of bandwidth. */
  limited(now: number): boolean {
    this.advance(now)
    if (!this._limited && this._linkBandwidth !== undefined) {
      const backlogMs = this.backlogMs()
      if (backlogMs > BURST_MS) {
        this.setLimited(true, now, { held: this.heldMs / this.periodMs, backlogMs })
      }
    }
    return this._limited
  }

  /**
   * The link's bandwidth (bytes per ms) as of its last saturated period, or the controller's estimate if that's higher
   * now (it's a lower bound); undefined if the link never was saturated.
   */
  get linkBandwidth(): number | undefined {
    return this._linkBandwidth === undefined ? undefined : Math.max(this._linkBandwidth, this.capacity())
  }

  /** Whether streaming items are waiting now and held back by the controller (or the socket). */
  setHeld(held: boolean, now: number): void {
    this.advance(now)
    if (held && this.heldSince === undefined) {
      this.heldSince = now
    } else if (!held && this.heldSince !== undefined) {
      this.heldMs += now - this.heldSince
      this.heldSince = undefined
    }
  }

  private backlogMs(): number {
    const bandwidth = this.linkBandwidth
    return bandwidth ? this.backlogBytes() / bandwidth : 0
  }

  private setLimited(limited: boolean, now: number, reason: LimitedReason) {
    this._limited = limited
    if (limited) {
      this.limitedSince = now
    }
    this.onChange?.(limited, reason)
  }

  /** Close the periods that ended by `now`. */
  private advance(now: number) {
    let closed = 0
    while (now >= this.periodStart + this.periodMs) {
      const end = this.periodStart + this.periodMs
      if (closed >= 3) {
        // a long quiet stretch: every further period would be the same as the last one, skip to the current one
        this.periodStart += Math.floor((now - this.periodStart) / this.periodMs) * this.periodMs
        if (this.heldSince !== undefined) {
          this.heldSince = this.periodStart
        }
        break
      }
      if (this.heldSince !== undefined) {
        this.heldMs += end - this.heldSince
        this.heldSince = end
      }
      this.closePeriod(end)
      this.heldMs = 0
      this.periodStart = end
      closed++
    }
  }

  private closePeriod(end: number) {
    const held = this.heldMs / this.periodMs
    this.heldPeriods = held >= LIMITED_HELD_FRACTION ? this.heldPeriods + 1 : 0
    if (this.heldPeriods >= LIMITED_PERIODS && this.capacity() > 0) {
      // the link was saturated: the controller measured its bandwidth
      this._linkBandwidth = this.capacity()
    }
    if (!this._limited) {
      if (this.heldPeriods >= LIMITED_PERIODS) {
        this.setLimited(true, end, { held, backlogMs: this.backlogMs() })
      }
    } else if (end - this.limitedSince >= MIN_LIMITED_MS && held < RECOVERED_HELD_FRACTION) {
      const backlogMs = this.backlogMs()
      if (backlogMs < BURST_MS) {
        this.setLimited(false, end, { held, backlogMs })
      }
    }
  }
}
