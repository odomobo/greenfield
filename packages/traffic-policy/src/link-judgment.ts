/**
 * Judges a viewer connection's link from the transport's link stats and the congestion estimate: whether it is short of
 * bandwidth for the streaming class (see bandwidth.ts), and its bandwidth as measured when saturated. One per
 * connection.
 */
import { performance } from 'node:perf_hooks'
import type { CongestionEstimate, LinkStats } from '@nebula/session-contracts'
import { BandwidthMonitor } from './bandwidth.js'

export type PolicyLogger = { info?(message: string): void }

/** A connection's link, as traffic policy judges it (LinkJudgment; tests pass their own). */
export interface LinkJudge {
  /**
   * The link is short of bandwidth for the streaming class: its surfaces go lossy (JPEG patches, lower-quality video)
   * while it is.
   */
  readonly bandwidthLimited: boolean
  /** The link's bandwidth (bytes per ms) as measured when it was saturated; undefined if it never was. */
  readonly linkBandwidth: number | undefined
}

export class LinkJudgment implements LinkJudge {
  private readonly bandwidth: BandwidthMonitor

  constructor(
    link: LinkStats,
    estimate: CongestionEstimate,
    /** the predicted backlog of the surfaces' damage not handed to the transport yet (see bandwidth.ts) */
    unencodedBytes: () => number,
    private readonly now: () => number = () => performance.now(),
    logger?: PolicyLogger,
  ) {
    this.bandwidth = new BandwidthMonitor(
      this.now(),
      () => estimate.bandwidthEstimate ?? 0,
      () => link.totalUnsentBytes('settle') + unencodedBytes(),
      (limited, { held, backlogMs }) =>
        logger?.info?.(
          limited
            ? `Bandwidth-limited: streaming surfaces go lossy (held back ${Math.round(held * 100)}% of the period, predicted backlog ${Math.round(backlogMs)} ms).`
            : `No longer bandwidth-limited: streaming surfaces go lossless again (held back ${Math.round(held * 100)}% of the last second, predicted backlog ${Math.round(backlogMs)} ms).`,
        ),
    )
    // held back while streaming items wait
    link.onDataHeld = (held, now) => this.bandwidth.setHeld(held && link.tierWaiting('streaming'), now)
  }

  get bandwidthLimited(): boolean {
    return this.bandwidth.limited(this.now())
  }

  get linkBandwidth(): number | undefined {
    return this.bandwidth.linkBandwidth
  }
}
