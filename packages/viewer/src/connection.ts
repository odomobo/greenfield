import { AckTracker } from './acks'
import {
  ChunkAssembler,
  CLOSE_TAKEN_OVER,
  decodeChunk,
  decodeEnvelope,
  DecodedEnvelope,
  encodeAck,
  encodeControl,
  encodeFileChunk,
  isChunkEnvelope,
  isDataEnvelope,
  ViewerMessage,
} from './protocol'

export type ConnectionState =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'reconnecting'; inSeconds: number }
  | { kind: 'taken-over' }
  /** the gateway no longer accepts our sign-in */
  | { kind: 'signed-out' }
  /** the desktop doesn't exist (anymore) */
  | { kind: 'ended' }

/** close codes of the gateway */
const CLOSE_UNAUTHORIZED = 4001
const CLOSE_NOT_FOUND = 4004

/**
 * The viewer's single WebSocket to a session. Reconnects with backoff, except when another viewer took the session
 * over (then the user decides), the session ended or we're signed out.
 *
 * The first message on the socket is the sign-in token (not the URL, so it doesn't end up in logs).
 *
 * Data envelopes (frames, patches, chunks) are acknowledged the moment they arrive, before decoding (see acks.ts);
 * whoever handles one calls its `applied` once it's drawn, decoded or dropped. Chunks are joined into the envelope
 * they were cut from, which is handled once it's whole (its `applied` covers all its chunks).
 */
export class Connection {
  onEnvelope: (envelope: DecodedEnvelope, applied: () => void) => void = () => {
    /* noop */
  }
  /** a (new) WebSocket is open, the server will send a full snapshot */
  onOpen: () => void = () => {
    /* noop */
  }
  onStateChange: (state: ConnectionState) => void = () => {
    /* noop */
  }

  private ws?: WebSocket
  private readonly acks = new AckTracker((ack) => {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeAck(ack))
    }
  })
  private readonly chunks = new ChunkAssembler()
  /** the ack tokens of the chunks of each item still being joined */
  private readonly chunkTokens = new Map<number, number[]>()
  private retryDelay = 500
  private retryTimer?: number
  private target?: { url: string; token: string }

  /** connect to the user's desktop (and stay connected) */
  attach(token: string): void {
    this.stop()
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    this.target = { url, token }
    this.retryDelay = 500
    this.connect()
  }

  /** connect again to the last attached session */
  connect(): void {
    clearTimeout(this.retryTimer)
    if (this.target === undefined) {
      return
    }
    const { url, token } = this.target
    this.onStateChange({ kind: 'connecting' })
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    // the server counts data envelopes (and numbers chunked items) per connection
    this.acks.reset()
    this.chunks.reset()
    this.chunkTokens.clear()
    ws.onopen = () => {
      ws.send(token)
      this.retryDelay = 500
      this.onStateChange({ kind: 'connected' })
      this.onOpen()
    }
    ws.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer) || this.ws !== ws) {
        return
      }
      const head = new Uint8Array(event.data, 0, Math.min(2, event.data.byteLength))
      if (isChunkEnvelope(head)) {
        this.onChunk(event.data)
        return
      }
      // acknowledge data first thing, so the server's round-trip times measure the network, not our decoding
      const token = isDataEnvelope(head) ? this.acks.arrived(event.data.byteLength) : undefined
      const applied = token === undefined ? noop : () => this.acks.applied(token)
      this.handle(event.data, applied)
    }
    ws.onclose = (event) => {
      if (this.ws !== ws) {
        return
      }
      this.ws = undefined
      if (event.code === CLOSE_TAKEN_OVER) {
        this.onStateChange({ kind: 'taken-over' })
        return
      }
      if (event.code === CLOSE_UNAUTHORIZED) {
        this.target = undefined
        this.onStateChange({ kind: 'signed-out' })
        return
      }
      if (event.code === CLOSE_NOT_FOUND) {
        this.onStateChange({ kind: 'ended' })
        return
      }
      const delay = this.retryDelay
      this.retryDelay = Math.min(this.retryDelay * 2, 10000)
      this.onStateChange({ kind: 'reconnecting', inSeconds: Math.ceil(delay / 1000) })
      this.retryTimer = window.setTimeout(() => this.connect(), delay)
    }
  }

  /** A chunk arrived: acknowledged at once like any data envelope; its item is handled once it's whole. */
  private onChunk(data: ArrayBuffer) {
    let chunk: ReturnType<typeof decodeChunk>
    try {
      chunk = decodeChunk(new Uint8Array(data))
    } catch (e) {
      console.error('Invalid chunk from server', e)
      // still a data envelope the server counts
      this.acks.applied(this.acks.arrived(data.byteLength))
      return
    }
    const token = this.acks.arrived(data.byteLength, chunk.id)
    const tokens = this.chunkTokens.get(chunk.id) ?? []
    tokens.push(token)
    this.chunkTokens.set(chunk.id, tokens)
    let whole: Uint8Array | undefined
    try {
      whole = this.chunks.push(chunk)
    } catch (e) {
      console.error('Invalid chunk from server', e)
      this.chunkTokens.delete(chunk.id)
      for (const token of tokens) {
        this.acks.applied(token)
      }
      return
    }
    if (whole === undefined) {
      return
    }
    this.chunkTokens.delete(chunk.id)
    this.handle(whole.buffer as ArrayBuffer, () => {
      for (const token of tokens) {
        this.acks.applied(token)
      }
    })
  }

  /** Decode a (whole) envelope and pass it on. */
  private handle(data: ArrayBuffer, applied: () => void) {
    let envelope: DecodedEnvelope
    try {
      envelope = decodeEnvelope(data)
    } catch (e) {
      console.error('Invalid message from server', e)
      applied()
      return
    }
    this.onEnvelope(envelope, applied)
  }

  /** disconnect and stop reconnecting */
  stop(): void {
    clearTimeout(this.retryTimer)
    const ws = this.ws
    this.ws = undefined
    ws?.close()
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /** bytes handed to the socket and not sent yet (uploads wait for this to go down) */
  get buffered(): number {
    return this.ws?.bufferedAmount ?? 0
  }

  /** The next bytes of a file being uploaded (see the protocol's `file-drop`). */
  sendFileChunk(id: number, bytes: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeFileChunk(id, bytes))
    }
  }

  send(message: ViewerMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeControl(message))
    }
  }
}

function noop() {
  /* nothing to acknowledge */
}
