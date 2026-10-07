/**
 * A user's desktop session: the server-side compositor (wlroots, see WlrCompositor in the compositor proxy) plus the
 * user's apps. Runs as the user. Serves the viewer WebSocket; the gateway's web process authenticates browsers and
 * relays to it. The desktop shell's server side (apps, launching, pinned apps, notifications) talks to the viewer over
 * that WebSocket too (shell/service.ts). Viewer connections come one of two ways (SessionConfig, session-config.ts):
 *
 *   - started by a login helper (packages/login): it inherits its listening socket (`desktop.sock`, `listenFd`) and
 *     accepts Handover records on it, each carrying a connection the web process relays and the client's address;
 *   - started by the monitor (through the PAM helper in PAM mode): it listens on a Unix socket path itself
 *     (`socketPath`) that only the web process can reach, which tells it the client's address in an `X-Client-IP`
 *     header. (Until the production login helper replaces the monitor.)
 *
 * Lives until the user logs out (`session.logout` from the viewer) or its starter stops it; viewers come and go.
 */
import {
  Apps,
  createLogger,
  KILL_AFTER_MS,
  createSessionController,
  SessionController,
  startWlrootsCompositor,
} from '@gfld/compositor-proxy'
import { existsSync, unlinkSync } from 'node:fs'
import { createServer, IncomingMessage, Server } from 'node:http'
import { Socket } from 'node:net'
import { AudioService } from './audio/service'
import { resolveEncoder } from './encoder'
import { SessionMessage } from './ipc'
import { fdPassing, Kind, RecordChannel } from './login-protocol'
import { DEFAULT_SITE_SETTINGS_PATH, DevFlags, readSessionConfig, SessionConfig } from './session-config'
import { readSiteSettings } from './site-settings'
import { scrubEnvironment, setupSessionEnvironment } from './session-environment'
import { ShellService } from './shell/service'

const logger = createLogger('session')

process.on('uncaughtException', (e) => {
  logger.error(`uncaught: ${e.name}: ${e.message}\n${e.stack ?? ''}`)
})

scrubEnvironment()

// the starter writes the SessionConfig to fd 3 (see session-config.ts); the IPC channel (fd 4) only carries the ready
// signal and tells us when the starter goes away
readSessionConfig()
  .then(({ config, devFlags }) => start(config, config.siteSettingsPath ?? DEFAULT_SITE_SETTINGS_PATH, devFlags))
  .catch((e) => {
    logger.error(`Session failed to start: ${e.message}`)
    process.exit(1)
  })

async function start(
  config: SessionConfig,
  siteSettingsPath: string,
  { timeScale, linkKbps, patchOrder, patchShape }: DevFlags,
) {
  if (config.listenFd !== undefined) {
    // an inherited fd isn't close-on-exec: before we start anything, or it would keep the socket open after we close it
    fdPassing().setCloseOnExec(config.listenFd)
  }
  const settings = readSiteSettings(siteSettingsPath)
  // GStreamer is only ever run here, as the user (never in the privileged monitor)
  const encoder = resolveEncoder(settings.encoder, (message) => logger.info(message))
  const { audioDir } = setupSessionEnvironment()

  const { viewerHost, apps } = startWlrootsCompositor({
    h264Encoder: encoder === 'none' ? undefined : encoder,
    // kbit/s to bytes per ms
    link: linkKbps > 0 ? { bytesPerMs: linkKbps / 8 } : undefined,
    patchOrder,
    patchShape,
  })
  if (patchShape === 'tiles') {
    logger.info('Splitting large damage into squarish tiles (--dev-patch-shape).')
  }
  if (patchOrder === 'random') {
    logger.info('Sending queued patches in random order (--dev-patch-order).')
  }
  if (linkKbps > 0) {
    logger.info(`Sending to the viewer through a simulated link of ${linkKbps} kbit/s (--dev-link-kbps).`)
  }
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
  const terminate = () => void endSession(apps, audio, KILL_AFTER_MS / timeScale)
  process.once('disconnect', terminate)
  // on, not once: a second signal while ending must not kill us before we exit (exiting cleans up after XWayland)
  process.on('SIGTERM', terminate)
  process.on('SIGINT', terminate)

  const server = viewerServer(controller)
  const stopListening =
    config.listenFd !== undefined ? acceptHandovers(config.listenFd, server) : await listen(config.socketPath!, server)
  // Log out: stop taking connections and tell the starter first (a sign-in from now on starts a new desktop: a login
  // helper finds the listening socket closed), then close the viewer and end
  viewerHost.onLogout = (done) => {
    stopListening()
    const ending: SessionMessage = { type: 'ending' }
    const end = () => {
      done()
      terminate()
    }
    if (process.send === undefined || !process.connected) {
      end()
    } else {
      process.send(ending, undefined, {}, end)
    }
  }
  const ready: SessionMessage = { type: 'ready' }
  process.send?.(ready)
  logger.info('Session ready.')
}

