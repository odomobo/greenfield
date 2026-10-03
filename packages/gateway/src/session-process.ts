/**
 * A user's desktop session: the server-side compositor plus the user's apps. Runs as the user (started through the
 * PAM helper in PAM mode). Serves the viewer WebSocket on a Unix socket that only the gateway's web process can
 * reach; the web process authenticates browsers and relays to it. The desktop shell's server side (apps, launching,
 * pinned apps, notifications) talks to the viewer over that WebSocket too (shell/service.ts).
 *
 * Lives until it's ended explicitly or the gateway stops; viewers come and go.
 */
import {
  createLogger,
  createSession,
  createSessionController,
  initSurfaceBufferEncoding,
  Session,
  SessionController,
  startServerCompositor,
} from '@gfld/compositor-proxy'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import path from 'node:path'
import { SessionStart } from './ipc'
import { ShellService } from './shell/service'

const logger = createLogger('session')

process.on('uncaughtException', (e) => {
  logger.error(`uncaught: ${e.name}: ${e.message}\n${e.stack ?? ''}`)
})

// Apps inherit this environment: drop everything that isn't theirs to see.
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
  viewerHost.shell = new ShellService(session)
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

/**
 * What a desktop session needs so apps behave: a runtime dir, a D-Bus session bus, and the desktop portal and a
 * secrets service. With logind (pam_systemd) the runtime dir and bus exist already, and the portal and secrets
 * service are started by D-Bus activation when an app first asks. Without it we start a bus ourselves. Missing
 * services are reported, not fatal.
 */
function setupSessionEnvironment() {
  const env = process.env
  const uid = process.getuid?.() ?? 0

  if (env.XDG_RUNTIME_DIR === undefined || !existsSync(env.XDG_RUNTIME_DIR)) {
    const fallback = `/tmp/greenfield-runtime-${uid}`
    mkdirSync(fallback, { recursive: true, mode: 0o700 })
    env.XDG_RUNTIME_DIR = fallback
    logger.info(`No XDG_RUNTIME_DIR from logind; using ${fallback}.`)
  }

  env.XDG_SESSION_TYPE = 'wayland'
  env.XDG_CURRENT_DESKTOP = 'greenfield'
  env.XDG_SESSION_DESKTOP = 'greenfield'
  // our portals config (prefers the gtk backend) without touching the user's own configuration
  const configDir = path.resolve(__dirname, '../xdg')
  env.XDG_CONFIG_DIRS = [configDir, env.XDG_CONFIG_DIRS ?? '/etc/xdg'].join(':')

  if (env.DBUS_SESSION_BUS_ADDRESS === undefined) {
    const userBus = path.join(env.XDG_RUNTIME_DIR, 'bus')
    if (existsSync(userBus)) {
      env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${userBus}`
    } else {
      try {
        const address = startDBus()
        env.DBUS_SESSION_BUS_ADDRESS = address
        logger.info('Started a D-Bus session bus for this session.')
      } catch (e: any) {
        logger.error(`No D-Bus session bus (${e.message}); many apps will misbehave. Install dbus.`)
      }
    }
  }

  if (env.DBUS_SESSION_BUS_ADDRESS !== undefined) {
    try {
      // tell activated services (portal, keyring) about our session's environment
      execFileSync(
        'dbus-update-activation-environment',
        ['--systemd', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'XDG_CONFIG_DIRS'],
        { env, stdio: 'ignore', timeout: 5000 },
      )
    } catch {
      // without systemd --user, or old dbus; activation still works with the bus's own environment
    }
  }

  const services: [string, string[]][] = [
    ['desktop portal (xdg-desktop-portal)', ['/usr/share/dbus-1/services/org.freedesktop.portal.Desktop.service']],
    [
      'portal backend (xdg-desktop-portal-gtk)',
      ['/usr/share/dbus-1/services/org.freedesktop.impl.portal.desktop.gtk.service'],
    ],
    [
      'secrets service (gnome-keyring)',
      [
        '/usr/share/dbus-1/services/org.freedesktop.secrets.service',
        '/usr/share/dbus-1/services/org.gnome.keyring.service',
      ],
    ],
  ]
  const missing = services.filter(([, files]) => !files.some((file) => existsSync(file))).map(([name]) => name)
  if (missing.length > 0) {
    logger.info(`Not installed (apps lose these features): ${missing.join(', ')}.`)
  }
}

function startDBus(): string {
  // --fork: the parent prints the address and pid once the bus is up, then exits
  const output = execFileSync(
    'dbus-daemon',
    ['--session', '--fork', '--nopidfile', '--print-address=1', '--print-pid=1'],
    {
      encoding: 'utf8',
      timeout: 5000,
    },
  )
  const [address, pid] = output.trim().split('\n')
  if (!address?.startsWith('unix:')) {
    throw new Error('dbus-daemon did not report an address')
  }
  process.once('exit', () => {
    try {
      process.kill(Number(pid))
    } catch {
      // already gone
    }
  })
  return address
}
