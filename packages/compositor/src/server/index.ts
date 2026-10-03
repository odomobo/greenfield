/**
 * Server-side entry point: runs the protocol implementation inside the proxy process, without a browser.
 *
 * The proxy keeps intercepting native libwayland traffic exactly as before, but instead of shipping the wire
 * messages over a WebSocket to a browser compositor, they are handed to this in-process compositor. The message
 * framing is the same one the browser used (see remote/RemoteAppLauncher.ts), so the proxy needs no protocol changes.
 */
import { WlBufferResource, WlSurfaceResource } from '@gfld/compositor-protocol'
import { FD, SendMessage } from '@gfld/common'
import { init as initWasm } from '@gfld/compositor-wasm'
import { InputOutput } from '../InputOutput'
import { Size } from '../math/Size'
import Output from '../Output'
import Session, { GreenfieldLogger } from '../Session'
import Surface from '../Surface'
import { createServerPlatform, ServerPlatformOptions } from './platform'
import { ServerBuffer } from './ServerBuffer'
import { WindowScene, WindowSceneEndpoint } from './scene'

export type { InputOutput, InputOutputFD } from '../InputOutput'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// out-of-band opcodes, see remote/RemoteOutOfBandChannel.ts
const OOB_RESOURCE_DESTROYED = 1
const OOB_BUFFER_CREATION = 2
const OOB_RECYCLED_RESOURCE_IDS = 6
const OOB_COMMIT_SERIAL = 7

export type ServerClientOptions = {
  clientId: string
  /**
   * Deliver a message to the native side of the proxy (what NativeWaylandClientSession.onMessage expects).
   */
  send: (data: Uint8Array) => void
  inputOutput: InputOutput
  getBufferSize: (bufferId: number) => Size | undefined
}

export interface ServerClientConnection {
  /**
   * A message from the native side of the proxy (what was previously sent over the protocol channel).
   */
  onMessage(data: Uint8Array): void

  close(): void
}

export interface ServerCompositor {
  readonly session: Session

  connectClient(options: ServerClientOptions): ServerClientConnection

  /**
   * What an attached viewer talks to.
   */
  readonly scene: WindowSceneEndpoint
}

export async function createServerCompositor(
  options: ServerPlatformOptions & { logger?: GreenfieldLogger },
): Promise<ServerCompositor> {
  await initWasm()
  let outputSize: Size = options.outputSize
  const session = await Session.create(
    { mode: 'floating' },
    createServerPlatform({ ...options, outputSize: () => outputSize }),
    options.logger,
  )

  const output = Output.create(() => outputSize, 'viewer', 'landscape-primary')
  session.globals.registerOutput(output)
  session.globals.register()

  const scene = new WindowScene(session, output, (size) => (outputSize = size))

  return {
    session,
    connectClient: (clientOptions) => connectClient(session, clientOptions),
    scene,
  }
}