let ending = false

async function endSession(apps: Apps, audio: AudioService, killAfterMs: number) {
  if (ending) {
    return
  }
  ending = true
  logger.info('Session ending, terminating its apps.')
  // we stay until they're gone: the apps that don't quit are killed by us, and quitting ones still have their display
  await apps.terminate(killAfterMs)
  audio.stop()
  setTimeout(() => process.exit(), 500)
}

/** The client address of each connection a login helper handed over (from its Handover record). */
const handedOverAddress = new WeakMap<Socket, string>()

function viewerServer(controller: SessionController): Server {
  // everything goes through the viewer WebSocket (window scene and desktop shell)
  const server = createServer((_request, response) => response.writeHead(404).end())
  server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(request.url ?? '/', 'http://session')
    if (url.pathname !== '/viewer') {
      socket.destroy()
      return
    }
    controller.onWsUpgrade(
      request as Parameters<SessionController['onWsUpgrade']>[0],
      socket,
      head,
      handedOverAddress.get(socket),
    )
  })
  return server
}

/** A login helper's handover connection sends its record right away. */
const HANDOVER_TIMEOUT_MS = 10_000
const EAGAIN = 11

/**
 * Accept the connections a login helper hands over on our inherited listening socket: each brings a Handover record
 * with the viewer connection (an fd) and the client's address, and goes to the viewer server like an accepted one.
 * Returns how to stop: closing the socket, after which the helper can't connect and starts a new desktop.
 */
function acceptHandovers(listenFd: number, server: Server): () => void {
  const { startPoll, stopPoll, acceptConnection, closeFd } = fdPassing()
  const poll = startPoll(listenFd, () => {
    for (;;) {
      const fd = acceptConnection(listenFd)
      if (fd < 0) {
        if (fd !== -EAGAIN) {
          logger.error(`Accepting a handover failed (errno ${-fd}).`)
        }
        return
      }
      const channel = new RecordChannel(fd)
      void channel.read(HANDOVER_TIMEOUT_MS).then((result) => {
        channel.close()
        if (result?.record.kind !== Kind.Handover || result.fd === undefined) {
          if (result?.fd !== undefined) {
            closeFd(result.fd)
          }
          logger.error('A handover connection brought no valid handover.')
          return
        }
        const socket = new Socket({ fd: result.fd, readable: true, writable: true })
        handedOverAddress.set(socket, result.record.address)
        server.emit('connection', socket)
      })
    }
  })
  return () => {
    stopPoll(poll)
    closeFd(listenFd)
  }
}

function listen(socketPath: string, server: Server): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (existsSync(socketPath)) {
      unlinkSync(socketPath)
    }
    // rw for us and the gateway's group (inherited from the setgid session dir), nothing for others
    const previousUmask = process.umask(0o007)
    server.once('error', reject)
    server.listen(socketPath, () => {
      process.umask(previousUmask)
      resolve(() => server.close())
    })
  })
}
