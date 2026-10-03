/**
 * A desktop session on the wlroots prototype (ROADMAP.md, Core item 1), started instead of session-process.js when the
 * gateway runs with GFLD_WLROOTS=1. Same viewer socket and start/ready handshake, but the Wayland side is wlroots.
 *
 * Prototype limits: no desktop shell (Apps menu, launching, notifications); start apps with the WAYLAND_DISPLAY this
 * logs. It only loads the compositor proxy modules that don't pull in the libwayland fork (see WlrCompositor.ts),
 * which is why it doesn't import the package index.
 */
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import type { SessionStart } from './ipc'
type WlrModule = typeof import('@gfld/compositor-proxy/types/wlroots/WlrCompositor')
type ControllerModule = typeof import('@gfld/compositor-proxy/types/SessionController')
type LoggerModule = typeof import('@gfld/compositor-proxy/types/Logger')

/* eslint-disable @typescript-eslint/no-var-requires */
const { startWlrootsCompositor } = require('@gfld/compositor-proxy/dist/wlroots/WlrCompositor.js') as WlrModule
const { createSessionController } = require('@gfld/compositor-proxy/dist/SessionController.js') as ControllerModule
const { createLogger } = require('@gfld/compositor-proxy/dist/Logger.js') as LoggerModule
/* eslint-enable @typescript-eslint/no-var-requires */

const logger = createLogger('session-wlroots')

process.on('uncaughtException', (e) => {
  logger.error(`uncaught: ${e.name}: ${e.message}\n${e.stack ?? ''}`)
})

for (const name of Object.keys(process.env)) {
  if (
    name.startsWith('GREENFIELD_') ||
    name.startsWith('NODE_CHANNEL') ||
    name === 'DISPLAY' ||
    name === 'WAYLAND_DISPLAY'
  ) {
    delete process.env[name]
  }
}

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

async function start({ socketPath, encoder }: SessionStart) {
  const env = process.env
  if (env.XDG_RUNTIME_DIR === undefined || !existsSync(env.XDG_RUNTIME_DIR)) {
    const fallback = `/tmp/greenfield-runtime-${process.getuid?.() ?? 0}`
    mkdirSync(fallback, { recursive: true, mode: 0o700 })
    env.XDG_RUNTIME_DIR = fallback
  }
  env.XDG_SESSION_TYPE = 'wayland'

  const { viewerHost, compositor } = startWlrootsCompositor({ h264Encoder: encoder })
  env.WAYLAND_DISPLAY = compositor.waylandDisplay
  const controller = createSessionController(viewerHost)

  const terminate = () => process.exit()
  process.once('disconnect', terminate)
  process.once('SIGTERM', terminate)
  process.once('SIGINT', terminate)

  const server = createServer((_request, response) => response.writeHead(404).end())
  server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(request.url ?? '/', 'http://session')
    if (url.pathname !== '/viewer') {
      socket.destroy()
      return
    }
    controller.onWsUpgrade(request as Parameters<typeof controller.onWsUpgrade>[0], socket, head)
  })
  await new Promise<void>((resolve, reject) => {
    if (existsSync(socketPath)) {
      unlinkSync(socketPath)
    }
    const previousUmask = process.umask(0o007)
    server.once('error', reject)
    server.listen(socketPath, () => {
      process.umask(previousUmask)
      resolve()
    })
  })
  process.send?.({ type: 'ready' })
  logger.info('Session ready (wlroots).')
}
