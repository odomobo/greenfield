import { WebSocket } from 'ws'
import { createLogger } from '../Logger.js'
import { onViewerFeedback, setViewerAttached } from '../FrameFeedback.js'
import { requestKeyFrame, requestKeyFramesForAllSurfaces, setFrameSink } from '../SurfaceBufferEncoding.js'
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
 * Owns the (at most one) viewer connection of this session. A new viewer takes over from the previous one. The
 * session, its compositor and apps live on without a viewer.
 */
export class ViewerHost {
  private transport?: ViewerTransport

  constructor(private readonly scene: WindowSceneEndpoint) {
    const isAttached = () => this.transport !== undefined
    setFrameSink({
      get active() {
        return isAttached()
      },
      sendFrame: (surfaceKey, frame) => this.transport?.send({ priority: 'frame', surface: surfaceKey, frame }),
    })
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
    }

    const transport = new WebSocketViewerTransport(ws)
    this.transport = transport
    transport.onKeyFrameNeeded = (surface) => requestKeyFrame(surface)
    transport.onMessage = (message) => this.onMessage(transport, message)
    transport.onClose = (code, reason) => {
      if (this.transport !== transport) {
        return
      }
      logger.info(`Viewer detached. Code: ${code}. Reason: ${reason}`)
      this.transport = undefined
      setViewerAttached(false)
      this.scene.detach()
    }

    logger.info('Viewer attached.')
    setViewerAttached(true)
    transport.send({ priority: 'control', message: { type: 'welcome', protocolVersion: PROTOCOL_VERSION } })
    this.scene.attach((message) => transport.send({ priority: 'control', message }))
    // the viewer has nothing yet, every surface starts with a key frame of its current content
    requestKeyFramesForAllSurfaces()
  }

  private onMessage(transport: ViewerTransport, message: ControlMessage) {
    switch (message.type) {
      case 'feedback':
        onViewerFeedback(Number(message.refreshInterval) || 0, Number(message.decodeDuration) || 0)
        break
      case 'keyframe':
        if (typeof message.surface === 'string') {
          transport.requireKeyFrame(message.surface)
          requestKeyFrame(message.surface)
        }
        break
      default:
        try {
          this.scene.handleMessage(message)
        } catch (e: any) {
          logger.error(`Failed to handle viewer message ${message.type}: ${e.message}\n${e.stack}`)
        }
    }
  }
}
