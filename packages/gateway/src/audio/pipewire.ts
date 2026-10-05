/**
 * A session's own PipeWire, isolated from the user's. The user has one PipeWire per user (started by their systemd
 * instance, shared by all their logins, like their D-Bus session bus); a nebula session must neither play into it
 * (its sound would come out of the user's speakers) nor show up in it (the user's other desktops would see our sink
 * and streams). So each session starts its own `pipewire`, `pipewire-pulse` and `wireplumber`, as children of the
 * session process, and nothing of the user's is reached:
 *
 * - Directory: `$XDG_RUNTIME_DIR/nebula-audio-<session pid>` (mode 0700) holds every socket and the daemons' state.
 *   `PIPEWIRE_RUNTIME_DIR` (PipeWire 1.0.5 looks there first, before `XDG_RUNTIME_DIR`) makes `pipewire-0` and
 *   `pipewire-0-manager` live there; `PULSE_RUNTIME_PATH` makes `pipewire-pulse` listen on `<dir>/native`.
 * - Apps: the session's environment has the same `PIPEWIRE_RUNTIME_DIR` and `PULSE_RUNTIME_PATH`, and
 *   `PULSE_SERVER=unix:<dir>/native`, which libpulse uses exclusively (no fallback to the user's server). These are
 *   set whether or not our daemons could be started: an app then has no audio, rather than the user's. They are not
 *   given to `dbus-update-activation-environment` (the D-Bus session bus is the user's, shared with their other
 *   desktops).
 * - Configuration: our own files (config.ts), `pipewire -c <absolute path>` for the two PipeWire daemons and
 *   `XDG_CONFIG_HOME=dist/audio-config/xdg` for WirePlumber, so `~/.config/pipewire`, `~/.config/wireplumber` and
 *   `~/.config/pulse` are not read. `XDG_STATE_HOME` and `XDG_CACHE_HOME` point into the session's directory, so
 *   WirePlumber's stored defaults don't land in the user's `~/.local/state/wireplumber`.
 * - D-Bus: the daemons get a session bus address that goes nowhere, so they never register on or listen to the
 *   user's bus (device reservation, portals, rtkit). We run no hardware: no ALSA, no bluetooth, one null sink.
 * - No `systemctl --user`: the user's systemd instance isn't touched.
 *
 * Lifecycle: started with the session, stopped by the PIDs we started (SIGTERM, then SIGKILL) when the session ends;
 * `setpriv --pdeathsig` makes the kernel stop them if the session process dies without cleaning up.
 */
