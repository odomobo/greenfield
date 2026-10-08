import { WebSocket } from 'ws'
import { Socket } from 'node:net'
import { performance } from 'node:perf_hooks'
import { createLogger } from '../Logger.js'
import type { SendTier, SurfaceClass } from '../encoding/policy.js'
import { setSocketSendBuffer, setTcpNotSentLowat } from '../socket-options.js'
import { CongestionController } from './congestion.js'
import { BandwidthMonitor } from './bandwidth.js'

/** What the transport needs of a congestion controller (tests pass one that never holds anything back). */
export type Congestion = Pick<CongestionController, 'canSend' | 'nextSendTime' | 'onSend' | 'onAck' | 'setDataWaiting'> &
  Partial<Pick<CongestionController, 'bandwidthEstimate'>>
import {
  AudioPacket,
  CHUNK_HEADER_BYTES,
  decodeViewerEnvelope,
  encodeChunk,
  EnvelopeKind,
  encodeAudio,
  encodeControl,
  encodeFrame,
  encodePatch,
  isKeyFrame,
  Patch,
  ViewerAck,
} from './protocol.js'

const logger = createLogger('viewer-transport')

export type ControlMessage = { type: string; [key: string]: any }

export type OutgoingMessage =
  | { readonly priority: 'control'; readonly message: ControlMessage }
  /**
   * An audio packet (see the AUDIO envelope): control priority, sent right away, but dropped instead of queued when
   * the connection's send buffer is full.
   */
  | { readonly priority: 'audio'; readonly packet: AudioPacket }
  /**
   * Video frames and patches carry their surface's priority class, and `done`, which is called once: sent true when
   * handed to the socket, false when dropped unsent.
   */
  | {
      readonly priority: 'frame'
      readonly surface: string
      readonly frame: Uint8Array
      readonly surfaceClass: SurfaceClass
      readonly done?: (sent: boolean) => void
    }
  /** A patch's tier: its surface's class, or settle for a lossless resend of a lossy area. */
  | {
      readonly priority: 'patch'
      readonly surface: string
      readonly patch: Patch
      readonly tier: SendTier
      readonly done?: (sent: boolean) => void
    }

/**
 * Connection to one viewer. Kept small so the WebSocket implementation can later be swapped for e.g. WebTransport
 * (independent streams per surface + datagrams for input).
 */
export interface ViewerTransport {
  /**
   * Queue a message. Control messages are always sent before pending frames and patches, never held back; audio
   * packets are written to the socket at once too (not subject to the congestion controller, never dropped: late
   * audio is the viewer's jitter buffer's to handle). Of the rest, the three send tiers (the normal and
   * streaming classes, then settling) share the link by byte-weighted deficit round-robin (9 : 3 : 1, work-conserving),
   * surfaces of a tier take turns, one item per visit, as fast as the congestion controller lets them go (see
   * congestion.ts: pacing, in-flight limit, the viewer's backlog). Video frames and patches of a surface are sent in
   * order, so a surface's items wait in the highest tier of any of them. Items larger than the chunk size (chunkSize)
   * go out in chunks (CHUNK envelopes): control messages and audio go between any two, a higher tier's items too, but a
   * tier sends one item at a time (its started item continues until done), and a surface's next item waits for its
   * started one. A started item is never dropped. A video key frame replaces everything unsent
   * of its surface (it covers the whole surface),
   * delta frames are chained behind it up to a small limit. Patches are never coalesced or dropped, except by a later
   * key frame or the calls below.
   */
  send(message: OutgoingMessage): void

  /**
   * Drop what is queued for this surface and only send video for it again from its next key frame on (e.g. the
   * viewer's decoder failed and asked for one, or the surface starts streaming video).
   */
  requireKeyFrame(surface: string): void

  /** Drop the unsent patches of this surface. */
  dropPatches(surface: string): void

  /**
   * The link is short of bandwidth for the streaming class (see bandwidth.ts): its surfaces go lossy (JPEG patches,
   * lower-quality video) while it is.
   */
  readonly bandwidthLimited: boolean

  /** The link's bandwidth (bytes per ms) as measured when it was saturated; undefined if it never was. */
  readonly linkBandwidth: number | undefined

  /** The bytes of the surface's frames and patches waiting to be sent, except settling patches. */
  queuedBytes(surface: string): number

  close(code: number, reason: string): void

  readonly closed: boolean

