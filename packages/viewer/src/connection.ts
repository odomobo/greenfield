import { AckTracker } from './acks.js'
import {
  ChunkAssembler,
  CLOSE_LOGGED_OUT,
  CLOSE_TAKEN_OVER,
  decodeChunk,
  decodeEnvelope,
  DecodedEnvelope,
  encodeAck,
  encodeControl,
  encodeFileChunk,
  isChunkEnvelope,
  isDataEnvelope,
  SignInClientMessage,
  SignInServerMessage,
  ViewerMessage,
} from './protocol.js'

export type ConnectionState =
  /** no connection: the sign-in form */
  { kind: 'closed' } | { kind: 'signing-in' } | { kind: 'connected' }

/** How a sign-in ended. */
export type SignInResult = { ok: true; username: string } | { ok: false; message: string }

/** Why the connection to the desktop closed (not after `stop()`). */
export type ConnectionEnd =
  /** another sign-in took the desktop over, from this client address ('' if unknown) */
  | { kind: 'taken-over'; ip: string }
  /** our `logout()` ended the desktop */
  | { kind: 'logged-out' }
  | { kind: 'lost' }

/** The page's side of the sign-in conversation (see "Sign-in" in the scene protocol). */
export type SignInConversation = {
  /** a question from the server (PAM's): resolves with the answer */
  prompt(text: string, echo: boolean): Promise<string>
  /** a message from the server to show (PAM's info and error messages); the sign-in goes on */
  message(kind: 'info' | 'error', text: string): void
}

/**
 * The page's single WebSocket: the sign-in, then the connection to the user's desktop. Signing in happens on the
 * socket itself (in-band, see "Sign-in" in the scene protocol), there is no token: once it closes, for whatever
 * reason, the page has to sign in again. So it never reconnects by itself.
 *
 * Data envelopes (frames, patches, chunks) are acknowledged the moment they arrive, before decoding (see acks.ts);
 * whoever handles one calls its `applied` once it's drawn, decoded or dropped. Chunks are joined into the envelope
 * they were cut from, which is handled once it's whole (its `applied` covers all its chunks).
 */
export class Connection {
  onEnvelope: (envelope: DecodedEnvelope, applied: () => void) => void = () => {
    /* noop */
  }
  /** signed in: the server sends a full snapshot next. Called before any envelope of the desktop is handled. */
  onOpen: (username: string) => void = () => {
    /* noop */
  }
  /** the connection to the desktop closed (not after stop()) */
  onClosed: (end: ConnectionEnd) => void = () => {
    /* noop */
  }
  onStateChange: (state: ConnectionState) => void = () => {
    /* noop */
  }

  private ws?: WebSocket
  /**
   * `ws` once signed in. Everything but the sign-in conversation (control messages, acks, file chunks) goes out on
   * this only: the desktop and the audio player send whenever they like (e.g. frame pacing feedback every 500 ms), and
   * a binary frame before the sign-in ended would break it.
   */
  private desktop?: WebSocket
  /** ends a sign-in in progress (with a failure), when stopped */
  private abortSignIn?: () => void
  private readonly acks = new AckTracker((ack) => {
    if (this.desktop?.readyState === WebSocket.OPEN) {
      this.desktop.send(encodeAck(ack))
    }
  })
  private readonly chunks = new ChunkAssembler()
  /** the ack tokens of the chunks of each item still being joined */
  private readonly chunkTokens = new Map<number, number[]>()

  /** Open the WebSocket and sign in on it as `username`. Once signed in, it is the connection to the user's desktop. */
  signIn(username: string, conversation: SignInConversation): Promise<SignInResult> {
    this.stop()
    return new Promise((resolve) => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
      ws.binaryType = 'arraybuffer'
      this.ws = ws
      this.onStateChange({ kind: 'signing-in' })
      let signedIn = false
      let settled = false
      const settle = (result: SignInResult) => {
        if (!settled) {
          settled = true
          this.abortSignIn = undefined
          resolve(result)
        }
      }
      this.abortSignIn = () => settle({ ok: false, message: '' })
      // prompts are answered one after the other, in order
      let answered = Promise.resolve()
      const send = (message: SignInClientMessage) => {
        if (this.ws === ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(message))
        }
      }
      ws.onopen = () => send({ type: 'begin', username })
      ws.onmessage = (event) => {
        if (this.ws !== ws) {
          return
        }
        if (typeof event.data === 'string') {
          // the sign-in conversation; the desktop sends binary envelopes only
          if (!signedIn) {
            this.onSignInMessage(event.data, conversation, {
              answer: (prompt) => {
                answered = answered.then(async () => send({ type: 'answer', text: await prompt }))
              },
              signedIn: (name) => {
                signedIn = true
                this.desktop = ws
                // the server counts data envelopes (and numbers chunked items) per connection
                this.acks.reset()
                this.chunks.reset()
                this.chunkTokens.clear()
                this.onStateChange({ kind: 'connected' })
                this.onOpen(name)
                settle({ ok: true, username: name })
              },
              failed: (message) => settle({ ok: false, message }),
            })
          }
          return
        }
        if (!signedIn || !(event.data instanceof ArrayBuffer)) {
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
        this.desktop = undefined
        this.onStateChange({ kind: 'closed' })
        if (!signedIn) {
          settle({ ok: false, message: 'The server could not be reached.' })
          return
        }
        this.onClosed(
          event.code === CLOSE_TAKEN_OVER
            ? { kind: 'taken-over', ip: event.reason }
            : event.code === CLOSE_LOGGED_OUT
              ? { kind: 'logged-out' }
              : { kind: 'lost' },
        )
      }
    })
  }

  private onSignInMessage(
    data: string,
    conversation: SignInConversation,
    on: { answer(prompt: Promise<string>): void; signedIn(username: string): void; failed(message: string): void },
  ) {
    let message: SignInServerMessage
    try {
      message = JSON.parse(data)
    } catch {
      console.error('Invalid sign-in message from server')
      return
    }
    switch (message.type) {
      case 'prompt':
        on.answer(conversation.prompt(String(message.text), message.echo === true))
        break
      case 'info':
      case 'error':
        conversation.message(message.type, String(message.text))
        break
      case 'result':
        if (message.ok) {
          on.signedIn(String(message.username))
        } else {
          on.failed(String(message.message))
        }
        break
    }
  }

  /** Log out: the desktop ends (its apps are asked to quit). onClosed tells when it did. */
  logout(): void {
    this.send({ type: 'session.logout' })
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

  /** Close the connection (a sign-in in progress fails with an empty message). onClosed isn't called. */
  stop(): void {
    const ws = this.ws
    this.ws = undefined
    this.desktop = undefined
    ws?.close()
    this.abortSignIn?.()
    this.onStateChange({ kind: 'closed' })
  }

  get open(): boolean {
    return this.desktop?.readyState === WebSocket.OPEN
  }

  /** bytes handed to the socket and not sent yet (uploads wait for this to go down) */
  get buffered(): number {
    return this.desktop?.bufferedAmount ?? 0
  }

  /** The next bytes of a file being uploaded (see the protocol's `file-drop`). */
  sendFileChunk(id: number, bytes: Uint8Array): void {
    if (this.desktop?.readyState === WebSocket.OPEN) {
      this.desktop.send(encodeFileChunk(id, bytes))
    }
  }

  send(message: ViewerMessage): void {
    if (this.desktop?.readyState === WebSocket.OPEN) {
      this.desktop.send(encodeControl(message))
    }
  }
}

function noop() {
  /* nothing to acknowledge */
}
