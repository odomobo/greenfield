import { BACKLOG_HOLD_BYTES, type ViewerAck } from './protocol.js'

/**
 * Acknowledgements of data envelopes for the server's congestion control (see the ACK envelope in the scene protocol).
 *
 * Every data envelope (FRAME, PATCH) is acknowledged as soon as it arrives, before it's decoded. Each ack also reports
 * the backlog: envelopes received but not yet applied (a patch drawn, a frame decoded; dropped counts as applied). The
 * server stops sending data while that backlog, not counting its largest envelope, is over BACKLOG_HOLD_BYTES, so once
 * an envelope is applied while the last report was over the limit, a fresh ack tells the server the backlog went down.
 * Sizes are whole envelopes, as the server counts them. One tracker per connection (reset() on a new one).
 */
export class AckTracker {
  private received = 0
  private nextToken = 0
  /** token -> size of the envelopes received and not yet applied */
  private readonly pending = new Map<number, number>()
  private backlog = 0
  /** the last report's backlog not counting its largest envelope */
  private lastReportedExcess = 0

  constructor(
    private readonly send: (ack: ViewerAck) => void,
    private readonly holdBytes = BACKLOG_HOLD_BYTES,
  ) {}

  /** A data envelope of this size arrived: it's acknowledged right away. Pass the token to applied() later. */
  arrived(bytes: number): number {
    this.received = (this.received + 1) >>> 0
    const token = this.nextToken++
    this.pending.set(token, bytes)
    this.backlog += bytes
    this.report()
    return token
  }

  /** The envelope was applied (or dropped). Calling it again for the same token does nothing. */
  applied(token: number): void {
    const bytes = this.pending.get(token)
    if (bytes === undefined) {
      return
    }
    this.pending.delete(token)
    this.backlog -= bytes
    if (this.lastReportedExcess > this.holdBytes) {
      this.report()
    }
  }

  /** A new connection: the server counts from zero again. */
  reset(): void {
    this.received = 0
    this.pending.clear()
    this.backlog = 0
    this.lastReportedExcess = 0
  }

  private report() {
    let largest = 0
    for (const bytes of this.pending.values()) {
      largest = Math.max(largest, bytes)
    }
    this.lastReportedExcess = this.backlog - largest
    this.send({ received: this.received, backlogBytes: this.backlog, largestPendingBytes: largest })
  }
}
