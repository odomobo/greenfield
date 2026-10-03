import { NativeAppContext } from './NativeAppContext.js'

let nextChannelId = 1

export type ChannelDesc = {
  readonly id: string
  readonly clientId: string
}

/**
 * Bidirectional message pipe between the native side of a Wayland client (NativeWaylandClientSession) and its
 * counterpart in the server-side compositor. Both live in this process, so this is an in-memory loopback.
 */
export interface Channel {
  readonly desc: ChannelDesc
  readonly nativeAppContext: NativeAppContext
  isOpen: boolean
  onOpen: () => void
  onClose: () => void
  /**
   * Message from the compositor towards the native side.
   */
  onMessage: (buffer: Buffer) => void

  /**
   * Message from the native side towards the compositor.
   */
  send(buffer: Buffer): void

  close(): void
}

export class InProcessChannel implements Channel {
  isOpen = true
  onOpen = () => {
    /* noop */
  }
  onClose = () => {
    /* noop */
  }
  onMessage = (_buffer: Buffer) => {
    /* noop */
  }
  /**
   * Set by the compositor side to receive messages sent by the native side.
   */
  onSend: (buffer: Buffer) => void = () => {
    /* noop */
  }
  readonly closeListeners: (() => void)[] = []

  constructor(
    readonly desc: ChannelDesc,
    readonly nativeAppContext: NativeAppContext,
  ) {
    queueMicrotask(() => this.onOpen())
  }

  send(buffer: Buffer): void {
    if (this.isOpen) {
      this.onSend(buffer)
    }
  }

  /**
   * Deliver a message from the compositor side to the native side.
   */
  deliver(buffer: Buffer): void {
    if (this.isOpen) {
      this.onMessage(buffer)
    }
  }

  close(): void {
    if (!this.isOpen) {
      return
    }
    this.isOpen = false
    for (const closeListener of this.closeListeners) {
      closeListener()
    }
    this.onClose()
  }
}

/**
 * Connects a newly created protocol channel to the compositor. Installed by the in-process compositor.
 */
export type ProtocolChannelConnector = (channel: InProcessChannel) => void

let protocolChannelConnector: ProtocolChannelConnector | undefined

export function setProtocolChannelConnector(connector: ProtocolChannelConnector): void {
  protocolChannelConnector = connector
}

export function createProtocolChannel(clientId: string, nativeAppContext: NativeAppContext): Channel {
  if (protocolChannelConnector === undefined) {
    throw new Error('BUG. No compositor to connect a protocol channel to.')
  }
  const channel = new InProcessChannel({ id: `${nextChannelId++}`, clientId }, nativeAppContext)
  nativeAppContext.registerChannel(channel)
  protocolChannelConnector(channel)
  return channel
}