  onMessage: (message: ControlMessage) => void
  /** The next bytes of an uploaded file (see the scene protocol's `file-drop`). */
  onFileChunk: (id: number, data: Uint8Array) => void
  /** The viewer acknowledged data envelopes and reported its backlog (see the scene protocol's ACK). */
  onAck: (ack: ViewerAck) => void
  onClose: (code: number, reason: string) => void
  /**
   * A frame for this surface had to be dropped and the following frames can't be decoded without a key frame.
   */
  onKeyFrameNeeded: (surface: string) => void
}

// Keep the kernel's unsent backlog small, so frames wait in our queue where they can still be coalesced and control
// messages can overtake them.
const TCP_NOTSENT_LOWAT_BYTES = 32 * 1024
// Same idea when the viewer is relayed to us over a Unix socket (by the gateway): cap the kernel send buffer.
const UNIX_SEND_BUFFER_BYTES = 32 * 1024
// A safety limit under the congestion controller: never hand a data item to the socket while more than this is still
// buffered in user space (with the controller working, it shouldn't be reached).
const SEND_BUFFERED_LIMIT = 256 * 1024
// Deficit round-robin between the send tiers: each turn a tier may send up to its quantum (plus what it carried over)
// in bytes. Normal surfaces get 3 times the share of streaming ones, which get 3 times the share of settling, and the
// others get all of the link when a tier has nothing waiting.
const DRR_QUANTUM_STREAMING_BASE = 16 * 1024
const DRR_QUANTUM: Record<SendTier, number> = {
  normal: 3 * DRR_QUANTUM_STREAMING_BASE,
  streaming: DRR_QUANTUM_STREAMING_BASE,
  settle: Math.round(DRR_QUANTUM_STREAMING_BASE / 3),
}
/** The tiers from the highest priority, the round-robin's order. */
const TIERS: readonly SendTier[] = ['normal', 'streaming', 'settle']
// Items larger than this are sent in chunks of this size: about 10 ms of the link at the congestion controller's
// bandwidth estimate, at least CHUNK_MIN_BYTES (a slow link, or no estimate yet) and at most CHUNK_MAX_BYTES (an
// overestimate). So nothing else waits behind one data item for long, and the message (and ack) rate stays moderate.
export const CHUNK_MS = 10
export const CHUNK_MIN_BYTES = 10 * 1024
export const CHUNK_MAX_BYTES = 300 * 1024
// The simulated link logs audio waiting longer than this behind other data (see noteLinkAudioWait).
const LINK_AUDIO_WAIT_LOG_MS = 30
// Max unsent delta frames per surface. Beyond that the viewer is too far behind: drop them and resync with a key frame.
const MAX_UNSENT_FRAMES_PER_SURFACE = 3

type QueuedEntry = { readonly tier: SendTier; readonly done?: (sent: boolean) => void } & (
  | { readonly kind: 'frame'; readonly frame: Uint8Array }
  | { readonly kind: 'patch'; readonly envelope: Uint8Array }
)

/**
 * DEVELOPMENT ONLY (the gateway's --dev-link-kbps): a simulated bottleneck of this many bytes per ms between the
 * transport and the socket. Everything sent (control messages and audio too, in order) waits in a FIFO and leaves at
 * that rate, as through a slow link with a deep buffer, so the congestion controller sees the queue and the bandwidth.
 * As with a real socket, a write is done (the item's slot is free) as soon as the FIFO took it.
 */
export type SimulatedLink = { bytesPerMs: number }

function dropEntries(entries: QueuedEntry[]) {
  for (const entry of entries) {
    entry.done?.(false)
  }
}

function sizeOf(entry: QueuedEntry): number {
  return entry.kind === 'frame' ? entry.frame.length : entry.envelope.length
}

/** A data item being sent in chunks: its envelope and how much of it went out. */
type StartedItem = { readonly entry: QueuedEntry; readonly envelope: Uint8Array; readonly id: number; sent: number }

/** The next piece of a data item to hand to the socket. */
type NextSend = {
  surface: string
  entry: QueuedEntry
  /** what to write: the whole envelope, or a CHUNK of it */
  data: Uint8Array
  /** its first piece (a key frame is sent from here on) */
  first: boolean
  /** its last piece (the item is done once it's written) */
  last: boolean
}

const nextTier = (tier: SendTier): SendTier => TIERS[(TIERS.indexOf(tier) + 1) % TIERS.length]

