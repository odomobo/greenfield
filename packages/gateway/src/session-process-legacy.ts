/**
 * A desktop session on the old stack (the libwayland fork and the TypeScript compositor), started instead of
 * session-process.js when the gateway runs with GFLD_LEGACY_COMPOSITOR=1. Kept only until the old stack is deleted
 * (ROADMAP.md, Core item 1, wave 2); session-process.ts is the real one.
 */
import { existsSync, unlinkSync } from 'node:fs'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { SessionStart } from './ipc'
import { scrubEnvironment, setupSessionEnvironment } from './session-environment'
import { ShellService } from './shell/service'
type LegacyModule = typeof import('@gfld/compositor-proxy/types/legacy')
type Session = import('@gfld/compositor-proxy/types/legacy').Session
type SessionController = import('@gfld/compositor-proxy/types/legacy').SessionController

// eslint-disable-next-line @typescript-eslint/no-var-requires
const legacy = require('@gfld/compositor-proxy/dist/legacy.js') as LegacyModule
const {
  createLogger,
  createSession,
  createSessionController,
  initSurfaceBufferEncoding,
  launchApplication,
  startServerCompositor,
} = legacy

const logger = createLogger('session')

process.on('uncaughtException', (e) => {
  logger.error(`uncaught: ${e.name}: ${e.message}\n${e.stack ?? ''}`)
})

scrubEnvironment()

process.once('message', (message: SessionStart) => {
  if (message?.type !== 'start') {
    logger.error('Expected a start message.')
    process.exit(1)
  }
  start(message).catch((e) => {
    logger.error(`Session failed to start: ${e.message}`)
    process.exit(1)
  })
})

async function start({ sessionId, socketPath, encoder, renderDevice }: SessionStart) {
  setupSessionEnvironment()

  initSurfaceBufferEncoding()
  const session = createSession(sessionId, {
    // the session process isn't reachable over TCP; these are unused
    server: { http: { bindIP: '', bindPort: 0, allowOrigin: '' } },
    public: { baseURL: '' },
    encoder: { h264Encoder: encoder, renderDevice },
  })
  const { viewerHost } = await startServerCompositor(session)
  viewerHost.shell = new ShellService({
    launch: (name, executable, args) => launchApplication(name, executable, args, {}, session),
  })
  const controller = createSessionController(viewerHost)

  const terminate = () => {
    logger.info('Session ending, terminating its apps.')
    session.terminateApps()
    setTimeout(() => process.exit(), 500)
  }
  session.closeListeners.push(() => process.exit())
  // the gateway went away or asked us to stop: don't leave orphaned apps behind
  process.once('disconnect', terminate)
  process.once('SIGTERM', terminate)
  process.once('SIGINT', terminate)

  await listen(socketPath, session, controller)
  process.send?.({ type: 'ready' })
  logger.info('Session ready.')
}

function listen(socketPath: string, session: Session, controller: SessionController): Promise<void> {
  const server = createServer((request, response) => handleRequest(session, request, response))
  server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(request.url ?? '/', 'http://session')
    if (url.pathname !== '/viewer') {
      socket.destroy()
      return
    }
    controller.onWsUpgrade(request as Parameters<SessionController['onWsUpgrade']>[0], socket, head)
  })
  return new Promise((resolve, reject) => {
    if (existsSync(socketPath)) {
      unlinkSync(socketPath)
    }
    // rw for us and the gateway's group (inherited from the setgid session dir), nothing for others
    const previousUmask = process.umask(0o007)
    server.once('error', reject)
    server.listen(socketPath, () => {
      process.umask(previousUmask)
      resolve()
    })
  })
}

function handleRequest(_session: Session, _request: IncomingMessage, response: ServerResponse) {
  // everything goes through the viewer WebSocket (window scene and desktop shell)
  response.writeHead(404).end()
}
