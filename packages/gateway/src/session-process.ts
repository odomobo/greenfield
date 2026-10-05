/**
 * A user's desktop session: the server-side compositor (wlroots, see WlrCompositor in the compositor proxy) plus the
 * user's apps. Runs as the user (started through the PAM helper in PAM mode). Serves the viewer WebSocket on a Unix
 * socket that only the gateway's web process can reach; the web process authenticates browsers and relays to it. The
 * desktop shell's server side (apps, launching, pinned apps, notifications) talks to the viewer over that WebSocket too
 * (shell/service.ts).
 *
 * Lives until it's ended explicitly or the gateway stops; viewers come and go.
 */
import {
  Apps,
  createLogger,
  createSessionController,
  SessionController,
  startWlrootsCompositor,
} from '@gfld/compositor-proxy'
import { existsSync, unlinkSync } from 'node:fs'
import { createServer, IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { AudioService } from './audio/service'
import { SessionStart } from './ipc'
import { scrubEnvironment, setupSessionEnvironment } from './session-environment'
import { ShellService } from './shell/service'

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

async function start({ socketPath, encoder }: SessionStart) {
  const { audioDir } = setupSessionEnvironment()

  const { viewerHost, apps } = startWlrootsCompositor({ h264Encoder: encoder === 'none' ? undefined : encoder })
  // Apps get WAYLAND_DISPLAY when launched; it's not set in this process: GStreamer's GL would connect to our own
  // display as a client.
  viewerHost.shell = new ShellService(apps)
  // the session's own PipeWire starts in the background; until it is up (or if it can't) the session has no audio
  const audio = new AudioService(audioDir)
  viewerHost.audio = audio
  audio.start().catch((e) => logger.error(`Session audio failed: ${e.message}`))
  process.once('exit', () => audio.cleanUpAtExit())
  const controller = createSessionController(viewerHost)

  // the gateway went away or asked us to stop: don't leave orphaned apps behind
  const terminate = () => endSession(apps, audio)
  process.once('disconnect', terminate)
  // on, not once: a second signal while ending must not kill us before we exit (exiting cleans up after XWayland)
  process.on('SIGTERM', terminate)
  process.on('SIGINT', terminate)

  await listen(socketPath, controller)
  process.send?.({ type: 'ready' })
  logger.info('Session ready.')
}

let ending = false

function endSession(apps: Apps, audio: AudioService) {
  if (ending) {
    return
  }
  ending = true
  logger.info('Session ending, terminating its apps.')
  apps.terminate()
  audio.stop()
  setTimeout(() => process.exit(), 500)
}

function listen(socketPath: string, controller: SessionController): Promise<void> {
  // everything goes through the viewer WebSocket (window scene and desktop shell)
  const server = createServer((_request, response) => response.writeHead(404).end())
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
