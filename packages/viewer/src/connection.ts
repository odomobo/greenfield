import {
  CLOSE_TAKEN_OVER,
  decodeEnvelope,
  DecodedEnvelope,
  encodeControl,
  encodeFileChunk,
  ViewerMessage,
} from './protocol'

export type ConnectionState =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'reconnecting'; inSeconds: number }
  | { kind: 'taken-over' }
  /** the gateway no longer accepts our sign-in */
  | { kind: 'signed-out' }
  /** the session doesn't exist (anymore) */
  | { kind: 'ended' }

/** close codes of the gateway */
const CLOSE_UNAUTHORIZED = 4001
const CLOSE_NOT_FOUND = 4004

/**
 * The viewer's single WebSocket to a session. Reconnects with backoff, except when another viewer took the session
 * over (then the user decides), the session ended or we're signed out.
 *
 * The first message on the socket is the sign-in token (not the URL, so it doesn't end up in logs).
 */
export class Connection {
  onEnvelope: (envelope: DecodedEnvelope) => void = () => {
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
  private retryDelay = 500
  private retryTimer?: number
  private target?: { url: string; token: string }

  /** connect to a session (and stay connected) */
  attach(session: string, token: string): void {
    this.stop()
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?session=${encodeURIComponent(session)}`
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
    ws.onopen = () => {
      ws.send(token)
      this.retryDelay = 500
      this.onStateChange({ kind: 'connected' })
      this.onOpen()
    }
    ws.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) {
        return
      }
      let envelope: DecodedEnvelope
      try {
        envelope = decodeEnvelope(event.data)
      } catch (e) {
        console.error('Invalid message from server', e)
        return
      }
      this.onEnvelope(envelope)
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
