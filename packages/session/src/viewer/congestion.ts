/**
 * Congestion control for the data sent to one viewer (see "Transport and congestion control" in ARCHITECTURE.md).
 *
 * BBRv3 as specified in the IETF draft draft-ietf-ccwg-bbr (revision 06), run in user space on top of whatever TCP the
 * kernel uses: pacing our sends at the measured bottleneck rate keeps TCP (with a small TCP_NOTSENT_LOWAT) from ever
 * filling the network's queues. Adapted to messages instead of packets ("items": PATCH and FRAME envelopes), with one
 * substitution: we can't see packet loss or ECN, so a delay signal takes the place of loss (`DELAY_THRESHOLD_MS`).
 * Function and variable names follow the draft's pseudocode (BBR.x -> this.x, C.x -> this.x, RS.x -> this.rs.x), so the
 * code can be checked against it.
 *
 * Pure: no I/O, no timers, no clock of its own. The caller passes the time (ms) to every call. Control messages never
 * go through here: they're never counted, paced or held.
 *
 * Deviations from the draft, besides the delay signal (all marked "deviation" below):
 * - The per-packet state is per item. Items are much larger than packets, so an RTT sample includes the item's own
 *   transmission time at the bottleneck: the delay signal allows for it (size / max_bw on top of the threshold). It
 *   also takes the lowest sample of the last DELAY_NOISE_WINDOW_MS, as acks come in bursts (see sampleQueue()).
 *   min_rtt uses the raw samples (it then includes the smallest items' transmission time, a few ms at most).
 * - Reactions to the delay signal size the in-flight bounds from the measured delivery rate (bw_latest): the draft's
 *   loss reactions (max(inflight_latest, Beta * bound)) never shrink a standing queue without loss, as in a queue a
 *   round's delivered volume is everything in flight. inflight_shortterm becomes bw_latest * (min_rtt +
 *   DELAY_TARGET_MS), a queue of about DELAY_TARGET_MS, below the threshold; inflight_longterm (on a too-high probe,
 *   InflightAtLoss()) becomes bw_latest * (min_rtt + DELAY_THRESHOLD_MS), the volume at which the queue reaches it.
 *   Both include extra_acked, as C.cwnd does: acks handled in bursts keep items "in flight" longer than the path does.
 * - A too-high round outside of bandwidth probing whose delivery rate is well below max_bw (CAPACITY_DROP_FRACTION)
 *   also lowers inflight_longterm (the draft only adapts the short-term bounds there): when the path's capacity
 *   dropped, max_bw stays stale for up to two probe cycles, and the short-term bounds are reset when entering REFILL
 *   and leaving ProbeRTT, which would let the stale estimate fill the queue again. So such a round also restarts the
 *   max_bw filter from the measured delivery rate, and restarts the wait for the next bandwidth probe (no probing for
 *   more right after finding less).
 * - inflight_longterm is raised to a sample's tx_in_flight (AdaptLongTermModel) only if that sample wasn't high.
 * - ProbeBW_UP ends (as if too high) once DELAY_MIN_SAMPLES samples in a row show a queue over DELAY_TARGET_MS: the
 *   probe's own queue keeps growing for a round trip after it crosses the threshold, so waiting for the threshold
 *   itself would let probes peak at threshold + a quarter of a round trip.
 * - A sample from an item sent into an empty pipe that is within a whisker of the current probe_rtt_min_delay
 *   refreshes its timestamp (the draft only takes strictly lower samples), so a mostly idle desktop, whose idle
 *   moments show the base delay, doesn't keep entering ProbeRTT.
 * - When min_rtt rises by more than PATH_CHANGE_FACTOR (it only rises after MinRTTFilterLen without a lower sample),
 *   the path changed: the model starts over in Startup (RestartOnNewPath()). Until then, the delay signal reads the
 *   longer RTT as a queue and cuts the model down, unlike the draft's loss signal; without the restart, regrowing it
 *   by bandwidth probes alone takes many seconds.
 * - The draft's InitPacingRate() uses the handshake's RTT; we have no handshake, so the pacing rate is initialized again
 *   from the first RTT sample (before it, the initial window goes out practically unpaced). Without that, Startup
 *   sends in line-rate bursts whose queue triggers the delay signal long before the pipe is full.
 * - At least `MIN_ITEMS_IN_FLIGHT` items may always be in flight (one large item must never stall the link).
 * - No send quantum (an item is sent whole) and no offload budget.
 */

/** Typical TCP payload per packet, the draft's C.SMSS, for the draft's per-packet constants (MinPipeCwnd, headroom). */
export const SMSS = 1448
/** C.InitialCwnd: the in-flight limit before there is any estimate. */
export const INITIAL_WINDOW = 64 * 1024
/** At least this many data items may always be in flight, so a single large item never stalls the link. */
export const MIN_ITEMS_IN_FLIGHT = 2
/** Stands in for the draft's C.SMSS when growing inflight_longterm in ProbeBW_UP (1, 2, 4, ... of these per round). */
export const PROBE_UNIT = 16 * 1024
/** An RTT sample is "high" if it exceeds min_rtt by more than this (the delay signal, instead of loss). */
export const DELAY_THRESHOLD_MS = 20
/** The delay signal looks at the lowest RTT sample of this long a window (see sampleQueue()). */
export const DELAY_NOISE_WINDOW_MS = 20
/** The queue the short-term in-flight bound aims for when it reacts to the delay signal (below the threshold). */
export const DELAY_TARGET_MS = 10
/** A too-high round with a delivery rate under this fraction of max_bw means the path's capacity dropped. */
export const CAPACITY_DROP_FRACTION = 0.8
/**
 * A round is "too high" once it has at least this many RTT samples and more than half of them are high, or this many
 * high samples came in a row (a long round's early samples predate the queue: waiting for half of them would let the
 * queue grow for a large part of a round trip).
 */