function connectClient(session: Session, options: ServerClientOptions): ServerClientConnection {
  const client = session.display.createClient(options.clientId)
  client.userData = {
    inputOutput: options.inputOutput,
  }

  const sendOutOfBand = (opcode: number, payload: Uint32Array) => {
    const message = new Uint32Array(1 + payload.length)
    message[0] = opcode
    message.set(payload, 1)
    options.send(new Uint8Array(message.buffer))
  }

  // Server-side ids of objects created natively (not from our reserved id batch). Once destroyed they stay reserved on
  // the native side and are recycled here like any other server id.
  const nativeServerIds = new Set<number>()
  client.addResourceDestroyListener((resource) => {
    nativeServerIds.delete(resource.id)
    sendOutOfBand(OOB_RESOURCE_DESTROYED, new Uint32Array([resource.id]))
  })
  client.addResourceCreatedListener((resource) => {
    if (resource.id >= 0xff000000 && !nativeServerIds.has(resource.id) && client.recycledIds.length === 0) {
      session.logger.warn('[client] - Ran out of reserved resource ids.')
      client.close()
    }
  })
  client.connection.onFlush = (wireMessages: SendMessage[]) => {
    if (client.connection.closed) {
      return
    }
    options.send(serializeWireMessages(client.display.eventSerial, wireMessages))
  }

  const outOfBandHandlers: Record<number, (payload: Uint32Array) => void> = {
    [OOB_BUFFER_CREATION]: (payload) => {
      const resourceId = payload[0]
      if (resourceId >= 0xff000000) {
        // Created natively with a server-allocated id (linux-dmabuf non-immediate create), not taken from our id batch.
        nativeServerIds.add(resourceId)
      }
      const wlBufferResource = new WlBufferResource(client, resourceId, 1)
      wlBufferResource.implementation = new ServerBuffer(wlBufferResource, () => options.getBufferSize(resourceId))
    },
    [OOB_RECYCLED_RESOURCE_IDS]: (payload) => {
      client.recycledIds = Array.from(payload)
    },
    [OOB_COMMIT_SERIAL]: (payload) => {
      const wlSurface = client.connection.wlObjects[payload[0]] as WlSurfaceResource | undefined
      if (wlSurface === undefined) {
        return
      }
      ;(wlSurface.implementation as Surface).commitSerials.push(payload[1])
    },
  }

  return {
    onMessage(data: Uint8Array) {
      if (client.connection.closed) {
        return
      }
      // copy so we have an aligned buffer that is ours
      const words = new Uint32Array(data.slice().buffer)
      const outOfBandOpcode = words[0]
      if (outOfBandOpcode) {
        const handler = outOfBandHandlers[outOfBandOpcode]
        if (handler) {
          handler(words.subarray(1))
        } else {
          session.logger.warn(`[BUG?] Out of band using opcode: ${outOfBandOpcode} not found. Ignoring.`)
        }
        return
      }

      let offset = 1
      const fdsInCount = words[offset++]
      const fds = new Array<FD>(fdsInCount)
      for (let i = 0; i < fdsInCount; i++) {
        const fdByteLength = words[offset]
        const fdBytes = new Uint8Array(words.buffer, (offset + 1) * Uint32Array.BYTES_PER_ELEMENT, fdByteLength)
        fds[i] = JSON.parse(textDecoder.decode(fdBytes))
        offset += 1 + ((fdByteLength + 3) & ~3) / 4
      }
      client.connection.message({ buffer: words.subarray(offset), fds }).catch((e: Error) => {
        session.logger.error(`[client: ${client.id}] - ${e.name}: ${e.message}\n${e.stack}`)
      })
    },
    close() {
      client.close()
    },
  }
}

function serializeWireMessages(eventSerial: number, wireMessages: SendMessage[]): Uint8Array {
  let messageSize = 2 // out-of-band indicator & event serial
  const serializedWireMessages = wireMessages.map((wireMessage) => {
    let size = 1 // fd count
    const serializedFds = wireMessage.fds.map((fd: FD) => {
      // fds are ProxyFD json objects, created by the proxy's InputOutput implementation
      const serializedFD = textEncoder.encode(JSON.stringify(fd))
      size += 1 + ((serializedFD.byteLength + 3) & ~3) / 4
      return serializedFD
    })
    messageSize += size + wireMessage.buffer.byteLength / 4
    return { buffer: wireMessage.buffer, serializedFds }
  })

  const sendBuffer = new Uint32Array(messageSize)
  let offset = 0
  sendBuffer[offset++] = 0
  sendBuffer[offset++] = eventSerial
  for (const { buffer, serializedFds } of serializedWireMessages) {
    sendBuffer[offset++] = serializedFds.length
    for (const serializedFd of serializedFds) {
      sendBuffer[offset++] = serializedFd.byteLength
      new Uint8Array(sendBuffer.buffer, offset * Uint32Array.BYTES_PER_ELEMENT).set(serializedFd)
      offset += ((serializedFd.byteLength + 3) & ~3) / 4
    }
    const message = new Uint32Array(buffer)
    sendBuffer.set(message, offset)
    offset += message.length
  }
  return new Uint8Array(sendBuffer.buffer)
}
