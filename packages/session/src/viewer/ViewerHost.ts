import { WebSocket } from 'ws'
import { createLogger } from '../Logger.js'
import { onViewerFeedback, setViewerAttached } from '../FramePacing.js'
import type { EncodingSink } from '../encoding/SurfaceEncoder.js'
import { AudioPacket, CLOSE_LOGGED_OUT, CLOSE_TAKEN_OVER, PROTOCOL_VERSION } from './protocol.js'
import { ControlMessage, SimulatedLink, ViewerTransport, WebSocketViewerTransport } from './ViewerTransport.js'

const logger = createLogger('viewer-host')

/**
 * The window scene of the server-side compositor, as seen by the viewer host. Implemented in
 * packages/compositor/src/server/scene.ts.
 */
export interface WindowSceneEndpoint {
  /** A viewer attached. Send it a full snapshot now and updates from then on. */
  attach(send: (message: ControlMessage) => void): void

  detach(): void

  /** Input, window management and output messages from the viewer. */
  handleMessage(message: ControlMessage): void

  /** The next bytes of a file the viewer uploads (a file drop, see the scene protocol). */
  handleFileChunk?(id: number, data: Uint8Array): void
}

/**
 * The session's surface contents (its encoders): where encoded frames and patches go, and resending a surface's whole
 * content. Implemented by wlroots/WlrCompositor.ts.
 */
export interface SurfaceContent {
  setFrameSink(sink: EncodingSink): void

  /** The predicted size of the surfaces' damage not handed to the sink yet (see SurfaceEncoder.unencodedBytes). */
  unencodedBytes?(): number

  /** Send the whole current content of a surface again (a video key frame or a full set of patches). */
  requestKeyFrame(surface: string): void

  requestKeyFramesForAllSurfaces(): void
}

/**
 * The desktop shell's server side (app list, launching, pinned apps, notifications), provided by the session process.
 * Gets the viewer's `shell.*` messages.
 */
export interface ShellEndpoint {
  attach(send: (message: ControlMessage) => void): void

  detach(): void

  handleMessage(message: ControlMessage): void
}

/**
 * The session's audio (its PipeWire and the capture of its output), provided by the session process. Gets the
 * viewer's `audio.*` messages. Sends control messages (`audio.state`) and, while the viewer wants audio, packets.
 */
export interface AudioEndpoint {
  attach(send: (message: ControlMessage) => void, sendAudio: (packet: AudioPacket) => void): void

  detach(): void

  handleMessage(message: ControlMessage): void
}

/**
 * Owns the (at most one) viewer connection of this session. A new viewer takes over from the previous one. The
 * session, its compositor and apps live on without a viewer.
 */
export class ViewerHost {
  private transport?: ViewerTransport
  private shellEndpoint?: ShellEndpoint
  private audioEndpoint?: AudioEndpoint
  /**
   * The viewer asked to log out (`session.logout`). The session stops taking connections and ends; it calls `done`
   * once a new sign-in can no longer reach it, and the viewer is closed with CLOSE_LOGGED_OUT then.
   */
  onLogout?: (done: () => void) => void

  constructor(
    private readonly scene: WindowSceneEndpoint,
    private readonly content: SurfaceContent,
    private readonly options: { link?: SimulatedLink } = {},
  ) {
    const isAttached = () => this.transport !== undefined
    const isBandwidthLimited = () => this.transport?.bandwidthLimited ?? false
    const linkBandwidth = () => this.transport?.linkBandwidth
    content.setFrameSink({
      get active() {
        return isAttached()
      },
      get bandwidthLimited() {
        return isBandwidthLimited()
      },
      get linkBandwidth() {
        return linkBandwidth()
      },
      queuedBytes: (surfaceKey) => this.transport?.queuedBytes(surfaceKey) ?? 0,
      sendFrame: (surfaceKey, frame, surfaceClass, done) => {
        if (this.transport) {
          this.transport.send({ priority: 'frame', surface: surfaceKey, frame, surfaceClass, done })
        } else {
          done(false)
        }
      },
      sendPatch: (surfaceKey, patch, tier, done) => {
        if (this.transport) {
          this.transport.send({ priority: 'patch', surface: surfaceKey, patch, tier, done })
        } else {
          done(false)
        }
      },
      requireKeyFrame: (surfaceKey) => this.transport?.requireKeyFrame(surfaceKey),
      dropPatches: (surfaceKey) => this.transport?.dropPatches(surfaceKey),
      forgetSurface: (surfaceKey) => this.transport?.forgetSurface(surfaceKey),
    })
  }