export const DELAY_MIN_SAMPLES = 4

// constants of the draft
const StartupPacingGain = 2.77 // 4 * ln(2)
const DefaultCwndGain = 2
const DrainPacingGain = 0.5
const PacingMarginPercent = 1
const LossThresh = 0.5 // deviation: fraction of high RTT samples in a round, instead of the loss rate (2%)
const Beta = 0.7
const Headroom = 0.15
const MinPipeCwnd = 4 * SMSS
const MaxBwFilterLen = 2
const ExtraAckedFilterLen = 10
const MinRTTFilterLen = 10_000
const ProbeRTTInterval = 5_000
const ProbeRTTDuration = 200
const ProbeRTTCwndGain = 0.5
/** deviation: min_rtt rising by more than this factor means a new path (RestartOnNewPath()) */
const PATH_CHANGE_FACTOR = 1.25
/** deviation: how close an idle sample must be to probe_rtt_min_delay to refresh it */
const IDLE_REFRESH_MARGIN_MS = 1
const IDLE_REFRESH_MARGIN_FRACTION = 0.05

export type CongestionState =
  | 'Startup'
  | 'Drain'
  | 'ProbeBW_DOWN'
  | 'ProbeBW_CRUISE'
  | 'ProbeBW_REFILL'
  | 'ProbeBW_UP'
  | 'ProbeRTT'

type AckPhase = 'ACKS_INIT' | 'ACKS_PROBE_STARTING' | 'ACKS_PROBE_STOPPING' | 'ACKS_PROBE_FEEDBACK' | 'ACKS_REFILLING'

/** What the viewer reports in an ACK envelope (see the scene protocol). */
export type ViewerAck = {
  /** cumulative count of data envelopes received on this connection, mod 2^32 */
  received: number
  /** bytes of data envelopes received but not yet applied */
  backlogBytes: number
  /** the largest single item in that backlog */
  largestPendingBytes: number
}

/** Per-item state (the draft's per-packet state P). */
type SentItem = {
  size: number
  send_time: number
  delivered: number
  delivered_time: number
  first_send_time: number
  is_app_limited: boolean
  /** C.inflight right after sending it */
  tx_in_flight: number
  /** the pipe was empty when it was sent (only it was in flight) */
  sent_into_empty_pipe: boolean
}

/** The draft's rate sample RS, for one ack. */
type RateSample = {
  has_data: boolean
  prior_delivered: number
  prior_time: number
  is_app_limited: boolean
  send_elapsed: number
  ack_elapsed: number
  interval: number
  delivered: number
  delivery_rate: number
  newly_acked: number
  /** RTT of the newest item acked, -1 if none */
  rtt: number
  /** that item's size */
  rtt_size: number
  tx_in_flight: number
  sent_into_empty_pipe: boolean
}

/** A max filter over a window of (virtual) time: keeps the largest value per time unit. */
class WindowedMax {
  private entries: { time: number; value: number }[] = []

  update(value: number, time: number, windowLength: number): number {
    this.entries = this.entries.filter((entry) => entry.time > time - windowLength)
    const last = this.entries[this.entries.length - 1]
    if (last && last.time === time) {
      last.value = Math.max(last.value, value)
    } else {
      this.entries.push({ time, value })
    }
    return this.get()
  }

  /** forget everything, start over with this value */
  reset(value: number, time: number): number {
    this.entries = [{ time, value }]
    return value
  }

  get(): number {
    let max = 0
    for (const entry of this.entries) {
      max = Math.max(max, entry.value)
    }
    return max
  }
}

export class CongestionController {
  // connection state (the draft's C.*)
  private sent: SentItem[] = []
  /** items acked so far (mod 2^32, compared with the viewer's `received`) */
  private ackedCount = 0
  inflight = 0
  cwnd = INITIAL_WINDOW
  pacing_rate = 0
  private delivered = 0
  private delivered_time = 0
  private first_send_time = 0
  private app_limited = 0
  private nextSendAt = 0
  private dataWaiting = false
  private cwndLimitedThisRound = false
  private cwndLimitedLastRound = false
  private rs: RateSample = emptyRateSample()

  // BBR state
  state: CongestionState = 'Startup'
  private pacing_gain = StartupPacingGain
  private cwnd_gain = DefaultCwndGain
  private readonly max_bw_filter = new WindowedMax()
  max_bw = 0
  bw = 0
  private bw_shortterm = Infinity
  private inflight_shortterm = Infinity
  inflight_longterm = Infinity
  private bw_latest = 0
  private inflight_latest = 0
  private cycle_count = 0
  min_rtt = Infinity
  private min_rtt_stamp: number
  private probe_rtt_min_delay = Infinity
  private probe_rtt_min_stamp: number
  private probe_rtt_expired = false
  private probe_rtt_done_stamp = 0
  private probe_rtt_round_done = false
  private prior_cwnd = 0
  private idle_restart = false
  private extra_acked_interval_start: number
  private extra_acked_delivered = 0
  private readonly extra_acked_filter = new WindowedMax()
  private extra_acked = 0
  private full_bw_reached = false
  private full_bw = 0
  private full_bw_count = 0
  private full_bw_now = false
  private probe_up_acked_per_inc = Infinity
  private bw_probe_up_acked = 0
  private bw_probe_up_rounds = 0
  private rounds_since_probe_up = 0
  private is_bw_probe_sample = false
  private prev_probe_too_high = false
  private prev_probe_precautionary = false
  private ack_phase: AckPhase = 'ACKS_INIT'
  private cycle_stamp = 0
  private bw_probe_wait = 0
  private next_round_delivered = 0
  private round_start = false
  round_count = 0
  /** for tests and logs: how often the delay signal cut the bounds outside of probing, and ended a probe */
  readonly stats = { congestionRounds: 0, probesTooHigh: 0, probeRttEntries: 0, pathChanges: 0 }
  private drain_start_round = 0
  private bdp = 0
  private max_inflight = 0
  // the delay signal (instead of the draft's loss signal)
  private is_delay_high_in_round = false
  private delay_round_delivered = 0
  private delay_round_start = false
  private delaySamples = 0
  private delayHighSamples = 0
  private delayHighInARow = 0
  private probeQueueInARow = 0
  private readonly recentRtts: { time: number; rtt: number }[] = []
  private filtered_rtt = Infinity
  // the viewer's backlog
  private backlogBytes = 0
  private largestPendingBytes = 0
  /** the hold threshold: bytes of backlog not counting the largest item */
  private readonly backlogHoldBytes: number
  private readonly random: () => number

