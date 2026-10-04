import { WebSocket } from 'ws'
import { Socket } from 'node:net'
import { createLogger } from '../Logger.js'
import type { SurfaceClass } from '../encoding/policy.js'
import { setSocketSendBuffer, setTcpNotSentLowat } from '../socket-options.js'
import { decodeViewerEnvelope, encodeControl, encodeFrame, encodePatch, isKeyFrame, Patch } from './protocol.js'

const logger = createLogger('viewer-transport')

export type ControlMessage = { type: string; [key: string]: any }

export type OutgoingMessage =
  | { readonly priority: 'control'; readonly message: ControlMessage }
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
  | {
      readonly priority: 'patch'
      readonly surface: string
      readonly patch: Patch
      readonly surfaceClass: SurfaceClass
      readonly done?: (sent: boolean) => void
    }

/**
 * Connection to one viewer. Kept small so the WebSocket implementation can later be swapped for e.g. WebTransport
 * (independent streams per surface + datagrams for input).
 */
export interface ViewerTransport {
  /**
   * Queue a message. Control messages are always sent before pending frames and patches. Of those, the two priority
   * classes share the link by byte-weighted deficit round-robin (normal 3 : streaming 1, work-conserving), surfaces
   * of a class take turns, one item per visit. Video frames and patches of a surface are sent in order. A video key frame replaces everything unsent of its surface (it covers the whole surface),
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

  close(code: number, reason: string): void

  readonly closed: boolean

  onMessage: (message: ControlMessage) => void
  /** The next bytes of an uploaded file (see the scene protocol's `file-drop`). */
  onFileChunk: (id: number, data: Uint8Array) => void
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
// Don't hand a new frame to the socket while more than this is still buffered in user space.
const FRAME_SEND_BUFFERED_LIMIT = 64 * 1024
// Deficit round-robin between the priority classes: each turn a class may send up to its quantum (plus what it carried
// over) in bytes. Normal surfaces get 3 times the share of streaming ones, and the other class gets all of the link
// when one has nothing waiting.
const DRR_QUANTUM = 16 * 1024
const DRR_QUANTUM_NORMAL = 3 * DRR_QUANTUM
const DRR_QUANTUM_STREAMING = 1 * DRR_QUANTUM
// Max unsent delta frames per surface. Beyond that the viewer is too far behind: drop them and resync with a key frame.
const MAX_UNSENT_FRAMES_PER_SURFACE = 3

type QueuedEntry = { readonly surfaceClass: SurfaceClass; readonly done?: (sent: boolean) => void } & (
  | { readonly kind: 'frame'; readonly frame: Uint8Array }
  | { readonly kind: 'patch'; readonly envelope: Uint8Array }
)

function dropEntries(entries: QueuedEntry[]) {
  for (const entry of entries) {
    entry.done?.(false)
  }
}

function sizeOf(entry: QueuedEntry): number {
  return entry.kind === 'frame' ? entry.frame.length : entry.envelope.length
}

const otherClass = (surfaceClass: SurfaceClass): SurfaceClass => (surfaceClass === 'normal' ? 'streaming' : 'normal')

export class WebSocketViewerTransport implements ViewerTransport {
  onMessage: (message: ControlMessage) => void = () => {
    /* noop */
  }
  onFileChunk: (id: number, data: Uint8Array) => void = () => {
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
   * goes to the back after each of its items is sent. A surface's class is that of its next item.
   */
  private readonly pendingFrames = new Map<string, QueuedEntry[]>()
  /** deficit round-robin state: whose turn it is, whether it got its quantum for this turn, bytes carried over */
  private drrTurn: SurfaceClass = 'normal'
  private drrQuantumGiven = false
  private readonly drrDeficit: Record<SurfaceClass, number> = { normal: 0, streaming: 0 }
  /**
   * Surfaces whose next frame must be a key frame because a frame was dropped.
   */
  private readonly needsKeyFrame = new Set<string>()
  private readonly keyFrameSent = new Set<string>()
  private framesInFlight = 0
  private _closed = false

  constructor(private readonly ws: WebSocket) {
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
      } else {
        this.onMessage(envelope.message)
      }
    })
    ws.on('close', (code, reason) => {
      this._closed = true
      this.dropAll()
      this.onClose(code, reason.toString())
    })
    ws.on('error', (error) => logger.error(`Viewer connection error: ${error.message}`))
  }

  get closed(): boolean {
    return this._closed
  }

  send(message: OutgoingMessage): void {
    if (this._closed) {
      if (message.priority !== 'control') {
        message.done?.(false)
      }
      return
    }
    if (message.priority === 'control') {
      this.controlQueue.push(Buffer.from(encodeControl(message.message)))
    } else if (message.priority === 'frame') {
      this.queueFrame(message.surface, message.frame, message.surfaceClass, message.done)
    } else {
      this.queuePatch(
        message.surface,
        encodePatch(message.surface, message.patch),
        message.surfaceClass,
        message.done,
      )
    }
    this.pump()
  }

  close(code: number, reason: string): void {
    if (this._closed) {
      return
    }
    this._closed = true
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
  }

  private queueFrame(surface: string, frame: Uint8Array, surfaceClass: SurfaceClass, done?: (sent: boolean) => void) {
    const entry: QueuedEntry = { kind: 'frame', frame, surfaceClass, done }
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

  private queuePatch(
    surface: string,
    envelope: Uint8Array,
    surfaceClass: SurfaceClass,
    done?: (sent: boolean) => void,
  ) {
    const entry: QueuedEntry = { kind: 'patch', envelope, surfaceClass, done }
    const chain = this.pendingFrames.get(surface)
    if (chain === undefined) {
      this.pendingFrames.set(surface, [entry])
    } else {
      chain.push(entry)
    }
  }

  /** The first surface of the class, in round-robin order, and its chain of items. */
  private findHead(surfaceClass: SurfaceClass): { surface: string; chain: QueuedEntry[] } | undefined {
    for (const [surface, chain] of this.pendingFrames) {
      if (chain[0].surfaceClass === surfaceClass) {
        return { surface, chain }
      }
    }
    return undefined
  }

  /**
   * The next data item to send, by deficit round-robin between the classes, weighted by bytes: on its turn a class adds
   * its quantum to its deficit and sends items while the next fits in the deficit. A class with nothing waiting loses
   * its turn and its deficit, so the other class gets the whole link.
   */
  private takeNext(): { surface: string; entry: QueuedEntry } | undefined {
    // a deficit grows every turn, so even a huge item fits eventually
    for (let turns = 0; turns < 10_000; turns++) {
      const turn = this.drrTurn
      const head = this.findHead(turn)
      if (head === undefined) {
        this.drrDeficit[turn] = 0
        this.drrQuantumGiven = false
        this.drrTurn = otherClass(turn)
        if (this.findHead(this.drrTurn) === undefined) {
          return undefined
        }
        continue
      }
      if (!this.drrQuantumGiven) {
        this.drrQuantumGiven = true
        this.drrDeficit[turn] += turn === 'normal' ? DRR_QUANTUM_NORMAL : DRR_QUANTUM_STREAMING
      }
      const entry = head.chain[0]
      if (sizeOf(entry) <= this.drrDeficit[turn]) {
        this.drrDeficit[turn] -= sizeOf(entry)
        head.chain.shift()
        // back of the line, for fairness between surfaces
        this.pendingFrames.delete(head.surface)
        if (head.chain.length) {
          this.pendingFrames.set(head.surface, head.chain)
        }
        return { surface: head.surface, entry }
      }
      this.drrQuantumGiven = false
      this.drrTurn = otherClass(turn)
    }
    return undefined
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

    // Control messages always go first, they are small. A burst of them (e.g. on attach) can fill the socket past
    // FRAME_SEND_BUFFERED_LIMIT with no frame in flight, so once one is written, check again for frames to send.
    while (this.controlQueue.length) {
      this.ws.send(this.controlQueue.shift()!, { binary: true }, () => this.pump())
    }

    // roughly one frame in flight
    if (this.framesInFlight > 0 || this.ws.bufferedAmount > FRAME_SEND_BUFFERED_LIMIT) {
      return
    }
    const next = this.takeNext()
    if (next === undefined) {
      return
    }
    const { surface, entry } = next
    let data: Uint8Array
    if (entry.kind === 'frame') {
      if (isKeyFrame(entry.frame)) {
        this.keyFrameSent.add(surface)
      }
      data = encodeFrame(surface, entry.frame)
    } else {
      data = entry.envelope
    }
    this.framesInFlight++
    // The callback fires once the data was handed to the kernel. With TCP_NOTSENT_LOWAT that means most of it has
    // actually left, so the next frame (possibly a newer one for the same surface) is picked as late as possible.
    this.ws.send(data, { binary: true }, () => {
      this.framesInFlight--
      entry.done?.(true)
      this.pump()
    })
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
