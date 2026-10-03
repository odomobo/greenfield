import { WebSocket } from 'ws'
import { createLogger } from '../Logger.js'
import { onViewerFeedback, setViewerAttached } from '../FramePacing.js'
import type { EncodingSink } from '../encoding/SurfaceEncoder.js'
import { CLOSE_TAKEN_OVER, PROTOCOL_VERSION } from './protocol.js'
import { ControlMessage, ViewerTransport, WebSocketViewerTransport } from './ViewerTransport.js'

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
}

/**
 * The session's surface contents (its encoders): where encoded frames and patches go, and resending a surface's whole
 * content. Implemented by SurfaceBufferEncoding.ts (libwayland fork) and wlroots/WlrCompositor.ts (prototype).
 */
export interface SurfaceContent {
  setFrameSink(sink: EncodingSink): void

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
 * Owns the (at most one) viewer connection of this session. A new viewer takes over from the previous one. The
 * session, its compositor and apps live on without a viewer.
 */
export class ViewerHost {
  private transport?: ViewerTransport
  private shellEndpoint?: ShellEndpoint

  constructor(
    private readonly scene: WindowSceneEndpoint,
    private readonly content: SurfaceContent,
  ) {
    const isAttached = () => this.transport !== undefined
    content.setFrameSink({
      get active() {
        return isAttached()
      },
      sendFrame: (surfaceKey, frame) => this.transport?.send({ priority: 'frame', surface: surfaceKey, frame }),
      sendPatch: (surfaceKey, patch, done) => {
        if (this.transport) {
          this.transport.send({ priority: 'patch', surface: surfaceKey, patch, done })
        } else {
          done(false)
        }
      },
      requireKeyFrame: (surfaceKey) => this.transport?.requireKeyFrame(surfaceKey),
      dropPatches: (surfaceKey) => this.transport?.dropPatches(surfaceKey),
    })
  }

  set shell(shell: ShellEndpoint) {
    this.shellEndpoint = shell
    const transport = this.transport
    if (transport) {
      shell.attach((message) => transport.send({ priority: 'control', message }))
    }
  }

  attach(ws: WebSocket): void {
    const previous = this.transport
    if (previous) {
      logger.info('New viewer, taking over from the previous one.')
      this.transport = undefined
      previous.onClose = () => {
        /* noop, already detached */
      }
      previous.close(CLOSE_TAKEN_OVER, 'Session taken over by another viewer.')
      this.scene.detach()
      this.shellEndpoint?.detach()
    }

    const transport = new WebSocketViewerTransport(ws)
    this.transport = transport
    transport.onKeyFrameNeeded = (surface) => this.content.requestKeyFrame(surface)
    transport.onMessage = (message) => this.onMessage(transport, message)
    transport.onClose = (code, reason) => {
      if (this.transport !== transport) {
        return
      }
      logger.info(`Viewer detached. Code: ${code}. Reason: ${reason}`)
      this.transport = undefined
      setViewerAttached(false)
      this.scene.detach()
      this.shellEndpoint?.detach()
    }

    logger.info('Viewer attached.')
    setViewerAttached(true)
    transport.send({
      priority: 'control',
      message: { type: 'welcome', protocolVersion: PROTOCOL_VERSION },
    })
    this.scene.attach((message) => transport.send({ priority: 'control', message }))
    this.shellEndpoint?.attach((message) => transport.send({ priority: 'control', message }))
    // the viewer has nothing yet, every surface starts with its whole current content (key frame or patches)
    this.content.requestKeyFramesForAllSurfaces()
  }

  private onMessage(transport: ViewerTransport, message: ControlMessage) {
    switch (message.type) {
      case 'feedback':
        onViewerFeedback(Number(message.refreshInterval) || 0, Number(message.decodeDuration) || 0)
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
          } else {
            this.scene.handleMessage(message)
          }
        } catch (e: any) {
          logger.error(`Failed to handle viewer message ${message.type}: ${e.message}\n${e.stack}`)
        }
    }
  }
}