  constructor(options: { now?: number; random?: () => number; backlogHoldBytes?: number } = {}) {
    const now = options.now ?? 0
    this.random = options.random ?? Math.random
    this.backlogHoldBytes = options.backlogHoldBytes ?? 1024 * 1024
    // OnInit()
    this.min_rtt_stamp = now
    this.probe_rtt_min_stamp = now
    this.extra_acked_interval_start = now
    this.InitPacingRate()
    this.EnterStartup()
  }

  // -------------------------------------------------------------------------------------------------------------------
  // API for the transport

  /** The latest viewer report says its backlog is too large: send no data items. */
  get holding(): boolean {
    return this.backlogBytes - this.largestPendingBytes > this.backlogHoldBytes
  }

  /** The bottleneck bandwidth estimate (max_bw), in bytes per ms; 0 while unknown. */
  get bandwidthEstimate(): number {
    return this.max_bw
  }

  /** Items sent and not yet acked. */
  get itemsInFlight(): number {
    return this.sent.length
  }

  /** May a data item of this size be handed to the socket now? */
  canSend(bytes: number, now: number): boolean {
    if (!this.windowAllows(bytes)) {
      return false
    }
    return now >= this.nextSendAt
  }

  /**
   * The earliest time a data item of this size may be sent without waiting for an ack: the pacing time if the window
   * allows it, Infinity if only an ack (or the viewer's backlog report) can allow it.
   */
  nextSendTime(bytes: number, now: number): number {
    if (!this.windowAllows(bytes)) {
      return Infinity
    }
    return Math.max(now, this.nextSendAt)
  }

  /**
   * Tell the controller whether the transport has data items ready to send (they may still be waiting for it). Having
   * none while the window would allow sending makes the connection app-limited.
   */
  setDataWaiting(waiting: boolean): void {
    this.dataWaiting = waiting
    if (!waiting) {
      this.CheckIfApplicationLimited()
    }
  }

  /** A data item of this size was handed to the socket. */
  onSend(bytes: number, now: number): void {
    this.OnTransmit(now)
    if (this.inflight === 0) {
      this.first_send_time = now
      this.delivered_time = now
    }
    const sentIntoEmptyPipe = this.inflight === 0
    this.inflight += bytes
    this.sent.push({
      size: bytes,
      send_time: now,
      delivered: this.delivered,
      delivered_time: this.delivered_time,
      first_send_time: this.first_send_time,
      is_app_limited: this.app_limited !== 0,
      tx_in_flight: this.inflight,
      sent_into_empty_pipe: sentIntoEmptyPipe,
    })
    const rate = this.pacing_rate > 0 ? this.pacing_rate : Infinity
    this.nextSendAt = Math.max(this.nextSendAt, now) + bytes / rate
  }

  /** The viewer acknowledged data items (cumulatively) and reported its backlog. */
  onAck(ack: ViewerAck, now: number): void {
    this.backlogBytes = ack.backlogBytes
    this.largestPendingBytes = ack.largestPendingBytes
    const newly = Math.min((ack.received - this.ackedCount) >>> 0, this.sent.length)
    if (newly === 0) {
      // only a backlog update
      this.CheckIfApplicationLimited()
      return
    }
    this.CheckIfApplicationLimited()
    this.rs = emptyRateSample()
    let newlyAckedBytes = 0
    let newest: SentItem | undefined
    for (let i = 0; i < newly; i++) {
      const item = this.sent.shift()!
      this.UpdateRateSample(item, now)
      newlyAckedBytes += item.size
      newest = item
    }
    this.ackedCount = (this.ackedCount + newly) >>> 0
    this.inflight -= newlyAckedBytes
    this.rs.newly_acked = newlyAckedBytes
    if (newest) {
      this.rs.rtt = now - newest.send_time
      this.rs.rtt_size = newest.size
      this.UpdateFilteredRtt(now)
      this.rs.tx_in_flight = newest.tx_in_flight
      this.rs.sent_into_empty_pipe = newest.sent_into_empty_pipe
    }
    this.UpdateOnACK(now)
  }

  // -------------------------------------------------------------------------------------------------------------------
  // the draft's algorithm

  private windowAllows(bytes: number): boolean {
    if (this.holding) {
      return false
    }
    if (this.sent.length < MIN_ITEMS_IN_FLIGHT) {
      return true
    }
    if (this.inflight + bytes <= this.cwnd) {
      return true
    }
    if (this.dataWaiting) {
      this.cwndLimitedThisRound = true
    }
    return false
  }

  private get is_cwnd_limited(): boolean {
    return this.cwndLimitedThisRound || this.cwndLimitedLastRound
  }

  private CheckIfApplicationLimited() {
    if ((!this.dataWaiting || this.holding) && this.inflight < this.cwnd) {
      this.MarkConnectionAppLimited()
    }
  }

  private MarkConnectionAppLimited() {
    this.app_limited = Math.max(this.delivered + this.inflight, 1)
  }

