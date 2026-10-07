/**
 * The monitor is the privileged half of the gateway (root in PAM mode). It does nothing network-facing: it
 * authenticates users (through the PAM helper), keeps the session registry and spawns per-user session processes.
 * The unprivileged web process talks to it only over the IPC channel.
 */
import { ChildProcess, execFile, execFileSync, fork, spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, chownSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, Server } from 'node:net'
import { Writable } from 'node:stream'
import { userInfo } from 'node:os'
import path from 'node:path'
import { GatewayConfig } from './config'
import { MonitorReply, MonitorReplyEnvelope, WebRequest, WebRequestEnvelope, WebStart } from './ipc'
import { SessionConfig } from './session-config'
import { formatSiteSettings, SiteSettings, DEFAULT_SITE_SETTINGS } from './site-settings'
import { loadTLS } from './tls'
import { log } from './log'

type User = { username: string; uid: number; gid: number; home: string }

type Ticket = User & { expiresAt: number }

/** A user's desktop: the session process and where it listens. */
type SessionEntry = {
  id: string
  createdAt: number
  uid: number
  username: string
  dir: string
  socketPath: string
  process: ChildProcess
  ready: Promise<void>
  /** asked to end, still shutting down */
  ending: boolean
}

const TICKET_LIFETIME_MS = 7 * 24 * 3600 * 1000
const MAX_CONCURRENT_AUTH = 4
const SESSION_START_TIMEOUT_MS = 20_000
/** How long a stopping gateway waits for its sessions: they give their apps 5 s to quit (Apps.ts), then kill them. */
const SESSION_EXIT_TIMEOUT_MS = 8_000

/**
 * A session's stdio: fd 3 is the pipe for its SessionConfig (see session-config.ts); the pam helper execs the session
 * with its fds intact. The IPC channel (ready signal, and the session ends when it closes) is fd 4 until the login
 * helper replaces the monitor.
 */
const SESSION_STDIO: ['ignore', 'inherit', 'inherit', 'pipe', 'ipc'] = ['ignore', 'inherit', 'inherit', 'pipe', 'ipc']

const pamHelperPath = path.resolve(__dirname, 'pam-helper')
const sessionProcessPath = path.resolve(__dirname, 'session-process.js')

export class Monitor {
  private readonly tickets = new Map<string, Ticket>()
  private readonly sessions = new Map<string, SessionEntry>()
  private web?: ChildProcess
  private webGid?: number
  private activeAuths = 0

  /** the site settings file sessions read: --site-config, or one generated from --encoder / --render-device, or undefined (their default) */
  private siteSettingsPath?: string

  constructor(private readonly config: GatewayConfig) {}

  async start() {
    const { config } = this
    if (config.authMode === 'pam') {
      if (!existsSync(pamHelperPath)) {
        throw new Error(`${pamHelperPath} is missing. Build it with libpam headers installed (yarn build:native).`)
      }
      if (!existsSync('/etc/pam.d/greenfield')) {
        log.warn('/etc/pam.d/greenfield is missing; PAM falls back to the "other" service. See packages/gateway/pam/.')
      }
    }

    const web = this.lookupWebUser()
    this.webGid = web?.gid
    this.prepareRuntimeDir()
    this.prepareSiteSettings()

    const tls = config.tls ? await loadTLS(config) : undefined
    const listener = await this.listen()

    // the web process runs unprivileged; in dev mode everything already runs as the current user
    const child = fork(path.resolve(__dirname, 'web.js'), [], {
      ...(web ? { uid: web.uid, gid: web.gid } : {}),
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: process.env.LANG ?? 'C.UTF-8',
        NODE_ENV: 'production',
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      serialization: 'json',
    })
    this.web = child
    child.on('message', (message: WebRequestEnvelope) => this.onWebRequest(message))
    child.once('exit', (code, signal) => {
      if (!this.shuttingDown) {
        log.error(`Web process exited (${signal ?? code}). Shutting down.`)
        this.shutdown(1)
      }
    })
    const start: WebStart = {
      type: 'start',
      tls,
      hostname: config.hostname,
      allowedOrigins: config.allowedOrigins,
      viewerDir: config.viewerDir,
      devMode: config.authMode === 'dev',
      timeScale: config.timeScale,
    }
    // the web process owns the listening socket from now on; closing our copy only after the handle was passed
    child.send(start, listener, () => listener.close())

    process.once('SIGTERM', () => this.shutdown(0))
    process.once('SIGINT', () => this.shutdown(0))
  }

