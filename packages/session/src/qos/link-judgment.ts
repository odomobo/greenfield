/**
 * Judges a viewer connection's link from the transport's link stats and the congestion controller's estimate: whether
 * it is short of bandwidth for the streaming class (see bandwidth.ts), and its bandwidth as measured when saturated.
 * One per connection.
 */
import { performance } from 'node:perf_hooks'
import type { Congestion } from '@nebula/session-contracts'
import type { ViewerTransport } from '@nebula/transport'
import { createLogger } from '../Logger.js'
import { BandwidthMonitor } from './bandwidth.js'

// the transport's name: these lines were the transport's before the judgment moved out of it
const logger = createLogger('viewer-transport')

export class LinkJudgment {
  private readonly bandwidth: BandwidthMonitor

  constructor(
    transport: ViewerTransport,
    congestion: Congestion,
    /** the predicted backlog of the surfaces' damage not handed to the transport yet (see bandwidth.ts) */
    unencodedBytes: () => number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.bandwidth = new BandwidthMonitor(
      this.now(),
      () => congestion.bandwidthEstimate ?? 0,
      () => transport.totalUnsentBytes('settle') + unencodedBytes(),
      (limited, { held, backlogMs }) =>
        logger.info(
          limited
            ? `Bandwidth-limited: streaming surfaces go lossy (held back ${Math.round(held * 100)}% of the period, predicted backlog ${Math.round(backlogMs)} ms).`
            : `No longer bandwidth-limited: streaming surfaces go lossless again (held back ${Math.round(held * 100)}% of the last second, predicted backlog ${Math.round(backlogMs)} ms).`,
        ),
    )
    // held back while streaming items wait
    transport.onDataHeld = (held, now) => this.bandwidth.setHeld(held && transport.tierWaiting('streaming'), now)
  }

  /**
   * The link is short of bandwidth for the streaming class: its surfaces go lossy (JPEG patches, lower-quality video)
   * while it is.
   */
  get bandwidthLimited(): boolean {
    return this.bandwidth.limited(this.now())
  }

  /** The link's bandwidth (bytes per ms) as measured when it was saturated; undefined if it never was. */
  get linkBandwidth(): number | undefined {
    return this.bandwidth.linkBandwidth
  }
}