  set shell(shell: ShellEndpoint) {
    this.shellEndpoint = shell
    const transport = this.transport
    if (transport) {
      shell.attach((message) => transport.send({ priority: 'control', message }))
    }
  }

  set audio(audio: AudioEndpoint) {
    this.audioEndpoint = audio
    const transport = this.transport
    if (transport) {
      this.attachAudio(audio, transport)
    }
  }

  private attachAudio(audio: AudioEndpoint, transport: ViewerTransport) {
    audio.attach(
      (message) => transport.send({ priority: 'control', message }),
      (packet) => transport.send({ priority: 'audio', packet }),
    )
  }

  /** A new viewer, at the client address `clientIP` (text, '' if unknown): it takes over from the previous one. */
  attach(ws: WebSocket, clientIP = ''): void {
    if (this.transport) {
      logger.info(`New viewer from ${clientIP || 'an unknown address'}, taking over from the previous one.`)
      // the close reason is the new viewer's address (a close reason is at most 123 bytes; an address is shorter)
      this.detachViewer(CLOSE_TAKEN_OVER, clientIP.slice(0, 64))
    }

    const transport = new WebSocketViewerTransport(ws, {
      link: this.options.link,
      unencodedBytes: () => this.content.unencodedBytes?.() ?? 0,
    })
    this.transport = transport
    transport.onKeyFrameNeeded = (surface) => this.content.requestKeyFrame(surface)
    transport.onMessage = (message) => this.onMessage(transport, message)
    transport.onFileChunk = (id, data) => this.scene.handleFileChunk?.(id, data)
    transport.onClose = (code, reason) => {
      if (this.transport !== transport) {
        return
      }
      logger.info(`Viewer detached. Code: ${code}. Reason: ${reason}`)
      this.transport = undefined
      setViewerAttached(false)
      this.scene.detach()
      this.shellEndpoint?.detach()
      this.audioEndpoint?.detach()
    }

    logger.info('Viewer attached.')
    setViewerAttached(true)
    transport.send({
      priority: 'control',
      message: { type: 'welcome', protocolVersion: PROTOCOL_VERSION },
    })
    this.scene.attach((message) => transport.send({ priority: 'control', message }))
    this.shellEndpoint?.attach((message) => transport.send({ priority: 'control', message }))
    if (this.audioEndpoint) {
      this.attachAudio(this.audioEndpoint, transport)
    }
    // the viewer has nothing yet, every surface starts with its whole current content (key frame or patches)
    this.content.requestKeyFramesForAllSurfaces()
  }

  /** Close the current viewer's connection with this code and reason. */
  private detachViewer(code: number, reason: string) {
    const previous = this.transport
    if (previous === undefined) {
      return
    }
    this.transport = undefined
    previous.onClose = () => {
      /* noop, already detached */
    }
    previous.close(code, reason)
    setViewerAttached(false)
    this.scene.detach()
    this.shellEndpoint?.detach()
    this.audioEndpoint?.detach()
  }

  private onMessage(transport: ViewerTransport, message: ControlMessage) {
    switch (message.type) {
      case 'session.logout':
        logger.info('The viewer logs out.')
        if (this.onLogout === undefined) {
          this.detachViewer(CLOSE_LOGGED_OUT, 'logged out')
        } else {
          this.onLogout(() => {
            if (this.transport === transport) {
              this.detachViewer(CLOSE_LOGGED_OUT, 'logged out')
            }
          })
        }
        break
      case 'feedback':
        onViewerFeedback(Number(message.refreshInterval) || 0)
        break
      case 'keyframe':
        if (typeof message.surface === 'string') {
          transport.requireKeyFrame(message.surface)
          this.content.requestKeyFrame(message.surface)
        }
        break
      default:
        try {
          if (message.type.startsWith('shell.')) {
            this.shellEndpoint?.handleMessage(message)
          } else if (message.type.startsWith('audio.')) {
            this.audioEndpoint?.handleMessage(message)
          } else {
            this.scene.handleMessage(message)
          }
        } catch (e: any) {
          logger.error(`Failed to handle viewer message ${message.type}: ${e.message}\n${e.stack}`)
        }
    }
  }
}
