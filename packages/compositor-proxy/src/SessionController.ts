import { WebSocketServer } from 'ws'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { createLogger } from './Logger.js'
import { ViewerHost } from './viewer/ViewerHost.js'

const logger = createLogger('session-controller')

export type SessionController = {
  onWsUpgrade(
    request: { headers: IncomingMessage['headers']; method: IncomingMessage['method']; url: IncomingMessage['url'] },
    socket: Socket,
    head?: Buffer,
    clientIP?: string,
  ): void
}

/**
 * WebSocket endpoints of a session process. The gateway already signed the user in and checked that the session
 * belongs to them. The client's IP address (for the takeover message the previous viewer gets) is `clientIP` when the
 * session knows it otherwise (a login helper's handover), else the handshake's `X-Client-IP` header (the monitor's
 * relay).
 */
export function createSessionController(viewerHost: ViewerHost): SessionController {
  const wss = new WebSocketServer({ perMessageDeflate: false, noServer: true })

  return {
    onWsUpgrade(request, socket, head, clientIP) {
      wss.handleUpgrade(request as IncomingMessage, socket, head ?? Buffer.from([]), (ws) => {
        const url = new URL(request.url ?? '', `http://${request.headers.host}`)
        if (url.pathname === '/viewer') {
          const header = request.headers['x-client-ip']
          viewerHost.attach(ws, clientIP ?? (typeof header === 'string' ? header : ''))
        } else {
          logger.info(`Unknown WebSocket endpoint: ${url.pathname}`)
          ws.close(4404, 'Not found')
        }
      })
    },
  }
}