  private UpdateRateSample(P: SentItem, now: number) {
    this.delivered += P.size
    this.delivered_time = now
    // items are acked in order, so every newly acked item is the newest so far
    this.rs.has_data = true
    this.rs.prior_delivered = P.delivered
    this.rs.prior_time = P.delivered_time
    this.rs.is_app_limited = P.is_app_limited
    this.rs.send_elapsed = P.send_time - P.first_send_time
    this.rs.ack_elapsed = this.delivered_time - P.delivered_time
    this.first_send_time = P.send_time
  }

  private GenerateRateSample() {
    if (this.app_limited && this.delivered > this.app_limited) {
      this.app_limited = 0
    }
    if (!this.rs.has_data) {
      return
    }
    this.rs.interval = Math.max(this.rs.send_elapsed, this.rs.ack_elapsed)
    this.rs.delivered = this.delivered - this.rs.prior_delivered
    if (this.rs.interval < this.min_rtt) {
      return // no reliable rate sample
    }
    if (this.rs.interval !== 0) {
      this.rs.delivery_rate = this.rs.delivered / this.rs.interval
    }
  }

  private UpdateOnACK(now: number) {
    this.GenerateRateSample()
    this.UpdateModelAndState(now)
    this.UpdateControlParameters()
  }

  private UpdateModelAndState(now: number) {
    this.UpdateLatestDeliverySignals()
    this.UpdateCongestionSignals(now)
    this.UpdateACKAggregation(now)
    this.CheckFullBWReached()
    this.CheckStartupDone()
    this.CheckDrainDone(now)
    this.UpdateProbeBWCyclePhase(now)
    this.UpdateMinRTT(now)
    this.CheckProbeRTT(now)
    this.AdvanceLatestDeliverySignals()
    this.BoundBWForModel()
  }

  private UpdateControlParameters() {
    this.SetPacingRate()
    this.SetCwnd()
  }

  private OnTransmit(now: number) {
    this.CheckIfApplicationLimited()
    this.HandleRestartFromIdle(now)
  }

  // Startup ------------------------------------------------------------------------------------------------------------

  private EnterStartup() {
    this.state = 'Startup'
    this.pacing_gain = StartupPacingGain
    this.cwnd_gain = DefaultCwndGain
  }

  private CheckStartupDone() {
    this.CheckStartupHighDelay()
    if (this.state === 'Startup' && this.full_bw_reached) {
      this.EnterDrain()
    }
  }

  /** deviation: CheckStartupHighLoss(), with the delay signal: a too-high round in Startup means the pipe is full */
  private CheckStartupHighDelay() {
    if (this.state !== 'Startup' || !this.is_delay_high_in_round) {
      return
    }
    this.full_bw_reached = true
    this.inflight_longterm = Math.max(this.bdp, this.inflight_latest)
  }

  private ResetFullBW() {
    this.full_bw = 0
    this.full_bw_count = 0
    this.full_bw_now = false
  }

  private CheckFullBWReached() {
    if (this.full_bw_now || !this.round_start || this.rs.is_app_limited) {
      return
    }
    if (this.rs.delivery_rate >= this.full_bw * 1.25) {
      this.ResetFullBW()
      this.full_bw = this.rs.delivery_rate
      return
    }
    this.full_bw_count++
    this.full_bw_now = this.full_bw_count >= 3
    if (this.full_bw_now) {
      this.full_bw_reached = true
    }
  }

  // Drain --------------------------------------------------------------------------------------------------------------

  private EnterDrain() {
    this.state = 'Drain'
    this.pacing_gain = DrainPacingGain
    this.cwnd_gain = DefaultCwndGain
    this.drain_start_round = this.round_count
  }

  private CheckDrainDone(now: number) {
    if (
      this.state === 'Drain' &&
      (this.inflight <= this.Inflight(1.0) || this.round_count > this.drain_start_round + 3)
    ) {
      this.EnterProbeBW(now)
    }
  }

  // ProbeBW ------------------------------------------------------------------------------------------------------------

  private EnterProbeBW(now: number) {
    this.cwnd_gain = DefaultCwndGain
    this.StartProbeBW_DOWN(now)
  }

  private StartProbeBW_DOWN(now: number) {
    this.ResetCongestionSignals()
    this.probe_up_acked_per_inc = Infinity
    this.PickProbeWait()
    this.cycle_stamp = now
    this.ack_phase = 'ACKS_PROBE_STOPPING'
    this.StartRound()
    this.state = 'ProbeBW_DOWN'
    this.pacing_gain = 0.9
    this.cwnd_gain = DefaultCwndGain
  }

  private StartProbeBW_CRUISE() {
    this.state = 'ProbeBW_CRUISE'
    this.pacing_gain = 1.0
    this.cwnd_gain = DefaultCwndGain
  }

  private StartProbeBW_REFILL() {
    this.ResetShortTermModel()
    this.bw_probe_up_rounds = 0
    this.bw_probe_up_acked = 0
    this.prev_probe_precautionary = false
    this.ack_phase = 'ACKS_REFILLING'
    this.StartRound()
    this.state = 'ProbeBW_REFILL'
    this.pacing_gain = 1.0
    this.cwnd_gain = DefaultCwndGain
  }

  private StartProbeBW_UP() {
    this.ack_phase = 'ACKS_PROBE_STARTING'
    this.StartRound()
    this.ResetFullBW()
    this.full_bw = this.rs.delivery_rate
    this.state = 'ProbeBW_UP'
    this.pacing_gain = 1.25
    this.cwnd_gain = 2.25
    this.RaiseInflightLongtermSlope()
  }

