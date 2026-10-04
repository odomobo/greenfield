/**
 * The session's app processes: the ones the desktop shell launched, and the ones that connected to the session's
 * Wayland display without being launched by us (started from a terminal inside the session), known from the client's
 * credentials (wl_client_get_credentials, reported by the core). Ending the session asks all of them to quit.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createLogger } from '../Logger.js'

const logger = createLogger('apps')

/** How long an app gets to quit after SIGTERM before it's killed. */
const KILL_AFTER_MS = 10_000

type App = {
  pid: number
  name: string
  /** connected on its own rather than launched by us: forgotten once its last Wayland connection closes */
  external: boolean
  clients: Set<number>
}

/** Reads a process's parent and name; injectable for tests. */
export type ProcessInfo = (pid: number) => { ppid: number; name: string } | undefined

export function procStatus(pid: number): { ppid: number; name: string } | undefined {
  try {
    let ppid = 0
    let name = ''
    for (const line of readFileSync(`/proc/${pid}/status`, 'ascii').split('\n')) {
      if (line.startsWith('PPid:')) {
        ppid = Number.parseInt(line.slice(5).trim())
      } else if (line.startsWith('Name:')) {
        name = line.slice(5).trim()
      }
    }
    return { ppid, name }
  } catch {
    return undefined
  }
}

export class Apps {
  private readonly apps = new Map<number, App>()
  /** Wayland client id -> pid of its app */
  private readonly clients = new Map<number, number>()
  /** DISPLAY for X11 apps (XWayland), undefined if there's none */
  x11Display?: string

  constructor(
    private readonly waylandDisplay: string,
    private readonly processInfo: ProcessInfo = procStatus,
  ) {}

  get pids(): number[] {
    return [...this.apps.keys()]
  }

  /** Start an app in this session. Resolves once it's running, rejects if it can't be started. */
  launch(name: string, executable: string, args: string[], env: Record<string, string> = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const appLogger = createLogger(executable)
      // Don't log the environment, it can contain secrets.
      appLogger.info(`Launching application ${executable} with args ${JSON.stringify(args)}`)
      const child = spawn(executable, args, {
        env: {
          ...process.env,
          ...env,
          WAYLAND_DISPLAY: this.waylandDisplay,
          ...(this.x11Display ? { DISPLAY: this.x11Display } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout.on('data', (data) => appLogger.info(data.toString()))
      child.stderr.on('data', (data) => appLogger.error(data.toString()))
      child.once('error', (error) => {
        appLogger.error(`child process error: ${error.message}.`)
        reject(error)
      })
      child.once('spawn', () => {
        const pid = child.pid
        if (pid === undefined) {
          reject(new Error('Spawned a child process without a pid.'))
          return
        }
        appLogger.info('Child process started.')
        this.apps.set(pid, { pid, name, external: false, clients: new Set() })
        child.once('exit', (code, signal) => {
          appLogger.info(
            code !== null ? `Child process exited with code ${code}.` : `Child process ended by signal ${signal}.`,
          )
          this.apps.delete(pid)
        })
        resolve(pid)
      })
    })
  }

  /** A Wayland client connected (pid 0: unknown). */
  clientConnected(clientId: number, pid: number): void {
    if (pid <= 0 || pid === process.pid) {
      return
    }
    let app = this.appOf(pid)
    if (app === undefined) {
      // not one of ours: e.g. started from a terminal inside the session (its own process, not the terminal's)
      app = { pid, name: this.processInfo(pid)?.name ?? 'unknown', external: true, clients: new Set() }
      this.apps.set(pid, app)
      logger.info(`App ${app.name} (${pid}) connected on its own.`)
    }
    app.clients.add(clientId)
    this.clients.set(clientId, app.pid)
  }

  clientDisconnected(clientId: number): void {
    const pid = this.clients.get(clientId)
    this.clients.delete(clientId)
    const app = pid === undefined ? undefined : this.apps.get(pid)
    if (app === undefined) {
      return
    }
    app.clients.delete(clientId)
    if (app.external && app.clients.size === 0) {
      this.apps.delete(app.pid)
    }
  }

  /** Ask every app of the session to quit; kill the ones still running a while later (if we're still here). */
  terminate(): void {
    for (const app of this.apps.values()) {
      signal(app.pid, 'SIGTERM')
      // only while it's still ours: once it's gone, its pid may belong to someone else
      setTimeout(() => this.apps.get(app.pid) === app && signal(app.pid, 'SIGKILL'), KILL_AFTER_MS).unref()
    }
  }

  /** The app a process belongs to: the process itself, or the nearest ancestor that's an app of ours. */
  private appOf(pid: number): App | undefined {
    const seen = new Set<number>()
    let current = pid
    while (current > 1 && !seen.has(current)) {
      seen.add(current)
      const app = this.apps.get(current)
      if (app) {
        return app
      }
      current = this.processInfo(current)?.ppid ?? 0
    }
    return undefined
  }
}

function signal(pid: number, name: 'SIGTERM' | 'SIGKILL') {
  try {
    process.kill(pid, name)
  } catch (e: any) {
    // ESRCH: already gone
    if (e.code !== 'ESRCH') {
      logger.error(`Can't send ${name} to ${pid}: ${e.message}`)
    }
  }
}
