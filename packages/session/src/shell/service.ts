/**
 * The desktop shell's server side, part of the user's session process: installed apps, launching them, pinned apps
 * (kept in the user's config dir) and notifications. The shell UI itself runs in the viewer; this talks to it with
 * `shell.*` control messages over the session's viewer WebSocket (see packages/viewer/src/protocol.ts).
 */
import { createLogger } from '../Logger.js'
import type { ShellEndpoint } from '../viewer/ViewerHost.js'
import type { ControlMessage } from '../viewer/ViewerTransport.js'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DesktopEntry, findProgram, loadDesktopEntries, parseExec, terminalCommand } from './desktop-entries'
import { IconResolver } from './icons'
import { Notification, NotificationServer } from './notifications'

const logger = createLogger('shell')

const MAX_PINNED = 32
const MAX_ICON_REQUEST = 64
/** re-read .desktop files at most this often (apps get installed while a session runs) */
const APPS_REFRESH_MS = 30_000

export type ShellApp = {
  id: string
  name: string
  genericName?: string
  comment?: string
  keywords: string[]
  icon?: string
  wmClass?: string
}

function toShellApp(entry: DesktopEntry): ShellApp {
  return {
    id: entry.id,
    name: entry.name,
    genericName: entry.genericName,
    comment: entry.comment,
    keywords: entry.keywords,
    icon: entry.icon,
    wmClass: entry.startupWMClass,
  }
}

/** Starts an app in the session (Apps in the session). */
export interface AppLauncher {
  launch(name: string, executable: string, args: string[]): Promise<unknown>
}

export class ShellService implements ShellEndpoint {
  private send?: (message: ControlMessage) => void
  private entries: DesktopEntry[] = []
  private entriesLoadedAt = 0
  private pinned: string[]
  private readonly icons = new IconResolver()
  private readonly notifications = new NotificationServer()
  private readonly pinnedFile: string

  constructor(private readonly apps: AppLauncher) {
    const env = process.env
    const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME ?? '/tmp', '.config')
    this.pinnedFile = path.join(configHome, 'greenfield', 'pinned.json')
    this.refreshEntries(true)
    this.pinned = this.loadPinned()
    this.notifications.listener = {
      added: (notification: Notification) => this.send?.({ type: 'shell.notification', notification }),
      closed: (id: number) => this.send?.({ type: 'shell.notification-closed', id }),
    }
    this.notifications.start().catch((e) => logger.error(`Notification server failed: ${e.message}`))
  }

  attach(send: (message: ControlMessage) => void): void {
    this.send = send
    this.refreshEntries()
    send({ type: 'shell.apps', apps: this.entries.map(toShellApp) })
    send({ type: 'shell.pinned', apps: this.pinned })
    send({ type: 'shell.notifications', notifications: this.notifications.all })
  }

  detach(): void {
    this.send = undefined
  }

  handleMessage(message: ControlMessage): void {
    switch (message.type) {
      case 'shell.launch':
        this.launch(message.app)
        break
      case 'shell.pin':
        this.setPinned(message.apps)
        break
      case 'shell.icons':
        this.sendIcons(message.names)
        break
      case 'shell.notification-dismiss':
        this.notifications.dismiss(Number(message.id))
        break
      case 'shell.notifications-clear':
        this.notifications.dismissAll()
        break
      case 'shell.refresh-apps':
        if (this.refreshEntries()) {
          this.send?.({ type: 'shell.apps', apps: this.entries.map(toShellApp) })
        }
        break
      default:
        logger.info(`Unknown shell message: ${message.type}`)
    }
  }

  /** Returns whether the list was (re)loaded. */
  private refreshEntries(force = false): boolean {
    if (!force && Date.now() - this.entriesLoadedAt < APPS_REFRESH_MS) {
      return false
    }
    this.entriesLoadedAt = Date.now()
    try {
      this.entries = loadDesktopEntries()
    } catch (e: any) {
      logger.error(`Reading installed applications failed: ${e.message}`)
    }
    return true
  }

  private launch(id: unknown) {
    const entry = typeof id === 'string' ? this.entries.find((e) => e.id === id) : undefined
    if (entry === undefined) {
      this.send?.({ type: 'shell.launch-failed', app: String(id), reason: 'unknown' })
      return
    }
    let args = parseExec(entry.exec, entry)
    if (args && entry.terminal) {
      args = terminalCommand(args)
    }
    if (args === undefined || findProgram(args[0]) === undefined) {
      logger.error(`Can't run ${entry.id}: ${entry.exec}`)
      this.send?.({ type: 'shell.launch-failed', app: entry.id, reason: 'not-runnable' })
      return
    }
    const [executable, ...rest] = args
    this.apps.launch(entry.name, executable, rest).catch((e: Error) => {
      logger.error(`Launching ${entry.id} failed: ${e.message}`)
      this.send?.({ type: 'shell.launch-failed', app: entry.id, reason: 'failed' })
    })
  }

  private loadPinned(): string[] {
    try {
      const pinned = JSON.parse(readFileSync(this.pinnedFile, 'utf8'))
      if (Array.isArray(pinned)) {
        return pinned.filter((id): id is string => typeof id === 'string').slice(0, MAX_PINNED)
      }
    } catch {
      // first session: pin a terminal
    }
    const terminal = this.entries.find((entry) => entry.categories.includes('TerminalEmulator'))
    return terminal ? [terminal.id] : []
  }

  private setPinned(apps: unknown) {
    if (!Array.isArray(apps)) {
      return
    }
    const pinned = [...new Set(apps.filter((id): id is string => typeof id === 'string' && id.length <= 256))].slice(
      0,
      MAX_PINNED,
    )
    this.pinned = pinned
    try {
      mkdirSync(path.dirname(this.pinnedFile), { recursive: true, mode: 0o700 })
      const temporary = `${this.pinnedFile}.tmp`
      writeFileSync(temporary, JSON.stringify(pinned, null, 2) + '\n', { mode: 0o600 })
      renameSync(temporary, this.pinnedFile)
    } catch (e: any) {
      logger.error(`Saving pinned apps failed: ${e.message}`)
    }
    this.send?.({ type: 'shell.pinned', apps: pinned })
  }

  private sendIcons(names: unknown) {
    if (!Array.isArray(names)) {
      return
    }
    const icons: Record<string, string | null> = {}
    for (const name of names.slice(0, MAX_ICON_REQUEST)) {
      if (typeof name === 'string') {
        icons[name] = this.icons.resolve(name)
      }
    }
    this.send?.({ type: 'shell.icons', icons })
  }
}