  private listen(): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen({ host: this.config.bindIP, port: this.config.bindPort }, () => resolve(server))
    })
  }

  private lookupWebUser(): { uid: number; gid: number } | undefined {
    if (this.config.authMode === 'dev') {
      return undefined
    }
    try {
      const entry = execFileSync('getent', ['passwd', this.config.webUser], { encoding: 'utf8' }).trim()
      const [, , uid, gid] = entry.split(':')
      if (Number(uid) === 0) {
        throw new Error('the web user must not be root')
      }
      return { uid: Number(uid), gid: Number(gid) }
    } catch (e: any) {
      throw new Error(
        `Web user "${this.config.webUser}" not usable (${e.message}). Create it, e.g.: ` +
          `useradd --system --no-create-home --shell /usr/sbin/nologin ${this.config.webUser}`,
      )
    }
  }

  private prepareRuntimeDir() {
    const sessionsDir = path.join(this.config.runtimeDir, 'sessions')
    rmSync(sessionsDir, { recursive: true, force: true })
    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 })
    if (this.webGid !== undefined) {
      // traversable, not listable; each session dir decides who may enter
      chmodSync(this.config.runtimeDir, 0o711)
      chmodSync(sessionsDir, 0o711)
    } else {
      chmodSync(this.config.runtimeDir, 0o700)
    }
  }

  /**
   * Sessions read the site settings (encoder, render device) themselves. --encoder and --render-device override the
   * file, so for them the monitor writes a settings file of its own for the sessions to read.
   */
  private prepareSiteSettings() {
    const { config } = this
    this.siteSettingsPath = config.siteConfig
    if (config.encoder === undefined && config.renderDevice === undefined) {
      return
    }
    const settings: SiteSettings = {
      encoder: config.encoder ?? DEFAULT_SITE_SETTINGS.encoder,
      renderDevice: config.renderDevice ?? DEFAULT_SITE_SETTINGS.renderDevice,
    }
    // (the runtime dir is traversable for everyone in PAM mode, the sessions run as other users)
    const file = path.join(config.runtimeDir, 'nebula.conf')
    writeFileSync(file, formatSiteSettings(settings), { mode: 0o644 })
    this.siteSettingsPath = file
  }

  private reply(serial: number, reply: MonitorReply) {
    const envelope: MonitorReplyEnvelope = { serial, reply }
    this.web?.send(envelope)
  }

  private async onWebRequest({ serial, request }: WebRequestEnvelope) {
    try {
      this.reply(serial, await this.handle(request))
    } catch (e: any) {
      log.error(`Request ${request.type} failed: ${e.message}`)
      this.reply(serial, { ok: false, error: 'failed' })
    }
  }

  private ticketUser(ticket: string): Ticket | undefined {
    const entry = this.tickets.get(ticket)
    if (entry === undefined) {
      return undefined
    }
    if (entry.expiresAt < Date.now()) {
      this.tickets.delete(ticket)
      return undefined
    }
    return entry
  }

  private async handle(request: WebRequest): Promise<MonitorReply> {
    if (request.type === 'auth') {
      const user = await this.authenticate(request.username, request.password)
      if (user === undefined) {
        return { ok: false, error: 'auth-failed' }
      }
      const ticket = randomBytes(32).toString('base64url')
      this.tickets.set(ticket, { ...user, expiresAt: Date.now() + TICKET_LIFETIME_MS })
      log.info(`Login: ${user.username}`)
      return { ok: true, type: 'auth', ticket, username: user.username }
    }

    const user = this.ticketUser(request.ticket)
    if (user === undefined) {
      return { ok: false, error: 'forbidden' }
    }

    switch (request.type) {
      case 'logout':
        this.tickets.delete(request.ticket)
        return { ok: true, type: 'done' }
      case 'desktop':
        // attach or create: a user has at most one desktop
        await (this.userDesktop(user)?.ready ?? this.createSession(user))
        return { ok: true, type: 'done' }
      case 'endDesktop': {
        const session = this.userDesktop(user)
        if (session === undefined) {
          return { ok: false, error: 'not-found' }
        }
        log.info(`Ending session ${session.id} of ${session.username}.`)
        session.ending = true
        session.process.kill('SIGTERM')
        return { ok: true, type: 'done' }
      }
      case 'desktopSocket': {
        const session = this.userDesktop(user)
        if (session === undefined) {
          return { ok: false, error: 'not-found' }
        }
        await session.ready
        return { ok: true, type: 'socket', path: session.socketPath }
      }
    }
  }

  private async authenticate(username: string, password: string): Promise<User | undefined> {
    if (this.activeAuths >= MAX_CONCURRENT_AUTH) {
      return undefined
    }
    this.activeAuths++
    try {
      if (this.config.authMode === 'dev') {
        return this.authenticateDev(username, password)
      }
      return await this.authenticatePAM(username, password)
    } finally {
      this.activeAuths--
    }
  }

  private authenticateDev(username: string, password: string): User | undefined {
    const expected = Buffer.from(this.config.devPassword ?? '')
    const given = Buffer.from(password)
    const passwordOk = given.length === expected.length && timingSafeEqual(given, expected)
    if (!passwordOk || username !== this.config.devUser) {
      return undefined
    }
    const info = userInfo()
    return { username: info.username, uid: info.uid, gid: info.gid, home: info.homedir }
  }

  private authenticatePAM(username: string, password: string): Promise<User | undefined> {
    return new Promise((resolve) => {
      const child = execFile(pamHelperPath, ['auth', username], { env: {}, timeout: 30_000 }, (error, stdout) => {
        if (error) {
          resolve(undefined)
          return
        }
        const match = /^(\d+) (\d+) (.+)\n$/.exec(stdout)
        if (match === null) {
          resolve(undefined)
          return
        }
        const uid = Number(match[1])
        if (uid === 0) {
          // no root desktop sessions
          resolve(undefined)
          return
        }
        // PAM may canonicalize the name; sessions are opened for the name PAM authenticated
        resolve({ username, uid, gid: Number(match[2]), home: match[3] })
      })
      child.stdin?.end(password)
    })
  }

  private async createSession(user: User): Promise<SessionEntry> {
    const id = randomBytes(12).toString('base64url')
    const dir = path.join(this.config.runtimeDir, 'sessions', id)
    mkdirSync(dir, { mode: 0o700 })
    if (this.webGid !== undefined) {
      // the user's session creates its socket here; the web process (group) may connect, nobody else may enter
      chownSync(dir, user.uid, this.webGid)
      chmodSync(dir, 0o2750)
    }
    const socketPath = path.join(dir, 'viewer.sock')

    const env: Record<string, string> = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: process.env.LANG ?? 'C.UTF-8',
    }
    let child: ChildProcess
    if (this.config.authMode === 'dev') {
      // never hand the dev password down (it would stay readable in /proc/<pid>/environ)
      const { GREENFIELD_DEV_PASSWORD: _password, ...inherited } = process.env
      child = fork(sessionProcessPath, [], {
        env: inherited,
        cwd: user.home,
        stdio: SESSION_STDIO,
      })
    } else {
      child = spawn(pamHelperPath, ['session', user.username, '--', process.execPath, sessionProcessPath], {
        env,
        stdio: SESSION_STDIO,
      })
    }

    let readyResolve!: () => void
    let readyReject!: (e: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    ready.catch(() => {
      /* reported to whoever awaits it */
    })
    const timeout = setTimeout(() => readyReject(new Error('session did not start in time')), SESSION_START_TIMEOUT_MS)
    child.on('message', (message: any) => {
      if (message?.type === 'ready') {
        clearTimeout(timeout)
        readyResolve()
      }
    })

    const entry: SessionEntry = {
      id,
      createdAt: Date.now(),
      uid: user.uid,
      username: user.username,
      dir,
      socketPath,
      process: child,
      ready,
      ending: false,
    }
    this.sessions.set(id, entry)
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      readyReject(new Error('session exited'))
      log.info(`Session ${id} of ${user.username} exited (${signal ?? code}).`)
      this.sessions.delete(id)
      rmSync(dir, { recursive: true, force: true })
    })

    // dev flags are the monitor's for now; the dev login helper will write them later
    const sessionConfig: SessionConfig = {
      version: 1,
      socketPath,
      siteSettingsPath: this.siteSettingsPath,
      ...(this.config.authMode === 'dev'
        ? {
            devFlags: {
              timeScale: this.config.timeScale,
              linkKbps: this.config.linkKbps,
              patchOrder: this.config.patchOrder,
              patchShape: this.config.patchShape,
            },
          }
        : {}),
    }
    const configPipe = child.stdio[3] as Writable
    configPipe.on('error', (e) => log.error(`Writing the session config failed: ${e.message}`))
    configPipe.end(JSON.stringify(sessionConfig))
    log.info(`Started session ${id} for ${user.username}.`)
    await ready
    return entry
  }

  /** The user's running desktop (one at most; one that is shutting down doesn't count). */
  private userDesktop({ uid }: User): SessionEntry | undefined {
    return [...this.sessions.values()].find((session) => session.uid === uid && !session.ending)
  }

  private shuttingDown = false

  private shutdown(code: number) {
    if (this.shuttingDown) {
      return
    }
    this.shuttingDown = true
    log.info('Stopping sessions.')
    this.web?.kill('SIGTERM')
    for (const session of this.sessions.values()) {
      session.process.kill('SIGTERM')
    }
    // the sessions end their apps (killing the ones that don't quit) before they exit; wait for that, within reason
    const deadline = Date.now() + SESSION_EXIT_TIMEOUT_MS / this.config.timeScale
    const exitWhenDone = () => {
      if (this.sessions.size === 0 || Date.now() >= deadline) {
        process.exit(code)
      }
      setTimeout(exitWhenDone, 50)
    }
    // (the web process gets a moment to close its connections even without sessions)
    setTimeout(exitWhenDone, 300)
  }
}