  private UpdateProbeBWCyclePhase(now: number) {
    if (!this.full_bw_reached) {
      return
    }
    if (this.AdaptLongTermModel()) {
      return
    }
    if (!this.IsInAProbeBWState()) {
      return
    }
    switch (this.state) {
      case 'ProbeBW_DOWN':
        if (this.IsTimeToProbeBW(now)) {
          return
        }
        if (this.IsTimeToCruise()) {
          this.StartProbeBW_CRUISE()
        }
        break
      case 'ProbeBW_CRUISE':
        this.IsTimeToProbeBW(now)
        break
      case 'ProbeBW_REFILL':
        if (this.round_start) {
          this.is_bw_probe_sample = true
          this.StartProbeBW_UP()
        }
        break
      case 'ProbeBW_UP':
        if (this.IsTimeToGoDown()) {
          this.prev_probe_too_high = false
          this.StartProbeBW_DOWN(now)
        }
        break
    }
  }

  private IsInAProbeBWState(): boolean {
    return (
      this.state === 'ProbeBW_DOWN' ||
      this.state === 'ProbeBW_CRUISE' ||
      this.state === 'ProbeBW_REFILL' ||
      this.state === 'ProbeBW_UP'
    )
  }

  private IsTimeToCruise(): boolean {
    if (this.inflight > this.InflightWithHeadroom()) {
      return false
    }
    if (this.inflight > this.Inflight(1.0)) {
      return false
    }
    return true
  }

  private IsTimeToGoDown(): boolean {
    if (this.prev_probe_too_high && this.inflight >= this.inflight_longterm) {
      this.prev_probe_precautionary = true
      return true
    }
    if (this.is_cwnd_limited && this.cwnd >= this.inflight_longterm) {
      this.ResetFullBW()
      this.full_bw = this.rs.delivery_rate
    } else if (this.full_bw_now) {
      return true
    }
    return false
  }

  private IsProbingBW(): boolean {
    return this.state === 'Startup' || this.state === 'ProbeBW_REFILL' || this.state === 'ProbeBW_UP'
  }

  private HasElapsedInPhase(interval: number, now: number): boolean {
    return now > this.cycle_stamp + interval
  }

  private InflightWithHeadroom(): number {
    if (this.inflight_longterm === Infinity) {
      return Infinity
    }
    const headroom = Math.max(SMSS, Headroom * this.inflight_longterm)
    return Math.max(this.inflight_longterm - headroom, MinPipeCwnd)
  }

  private RaiseInflightLongtermSlope() {
    const growth_this_round = 1 << this.bw_probe_up_rounds
    this.bw_probe_up_rounds = Math.min(this.bw_probe_up_rounds + 1, 30)
    this.probe_up_acked_per_inc = Math.max(this.cwnd / growth_this_round, PROBE_UNIT)
  }

  private ProbeInflightLongtermUpward() {
    if (!this.is_cwnd_limited || this.cwnd < this.inflight_longterm) {
      return
    }
    this.bw_probe_up_acked += this.rs.newly_acked
    if (this.bw_probe_up_acked >= this.probe_up_acked_per_inc) {
      const delta = Math.floor(this.bw_probe_up_acked / this.probe_up_acked_per_inc)
      this.bw_probe_up_acked -= delta * this.probe_up_acked_per_inc
      this.inflight_longterm += delta * PROBE_UNIT
    }
    if (this.round_start) {
      this.RaiseInflightLongtermSlope()
    }
  }

  private AdaptLongTermModel(): boolean {
    if (this.ack_phase === 'ACKS_PROBE_STARTING' && this.round_start) {
      this.ack_phase = 'ACKS_PROBE_FEEDBACK'
    }
    if (this.ack_phase === 'ACKS_PROBE_STOPPING' && this.round_start) {
      this.is_bw_probe_sample = false
      this.ack_phase = 'ACKS_INIT'
      if (this.IsInAProbeBWState() && !this.rs.is_app_limited) {
        this.AdvanceMaxBwFilter()
      }
      if (this.IsInAProbeBWState() && this.prev_probe_precautionary && !this.prev_probe_too_high) {
        this.StartProbeBW_REFILL()
        return true
      }
    }
    if (!this.IsInflightTooHigh()) {
      if (this.inflight_longterm === Infinity) {
        return false
      }
      // deviation: only an in-flight volume that didn't make this sample high is known to be safe
      if (this.rs.tx_in_flight > this.inflight_longterm && !this.isHighSample()) {
        this.inflight_longterm = this.rs.tx_in_flight
      }
      if (this.state === 'ProbeBW_UP') {
        this.ProbeInflightLongtermUpward()
      }
    }
    return false
  }

  private IsTimeToProbeBW(now: number): boolean {
    if (this.HasElapsedInPhase(this.bw_probe_wait, now) || this.IsRenoCoexistenceProbeTime()) {
      this.StartProbeBW_REFILL()
      return true
    }
    return false
  }

  private PickProbeWait() {
    this.rounds_since_probe_up = Math.floor(this.random() * 2)
    this.bw_probe_wait = 2000 + this.random() * 1000
  }

  /** T_reno: 62 or 63 rounds at most (PickProbeWait() starts rounds_since_probe_up at 0 or 1). */
  private IsRenoCoexistenceProbeTime(): boolean {
    // The draft counts TargetInflight() in packets here: the network still carries packets of about SMSS each (in
    // items, a typical BDP would be a few rounds, and probes would come far too often).
    const reno_rounds = this.TargetInflight() / SMSS
    const rounds = Math.min(reno_rounds, 63)
    return this.rounds_since_probe_up >= rounds
  }

  private TargetInflight(): number {
    return Math.min(this.bdp, this.cwnd)
  }

  private AdvanceMaxBwFilter() {
    this.cycle_count++
  }

  // ProbeRTT -----------------------------------------------------------------------------------------------------------

