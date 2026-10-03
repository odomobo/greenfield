import { WebSocket } from 'ws'
import { Socket } from 'node:net'
import { createLogger } from '../Logger.js'
import { setSocketSendBuffer, setTcpNotSentLowat } from '../socket-options.js'
import { decodeControl, encodeControl, encodeFrame, encodePatch, isKeyFrame, Patch } from './protocol.js'

const logger = createLogger('viewer-transport')

export type ControlMessage = { type: string; [key: string]: any }

export type OutgoingMessage =
  | { readonly priority: 'control'; readonly message: ControlMessage }
  | { readonly priority: 'frame'; readonly surface: string; readonly frame: Uint8Array }
  /** `done` is called once: sent true when handed to the socket, false when dropped unsent. */
  | {
      readonly priority: 'patch'
      readonly surface: string
      readonly patch: Patch
      readonly done?: (sent: boolean) => void
    }

/**
 * Connection to one viewer. Kept small so the WebSocket implementation can later be swapped for e.g. WebTransport
 * (independent streams per surface + datagrams for input).
 */
export interface ViewerTransport {
  /**
   * Queue a message. Control messages are always sent before pending frames. Video frames and patches of a surface
   * are sent in order. A video key frame replaces everything unsent of its surface (it covers the whole surface),
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
// Max unsent delta frames per surface. Beyond that the viewer is too far behind: drop them and resync with a key frame.
const MAX_UNSENT_FRAMES_PER_SURFACE = 3

type QueuedEntry =
  | { readonly kind: 'frame'; readonly frame: Uint8Array }
  | { readonly kind: 'patch'; readonly envelope: Uint8Array; readonly done?: (sent: boolean) => void }

function dropEntries(entries: QueuedEntry[]) {
  for (const entry of entries) {
    if (entry.kind === 'patch') {
      entry.done?.(false)
    }
  }
}

export class WebSocketViewerTransport implements ViewerTransport {
  onMessage: (message: ControlMessage) => void = () => {
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
   * the viewer already decodes. Map iteration order (insertion) gives a rough oldest-first fairness.
   */
  private readonly pendingFrames = new Map<string, QueuedEntry[]>()
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
      let message: ControlMessage
      try {
        message = decodeControl(data)
      } catch (e: any) {
        logger.error(`Invalid message from viewer: ${e.message}`)
        this.close(4400, e.message)
        return
      }
      this.onMessage(message)
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
      return
    }
    if (message.priority === 'control') {
      this.controlQueue.push(Buffer.from(encodeControl(message.message)))
    } else if (message.priority === 'frame') {
      this.queueFrame(message.surface, message.frame)
    } else {
      this.queuePatch(message.surface, encodePatch(message.surface, message.patch), message.done)
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

  private queueFrame(surface: string, frame: Uint8Array) {
    if (isKeyFrame(frame)) {
      // everything unsent is superseded, a key frame covers the whole surface
      this.dropQueued(surface)
      this.pendingFrames.set(surface, [{ kind: 'frame', frame }])
      this.needsKeyFrame.delete(surface)
      return
    }

    const chain = this.pendingFrames.get(surface)
    const decodable = !this.needsKeyFrame.has(surface) && (this.keyFrameSent.has(surface) || chain !== undefined)
    if (!decodable) {
      // the viewer can't decode this, wait for a key frame
      this.requestKeyFrame(surface)
      return
    }

    const unsentVideo = chain?.filter((entry) => entry.kind === 'frame').length ?? 0
    if (chain === undefined) {
      this.pendingFrames.set(surface, [{ kind: 'frame', frame }])
    } else if (unsentVideo < MAX_UNSENT_FRAMES_PER_SURFACE) {
      chain.push({ kind: 'frame', frame })
    } else {
      // too far behind, resync
      this.dropQueued(surface)
      this.requestKeyFrame(surface)
    }
  }

  private queuePatch(surface: string, envelope: Uint8Array, done?: (sent: boolean) => void) {
    const entry: QueuedEntry = { kind: 'patch', envelope, done }
    const chain = this.pendingFrames.get(surface)
    if (chain === undefined) {
      this.pendingFrames.set(surface, [entry])
    } else {
      chain.push(entry)
    }
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
    const next = this.pendingFrames.entries().next()
    if (next.done) {
      return
    }
    const [surface, chain] = next.value
    const entry = chain.shift()!
    // re-insert at the back for fairness between surfaces
    this.pendingFrames.delete(surface)
    if (chain.length) {
      this.pendingFrames.set(surface, chain)
    }
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
      if (entry.kind === 'patch') {
        entry.done?.(true)
      }
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