/** The tier a surface's items wait in: the highest of any of them (they're sent in order). */
function tierOf(chain: QueuedEntry[]): SendTier {
  let rank = TIERS.length - 1
  for (const entry of chain) {
    rank = Math.min(rank, TIERS.indexOf(entry.tier))
  }
  return TIERS[rank]
}

export class WebSocketViewerTransport implements ViewerTransport {
  onMessage: (message: ControlMessage) => void = () => {
    /* noop */
  }
  onFileChunk: (id: number, data: Uint8Array) => void = () => {
    /* noop */
  }
  onAck: (ack: ViewerAck) => void = () => {
    /* noop */
  }
  onClose: (code: number, reason: string) => void = () => {
    /* noop */
  }
  onKeyFrameNeeded: (surface: string) => void = () => {
    /* noop */
  }

  private readonly controlQueue: Buffer[] = []
  /**
   * Unsent frames and patches per surface, in order. Video in a chain starts with a key frame or continues a stream
   * the viewer already decodes. Map iteration order (insertion) is the round-robin order between surfaces: a surface
   * goes to the back after each of its items is sent. A surface's tier is the highest of its items' (see tierOf).
   */
  private readonly pendingFrames = new Map<string, QueuedEntry[]>()
  /**
   * Items being sent in chunks, at most one per surface (its next item waits) and one per tier (a tier continues its
   * started item before it starts another). They are out of their surface's chain: never dropped.
   */
  private readonly started = new Map<string, StartedItem>()
  private nextItemId = 0
  private readonly chunkBytes: { min: number; max: number }
  /** FRAME envelopes encoded while asking whether they may go (the controller may say not yet) */
  private readonly frameEnvelopes = new WeakMap<QueuedEntry, Uint8Array>()
  /** deficit round-robin state: whose turn it is, whether it got its quantum for this turn, bytes carried over */
  private drrTurn: SendTier = 'normal'
  private drrQuantumGiven = false
  private readonly drrDeficit: Record<SendTier, number> = { normal: 0, streaming: 0, settle: 0 }
  /**
   * Surfaces whose next frame must be a key frame because a frame was dropped.
   */
  private readonly needsKeyFrame = new Set<string>()
  private readonly keyFrameSent = new Set<string>()
  private readonly congestion: Congestion
  private readonly now: () => number
  /** wakes the pump when the controller's pacing lets the next item go */
  private pacingTimer?: NodeJS.Timeout
  private pacingAt = Infinity
  private safetyLimitLogged = false
  private _closed = false
  private readonly bandwidth: BandwidthMonitor
  private readonly link?: SimulatedLink
  /** the simulated link's queue (see SimulatedLink) and when it is free again */
  private readonly linkQueue: { data: Uint8Array; at: number }[] = []
  private linkFreeAt = 0
  private linkTimer?: NodeJS.Timeout
  /** the longest an audio packet waited in the simulated link this second, and when the second began */
  private linkAudioWait = 0
  private linkAudioWaitSince = 0