  private UpdateMinRTT(now: number) {
    if (this.min_rtt === Infinity && this.rs.rtt > 0 && !this.full_bw_reached) {
      // InitPacingRate() with C.srtt: the draft has the handshake's RTT before sending anything, we have it now
      this.InitPacingRate(this.rs.rtt)
    }
    this.probe_rtt_expired = now > this.probe_rtt_min_stamp + ProbeRTTInterval
    const rtt = this.rs.rtt
    if (rtt >= 0 && (rtt < this.probe_rtt_min_delay || this.probe_rtt_expired)) {
      this.probe_rtt_min_delay = rtt
      this.probe_rtt_min_stamp = now
    } else if (
      rtt >= 0 &&
      this.rs.sent_into_empty_pipe &&
      rtt - this.transmissionTime(this.rs.rtt_size) <=
        this.probe_rtt_min_delay * (1 + IDLE_REFRESH_MARGIN_FRACTION) + IDLE_REFRESH_MARGIN_MS
    ) {
      // deviation: an idle moment showed the base delay again (less the item's own transmission time)
      this.probe_rtt_min_stamp = now
    }
    const min_rtt_expired = now > this.min_rtt_stamp + MinRTTFilterLen
    if (this.probe_rtt_min_delay < this.min_rtt || min_rtt_expired) {
      const previous = this.min_rtt
      this.min_rtt = this.probe_rtt_min_delay
      this.min_rtt_stamp = this.probe_rtt_min_stamp
      if (previous !== Infinity && this.min_rtt > previous * PATH_CHANGE_FACTOR) {
        this.RestartOnNewPath(now)
      }
    }
  }

  /**
   * deviation: the base RTT went up a lot (min_rtt only rises when a whole MinRTTFilterLen had no lower sample): the
   * path changed, so did its bandwidth, probably. Until now the delay signal read the longer RTT as a queue and cut
   * the model down; start over with Startup, which finds the bandwidth in a few round trips.
   */
  private RestartOnNewPath(now: number) {
    this.stats.pathChanges++
    this.ResetShortTermModel()
    this.inflight_longterm = Infinity
    this.full_bw_reached = false
    this.ResetFullBW()
    this.ResetCongestionSignals()
    this.prev_probe_too_high = false
    this.is_bw_probe_sample = false
    this.ack_phase = 'ACKS_INIT'
    this.StartRound()
    this.EnterStartup()
    void now
  }

  private CheckProbeRTT(now: number) {
    if (this.state !== 'ProbeRTT' && this.probe_rtt_expired && !this.idle_restart) {
      this.EnterProbeRTT()
      this.SaveCwnd()
      this.probe_rtt_done_stamp = 0
      this.ack_phase = 'ACKS_PROBE_STOPPING'
      this.StartRound()
    }
    if (this.state === 'ProbeRTT') {
      this.HandleProbeRTT(now)
    }
    if (this.rs.delivered > 0) {
      this.idle_restart = false
    }
  }

  private EnterProbeRTT() {
    this.stats.probeRttEntries++
    this.state = 'ProbeRTT'
    this.pacing_gain = 1
    this.cwnd_gain = ProbeRTTCwndGain
  }

  private HandleProbeRTT(now: number) {
    this.MarkConnectionAppLimited()
    if (this.probe_rtt_done_stamp === 0 && this.inflight <= this.ProbeRTTCwnd()) {
      this.probe_rtt_done_stamp = now + ProbeRTTDuration
      this.probe_rtt_round_done = false
      this.StartRound()
    } else if (this.probe_rtt_done_stamp !== 0) {
      if (this.round_start) {
        this.probe_rtt_round_done = true
      }
      if (this.probe_rtt_round_done) {
        this.CheckProbeRTTDone(now)
      }
    }
  }

  private CheckProbeRTTDone(now: number) {
    if (this.probe_rtt_done_stamp !== 0 && now > this.probe_rtt_done_stamp) {
      this.probe_rtt_min_stamp = now
      this.RestoreCwnd()
      this.ExitProbeRTT(now)
    }
  }

  private ExitProbeRTT(now: number) {
    this.ResetShortTermModel()
    if (this.full_bw_reached) {
      this.StartProbeBW_DOWN(now)
      this.StartProbeBW_CRUISE()
    } else {
      this.EnterStartup()
    }
  }

  private HandleRestartFromIdle(now: number) {
    if (this.inflight === 0 && this.app_limited) {
      this.idle_restart = true
      this.extra_acked_interval_start = now
      if (this.IsInAProbeBWState()) {
        this.SetPacingRateWithGain(1)
      } else if (this.state === 'ProbeRTT') {
        this.CheckProbeRTTDone(now)
      }
    }
  }

  // rounds -------------------------------------------------------------------------------------------------------------

  private UpdateRound() {
    if (this.rs.prior_delivered >= this.next_round_delivered) {
      this.StartRound()
      this.round_count++
      this.rounds_since_probe_up++
      this.round_start = true
      this.cwndLimitedLastRound = this.cwndLimitedThisRound
      this.cwndLimitedThisRound = false
    } else {
      this.round_start = false
    }
  }

  private StartRound() {
    this.next_round_delivered = this.delivered
  }

  // model --------------------------------------------------------------------------------------------------------------

  private UpdateMaxBw() {
    this.UpdateRound()
    if (this.rs.delivery_rate > 0 && (this.rs.delivery_rate >= this.max_bw || !this.rs.is_app_limited)) {
      this.max_bw = this.max_bw_filter.update(this.rs.delivery_rate, this.cycle_count, MaxBwFilterLen)
    }
  }

  private UpdateACKAggregation(now: number) {
    const interval = now - this.extra_acked_interval_start
    let expected_delivered = this.bw * interval
    if (this.extra_acked_delivered <= expected_delivered) {
      this.extra_acked_delivered = 0
      this.extra_acked_interval_start = now
      expected_delivered = 0
    }
    this.extra_acked_delivered += this.rs.newly_acked
    let extra = this.extra_acked_delivered - expected_delivered
    extra = Math.min(extra, this.cwnd)
    const filter_len = this.full_bw_reached ? ExtraAckedFilterLen : 1
    this.extra_acked = this.extra_acked_filter.update(extra, this.round_count, filter_len)
  }