import { createLogger } from '@gfld/compositor-proxy'
import { ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { findProgram } from '../shell/desktop-entries'
import { audioConfigDir } from './config'

const logger = createLogger('audio')

/** The prefix of the session directories in the runtime dir. */
export const AUDIO_DIR_PREFIX = 'nebula-audio-'

/** The directory of this session's audio sockets and state, below the user's runtime directory. */
export function audioDirectory(runtimeDir: string, pid: number = process.pid): string {
  return path.join(runtimeDir, `${AUDIO_DIR_PREFIX}${pid}`)
}

/** The environment variables that make a process use the session's audio (and nothing else). */
export function appAudioVariables(dir: string): Record<string, string> {
  return {
    PIPEWIRE_RUNTIME_DIR: dir,
    PULSE_RUNTIME_PATH: dir,
    PULSE_SERVER: `unix:${path.join(dir, 'native')}`,
  }
}

/** Variables that would point a process to another PipeWire, PulseAudio or WirePlumber setup. */
const FOREIGN_VARIABLE = /^(PIPEWIRE_|PULSE_|WIREPLUMBER_|SPA_)/

/** The environment of our daemons (and the capture): the session's, with ours, and without anything foreign. */
export function daemonEnvironment(base: NodeJS.ProcessEnv, dir: string, configDir = audioConfigDir): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(base)) {
    if (!FOREIGN_VARIABLE.test(name)) {
      env[name] = value
    }
  }
  return {
    ...env,
    ...appAudioVariables(dir),
    XDG_CONFIG_HOME: path.join(configDir, 'xdg'),
    XDG_STATE_HOME: path.join(dir, 'state'),
    XDG_CACHE_HOME: path.join(dir, 'cache'),
    // an address nothing listens on: the user's session bus is off limits
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(dir, 'no-bus')}`,
  }
}

/** Creates the session's audio directory, and removes those of sessions that are gone. */
export function createAudioDirectory(runtimeDir: string): string {
  removeStaleDirectories(runtimeDir)
  const dir = audioDirectory(runtimeDir)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(path.join(dir, 'state'), { recursive: true, mode: 0o700 })
  mkdirSync(path.join(dir, 'cache'), { recursive: true, mode: 0o700 })
  return dir
}

function removeStaleDirectories(runtimeDir: string) {
  let names: string[]
  try {
    names = readdirSync(runtimeDir)
  } catch {
    return
  }
  for (const name of names) {
    const pid = name.startsWith(AUDIO_DIR_PREFIX) ? Number(name.slice(AUDIO_DIR_PREFIX.length)) : NaN
    if (!Number.isInteger(pid) || pid <= 0) {
      continue
    }
    try {
      // signal 0 only checks that the process exists; our own sessions' directories are the only ones named so
      process.kill(pid, 0)
    } catch (e: any) {
      if (e.code === 'ESRCH') {
        rmSync(path.join(runtimeDir, name), { recursive: true, force: true })
      }
    }
  }
}

/** `setpriv --pdeathsig TERM <command>` when setpriv exists: the kernel ends the child if we die without cleaning up. */
export function withParentDeathSignal(command: string, args: string[]): [string, string[]] {
  const setpriv = findProgram('setpriv')
  return setpriv === undefined ? [command, args] : [setpriv, ['--pdeathsig', 'TERM', command, ...args]]
}

/** A child process we started and stop by its PID. */
export class Daemon {
  private child?: ChildProcess
  private stopped = false
  /** the last of its error output, for the log */
  private errors = ''
  /** called when it exits without being stopped */
  onUnexpectedExit: (description: string) => void = () => undefined

  constructor(
    readonly name: string,
    private readonly command: string,
    private readonly args: string[],
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  get pid(): number | undefined {
    return this.child?.pid
  }

  start(): void {
    const [command, args] = withParentDeathSignal(this.command, this.args)
    const child = spawn(command, args, { env: this.env, stdio: ['ignore', 'ignore', 'pipe'] })
    this.child = child
    child.stderr!.on('data', (chunk: Buffer) => {
      this.errors = (this.errors + chunk.toString()).slice(-400)
    })
    child.on('error', (e) => {
      logger.error(`${this.name} could not be started: ${e.message}`)
      this.onUnexpectedExit(`could not be started: ${e.message}`)
    })
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = undefined
      }
      if (!this.stopped) {
        const tail = this.errors.trim().replace(/["\n]+/g, ' ')
        const description = `exited (${signal ?? `code ${code}`})${tail ? `: ${tail}` : ''}`
        logger.error(`${this.name} ${description}`)
        this.onUnexpectedExit(description)
      }
    })
  }

  /** SIGTERM now, SIGKILL if it's still there a second later. */
  stop(): void {
    this.stopped = true
    const child = this.child
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      return
    }
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000)
    timer.unref()
    child.once('exit', () => clearTimeout(timer))
  }

  /** Immediately, for the exit handler (no timers). */
  kill(): void {
    this.stopped = true
    this.child?.kill('SIGKILL')
  }
}

function waitForSocket(file: string, timeoutMs: number, alive: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const check = () => {
      if (existsSync(file)) {
        resolve(true)
      } else if (!alive() || Date.now() > deadline) {
        resolve(false)
      } else {
        setTimeout(check, 20)
      }
    }
    check()
  })
}

/**
 * The three daemons of a session's PipeWire. `start()` resolves true when the PipeWire core and the PulseAudio
 * protocol server are listening, false (after logging why) if it can't run: a missing program or one that exits.
 */
export class SessionPipeWire {
  private readonly daemons: Daemon[] = []
  private failed = false
  /** called when a daemon exits unexpectedly after start() */
  onFailed: () => void = () => undefined

  constructor(
    readonly dir: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly configDir = audioConfigDir,
  ) {}

  async start(): Promise<boolean> {
    const programs = ['pipewire', 'pipewire-pulse', 'wireplumber']
    const missing = programs.filter((program) => findProgram(program, this.env) === undefined)
    if (missing.length > 0) {
      logger.info(`Not installed, the session has no audio: ${missing.join(', ')}.`)
      return false
    }
    const core = this.add('pipewire', ['-c', path.join(this.configDir, 'pipewire.conf')])
    if (!(await waitForSocket(path.join(this.dir, 'pipewire-0'), 5000, () => !this.failed))) {
      logger.error('PipeWire did not start, the session has no audio.')
      this.stop()
      return false
    }
    this.add('wireplumber', [])
    this.add('pipewire-pulse', ['-c', path.join(this.configDir, 'pipewire-pulse.conf')])
    if (!(await waitForSocket(path.join(this.dir, 'native'), 5000, () => !this.failed))) {
      logger.error('pipewire-pulse did not start, the session has no audio.')
      this.stop()
      return false
    }
    logger.info(
      `Session audio is up (PipeWire ${core.pid}, ${this.daemons.map((d) => `${d.name} ${d.pid}`).join(', ')}) in ${this.dir}.`,
    )
    return true
  }

  private add(name: string, args: string[]): Daemon {
    const daemon = new Daemon(name, name, args, this.env)
    daemon.onUnexpectedExit = () => {
      if (!this.failed) {
        this.failed = true
        this.onFailed()
      }
    }
    this.daemons.push(daemon)
    daemon.start()
    return daemon
  }

  /** Stop the daemons (by the PIDs we started), and remove the directory once they are gone. */
  stop(): void {
    for (const daemon of this.daemons) {
      daemon.stop()
    }
  }

  /** For the exit handler: kill what is left and remove the directory. */
  killAndClean(): void {
    for (const daemon of this.daemons) {
      daemon.kill()
    }
    rmSync(this.dir, { recursive: true, force: true })
  }
}
