import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'
import { ReadableStream } from 'node:stream/web'
import { ChannelDesc, ChannelDescriptionType, setInProcessChannelFactory, WebSocketChannel } from './Channel.js'
import { createLogger } from './Logger.js'
import { NativeAppContext } from './NativeAppContext.js'
import { Session } from './Session.js'
import { getBufferSize } from './wayland-server.js'
import { ProxyFD } from './io/types.js'

const logger = createLogger('in-process-compositor')

// Minimal structural typing of the server compositor bundle (packages/compositor/src/server/index.ts).
type Size = { width: number; height: number }
type InputOutputFD = {
  fd: ProxyFD
  write(data: Blob): Promise<void>
  read(count: number): Promise<Blob>
  readStream(chunkSize: number): Promise<ReadableStream<Uint8Array>>
  readBlob(): Promise<Blob>
  close(): Promise<void>
}
type InputOutput = {
  mkstempMmap(data: Blob): Promise<InputOutputFD>
  mkfifo(): Promise<InputOutputFD[]>
  wrapFD(fd: unknown, type: 'pipe-read' | 'pipe-write' | 'shm'): InputOutputFD
}
type ServerClientConnection = { onMessage(data: Uint8Array): void; close(): void }
type ServerCompositor = {
  connectClient(options: {
    clientId: string
    send: (data: Uint8Array) => void
    inputOutput: InputOutput
    getBufferSize: (bufferId: number) => Size | undefined
  }): ServerClientConnection
  dumpSurfaces(): unknown
}
type ServerCompositorModule = {
  createServerCompositor(options: { outputSize: Size; keyboardLanguage: string }): Promise<ServerCompositor>
}

// tsc compiles import() to require() for commonjs output, which can't load the ES module bundle.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importESM = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>

/**
 * Runs the compositor (protocol implementation) inside this proxy session process instead of in a browser.
 * Enabled with GFLD_SERVER_COMPOSITOR=1.
 *
 * TODO spike: frames are encoded but dropped, there is no browser attached.
 */
export async function enableInProcessCompositor(session: Session): Promise<ServerCompositor> {
  const bundlePath =
    process.env.GFLD_SERVER_COMPOSITOR_BUNDLE ??
    path.resolve(__dirname, '../../compositor/dist-server/index.mjs')
  const serverCompositorModule: ServerCompositorModule = await importESM(pathToFileURL(bundlePath).href)
  const serverCompositor = await serverCompositorModule.createServerCompositor({
    outputSize: { width: 1280, height: 720 },
    keyboardLanguage: process.env.LANG?.split('.')[0]?.replace('_', '-') ?? 'en-US',
  })

  setInProcessChannelFactory((desc, nativeAppContext) => {
    switch (desc.type) {
      case ChannelDescriptionType.PROTOCOL:
        return createProtocolLoopbackChannel(desc, nativeAppContext, session, serverCompositor)
      case ChannelDescriptionType.FRAME:
        return new LoopbackChannel(desc, nativeAppContext)
      case ChannelDescriptionType.FEEDBACK:
        return createFeedbackLoopbackChannel(desc, nativeAppContext)
      default:
        // TODO XWM
        return undefined
    }
  })

  logger.info(`Server-side compositor enabled.`)
  return serverCompositor
}

class LoopbackChannel implements WebSocketChannel {
  readonly inProcess = true
  isOpen = true
  ws?: WebSocket
  onOpen = () => {
    /* noop */
  }
  onClose = () => {
    /* noop */
  }
  onMessage = (_buffer: Buffer) => {
    /* noop */
  }
  onSend: (buffer: Buffer) => void = () => {
    /* noop, e.g. encoded frames while no browser is attached */
  }
  closeListeners: (() => void)[] = []

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

  close(): void {
    this.doClose()
  }

  doOpen(_ws: WebSocket): void {
    /* noop */
  }

  doMessage(buffer: Buffer): void {
    this.onMessage(buffer)
  }

  doClose(): void {
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

function createProtocolLoopbackChannel(
  desc: ChannelDesc,
  nativeAppContext: NativeAppContext,
  session: Session,
  serverCompositor: ServerCompositor,
): LoopbackChannel {
  const channel = new LoopbackChannel(desc, nativeAppContext)
  const webFS = session.nativeWaylandCompositorSession.webFS
  const connection = serverCompositor.connectClient({
    clientId: desc.clientId,
    send: (data) => channel.doMessage(Buffer.from(data.buffer, data.byteOffset, data.byteLength)),
    inputOutput: createInputOutput((buffer) => webFS.mkstempMmap(buffer)),
    getBufferSize: (bufferId) => {
      const clientEntry = session.nativeWaylandCompositorSession.clients.find(
        (entry) => entry.clientId === desc.clientId,
      )
      return clientEntry ? getBufferSize(clientEntry.nativeClientSession.wlClient, bufferId) : undefined
    },
  })
  // Messages from the native side are delivered asynchronously, like they were over a WebSocket, so the compositor
  // never runs (and re-enters libwayland) inside a native dispatch callback.
  channel.onSend = (buffer) => {
    const data = new Uint8Array(buffer)
    queueMicrotask(() => connection.onMessage(data))
  }
  channel.closeListeners.push(() => connection.close())
  return channel
}

function createFeedbackLoopbackChannel(desc: ChannelDesc, nativeAppContext: NativeAppContext): LoopbackChannel {
  const channel = new LoopbackChannel(desc, nativeAppContext)
  // FrameFeedback stops releasing frame callbacks when it doesn't hear from a viewer for >1.5s. Pretend to be a
  // viewer with a 60Hz refresh rate that decodes instantly.
  // TODO when a browser is attached, forward its real feedback. When none is attached, throttle clients instead.
  const sendFeedback = () => {
    const feedback = Buffer.alloc(4)
    feedback.writeUInt16LE(16, 0) // refresh interval in ms
    feedback.writeUInt16LE(0, 2) // average decode duration in ms
    channel.doMessage(feedback)
  }
  setImmediate(sendFeedback)
  const timer = setInterval(sendFeedback, 500)
  channel.closeListeners.push(() => clearInterval(timer))
  return channel
}

function createInputOutput(mkstempMmap: (buffer: Buffer) => ProxyFD): InputOutput {
  const wrap = (fd: ProxyFD): InputOutputFD => ({
    fd,
    write: () => Promise.reject(new Error('TODO server-side fd write')),
    read: () => Promise.reject(new Error('TODO server-side fd read')),
    readStream: () => Promise.reject(new Error('TODO server-side fd read stream')),
    readBlob: () => Promise.reject(new Error('TODO server-side fd read blob')),
    close: () => Promise.resolve(),
  })

  return {
    mkstempMmap: async (data) => wrap(mkstempMmap(Buffer.from(await data.arrayBuffer()))),
    mkfifo: () => Promise.reject(new Error('TODO server-side mkfifo')),
    wrapFD: (fd, type) => wrap({ ...(fd as ProxyFD), type }),
  }
}