  /**
   * deviation: the delay signal in place of the draft's per-packet loss detection (NoteLoss(), HandleLostPacket()).
   * One RTT sample per ack: the newest item's adjusted RTT.
   */
  private UpdateDelaySignal() {
    if (this.rs.rtt < 0 || this.min_rtt === Infinity) {
      return
    }
    this.delaySamples++
    if (this.isHighSample()) {
      this.delayHighSamples++
      this.delayHighInARow++
    } else {
      this.delayHighInARow = 0
    }
    const queue = this.sampleQueue()
    this.probeQueueInARow = queue !== undefined && queue > DELAY_TARGET_MS ? this.probeQueueInARow + 1 : 0
    if (this.is_bw_probe_sample && this.state === 'ProbeBW_UP' && this.probeQueueInARow >= DELAY_MIN_SAMPLES) {
      // deviation: a bandwidth probe ends as soon as it builds a queue of DELAY_TARGET_MS (see the top of this file)
      this.is_delay_high_in_round = true
      this.HandleInflightTooHigh()
      return
    }
    if (!this.IsInflightTooHigh()) {
      return
    }
    this.is_delay_high_in_round = true // NoteLoss()
    if (this.is_bw_probe_sample) {
      // HandleLostPacket(): reacts once per probe (HandleInflightTooHigh() clears is_bw_probe_sample)
      this.HandleInflightTooHigh()
    }
  }

  /**
   * The queueing delay the RTT samples show, or undefined if there's no sample or no min_rtt yet: the lowest sample
   * of the last DELAY_NOISE_WINDOW_MS, each less its item's own transmission time. Noise only ever adds delay (acks
   * handled in bursts by the viewer's event loop, jitter), a queue lasts: the window's minimum sees through the first.
   */
  private sampleQueue(): number | undefined {
    if (this.rs.rtt < 0 || this.min_rtt === Infinity) {
      return undefined
    }
    return this.filtered_rtt - this.min_rtt
  }

  /** How long an item of this size takes to cross the bottleneck, by max_bw (0 while unknown). */
  private transmissionTime(size: number): number {
    return this.max_bw > 0 ? size / this.max_bw : 0
  }

  private UpdateFilteredRtt(now: number) {
    if (this.rs.rtt < 0) {
      return
    }
    this.recentRtts.push({ time: now, rtt: this.rs.rtt - this.transmissionTime(this.rs.rtt_size) })
    while (this.recentRtts.length > 1 && this.recentRtts[0].time < now - DELAY_NOISE_WINDOW_MS) {
      this.recentRtts.shift()
    }
    this.filtered_rtt = Math.min(...this.recentRtts.map((sample) => sample.rtt))
  }

  /** The newest RTT sample shows a queue over the threshold. */
  private isHighSample(): boolean {
    const queue = this.sampleQueue()
    return queue !== undefined && queue > DELAY_THRESHOLD_MS
  }

  /** The in-flight volume that makes a queue of `queueMs`, by the latest delivery rate (0: unknown). */
  private inflightForQueue(queueMs: number): number {
    if (this.bw_latest <= 0 || this.min_rtt === Infinity) {
      return 0
    }
    // plus the ack aggregation allowance, as C.cwnd has it (UpdateMaxInflight()): acks that come in bursts (the
    // viewer's event loop) keep items in flight longer than the path alone does
    return Math.max(this.bw_latest * (this.min_rtt + queueMs) + this.extra_acked, MinPipeCwnd)
  }

  /**
   * deviation: more than half (LossThresh) of the round's RTT samples (at least DELAY_MIN_SAMPLES) are high, or
   * DELAY_MIN_SAMPLES high samples in a row
   */
  private IsInflightTooHigh(): boolean {
    return (
      this.delayHighInARow >= DELAY_MIN_SAMPLES ||
      (this.delaySamples >= DELAY_MIN_SAMPLES && this.delayHighSamples > this.delaySamples * LossThresh)
    )
  }

  private HandleInflightTooHigh() {
    this.stats.probesTooHigh++
    this.prev_probe_too_high = true
    this.is_bw_probe_sample = false
    if (!this.rs.is_app_limited) {
      // deviation: InflightAtLoss() becomes the in-flight volume at which the queue reaches the delay threshold
      const inflightAtDelay = this.inflightForQueue(DELAY_THRESHOLD_MS)
      this.inflight_longterm = inflightAtDelay > 0 ? inflightAtDelay : this.TargetInflight() * Beta
    }
    if (this.state === 'ProbeBW_UP') {
      this.StartProbeBW_DOWN(this.delivered_time)
    }
  }

  private UpdateLatestDeliverySignals() {
    this.delay_round_start = false
    this.bw_latest = Math.max(this.bw_latest, this.rs.delivery_rate)
    this.inflight_latest = Math.max(this.inflight_latest, this.rs.delivered)
    if (this.rs.prior_delivered >= this.delay_round_delivered) {
      this.delay_round_delivered = this.delivered
      this.delay_round_start = true
    }
  }

  private AdvanceLatestDeliverySignals() {
    if (this.delay_round_start) {
      this.bw_latest = this.rs.delivery_rate
      this.inflight_latest = this.rs.delivered
    }
  }

  private ResetCongestionSignals() {
    this.is_delay_high_in_round = false
    this.delaySamples = 0
    this.delayHighSamples = 0
    this.delayHighInARow = 0
    this.bw_latest = 0
    this.inflight_latest = 0
  }

  private UpdateCongestionSignals(now: number) {
    this.UpdateMaxBw()
    if (this.delay_round_start) {
      // a new round of delay samples (the draft's loss round)
      this.AdaptLowerBoundsFromCongestion(now)
      this.is_delay_high_in_round = false
      this.delaySamples = 0
      this.delayHighSamples = 0
      this.delayHighInARow = 0
    }
    this.UpdateDelaySignal()
  }

