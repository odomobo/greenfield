import type { WebSocket } from 'ws'
import { performance } from 'node:perf_hooks'
import type { Congestion } from '@nebula/session-contracts'
import {
  AudioPacket,
  encodeAudio,
  encodeControl,
  encodeFrame,
  encodePatch,
  Patch,
  ViewerAck,
} from '@gfld/scene-protocol'
import { ChunkBounds, chunkSize, DEFAULT_CHUNK_BOUNDS } from './chunking.js'
import { FairQueue, TierConfig } from './FairQueue.js'
import { SimulatedLink, TransportLogger, ViewerEnvelope, WebSocketLink } from './link.js'

export type ControlMessage = { type: string; [key: string]: any }

export type OutgoingMessage =
  | { readonly priority: 'control'; readonly message: ControlMessage }
  /**
   * An audio packet (see the AUDIO envelope): control priority, sent right away, but dropped instead of queued when
   * the connection's send buffer is full.
   */
  | { readonly priority: 'audio'; readonly packet: AudioPacket }
  /**
   * Video frames and patches of a stream (a surface), in a send tier (one of the transport's `tiers`), and `done`,
   * which is called once: sent true when handed to the socket, false if the transport closed before it was.
   */
  | {
      readonly priority: 'frame'
      readonly surface: string
      readonly frame: Uint8Array
      readonly tier: string
      readonly done?: (sent: boolean) => void
    }
  | {
      readonly priority: 'patch'
      readonly surface: string
      readonly patch: Patch
      readonly tier: string
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
   * audio is the viewer's jitter buffer's to handle). Of the rest, the send tiers share the link by byte-weighted
   * deficit round-robin (their quanta, work-conserving), surfaces of a tier take turns, one item per visit, as fast as
   * the congestion controller lets them go (see the contracts' `Congestion`: pacing, in-flight limit, the viewer's
   * backlog). Video frames and patches of a surface are sent in order, so a surface's items wait in the highest tier of
   * any of them. Items larger than the chunk size (see CHUNK_MS) go out in chunks (CHUNK envelopes): control messages
   * and audio go between any two, a higher tier's items too, but a tier sends one item at a time (its started item
   * continues until done), and a surface's next item waits for its started one. Nothing queued is ever dropped,
   * replaced or revised: the transport doesn't look into the items (a video key frame is just an item); every item goes
   * out, in order, until the transport closes, which reports all that is unsent as not sent. Items of a surface the
   * viewer has forgotten (destroyed) still go out: the viewer ignores them.
   */
  send(message: OutgoingMessage): void

  /**
   * The bytes of the surface's frames and patches not sent yet (its queued items and what's left of its started one),
   * except those in `exceptTier`.
   */
  unsentBytes(surface: string, exceptTier?: string): number

  /** The unsent bytes (see unsentBytes) of all surfaces. */
  totalUnsentBytes(exceptTier?: string): number

  /** Whether any surface's items wait in the tier (a surface's items wait in the highest tier of any of them). */
  tierWaiting(tier: string): boolean

  /**
   * Whether the surface's stream is ready for its next item: at most one chunk (the current chunk size, see CHUNK_MS)
   * of its data is left unsent, counted in bytes (its queued items and what's left of its started one). So small items
   * may be queued until about a chunk's worth waits, and a large one (a key frame) isn't followed by the next until it's
   * nearly sent. Items in `exceptTier` don't count. A closed transport is always ready (nothing is sent anymore). A
   * stream found not ready gets `onStreamReady` once it is.
   */
  streamReady(surface: string, exceptTier?: string): boolean

  close(code: number, reason: string): void

  readonly closed: boolean

  onMessage: (message: ControlMessage) => void
  /** The next bytes of an uploaded file (see the scene protocol's `file-drop`). */
  onFileChunk: (id: number, data: Uint8Array) => void
  /** The viewer acknowledged data envelopes and reported its backlog (see the scene protocol's ACK). */
  onAck: (ack: ViewerAck) => void
  /**
   * A surface's stream that `streamReady` found not ready is ready now (called once per such answer, after the
   * transport's state is updated; never while it's closed).
   */
  onStreamReady: (surface: string) => void
  /**
   * Called after every attempt to send data, with whether data waits because the congestion controller or the socket
   * holds it back (not because there's none), and the time. A link stat, for whoever judges the link (with
   * `tierWaiting` and `totalUnsentBytes`).
   */
  onDataHeld: (held: boolean, now: number) => void
  onClose: (code: number, reason: string) => void
}

// A safety limit under the congestion controller: never hand a data item to the socket while more than this is still
// buffered in user space (with the controller working, it shouldn't be reached).
const SEND_BUFFERED_LIMIT = 256 * 1024

