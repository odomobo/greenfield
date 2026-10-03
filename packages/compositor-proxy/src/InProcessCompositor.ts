import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ReadableStream } from 'node:stream/web'
import { InProcessChannel, setProtocolChannelConnector } from './Channel.js'
import { createLogger } from './Logger.js'
import { Session } from './Session.js'
import { getBufferSize } from './wayland-server.js'
import { ProxyFD } from './io/types.js'
import { ViewerHost, WindowSceneEndpoint } from './viewer/ViewerHost.js'
import { requestKeyFrame, requestKeyFramesForAllSurfaces, setFrameSink } from './SurfaceBufferEncoding.js'

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
export type ServerCompositor = {
  connectClient(options: {
    clientId: string
    send: (data: Uint8Array) => void
    inputOutput: InputOutput
    getBufferSize: (bufferId: number) => Size | undefined
  }): ServerClientConnection
  readonly scene: WindowSceneEndpoint
}
type ServerCompositorModule = {
  createServerCompositor(options: { outputSize: Size; keyboardLanguage: string }): Promise<ServerCompositor>
}

// tsc compiles import() to require() for commonjs output, which can't load the ES module bundle.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importESM = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>

/**
 * Runs the compositor (protocol implementation) inside this session process. Native Wayland clients talk to it over
 * in-process channels, a viewer (browser) attaches through the ViewerHost.
 */
export async function startServerCompositor(session: Session): Promise<{ viewerHost: ViewerHost }> {
  const bundlePath =
    process.env.GFLD_SERVER_COMPOSITOR_BUNDLE ?? path.resolve(__dirname, '../../compositor/dist-server/index.mjs')
  const serverCompositorModule: ServerCompositorModule = await importESM(pathToFileURL(bundlePath).href)
  const serverCompositor = await serverCompositorModule.createServerCompositor({
    // replaced by the viewer's output size once one attaches
    outputSize: { width: 1280, height: 720 },
    keyboardLanguage: process.env.LANG?.split('.')[0]?.replace('_', '-') ?? 'en-US',
  })

  setProtocolChannelConnector((channel) => connectProtocolChannel(channel, session, serverCompositor))

  logger.info(`Server-side compositor started.`)
  return {
    viewerHost: new ViewerHost(serverCompositor.scene, {
      setFrameSink,
      requestKeyFrame,
      requestKeyFramesForAllSurfaces,
    }),
  }
}

function connectProtocolChannel(channel: InProcessChannel, session: Session, serverCompositor: ServerCompositor) {
  const webFS = session.nativeWaylandCompositorSession.webFS
  const connection = serverCompositor.connectClient({
    clientId: channel.desc.clientId,
    send: (data) => channel.deliver(Buffer.from(data.buffer, data.byteOffset, data.byteLength)),
    inputOutput: createInputOutput((buffer) => webFS.mkstempMmap(buffer)),
    getBufferSize: (bufferId) => {
      const clientEntry = session.nativeWaylandCompositorSession.clients.find(
        (entry) => entry.clientId === channel.desc.clientId,
      )
      return clientEntry ? getBufferSize(clientEntry.nativeClientSession.wlClient, bufferId) : undefined
    },
  })
  // Messages from the native side are delivered asynchronously, so the compositor never runs (and re-enters
  // libwayland) inside a native dispatch callback.
  channel.onSend = (buffer) => {
    const data = new Uint8Array(buffer)
    queueMicrotask(() => connection.onMessage(data))
  }
  channel.closeListeners.push(() => connection.close())
}

function createInputOutput(mkstempMmap: (buffer: Buffer) => ProxyFD): InputOutput {
  // TODO clipboard & drag and drop: read/write pipes and mkfifo server-side
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