  private AdaptLowerBoundsFromCongestion(now: number) {
    if (this.IsProbingBW()) {
      return
    }
    if (this.is_delay_high_in_round) {
      this.stats.congestionRounds++
      this.InitLowerBounds()
      this.LossLowerBounds()
      // deviation: the path's capacity dropped (see the top of this file)
      const inflightAtDelay = this.inflightForQueue(DELAY_THRESHOLD_MS)
      if (inflightAtDelay > 0 && !this.rs.is_app_limited && this.bw_latest < CAPACITY_DROP_FRACTION * this.max_bw) {
        this.inflight_longterm = Math.min(this.inflight_longterm, inflightAtDelay)
        this.max_bw = this.max_bw_filter.reset(this.bw_latest, this.cycle_count)
        if (this.state === 'ProbeBW_DOWN' || this.state === 'ProbeBW_CRUISE') {
          // ... and don't probe for more bandwidth right after finding less
          this.PickProbeWait()
          this.cycle_stamp = now
        }
      }
    }
  }

  private InitLowerBounds() {
    if (this.bw_shortterm === Infinity) {
      this.bw_shortterm = this.max_bw
    }
    if (this.inflight_shortterm === Infinity) {
      this.inflight_shortterm = this.cwnd
    }
  }

  private LossLowerBounds() {
    this.bw_shortterm = Math.max(this.bw_latest, Beta * this.bw_shortterm)
    // deviation: sized from the delivery rate (see the top of this file)
    const inflightAtDelay = this.inflightForQueue(DELAY_TARGET_MS)
    this.inflight_shortterm =
      inflightAtDelay > 0 ? inflightAtDelay : Math.max(this.inflight_latest, Beta * this.inflight_shortterm)
  }

  private ResetShortTermModel() {
    this.bw_shortterm = Infinity
    this.inflight_shortterm = Infinity
  }

  private BoundBWForModel() {
    this.bw = Math.min(this.max_bw, this.bw_shortterm)
  }

  // pacing and cwnd ----------------------------------------------------------------------------------------------------

  /** srtt: the first RTT sample; before it, 1 ms (the initial window goes out practically unpaced) */
  private InitPacingRate(srtt = 1) {
    const nominal_bandwidth = INITIAL_WINDOW / srtt // bytes per ms
    this.pacing_rate = StartupPacingGain * nominal_bandwidth
  }

  private SetPacingRateWithGain(pacing_gain: number) {
    const rate = (pacing_gain * this.bw * (100 - PacingMarginPercent)) / 100
    if (this.full_bw_reached || rate > this.pacing_rate) {
      this.pacing_rate = rate
    }
  }

  private SetPacingRate() {
    this.SetPacingRateWithGain(this.pacing_gain)
  }

  private BDPMultiple(gain: number): number {
    if (this.min_rtt === Infinity) {
      return INITIAL_WINDOW
    }
    this.bdp = this.bw * this.min_rtt
    return gain * this.bdp
  }

  private QuantizationBudget(inflight_cap: number): number {
    inflight_cap = Math.max(inflight_cap, MinPipeCwnd)
    if (this.state === 'ProbeBW_UP') {
      inflight_cap += 2 * SMSS
    }
    return inflight_cap
  }

  private Inflight(gain: number): number {
    return this.QuantizationBudget(this.BDPMultiple(gain))
  }

  private UpdateMaxInflight() {
    let inflight_cap = this.BDPMultiple(this.cwnd_gain)
    inflight_cap += this.extra_acked
    this.max_inflight = this.QuantizationBudget(inflight_cap)
  }

  private SaveCwnd() {
    if (this.state !== 'ProbeRTT') {
      this.prior_cwnd = this.cwnd
    } else {
      this.prior_cwnd = Math.max(this.prior_cwnd, this.cwnd)
    }
  }

  private RestoreCwnd() {
    this.cwnd = Math.max(this.cwnd, this.prior_cwnd)
  }

  private ProbeRTTCwnd(): number {
    return Math.max(this.BDPMultiple(ProbeRTTCwndGain), MinPipeCwnd)
  }

  private BoundCwndForProbeRTT() {
    if (this.state === 'ProbeRTT') {
      this.cwnd = Math.min(this.cwnd, this.ProbeRTTCwnd())
    }
  }

  private SetCwnd() {
    this.UpdateMaxInflight()
    if (this.full_bw_reached) {
      this.cwnd = Math.min(this.cwnd + this.rs.newly_acked, this.max_inflight)
    } else if (this.cwnd < this.max_inflight || this.delivered < INITIAL_WINDOW) {
      this.cwnd = this.cwnd + this.rs.newly_acked
    }
    this.cwnd = Math.max(this.cwnd, MinPipeCwnd)
    this.BoundCwndForProbeRTT()
    this.BoundCwndForModel()
  }

  private BoundCwndForModel() {
    let cap = Infinity
    if (this.IsInAProbeBWState() && this.state !== 'ProbeBW_CRUISE') {
      cap = this.inflight_longterm
    } else if (this.state === 'ProbeRTT' || this.state === 'ProbeBW_CRUISE') {
      cap = this.InflightWithHeadroom()
    }
    cap = Math.min(cap, this.inflight_shortterm)
    cap = Math.max(cap, MinPipeCwnd)
    this.cwnd = Math.min(this.cwnd, cap)
  }
}

function emptyRateSample(): RateSample {
  return {
    has_data: false,
    prior_delivered: 0,
    prior_time: 0,
    is_app_limited: false,
    send_elapsed: 0,
    ack_elapsed: 0,
    interval: 0,
    delivered: 0,
    delivery_rate: 0,
    newly_acked: 0,
    rtt: -1,
    rtt_size: 0,
    tx_in_flight: 0,
    sent_into_empty_pipe: false,
  }
}