const consoleLogger: TransportLogger = {
  info: (message) => console.info(message),
  error: (message) => console.error(message),
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
  onStreamReady: (surface: string) => void = () => {
    /* noop */
  }
  onDataHeld: (held: boolean, now: number) => void = () => {
    /* noop */
  }
  onClose: (code: number, reason: string) => void = () => {
    /* noop */
  }

  private readonly controlQueue: Buffer[] = []
  private readonly queue: FairQueue
  private readonly chunkBytes: ChunkBounds
  private readonly congestion: Congestion
  private readonly now: () => number
  private readonly logger: TransportLogger
  private readonly link: WebSocketLink
  /** wakes the pump when the controller's pacing lets the next item go */
  private pacingTimer?: NodeJS.Timeout
  private pacingAt = Infinity
  private safetyLimitLogged = false
  private _closed = false

  constructor(
    ws: WebSocket,
    options: {
      now?: () => number
      /** the congestion controller (created by the caller) */
      congestion: Congestion
      /** the send tiers and their weights, from the highest priority (see TierConfig) */
      tiers: readonly TierConfig[]
      link?: SimulatedLink
      /** the chunk size's bounds (see CHUNK_MS), for tests */
      chunkBytes?: ChunkBounds
      logger?: TransportLogger
    },
  ) {
    this.now = options.now ?? (() => performance.now())
    this.congestion = options.congestion
    this.queue = new FairQueue(options.tiers)
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BOUNDS
    this.logger = options.logger ?? consoleLogger
    this.link = new WebSocketLink(ws, {
      now: this.now,
      logger: this.logger,
      link: options.link,
      onEnvelope: (envelope) => this.received(envelope),
      onInvalid: (code, reason) => this.close(code, reason),
      onClose: (code, reason) => {
        this._closed = true
        this.clearPacingTimer()
        this.closeQueue()
        this.onClose(code, reason)
      },
    })
  }

  get closed(): boolean {
    return this._closed
  }

  unsentBytes(surface: string, exceptTier?: string): number {
    return this.queue.unsentBytes(surface, exceptTier)
  }

  totalUnsentBytes(exceptTier?: string): number {
    return this.queue.totalUnsentBytes(exceptTier)
  }

  tierWaiting(tier: string): boolean {
    return this.queue.tierWaiting(tier)
  }

  streamReady(surface: string, exceptTier?: string): boolean {
    if (this._closed) {
      return true
    }
    return this.queue.ready(surface, this.chunkSize, exceptTier)
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
      const { surface, frame, tier, done } = message
      let envelope: Uint8Array | undefined
      // a frame's envelope is encoded once, the first time it's needed (the controller may say not yet)
      this.queue.enqueue(surface, {
        tier,
        done,
        size: frame.length,
        envelope: () => (envelope ??= encodeFrame(surface, frame)),
      })
    } else {
      const { surface, patch, tier, done } = message
      const envelope = encodePatch(surface, patch)
      this.queue.enqueue(surface, { tier, done, size: envelope.length, envelope: () => envelope })
    }
    this.pump()
  }

  close(code: number, reason: string): void {
    if (this._closed) {
      return
    }
    this._closed = true
    this.clearPacingTimer()
    this.closeQueue()
    this.controlQueue.length = 0
    this.link.close(code, reason)
  }

  private received(envelope: ViewerEnvelope) {
    if (envelope.kind === 'file') {
      this.onFileChunk(envelope.id, envelope.data)
    } else if (envelope.kind === 'ack') {
      this.congestion.onAck(envelope, this.now())
      this.onAck(envelope)
      this.pump()
    } else {
      this.onMessage(envelope.message)
    }
  }

  private sendAudio(packet: AudioPacket) {
    if (!this.link.open) {
      return
    }
    // after queued control messages (normally none wait), before any data item
    this.flushControl()
    this.link.write(encodeAudio(packet))
  }

  /** The transport closed: everything queued or started is reported unsent (the only time an item is). */
  private closeQueue() {
    for (const item of this.queue.clear()) {
      item.done?.(false)
    }
  }

  /** The current chunk size (see CHUNK_MS). */
  private get chunkSize(): number {
    return chunkSize(this.congestion.bandwidthEstimate, this.chunkBytes)
  }

  /**
   * Tell the surfaces found not ready whose streams are ready now (their data went out, or the chunk size grew). Called
   * at the end of a pump, once its state is settled: a surface told may start its next item at once.
   */
  private notifyReady() {
    for (const surface of this.queue.takeReady(this.chunkSize)) {
      if (this._closed) {
        return
      }
      this.onStreamReady(surface)
    }
  }

  private pump() {
    if (this._closed || !this.link.open) {
      return
    }

    // Control messages always go first, they are small, and the congestion controller never holds them back. A burst
    // of them (e.g. on attach) can fill the socket past SEND_BUFFERED_LIMIT, so once one is written, check again for
    // data to send.
    this.flushControl()

    this.congestion.setDataWaiting(this.queue.waiting)
    // data waits because the controller or the socket holds it back (not because there's none)
    let held = false
    for (;;) {
      if (this.link.bufferedAmount > SEND_BUFFERED_LIMIT) {
        // a send's callback pumps again
        if (!this.safetyLimitLogged && this.queue.waiting) {
          this.safetyLimitLogged = true
          this.logger.info(`More than ${SEND_BUFFERED_LIMIT} bytes buffered for the viewer, holding data items.`)
        }
        held = true
        break
      }
      const now = this.now()
      let refused: number | undefined
      const next = this.queue.takeNext(this.chunkSize, (bytes) => {
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
      const { item, data } = next
      this.congestion.onSend(data.length, now)
      // The callback fires once the data was handed to the kernel. With TCP_NOTSENT_LOWAT that means most of it has
      // actually left; the item is done from then on (once its last chunk is).
      this.link.write(
        data,
        next.last
          ? () => {
              item.done?.(true)
              this.pump()
            }
          : () => this.pump(),
      )
    }
    this.congestion.setDataWaiting(this.queue.waiting)
    this.onDataHeld(held, this.now())
    this.notifyReady()
  }

  private flushControl() {
    while (this.controlQueue.length) {
      this.link.write(this.controlQueue.shift()!, () => this.pump())
    }
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
}
