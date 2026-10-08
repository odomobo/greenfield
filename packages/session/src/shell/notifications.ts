/**
 * The session's notification server (org.freedesktop.Notifications on the session bus): apps' notifications are kept
 * here (so they survive the viewer going away) and forwarded to the viewer, which shows toasts and a history.
 *
 * Supports summary, body (markup stripped), icons and urgency. No actions.
 *
 * Several sessions of one user may share a bus (logind's per-user bus); only one can own the name. The others queue
 * and take over when the owner ends.
 */
import * as dbus from 'dbus-next'
import { createLogger } from '../Logger.js'

const logger = createLogger('notifications')

const NAME = 'org.freedesktop.Notifications'
const PATH = '/org/freedesktop/Notifications'
const MAX_KEPT = 50
const MAX_TEXT = 2000

export type Notification = {
  id: number
  appName: string
  summary: string
  body: string
  /** icon name or image path, resolved by the viewer through shell.icons */
  icon?: string
  /** desktop file ID of the sender (desktop-entry hint), to find its icon */
  desktopEntry?: string
  urgency: 'low' | 'normal' | 'critical'
  /** ms the toast stays, -1: default, 0: until dismissed */
  expireTimeout: number
  time: number
}

/** Reasons of the NotificationClosed signal */
const CLOSED_DISMISSED = 2
const CLOSED_BY_CALL = 3

export type NotificationListener = {
  added(notification: Notification): void
  closed(id: number): void
}

function plainText(markup: string): string {
  const text = markup
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (entity, name: string) => {
      const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
      if (named[name.toLowerCase()]) {
        return named[name.toLowerCase()]
      }
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : entity
    })
  return text.slice(0, MAX_TEXT)
}

function variantValue(hints: Record<string, dbus.Variant>, key: string): unknown {
  return hints?.[key]?.value
}

export class NotificationServer {
  private readonly notifications: Notification[] = []
  private nextId = 1
  private iface?: NotificationsInterface
  listener?: NotificationListener

  /** Kept notifications, oldest first. */
  get all(): readonly Notification[] {
    return this.notifications
  }

  async start(): Promise<void> {
    if (process.env.DBUS_SESSION_BUS_ADDRESS === undefined) {
      logger.info('No session bus; apps cannot send notifications.')
      return
    }
    const bus = dbus.sessionBus()
    bus.on('error', (e: Error) => logger.error(`Session bus error: ${e.message}`))
    this.iface = new NotificationsInterface(this)
    bus.export(PATH, this.iface)
    const reply = await bus.requestName(NAME, 0)
    if (reply === dbus.RequestNameReply.PRIMARY_OWNER || reply === dbus.RequestNameReply.ALREADY_OWNER) {
      logger.info('Notification server running.')
    } else {
      logger.info('Another notification server owns the name; notifications go there until it ends.')
    }
  }

  notify(
    appName: string,
    replacesId: number,
    appIcon: string,
    summary: string,
    body: string,
    hints: Record<string, dbus.Variant>,
    expireTimeout: number,
  ): number {
    const replaced = replacesId > 0 ? this.notifications.findIndex((n) => n.id === replacesId) : -1
    const id = replaced >= 0 ? replacesId : this.nextId++
    const urgencyHint = Number(variantValue(hints, 'urgency'))
    const imagePath = variantValue(hints, 'image-path') ?? variantValue(hints, 'image_path')
    const desktopEntry = variantValue(hints, 'desktop-entry')
    const notification: Notification = {
      id,
      appName: plainText(String(appName)).slice(0, 200),
      summary: plainText(String(summary)),
      body: plainText(String(body)),
      icon: (typeof imagePath === 'string' && imagePath) || appIcon || undefined,
      desktopEntry: typeof desktopEntry === 'string' && desktopEntry ? desktopEntry : undefined,
      urgency: urgencyHint === 0 ? 'low' : urgencyHint === 2 ? 'critical' : 'normal',
      expireTimeout: Number.isFinite(expireTimeout) ? expireTimeout : -1,
      time: Date.now(),
    }
    if (replaced >= 0) {
      this.notifications.splice(replaced, 1)
    }
    this.notifications.push(notification)
    while (this.notifications.length > MAX_KEPT) {
      this.notifications.shift()
    }
    this.listener?.added(notification)
    return id
  }

  /** The app withdrew it. */
  closeFromApp(id: number): void {
    if (this.remove(id)) {
      this.iface?.NotificationClosed(id, CLOSED_BY_CALL)
    }
  }

  /** The user dismissed it. */
  dismiss(id: number): void {
    if (this.remove(id)) {
      this.iface?.NotificationClosed(id, CLOSED_DISMISSED)
    }
  }

  dismissAll(): void {
    for (const { id } of [...this.notifications]) {
      this.dismiss(id)
    }
  }

  private remove(id: number): boolean {
    const index = this.notifications.findIndex((n) => n.id === id)
    if (index < 0) {
      return false
    }
    this.notifications.splice(index, 1)
    this.listener?.closed(id)
    return true
  }
}

class NotificationsInterface extends dbus.interface.Interface {
  constructor(private readonly server: NotificationServer) {
    super('org.freedesktop.Notifications')
  }

  GetCapabilities(): string[] {
    return ['body']
  }

  Notify(
    appName: string,
    replacesId: number,
    appIcon: string,
    summary: string,
    body: string,
    _actions: string[],
    hints: Record<string, dbus.Variant>,
    expireTimeout: number,
  ): number {
    return this.server.notify(appName, replacesId, appIcon, summary, body, hints, expireTimeout)
  }

  CloseNotification(id: number): void {
    this.server.closeFromApp(id)
  }

  GetServerInformation(): string[] {
    return ['desktop-shell', '', '1.0', '1.2']
  }

  NotificationClosed(id: number, reason: number): number[] {
    return [id, reason]
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ActionInvoked(id: number, actionKey: string): [number, string] {
    return [id, actionKey]
  }
}

NotificationsInterface.configureMembers({
  methods: {
    GetCapabilities: { outSignature: 'as' },
    Notify: { inSignature: 'susssasa{sv}i', outSignature: 'u' },
    CloseNotification: { inSignature: 'u' },
    GetServerInformation: { outSignature: 'ssss' },
  },
  signals: {
    NotificationClosed: { signature: 'uu' },
    ActionInvoked: { signature: 'us' },
  },
})
