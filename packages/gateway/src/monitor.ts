/**
 * The monitor is the privileged half of the gateway (root in PAM mode). It does nothing network-facing: it
 * authenticates users (through the PAM helper), keeps the session registry and spawns per-user session processes.
 * The unprivileged web process talks to it only over the IPC channel.
 */
import { ChildProcess, execFile, execFileSync, fork, spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, chownSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, Server } from 'node:net'
import path from 'node:path'
import { GatewayConfig } from './config'
import {
  MonitorReply,
  MonitorReplyEnvelope,
  SessionInfo,
  SessionStart,
  WebRequest,
  WebRequestEnvelope,
  WebStart,
} from './ipc'
import { loadTLS } from './tls'
import { log } from './log'

type User = { username: string; uid: number; gid: number; home: string }

type Ticket = User & { expiresAt: number }

type SessionEntry = SessionInfo & {
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

const pamHelperPath = path.resolve(__dirname, 'pam-helper')
const sessionProcessPath = path.resolve(__dirname, 'session-process.js')

export class Monitor {
  private readonly tickets = new Map<string, Ticket>()
  private readonly sessions = new Map<string, SessionEntry>()
  private web?: ChildProcess
  private webGid?: number
  private activeAuths = 0

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
      log.error(`Web process exited (${signal ?? code}). Shutting down.`)
      this.shutdown(1)
    })
    const start: WebStart = {
      type: 'start',
      tls,
      hostname: config.hostname,
      allowedOrigins: config.allowedOrigins,
      applications: config.applications,
      viewerDir: config.viewerDir,
      devMode: config.authMode === 'dev',
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
      case 'listSessions':
        return {
          ok: true,
          type: 'sessions',
          sessions: [...this.sessions.values()]
            .filter((session) => session.uid === user.uid && !session.ending)
            .map(({ id, createdAt }) => ({ id, createdAt })),
        }
      case 'createSession': {
        const session = await this.createSession(user)
        return { ok: true, type: 'session', session: { id: session.id, createdAt: session.createdAt } }
      }
      case 'endSession': {
        const session = this.sessions.get(request.sessionId)
        if (session === undefined || session.uid !== user.uid || session.ending) {
          return { ok: false, error: 'not-found' }
        }
        log.info(`Ending session ${session.id} of ${session.username}.`)
        session.ending = true
        session.process.kill('SIGTERM')
        return { ok: true, type: 'done' }
      }
      case 'sessionSocket': {
        const session = this.sessions.get(request.sessionId)
        if (session === undefined || session.uid !== user.uid || session.ending) {
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
    const info = require('node:os').userInfo()
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
      child = fork(sessionProcessPath, [], {
        env: { ...process.env },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      })
    } else {
      child = spawn(pamHelperPath, ['session', user.username, '--', process.execPath, sessionProcessPath], {
        env,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
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

    const start: SessionStart = {
      type: 'start',
      sessionId: id,
      socketPath,
      encoder: this.config.encoder,
      renderDevice: this.config.renderDevice,
    }
    child.send(start)
    log.info(`Started session ${id} for ${user.username}.`)
    await ready
    return entry
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
    setTimeout(() => process.exit(code), 1500)
  }
}
