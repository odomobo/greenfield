import { CLOSE_TAKEN_OVER, decodeEnvelope, DecodedEnvelope, encodeControl, ViewerMessage } from './protocol'

export type ConnectionState =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'reconnecting'; inSeconds: number }
  | { kind: 'taken-over' }

/**
 * The viewer's single WebSocket to a session. Reconnects with backoff, except when another viewer took the session
 * over (then the user decides).
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

  constructor(private readonly url: string) {}

  connect(): void {
    clearTimeout(this.retryTimer)
    this.onStateChange({ kind: 'connecting' })
    const ws = new WebSocket(this.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
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
      const delay = this.retryDelay
      this.retryDelay = Math.min(this.retryDelay * 2, 10000)
      this.onStateChange({ kind: 'reconnecting', inSeconds: Math.ceil(delay / 1000) })
      this.retryTimer = window.setTimeout(() => this.connect(), delay)
    }
  }

  /** stop reconnecting (e.g. the session ended) */
  stop(): void {
    clearTimeout(this.retryTimer)
    const ws = this.ws
    this.ws = undefined
    ws?.close()
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  send(message: ViewerMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeControl(message))
    }
  }
}
