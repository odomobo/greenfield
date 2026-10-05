/**
 * Whether the link to the viewer is short of bandwidth, for the streaming class's encoding (see "QOI patches, and lossy
 * encoding only when bandwidth is short" in ROADMAP.md): while it is, streaming surfaces are sent as JPEG patches (or
 * lower-quality video), and once it recovers their lossy areas are refreshed losslessly.
 *
 * Judged on fixed, back-to-back periods (BANDWIDTH_PERIOD_MS) from two measures:
 * - **Held**: the share of the period during which streaming items waited in the transport and the congestion
 *   controller (or the socket's buffer) held them back. With pacing, a queued item waits until the link has room for
 *   it, so this is about the share of the link's capacity the waiting data wants: a stream the link can't keep up with
 *   is held all the time, one the CPU limits only now and then.
 * - **Lossless demand**: the bytes sent in the period, with lossy items counted at what they would have taken
 *   losslessly (a JPEG patch at the lossless bytes per pixel last measured for its surface, a lower-quality video frame
 *   at VIDEO_QUALITY_RATIO times its size), against the controller's bandwidth estimate (max_bw).
 *
 * Limited from the end of LIMITED_PERIODS periods in a row held at least LIMITED_HELD_FRACTION of the time (one isn't
 * enough: the controller's own Startup and ProbeRTT hold data back for a while on a link that is busy but keeps up).
 * Recovered at the end of a period
 * held under RECOVERED_HELD_FRACTION whose lossless demand fits in RECOVERED_DEMAND_FRACTION of the estimated bandwidth,
 * at least MIN_LIMITED_MS after becoming limited. Lossy output is smaller than lossless, so without the demand estimate
 * a link that is just too slow for lossless would flap between the two every period.
 *
 * Pure: no I/O and no clock of its own, the caller passes the time (ms) to every call.
 */
import type { SurfaceClass } from '../encoding/policy.js'

export const BANDWIDTH_PERIOD_MS = 1000
/** Limited at the end of LIMITED_PERIODS periods in a row in which streaming items were held back at least this share of the time. */
export const LIMITED_HELD_FRACTION = 0.8
export const LIMITED_PERIODS = 2
/** Recovered only at the end of a period held back less than this share of the time... */
export const RECOVERED_HELD_FRACTION = 0.5
/** ...whose demand, counted losslessly, was at most this share of the estimated bandwidth... */
export const RECOVERED_DEMAND_FRACTION = 0.7
/** ...and at least this long after becoming limited. */
export const MIN_LIMITED_MS = 2000
/** A lossy patch of a surface with no lossless patch measured yet is assumed this many times smaller than lossless. */
export const LOSSY_RATIO_GUESS = 3
/** A video frame at the higher quality is assumed this many times the size of one at the lower quality. */
export const VIDEO_QUALITY_RATIO = 2
/** Per-surface lossless sizes are forgotten after this long without a patch of the surface. */
const SURFACE_MEMORY_MS = 60_000
/** Weight of the older samples in a surface's lossless bytes per pixel (per patch). */
const BYTES_PER_PIXEL_DECAY = 0.8

export type SentItem =
  | {
      kind: 'patch'
      surface: string
      surfaceClass: SurfaceClass
      /** the envelope's size */
      bytes: number
      /** the patch's pixels (its rectangle's area) */
      pixels: number
      lossy: boolean
    }
  | { kind: 'frame'; surface: string; surfaceClass: SurfaceClass; bytes: number }

type SurfaceSize = { bytes: number; pixels: number; seen: number }

export class BandwidthMonitor {
  private periodStart: number
  private heldSince?: number
  private heldMs = 0
  private demandBytes = 0
  private _limited = false
  private limitedSince = 0
  /** periods in a row held back at least LIMITED_HELD_FRACTION */
  private heldPeriods = 0
  /** decayed sums of each surface's lossless patches: its lossless bytes per pixel */
  private readonly lossless = new Map<string, SurfaceSize>()

  /**
   * `capacity`: the controller's bandwidth estimate in bytes per ms (0 while unknown). `onChange` is called when the
   * state changes, with the measures of the period that decided it.
   */
  constructor(
    now: number,
    private readonly capacity: () => number,
    private readonly onChange?: (limited: boolean, period: { held: number; demand: number }) => void,
    private readonly periodMs = BANDWIDTH_PERIOD_MS,
  ) {
    this.periodStart = now
  }

  /** Whether the link is short of bandwidth (as of the last completed period). */
  limited(now: number): boolean {
    this.advance(now)
    return this._limited
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

  /** A data item was handed to the socket. */
  onSent(item: SentItem, now: number): void {
    this.advance(now)
    this.demandBytes += this.losslessBytes(item, now)
  }

  /** What the item would have taken losslessly (its own size if it is lossless). */
  private losslessBytes(item: SentItem, now: number): number {
    if (item.kind === 'frame') {
      // video is only lossy; at the lower quality while limited
      return this._limited ? item.bytes * VIDEO_QUALITY_RATIO : item.bytes
    }
    const known = this.lossless.get(item.surface)
    if (!item.lossy) {
      const size = known ?? { bytes: 0, pixels: 0, seen: now }
      size.bytes = size.bytes * BYTES_PER_PIXEL_DECAY + item.bytes
      size.pixels = size.pixels * BYTES_PER_PIXEL_DECAY + item.pixels
      size.seen = now
      this.lossless.set(item.surface, size)
      return item.bytes
    }
    if (known === undefined || known.pixels <= 0) {
      return item.bytes * LOSSY_RATIO_GUESS
    }
    known.seen = now
    return Math.max(item.bytes, (item.pixels * known.bytes) / known.pixels)
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
      this.demandBytes = 0
      this.periodStart = end
      closed++
    }
  }

  private closePeriod(end: number) {
    const held = this.heldMs / this.periodMs
    const capacity = this.capacity() * this.periodMs
    const demand = capacity > 0 ? this.demandBytes / capacity : 0
    this.heldPeriods = held >= LIMITED_HELD_FRACTION ? this.heldPeriods + 1 : 0
    if (!this._limited) {
      if (this.heldPeriods >= LIMITED_PERIODS) {
        this._limited = true
        this.limitedSince = end
        this.onChange?.(true, { held, demand })
      }
    } else if (
      end - this.limitedSince >= MIN_LIMITED_MS &&
      held < RECOVERED_HELD_FRACTION &&
      demand <= RECOVERED_DEMAND_FRACTION
    ) {
      this._limited = false
      this.onChange?.(false, { held, demand })
    }
    for (const [surface, size] of this.lossless) {
      if (end - size.seen > SURFACE_MEMORY_MS) {
        this.lossless.delete(surface)
      }
    }
  }
}
