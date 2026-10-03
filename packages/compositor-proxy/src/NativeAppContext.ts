import { NativeWaylandClientSession } from './NativeWaylandClientSession.js'
import { Channel } from './Channel.js'
import { createLogger } from './Logger.js'
import { spawn } from 'node:child_process'
import { Session } from './Session.js'
import { setTimeout } from 'node:timers'

/**
 * A (launched or externally started) application process and its Wayland connections. Its lifetime is independent of
 * any attached viewer.
 */
export class NativeAppContext {
  private nativeClientSessions: NativeWaylandClientSession[] = []
  public readonly destroyListeners: (() => void)[] = []

  private readonly channels: Record<string, Channel> = {}
  private sigKillTimer?: NodeJS.Timeout

  constructor(
    readonly session: Session,
    readonly pid: number,
    readonly name: string,
    readonly external: boolean,
  ) {}

  addNativeWaylandClientSession(nativeClientSession: NativeWaylandClientSession) {
    this.nativeClientSessions.push(nativeClientSession)
  }

  removeNativeWaylandClientSession(nativeClientSession: NativeWaylandClientSession) {
    this.nativeClientSessions = this.nativeClientSessions.filter(
      (otherNativeClientSession) => otherNativeClientSession !== nativeClientSession,
    )
    if (this.external && this.nativeClientSessions.length === 0) {
      this.onExit()
    }
  }

  onExit() {
    if (this.sigKillTimer) {
      clearTimeout(this.sigKillTimer)
      this.sigKillTimer = undefined
    }
    for (const destroyListener of this.destroyListeners) {
      destroyListener()
    }
    this.destroyListeners.splice(0, this.destroyListeners.length)
  }

  kill(signal: 'SIGTERM' | 'SIGHUP') {
    try {
      process.kill(this.pid, signal)
      if (this.sigKillTimer === undefined) {
        this.sigKillTimer = setTimeout(() => {
          this.sigKillTimer = undefined
          try {
            process.kill(this.pid, 'SIGKILL')
          } catch (e: any) {
            if (e.code !== 'ESRCH') {
              throw e
            }
          }
        }, 10000)
      }
    } catch (e: any) {
      // ESRCH: PID already gone, we can safely ignore this error.
      if (e.code !== 'ESRCH') {
        throw e
      }
    }
  }

  registerChannel(channel: Channel) {
    this.channels[channel.desc.id] = channel
    channel.onClose = () => {
      delete this.channels[channel.desc.id]
    }
  }

  closeClientChannels(clientId: string) {
    // Only close the channels of this client. An app can have several Wayland connections, e.g. Mesa opens a
    // short-lived one while probing EGL, and closing one must not take down the others.
    for (const channel of Object.values(this.channels)) {
      if (channel.desc.clientId === clientId) {
        channel.close()
      }
    }
  }
}

export function launchApplication(
  name: string,
  applicationExecutable: string,
  args: string[],
  env: Record<string, string>,
  session: Session,
): Promise<NativeAppContext> {
  return new Promise<NativeAppContext>((resolve, reject) => {
    const appLogger = createLogger(applicationExecutable)

    const appEnv = {
      ...process.env,
      ...env,
      WAYLAND_DISPLAY: session.nativeWaylandCompositorSession.waylandDisplay,
    }
    // Don't log the environment, it can contain secrets.
    appLogger.info(`Launching application ${applicationExecutable} with args ${JSON.stringify(args)}`)
    const childProcess = spawn(applicationExecutable, args, {
      env: appEnv,
    })

    childProcess.stdout.on('data', (data) => {
      appLogger.info(data.toString())
    })

    childProcess.stderr.on('data', (data) => {
      appLogger.error(data.toString())
    })

    const spawnErrorHandler = (error: Error) => {
      appLogger.error(`child process error: ${error.message}.`)
      reject(error)
    }
    childProcess.once('error', spawnErrorHandler)

    childProcess.once('spawn', () => {
      appLogger.info(`Child process started.`)
      childProcess.removeListener('error', spawnErrorHandler)
      childProcess.addListener('error', (error) => {
        appLogger.error(`child process error: ${error.message}.`)
      })

      if (childProcess.pid === undefined) {
        throw new Error('BUG? Spawned child process without a pid.')
      }

      const nativeAppContext = session.createNativeAppContext(childProcess.pid, name, false)
      childProcess.once('exit', (exitCode, signal) => {
        if (exitCode !== null) {
          appLogger.info(`Child process terminated with exit code: ${exitCode}.`)
        }
        if (signal !== null) {
          appLogger.info(`Child process terminated with signal: ${signal}.`)
        }
        nativeAppContext.onExit()
      })
      resolve(nativeAppContext)
    })
  })
}
