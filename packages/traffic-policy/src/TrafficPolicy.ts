/**
 * Traffic policy: how the link and the CPU are shared between surfaces (see "Traffic policy" in
 * docs/MODULARIZATION.md, "Encoding policy" in ARCHITECTURE.md). One per session; the surfaces' encoders and the viewer
 * connection reach it through the contracts' `SurfacePolicy` and `LinkPolicy`. Two independent axes:
 *
 * - **Priority**: is the surface relentless? Measured per surface on fixed periods (RelentlessMeter, priority.ts); a
 *   relentless surface is in the streaming class. A burst promotes at once: while the normal surfaces' predicted
 *   backlog would take the link more than BURST_MS (at its bandwidth as measured when it was saturated; never before),
 *   the one with the largest is promoted (`checkBurst`). Settling always goes in the lowest tier (tiers.ts).
 * - **Bottleneck**: is the surface CPU-bound or link-bound? CPU-bound until the link becomes the limit: the current
 *   connection's link judgment (LinkJudgment, bandwidth.ts) says the link is short for the streaming tier. Then the
 *   streaming surfaces (those sending in that tier) are link-bound: they go lossy. Video quality follows the link.
 *
 * Each surface's decision (`SurfaceTraffic`) is live: it reads the meter and the link when it's read, so the timing of
 * every verdict follows the moments the surface reads and reports, as it always has.
 */
import { performance } from 'node:perf_hooks'
import type {
  Bottleneck,
  CongestionEstimate,
  LinkPolicy,
  LinkStats,
  PeriodFractions,
  SendTier,
  SurfaceClass,
  SurfacePolicy,
  SurfaceTraffic,
  TrafficSource,
  VideoQuality,
} from '@nebula/session-contracts'
import { type LinkJudge, LinkJudgment, type PolicyLogger } from './link-judgment.js'
import { BURST_MS, RelentlessMeter } from './priority.js'
import { sendTierOf } from './tiers.js'

export class TrafficPolicy implements SurfacePolicy, LinkPolicy {
  /** the surfaces, in the order they were added (a burst promotes the first of equal backlogs) */
  private readonly surfaces = new Set<SurfaceTrafficState>()
  /** the current connection's link, judged; undefined without a viewer */
  private link?: LinkJudge
  private checkingBurst = false
  readonly now: () => number
  /** where the surfaces' class changes are logged */
  readonly logger?: PolicyLogger
  private readonly linkLogger?: PolicyLogger

  constructor(
    options: {
      /** the surfaces' class changes */
      logger?: PolicyLogger
      /** the link judgment's changes */
      linkLogger?: PolicyLogger
      /** the clock (ms) */
      now?: () => number
    } = {},
  ) {
    this.logger = options.logger
    this.linkLogger = options.linkLogger
    this.now = options.now ?? (() => performance.now())
  }

  addSurface(source: TrafficSource): SurfaceTraffic {
    const surface = new SurfaceTrafficState(source, this)
    this.surfaces.add(surface)
    return surface
  }

  /** @internal */
  removeSurface(surface: SurfaceTrafficState): void {
    this.surfaces.delete(surface)
  }

  connect(link: LinkStats, estimate: CongestionEstimate): void {
    this.useLink(new LinkJudgment(link, estimate, () => this.unencodedBytes, this.now, this.linkLogger))
  }

  /** Judge the current connection's link with this (tests pass their own); undefined: no viewer. */
  useLink(link: LinkJudge | undefined): void {
    this.link = link
  }

  disconnect(): void {
    this.link = undefined
  }

  /** The link is short of bandwidth for the streaming tier (false without a viewer). */
  get linkShort(): boolean {
    return this.link?.bandwidthLimited ?? false
  }

  judgeLink(): void {
    void this.linkShort
  }

  /** The surfaces' predicted backlog not handed to the transport yet (the link judgment adds what waits in it). */
  get unencodedBytes(): number {
    let bytes = 0
    for (const surface of this.surfaces) {
      bytes += surface.source.unencodedBytes
    }
    return bytes
  }

