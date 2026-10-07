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
  ): void
}

/**
 * WebSocket endpoints of a session process. The gateway already signed the user in and checked that the session
 * belongs to them; its handshake carries the client's IP address in `X-Client-IP` (for the takeover message the
 * previous viewer gets).
 */
export function createSessionController(viewerHost: ViewerHost): SessionController {
  const wss = new WebSocketServer({ perMessageDeflate: false, noServer: true })

  return {
    onWsUpgrade(request, socket, head) {
      wss.handleUpgrade(request as IncomingMessage, socket, head ?? Buffer.from([]), (ws) => {
        const url = new URL(request.url ?? '', `http://${request.headers.host}`)
        if (url.pathname === '/viewer') {
          const ip = request.headers['x-client-ip']
          viewerHost.attach(ws, typeof ip === 'string' ? ip : '')
        } else {
          logger.info(`Unknown WebSocket endpoint: ${url.pathname}`)
          ws.close(4404, 'Not found')
        }
      })
    },
  }
}
