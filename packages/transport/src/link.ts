/**
 * The link to the viewer: the WebSocket (with its socket tuned so data waits in the transport's queue, not the
 * kernel's), the simulated link (development only), and receive decoding.
 */
import { WebSocket } from 'ws'
import type { Socket } from 'node:net'
import { decodeViewerEnvelope, EnvelopeKind } from '@gfld/scene-protocol'
import { setSocketSendBuffer, setTcpNotSentLowat } from './socket-options.js'

/** Where the transport logs. */
export interface TransportLogger {
  info(message: string): void

  error(message: string): void
}

/**
 * DEVELOPMENT ONLY (the session's --dev-link-kbps): a simulated bottleneck of this many bytes per ms between the
 * transport and the socket. Everything sent (control messages and audio too, in order) waits in a FIFO and leaves at
 * that rate, as through a slow link with a deep buffer, so the congestion controller sees the queue and the bandwidth.
 * As with a real socket, a write is done (the item counts as sent) as soon as the FIFO took it.
 */
export type SimulatedLink = { bytesPerMs: number }

/** What the viewer sends, decoded. */
export type ViewerEnvelope = ReturnType<typeof decodeViewerEnvelope>

// Keep the kernel's unsent backlog small, so frames wait in our queue where control messages can overtake them.
const TCP_NOTSENT_LOWAT_BYTES = 32 * 1024
// Same idea when the viewer is relayed to us over a Unix socket (by the gateway): cap the kernel send buffer.
const UNIX_SEND_BUFFER_BYTES = 32 * 1024
// The simulated link logs audio waiting longer than this behind other data (see noteLinkAudioWait).
const LINK_AUDIO_WAIT_LOG_MS = 30

export class WebSocketLink {
  /** the simulated link's queue (see SimulatedLink) and when it is free again */
  private readonly linkQueue: { data: Uint8Array; at: number }[] = []
  private linkFreeAt = 0
  private linkTimer?: NodeJS.Timeout
  /** the longest an audio packet waited in the simulated link this second, and when the second began */
  private linkAudioWait = 0
  private linkAudioWaitSince = 0

  constructor(
    private readonly ws: WebSocket,
    private readonly options: {
      now: () => number
      logger: TransportLogger
      link?: SimulatedLink
      /** a message from the viewer, decoded */
      onEnvelope: (envelope: ViewerEnvelope) => void
      /** the viewer sent something that isn't a valid envelope: the connection is to be closed with this */
      onInvalid: (code: number, reason: string) => void
      /** the connection closed (the simulated link's queue is dropped first) */
      onClose: (code: number, reason: string) => void
    },
  ) {
    ws.binaryType = 'nodebuffer'
    this.limitSocketBacklog()
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        options.onInvalid(4400, 'Expected binary messages.')
        return
      }
      let envelope: ViewerEnvelope
      try {
        envelope = decodeViewerEnvelope(data)
      } catch (e: any) {
        options.logger.error(`Invalid message from viewer: ${e.message}`)
        options.onInvalid(4400, e.message)
        return
      }
      options.onEnvelope(envelope)
    })
    ws.on('close', (code, reason) => {
      this.clearLink()
      options.onClose(code, reason.toString())
    })
    ws.on('error', (error) => options.logger.error(`Viewer connection error: ${error.message}`))
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN
  }

  /** the bytes the WebSocket holds in user space, not handed to the socket yet */
  get bufferedAmount(): number {
    return this.ws.bufferedAmount
  }

  close(code: number, reason: string): void {
    this.clearLink()
    this.ws.close(code, reason)
  }

  /** Hand bytes to the socket (through the simulated link, if there is one); `sent` once the socket took them. */
  write(data: Uint8Array, sent?: () => void): void {
    const link = this.options.link
    if (link === undefined) {
      this.ws.send(data, { binary: true }, sent)
      return
    }
    const now = this.options.now()
    this.linkFreeAt = Math.max(now, this.linkFreeAt) + data.byteLength / link.bytesPerMs
    this.linkQueue.push({ data, at: this.linkFreeAt })
    if (data[1] === EnvelopeKind.AUDIO) {
      this.noteLinkAudioWait(this.linkFreeAt - now, now)
    }
    this.scheduleLink(now)
    if (sent) {
      queueMicrotask(sent)
    }
  }

  /**
   * How long audio waits behind other data in the simulated link: logged (at most once a second) when it was more than
   * LINK_AUDIO_WAIT_LOG_MS, for tests (scripts/e2e/lossy.sh) and for trying things by hand.
   */
  private noteLinkAudioWait(wait: number, now: number) {
    if (now - this.linkAudioWaitSince >= 1000) {
      if (this.linkAudioWait > LINK_AUDIO_WAIT_LOG_MS) {
        this.options.logger.info(
          `Simulated link: an audio packet waited ${Math.round(this.linkAudioWait)} ms behind other data.`,
        )
      }
      this.linkAudioWait = 0
      this.linkAudioWaitSince = now
    }
    this.linkAudioWait = Math.max(this.linkAudioWait, wait)
  }

  private scheduleLink(now: number) {
    if (this.linkTimer !== undefined || this.linkQueue.length === 0) {
      return
    }
    this.linkTimer = setTimeout(
      () => {
        this.linkTimer = undefined
        const now = this.options.now()
        while (this.linkQueue.length && this.linkQueue[0].at <= now) {
          const { data } = this.linkQueue.shift()!
          if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(data, { binary: true })
          }
        }
        this.scheduleLink(now)
      },
      Math.max(0, Math.ceil(this.linkQueue[0].at - now)),
    )
  }

  private clearLink() {
    if (this.linkTimer !== undefined) {
      clearTimeout(this.linkTimer)
      this.linkTimer = undefined
    }
    this.linkQueue.length = 0
  }

  private limitSocketBacklog() {
    const logger = this.options.logger
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
