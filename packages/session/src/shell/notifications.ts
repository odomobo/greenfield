/**
 * The session's notification server (org.freedesktop.Notifications on the session bus): apps' notifications are kept
 * here (so they survive the viewer going away) and forwarded to the viewer, which shows toasts and a history.
 *
 * Supports summary, body (markup stripped), icons and urgency. No actions.
 *
 * Several sessions of one user may share a bus (logind's per-user bus); only one can own the name. The others queue
 * and take over when the owner ends.
 */
import {
  ALREADY_OWNER,
  DBusConnection,
  DBusError,
  IncomingMessage,
  INVALID_ARGS,
  MethodReply,
  PRIMARY_OWNER,
  Variant,
} from './dbus'
import { createLogger } from '../Logger.js'

const logger = createLogger('notifications')

const NAME = 'org.freedesktop.Notifications'
const PATH = '/org/freedesktop/Notifications'
const IFACE = 'org.freedesktop.Notifications'
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

export function plainText(markup: string): string {
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

function variantValue(hints: Record<string, unknown>, key: string): unknown {
  const value = hints?.[key]
  return value instanceof Variant ? value.value : undefined
}

/** For apps that look before they call (gdbus introspect, D-Feet, ...). */
const INTROSPECTION = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="${IFACE}">
    <method name="GetCapabilities"><arg direction="out" type="as"/></method>
    <method name="Notify">
      <arg direction="in" type="s" name="app_name"/>
      <arg direction="in" type="u" name="replaces_id"/>
      <arg direction="in" type="s" name="app_icon"/>
      <arg direction="in" type="s" name="summary"/>
      <arg direction="in" type="s" name="body"/>
      <arg direction="in" type="as" name="actions"/>
      <arg direction="in" type="a{sv}" name="hints"/>
      <arg direction="in" type="i" name="expire_timeout"/>
      <arg direction="out" type="u" name="id"/>
    </method>
    <method name="CloseNotification"><arg direction="in" type="u" name="id"/></method>
    <method name="GetServerInformation">
      <arg direction="out" type="s" name="name"/>
      <arg direction="out" type="s" name="vendor"/>
      <arg direction="out" type="s" name="version"/>
      <arg direction="out" type="s" name="spec_version"/>
    </method>
    <signal name="NotificationClosed"><arg type="u" name="id"/><arg type="u" name="reason"/></signal>
    <signal name="ActionInvoked"><arg type="u" name="id"/><arg type="s" name="action_key"/></signal>
  </interface>
  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect"><arg direction="out" type="s"/></method>
  </interface>
  <interface name="org.freedesktop.DBus.Peer">
    <method name="Ping"/>
  </interface>
</node>
`

export class NotificationServer {
  private readonly notifications: Notification[] = []
  private nextId = 1
  private connection?: DBusConnection
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
    const connection = await DBusConnection.session((e) => logger.error(`Session bus error: ${e.message}`))
    this.connection = connection
    connection.export(PATH, (call) => this.call(call))
    const reply = await connection.requestName(NAME, 0)
    if (reply === PRIMARY_OWNER || reply === ALREADY_OWNER) {
      logger.info('Notification server running.')
    } else {
      logger.info('Another notification server owns the name; notifications go there until it ends.')
    }
  }

  stop(): void {
    this.connection?.close()
    this.connection = undefined
  }

  notify(
    appName: string,
    replacesId: number,
    appIcon: string,
    summary: string,
    body: string,
    hints: Record<string, unknown>,
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
      this.closed(id, CLOSED_BY_CALL)
    }
  }

  /** The user dismissed it. */
  dismiss(id: number): void {
    if (this.remove(id)) {
      this.closed(id, CLOSED_DISMISSED)
    }
  }

  dismissAll(): void {
    for (const { id } of [...this.notifications]) {
      this.dismiss(id)
    }
  }

  private closed(id: number, reason: number): void {
    this.connection?.emitSignal(PATH, IFACE, 'NotificationClosed', 'uu', [id, reason])
  }

  private call(call: IncomingMessage): MethodReply | undefined {
    if (call.interface === 'org.freedesktop.DBus.Introspectable' && call.member === 'Introspect') {
      return { signature: 's', body: [INTROSPECTION] }
    }
    if (call.interface !== IFACE && call.interface !== '') {
      return undefined
    }
    switch (call.member) {
      case 'GetCapabilities':
        return { signature: 'as', body: [['body']] }
      case 'GetServerInformation':
        return { signature: 'ssss', body: ['desktop-shell', '', '1.0', '1.2'] }
      case 'Notify': {
        if (call.signature !== 'susssasa{sv}i') {
          throw new DBusError(INVALID_ARGS, `Notify takes susssasa{sv}i, not ${call.signature}`)
        }
        const [appName, replacesId, appIcon, summary, body, , hints, expireTimeout] = call.body as [
          string,
          number,
          string,
          string,
          string,
          string[],
          Record<string, unknown>,
          number,
        ]
        return {
          signature: 'u',
          body: [this.notify(appName, replacesId, appIcon, summary, body, hints, expireTimeout)],
        }
      }
      case 'CloseNotification':
        if (call.signature !== 'u') {
          throw new DBusError(INVALID_ARGS, `CloseNotification takes u, not ${call.signature}`)
        }
        this.closeFromApp(call.body[0] as number)
        return { signature: '', body: [] }
    }
    return undefined
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