  constructor(
    private readonly ws: WebSocket,
    options: {
      now?: () => number
      congestion?: Congestion
      link?: SimulatedLink
      /** the predicted backlog of the surfaces' damage not handed to the transport yet (see bandwidth.ts) */
      unencodedBytes?: () => number
      /** the chunk size's bounds (see CHUNK_MS), for tests */
      chunkBytes?: { min: number; max: number }
    } = {},
  ) {
    this.now = options.now ?? (() => performance.now())
    this.congestion = options.congestion ?? new CongestionController({ now: this.now() })
    this.link = options.link
    this.chunkBytes = options.chunkBytes ?? { min: CHUNK_MIN_BYTES, max: CHUNK_MAX_BYTES }
    const unencodedBytes = options.unencodedBytes ?? (() => 0)
    this.bandwidth = new BandwidthMonitor(
      this.now(),
      () => this.congestion.bandwidthEstimate ?? 0,
      () => this.queuedBacklogBytes() + unencodedBytes(),
      (limited, { held, backlogMs }) =>
        logger.info(
          limited
            ? `Bandwidth-limited: streaming surfaces go lossy (held back ${Math.round(held * 100)}% of the period, predicted backlog ${Math.round(backlogMs)} ms).`
            : `No longer bandwidth-limited: streaming surfaces go lossless again (held back ${Math.round(held * 100)}% of the last second, predicted backlog ${Math.round(backlogMs)} ms).`,
        ),
    )
    ws.binaryType = 'nodebuffer'
    this.limitSocketBacklog()
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        this.close(4400, 'Expected binary messages.')
        return
      }
      let envelope: ReturnType<typeof decodeViewerEnvelope>
      try {
        envelope = decodeViewerEnvelope(data)
      } catch (e: any) {
        logger.error(`Invalid message from viewer: ${e.message}`)
        this.close(4400, e.message)
        return
      }
      if (envelope.kind === 'file') {
        this.onFileChunk(envelope.id, envelope.data)
      } else if (envelope.kind === 'ack') {
        this.congestion.onAck(envelope, this.now())
        this.onAck(envelope)
        this.pump()
      } else {
        this.onMessage(envelope.message)
      }
    })
    ws.on('close', (code, reason) => {
      this._closed = true
      this.clearPacingTimer()
      this.clearLink()
      this.dropAll()
      this.onClose(code, reason.toString())
    })
    ws.on('error', (error) => logger.error(`Viewer connection error: ${error.message}`))
  }

  get closed(): boolean {
    return this._closed
  }

  get bandwidthLimited(): boolean {
    return this.bandwidth.limited(this.now())
  }

  get linkBandwidth(): number | undefined {
    return this.bandwidth.linkBandwidth
  }

  queuedBytes(surface: string): number {
    let bytes = 0
    const started = this.started.get(surface)
    if (started !== undefined && started.entry.tier !== 'settle') {
      bytes += started.envelope.length - started.sent
    }
    for (const entry of this.pendingFrames.get(surface) ?? []) {
      if (entry.tier !== 'settle') {
        bytes += sizeOf(entry)
      }
    }
    return bytes
  }

  private queuedBacklogBytes(): number {
    let bytes = 0
    for (const surface of new Set([...this.pendingFrames.keys(), ...this.started.keys()])) {
      bytes += this.queuedBytes(surface)
    }
    return bytes
  }

  send(message: OutgoingMessage): void {
    if (this._closed) {
      if (message.priority === 'frame' || message.priority === 'patch') {
        message.done?.(false)
      }
      return
    }
    if (message.priority === 'audio') {
      this.sendAudio(message.packet)
      return
    }
    if (message.priority === 'control') {
      this.controlQueue.push(Buffer.from(encodeControl(message.message)))
    } else if (message.priority === 'frame') {
      this.queueFrame(message.surface, message.frame, message.surfaceClass, message.done)
    } else {
      this.queuePatch(message.surface, message.patch, message.tier, message.done)
    }
    this.pump()
  }

  private sendAudio(packet: AudioPacket) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return
    }
    // after queued control messages (normally none wait), before any data item
    this.flushControl()
    this.write(encodeAudio(packet))
  }

  close(code: number, reason: string): void {
    if (this._closed) {
      return
    }
    this._closed = true
    this.clearPacingTimer()
    this.clearLink()
    this.dropAll()
    this.controlQueue.length = 0
    this.ws.close(code, reason)
  }

  requireKeyFrame(surface: string): void {
    this.dropQueued(surface)
    this.needsKeyFrame.add(surface)
  }

  dropPatches(surface: string): void {
    const chain = this.pendingFrames.get(surface)
    if (chain === undefined) {
      return
    }
    const kept = chain.filter((entry) => entry.kind !== 'patch')
    dropEntries(chain.filter((entry) => entry.kind === 'patch'))
    if (kept.length) {
      this.pendingFrames.set(surface, kept)
    } else {
      this.pendingFrames.delete(surface)
    }
  }

  private dropQueued(surface: string) {
    const chain = this.pendingFrames.get(surface)
    this.pendingFrames.delete(surface)
    if (chain) {
      dropEntries(chain)
    }
  }

  private dropAll() {
    for (const chain of this.pendingFrames.values()) {
      dropEntries(chain)
    }
    this.pendingFrames.clear()
    dropEntries([...this.started.values()].map(({ entry }) => entry))
    this.started.clear()
  }

  private get dataWaiting(): boolean {
    return this.pendingFrames.size > 0 || this.started.size > 0
  }

  /** The current chunk size (see CHUNK_MS). */
  private get chunkSize(): number {
    const estimate = this.congestion.bandwidthEstimate ?? 0
    const { min, max } = this.chunkBytes
    return Math.min(max, Math.max(min, Math.round(estimate * CHUNK_MS)))
  }

  /** The item's envelope (a frame's is encoded once, the first time it's needed). */
  private envelopeOf(surface: string, entry: QueuedEntry): Uint8Array {
    if (entry.kind === 'patch') {
      return entry.envelope
    }
    let envelope = this.frameEnvelopes.get(entry)
    if (envelope === undefined) {
      envelope = encodeFrame(surface, entry.frame)
      this.frameEnvelopes.set(entry, envelope)
    }
    return envelope
  }

  /** The tier a surface's items wait in, its started one included (they go in order). */
  private surfaceTier(surface: string): SendTier {
    const chain = this.pendingFrames.get(surface) ?? []
    const started = this.started.get(surface)
    return tierOf(started ? [started.entry, ...chain] : chain)
  }

  private queueFrame(surface: string, frame: Uint8Array, surfaceClass: SurfaceClass, done?: (sent: boolean) => void) {
    const entry: QueuedEntry = { kind: 'frame', frame, tier: surfaceClass, done }
    if (isKeyFrame(frame)) {
      // everything unsent is superseded, a key frame covers the whole surface
      this.dropQueued(surface)
      this.pendingFrames.set(surface, [entry])
      this.needsKeyFrame.delete(surface)
      return
    }

    const chain = this.pendingFrames.get(surface)
    const decodable = !this.needsKeyFrame.has(surface) && (this.keyFrameSent.has(surface) || chain !== undefined)
    if (!decodable) {
      // the viewer can't decode this, wait for a key frame
      done?.(false)
      this.requestKeyFrame(surface)
      return
    }

    const unsentVideo = chain?.filter((entry) => entry.kind === 'frame').length ?? 0
    if (chain === undefined) {
      this.pendingFrames.set(surface, [entry])
    } else if (unsentVideo < MAX_UNSENT_FRAMES_PER_SURFACE) {
      chain.push(entry)
    } else {
      // too far behind, resync
      done?.(false)
      this.dropQueued(surface)
      this.requestKeyFrame(surface)
    }
  }

  private queuePatch(surface: string, patch: Patch, tier: SendTier, done?: (sent: boolean) => void) {
    const entry: QueuedEntry = { kind: 'patch', envelope: encodePatch(surface, patch), tier, done }
    const chain = this.pendingFrames.get(surface)
    if (chain === undefined) {
      this.pendingFrames.set(surface, [entry])
    } else {
      chain.push(entry)
    }
  }

  /**
   * What the tier sends next: its started item (one at a time), else the first surface of the tier in round-robin
   * order with nothing started, and its chain of items.
   */
  private findHead(
    tier: SendTier,
  ): { surface: string; started: StartedItem } | { surface: string; chain: QueuedEntry[] } | undefined {
    for (const [surface, started] of this.started) {
      if (this.surfaceTier(surface) === tier) {
        return { surface, started }
      }
    }
    for (const [surface, chain] of this.pendingFrames) {
      if (!this.started.has(surface) && tierOf(chain) === tier) {
        return { surface, chain }
      }
    }
    return undefined
  }

  /** The next chunk of a started item; the item is done with its last. */
  private nextChunk(surface: string, item: StartedItem): NextSend {
    const end = Math.min(item.envelope.length, item.sent + this.chunkSize)
    return {
      surface,
      entry: item.entry,
      data: encodeChunk(item.id, item.envelope, item.sent, end),
      first: item.sent === 0,
      last: end >= item.envelope.length,
    }
  }

  /**
   * The next data item (or chunk) to send, by deficit round-robin between the tiers, weighted by bytes: on its turn a
   * tier adds its quantum to its deficit and sends items (chunks) while the next fits in the deficit. A tier with
   * nothing waiting loses its turn and its deficit, so the others share the whole link. If nothing is taken (nothing is
   * waiting, or `allowed` refuses the next piece by its size), the round-robin state stays as it was: the transport asks
   * again whenever the congestion controller might allow more, and those questions must not count as turns.
   */
  private takeNext(allowed: (envelopeBytes: number) => boolean): NextSend | undefined {
    if (!this.dataWaiting) {
      return undefined
    }
    const saved = { turn: this.drrTurn, quantumGiven: this.drrQuantumGiven, ...this.drrDeficit }
    const nothingTaken = () => {
      this.drrTurn = saved.turn
      this.drrQuantumGiven = saved.quantumGiven
      for (const tier of TIERS) {
        this.drrDeficit[tier] = saved[tier]
      }
      return undefined
    }
    // a deficit grows every turn, so even a huge item fits eventually
    for (let turns = 0; turns < 10_000; turns++) {
      const turn = this.drrTurn
      const head = this.findHead(turn)
      if (head === undefined) {
        this.drrDeficit[turn] = 0
        this.drrQuantumGiven = false
        this.drrTurn = nextTier(turn)
        continue
      }
      if (!this.drrQuantumGiven) {
        this.drrQuantumGiven = true
        this.drrDeficit[turn] += DRR_QUANTUM[turn]
      }
      let next: NextSend
      let start: (() => void) | undefined
      if ('started' in head) {
        next = this.nextChunk(head.surface, head.started)
      } else {
        const entry = head.chain[0]
        const envelope = this.envelopeOf(head.surface, entry)
        if (envelope.length <= this.chunkSize) {
          next = { surface: head.surface, entry, data: envelope, first: true, last: true }
        } else {
          const item: StartedItem = { entry, envelope, id: this.nextItemId, sent: 0 }
          next = this.nextChunk(head.surface, item)
          start = () => {
            this.nextItemId = (this.nextItemId + 1) >>> 0
            this.started.set(head.surface, item)
          }
        }
      }
      const cost = next.data.length - (next.last && next.first ? 0 : CHUNK_HEADER_BYTES)
      if (cost <= this.drrDeficit[turn]) {
        if (!allowed(next.data.length)) {
          return nothingTaken()
        }
        this.drrDeficit[turn] -= cost
        if (next.first) {
          // out of the chain: from here on it's sent, whatever is dropped
          const chain = this.pendingFrames.get(head.surface)!
          chain.shift()
          if (chain.length === 0) {
            this.pendingFrames.delete(head.surface)
          }
          start?.()
        }
        const started = this.started.get(head.surface)
        if (started !== undefined && !next.last) {
          started.sent += next.data.length - CHUNK_HEADER_BYTES
        }
        if (next.last) {
          this.started.delete(head.surface)
          // back of the line, for fairness between surfaces
          const chain = this.pendingFrames.get(head.surface)
          if (chain !== undefined) {
            this.pendingFrames.delete(head.surface)
            this.pendingFrames.set(head.surface, chain)
          }
        }
        return next
      }
      this.drrQuantumGiven = false
      this.drrTurn = nextTier(turn)
    }
    return nothingTaken()
  }

  private requestKeyFrame(surface: string) {
    if (this.needsKeyFrame.has(surface)) {
      return
    }
    this.needsKeyFrame.add(surface)
    this.onKeyFrameNeeded(surface)
  }

  private pump() {
    if (this._closed || this.ws.readyState !== WebSocket.OPEN) {
      return
    }

    // Control messages always go first, they are small, and the congestion controller never holds them back. A burst
    // of them (e.g. on attach) can fill the socket past SEND_BUFFERED_LIMIT, so once one is written, check again for
    // data to send.
    this.flushControl()

    this.congestion.setDataWaiting(this.dataWaiting)
    // data waits because the controller or the socket holds it back (not because there's none)
    let held = false
    for (;;) {
      if (this.ws.bufferedAmount > SEND_BUFFERED_LIMIT) {
        // a send's callback pumps again
        if (!this.safetyLimitLogged && this.dataWaiting) {
          this.safetyLimitLogged = true
          logger.info(`More than ${SEND_BUFFERED_LIMIT} bytes buffered for the viewer, holding data items.`)
        }
        held = true
        break
      }
      const now = this.now()
      let refused: number | undefined
      const next = this.takeNext((bytes) => {
        if (this.congestion.canSend(bytes, now)) {
          return true
        }
        refused = bytes
        return false
      })
      if (next === undefined) {
        if (refused !== undefined) {
          // paced: wake up when it's due; waiting for an ack (or the viewer's backlog report): the ack pumps
          this.schedulePacing(this.congestion.nextSendTime(refused, now), now)
          held = true
        }
        break
      }
      const { surface, entry, data } = next
      if (next.first && entry.kind === 'frame' && isKeyFrame(entry.frame)) {
        this.keyFrameSent.add(surface)
      }
      this.congestion.onSend(data.length, now)
      // The callback fires once the data was handed to the kernel. With TCP_NOTSENT_LOWAT that means most of it has
      // actually left; the item's slot is free from then on (once its last chunk is).
      this.write(
        data,
        next.last
          ? () => {
              entry.done?.(true)
              this.pump()
            }
          : () => this.pump(),
      )
    }
    this.congestion.setDataWaiting(this.dataWaiting)
    this.bandwidth.setHeld(held && this.findHead('streaming') !== undefined, this.now())
  }

  private flushControl() {
    while (this.controlQueue.length) {
      this.write(this.controlQueue.shift()!, () => this.pump())
    }
  }

  /** Hand bytes to the socket (through the simulated link, if there is one); `sent` once the socket took them. */
  private write(data: Uint8Array, sent?: () => void) {
    if (this.link === undefined) {
      this.ws.send(data, { binary: true }, sent)
      return
    }
    const now = this.now()
    this.linkFreeAt = Math.max(now, this.linkFreeAt) + data.byteLength / this.link.bytesPerMs
    this.linkQueue.push({ data, at: this.linkFreeAt })
    if (data[1] === EnvelopeKind.AUDIO) {
      this.noteLinkAudioWait(this.linkFreeAt - now, now)
    }
    this.scheduleLink(now)
    if (sent) {
      queueMicrotask(sent)
    }
  }

  /**
   * How long audio waits behind other data in the simulated link: logged (at most once a second) when it was more than
   * LINK_AUDIO_WAIT_LOG_MS, for tests (scripts/e2e/lossy.sh) and for trying things by hand.
   */
  private noteLinkAudioWait(wait: number, now: number) {
    if (now - this.linkAudioWaitSince >= 1000) {
      if (this.linkAudioWait > LINK_AUDIO_WAIT_LOG_MS) {
        logger.info(`Simulated link: an audio packet waited ${Math.round(this.linkAudioWait)} ms behind other data.`)
      }
      this.linkAudioWait = 0
      this.linkAudioWaitSince = now
    }
    this.linkAudioWait = Math.max(this.linkAudioWait, wait)
  }

  private scheduleLink(now: number) {
    if (this.linkTimer !== undefined || this.linkQueue.length === 0) {
      return
    }
    this.linkTimer = setTimeout(
      () => {
        this.linkTimer = undefined
        const now = this.now()
        while (this.linkQueue.length && this.linkQueue[0].at <= now) {
          const { data } = this.linkQueue.shift()!
          if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(data, { binary: true })
          }
        }
        this.scheduleLink(now)
      },
      Math.max(0, Math.ceil(this.linkQueue[0].at - now)),
    )
  }

  private clearLink() {
    if (this.linkTimer !== undefined) {
      clearTimeout(this.linkTimer)
      this.linkTimer = undefined
    }
    this.linkQueue.length = 0
  }

  private schedulePacing(at: number, now: number) {
    if (at === Infinity || at >= this.pacingAt) {
      return
    }
    this.clearPacingTimer()
    this.pacingAt = at
    this.pacingTimer = setTimeout(
      () => {
        this.pacingTimer = undefined
        this.pacingAt = Infinity
        this.pump()
      },
      Math.max(1, Math.ceil(at - now)),
    )
    this.pacingTimer.unref?.()
  }

  private clearPacingTimer() {
    if (this.pacingTimer !== undefined) {
      clearTimeout(this.pacingTimer)
      this.pacingTimer = undefined
    }
    this.pacingAt = Infinity
  }

  private limitSocketBacklog() {
    // ws keeps the underlying net.Socket private
    const socket: Socket | undefined = (this.ws as any)._socket
    const fd: number | undefined = (socket as any)?._handle?.fd
    if (fd === undefined || fd < 0) {
      logger.info('Could not reach the viewer socket fd, TCP_NOTSENT_LOWAT not set.')
      return
    }
    if (socket?.remoteAddress === undefined) {
      // a Unix socket (relayed through the gateway)
      const result = setSocketSendBuffer(fd, UNIX_SEND_BUFFER_BYTES)
      if (result !== 0) {
        logger.info(`Could not limit the viewer socket send buffer (errno ${result}).`)
      }
      return
    }
    const result = setTcpNotSentLowat(fd, TCP_NOTSENT_LOWAT_BYTES)
    if (result !== 0) {
      logger.info(`Could not set TCP_NOTSENT_LOWAT on viewer socket (errno ${result}).`)
    }
  }
}