  /**
   * Burst promotion: while the normal surfaces' predicted backlog would take the link more than BURST_MS (at its
   * bandwidth as measured when it was last limited; never before it was), promote the one with the largest. Streaming
   * surfaces don't count: they don't push others out of the normal class.
   */
  checkBurst(): void {
    const bandwidth = this.link?.linkBandwidth
    if (bandwidth === undefined || bandwidth <= 0 || this.checkingBurst) {
      return
    }
    this.checkingBurst = true
    try {
      for (;;) {
        let total = 0
        let largest: SurfaceTrafficState | undefined
        let largestBytes = 0
        for (const surface of this.surfaces) {
          if (surface.surfaceClass !== 'normal') {
            continue
          }
          const bytes = surface.source.predictedBacklogBytes
          total += bytes
          if (bytes > largestBytes) {
            largest = surface
            largestBytes = bytes
          }
        }
        if (largest === undefined || total <= BURST_MS * bandwidth) {
          return
        }
        largest.promoteBurst(total / bandwidth)
        if (largest.surfaceClass === 'normal') {
          // couldn't be promoted (no content)
          return
        }
      }
    } finally {
      this.checkingBurst = false
    }
  }
}

/** A surface's priority measure and its decision. */
class SurfaceTrafficState implements SurfaceTraffic {
  private readonly meter: RelentlessMeter
  /** the class decided (the meter's verdict as of the last evaluation, or a burst's) */
  private decided: SurfaceClass = 'normal'

  constructor(
    readonly source: TrafficSource,
    private readonly policy: TrafficPolicy,
  ) {
    // demoted only once it is settled (video: stopping it sends a crisp image)
    this.meter = new RelentlessMeter(policy.now(), undefined, () => source.settled)
  }

  get surfaceClass(): SurfaceClass {
    return this.decided
  }

  get bottleneck(): Bottleneck {
    // (the link is judged only when a streaming surface asks, or on the tick)
    return this.decided === 'streaming' && this.policy.linkShort ? 'link' : 'cpu'
  }

  get videoQuality(): VideoQuality {
    return this.policy.linkShort ? 'low' : 'high'
  }

  sendTier(settling: boolean): SendTier {
    return sendTierOf(this.decided, settling)
  }

  get backlogged(): boolean {
    return this.meter.backlogged
  }

  get lastPeriod(): PeriodFractions | undefined {
    return this.meter.lastPeriod
  }

  setBusy(busy: boolean): void {
    if (busy && !this.meter.busy) {
      this.meter.markBusyStart(this.policy.now())
    } else if (!busy && this.meter.busy) {
      this.meter.markBusyEnd(this.policy.now())
    }
  }

  committed(): boolean {
    const now = this.policy.now()
    // backlogged if the last period was busy enough (the new work makes the surface busy, so it counts from now)
    this.meter.markBackloggedStart(now)
    return this.decide(now)
  }

  evaluate(): boolean {
    return this.decide(this.policy.now())
  }

  remove(): void {
    this.policy.removeSurface(this)
  }

  private decide(now: number): boolean {
    const after = this.meter.evaluate(now)
    if (after === this.decided) {
      return false
    }
    this.decided = after
    const last = this.meter.lastPeriod
    this.policy.logger?.info?.(
      `Surface ${this.source.key} is now ${after} (last period: busy ${Math.round((last?.busy ?? 0) * 100)}%, backlogged ${Math.round((last?.backlogged ?? 0) * 100)}%).`,
    )
    return true
  }

  /** Promote the surface now: a burst. `backlogMs`: the normal surfaces' predicted backlog that made it, for the log. */
  promoteBurst(backlogMs: number): void {
    if (!this.source.hasContent || this.decided === 'streaming') {
      return
    }
    this.meter.promote()
    this.decided = 'streaming'
    this.policy.logger?.info?.(
      `Surface ${this.source.key} is now streaming (a burst: the normal surfaces' predicted backlog is ${Math.round(backlogMs)} ms).`,
    )
    this.source.onPromoted()
  }
}
