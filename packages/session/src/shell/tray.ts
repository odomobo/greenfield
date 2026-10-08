/**
 * The system tray: the StatusNotifierItems apps put up (Discord, Steam, chat clients, network applets), forwarded to
 * the viewer, which shows them in the taskbar, and their com.canonical.dbusmenu menus.
 *
 * The session is the org.kde.StatusNotifierWatcher if no one else is on the bus (it queues for the name and takes over
 * when the owner ends, like the notification server), and always a host: with another watcher (the user's Plasma on a
 * shared bus) it registers with it and follows its list. Either way only the items of this desktop's apps are shown
 * (their process belongs to the desktop): a bus shared with the user's other desktops has theirs too.
 *
 * All D-Bus goes through dbus.ts.
 */
import { createLogger } from '../Logger.js'
import { encodePng } from '../encoding/png.js'
import {
  DBUS_NAME,
  DBusConnection,
  DBusError,
  IncomingMessage,
  IN_QUEUE,
  MethodReply,
  PRIMARY_OWNER,
  UNKNOWN_METHOD,
  Variant,
} from './dbus'
import type { IconResolver } from './icons'
import { plainText } from './notifications'

const logger = createLogger('tray')

const WATCHER_NAME = 'org.kde.StatusNotifierWatcher'
const WATCHER_PATH = '/StatusNotifierWatcher'
const WATCHER_IFACE = 'org.kde.StatusNotifierWatcher'
const ITEM_IFACE = 'org.kde.StatusNotifierItem'
const MENU_IFACE = 'com.canonical.dbusmenu'
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties'
const DEFAULT_ITEM_PATH = '/StatusNotifierItem'
const MAX_ITEMS = 64
/** pixmaps are picked for this size (24 px icons at a device pixel ratio of 2) */
const ICON_SIZE = 48
const MAX_PIXMAP_SIDE = 1024
const MAX_MENU_ENTRIES = 1000
const MAX_MENU_DEPTH = 8
const MAX_MENU_ICON_BYTES = 256 * 1024
/** an item's New* signals often come in bursts (NewIcon, NewToolTip, ...): re-read its properties once per burst */
const REFRESH_DELAY_MS = 30
/** calls to items: a hung app must not hold its icon or menu up for long */
const ITEM_CALL_TIMEOUT_MS = 5_000

const WATCHER_INTROSPECTION = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="${WATCHER_IFACE}">
    <method name="RegisterStatusNotifierItem"><arg name="service" type="s" direction="in"/></method>
    <method name="RegisterStatusNotifierHost"><arg name="service" type="s" direction="in"/></method>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
    <signal name="StatusNotifierItemRegistered"><arg type="s"/></signal>
    <signal name="StatusNotifierItemUnregistered"><arg type="s"/></signal>
    <signal name="StatusNotifierHostRegistered"/>
    <signal name="StatusNotifierHostUnregistered"/>
  </interface>
  <interface name="${PROPERTIES_IFACE}">
    <method name="Get">
      <arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/>
    </method>
    <method name="GetAll"><arg type="s" direction="in"/><arg type="a{sv}" direction="out"/></method>
  </interface>
  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect"><arg type="s" direction="out"/></method>
  </interface>
</node>
`

export type TrayItemState = {
  id: string
  title: string
  tooltip?: { title: string; body: string }
  status: 'active' | 'passive' | 'attention'
  icon: string | null
  menu: boolean
  itemIsMenu: boolean
}

export type TrayMenuEntry =
  | { id: number; separator: true }
  | {
      id: number
      label: string
      enabled: boolean
      toggle?: 'checkmark' | 'radio'
      checked?: boolean
      icon?: string
      children?: TrayMenuEntry[]
    }

export type TrayListener = {
  changed(item: TrayItemState): void
  removed(id: string): void
  /** show: open it there; undefined: an update of an open menu */
  menu(id: string, menu: TrayMenuEntry[], show: { x: number; y: number } | undefined): void
}

export type TrayEnvironment = {
  /** whether a process belongs to this desktop (its items are shown) */
  owns(pid: number): boolean
  icons: IconResolver
}

type Item = {
  /** `${busName}${path}`: what the watcher lists */
  key: string
  /** the name it registered with: its unique name or a well-known one */
  busName: string
  /** its unique name (signals come from it) */
  owner: string
  path: string
  /** its process isn't this desktop's: tracked (we may be the watcher), never shown */
  foreign: boolean
  /** what the viewer was last sent, undefined: nothing yet */
  state?: TrayItemState
  menuPath?: string
  unsubscribe: (() => void)[]
  refreshTimer?: NodeJS.Timeout
  /** the viewer shows its menu */
  menuOpen: boolean
  menuTimer?: NodeJS.Timeout
  menuSubscribed: boolean
}

/** Parses a service as the watcher gets it: a bus name, a bus name and a path, or (from the sender) a path. */
export function parseService(service: string, sender: string): { busName: string; path: string } | undefined {
  if (service.startsWith('/')) {
    return { busName: sender, path: service }
  }
  const slash = service.indexOf('/')
  const busName = slash < 0 ? service : service.slice(0, slash)
  const path = slash < 0 ? DEFAULT_ITEM_PATH : service.slice(slash)
  if (!/^(:[\w.-]+|[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)+)$/.test(busName) || !/^(\/[\w]+)+$|^\/$/.test(path)) {
    return undefined
  }
  return { busName, path }
}

/** Removes dbusmenu mnemonics: `_File` is File, `__` is a literal underscore. */
export function stripMnemonics(label: string): string {
  return label.replace(/_(_?)/g, (_, escaped: string) => escaped)
}

/** The pixmap (width, height, ARGB32 in network byte order) closest to `size`, preferring larger, as RGBA. */
export function pickPixmap(
  pixmaps: unknown,
  size = ICON_SIZE,
): { width: number; height: number; rgba: Uint8Array } | undefined {
  if (!Array.isArray(pixmaps)) {
    return undefined
  }
  let best: { width: number; height: number; data: Buffer; score: number } | undefined
  for (const pixmap of pixmaps) {
    if (!Array.isArray(pixmap)) {
      continue
    }
    const [width, height, data] = pixmap as [unknown, unknown, unknown]
    if (
      typeof width !== 'number' ||
      typeof height !== 'number' ||
      !Buffer.isBuffer(data) ||
      width <= 0 ||
      height <= 0 ||
      width > MAX_PIXMAP_SIDE ||
      height > MAX_PIXMAP_SIDE ||
      data.length < width * height * 4
    ) {
      continue
    }
    const side = Math.max(width, height)
    const score = side >= size ? side - size : (size - side) * 4
    if (best === undefined || score < best.score) {
      best = { width, height, data, score }
    }
  }
  if (best === undefined) {
    return undefined
  }
  const { width, height, data } = best
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height * 4; i += 4) {
    rgba[i] = data[i + 1]
    rgba[i + 1] = data[i + 2]
    rgba[i + 2] = data[i + 3]
    rgba[i + 3] = data[i]
  }
  return { width, height, rgba }
}

export class TrayHost {
  private connection?: DBusConnection
  private readonly items = new Map<string, Item>()
  private mode: 'none' | 'watcher' | 'host' = 'none'
  private watcherOwner?: string
  private unsubscribeWatcher?: () => void
  private readonly hostName = `org.kde.StatusNotifierHost-${process.pid}`
  listener?: TrayListener

  constructor(private readonly environment: TrayEnvironment) {}

  /** The items shown, in the order they came. */
  get all(): TrayItemState[] {
    return [...this.items.values()].flatMap((item) => (item.state ? [item.state] : []))
  }

  async start(): Promise<void> {
    if (process.env.DBUS_SESSION_BUS_ADDRESS === undefined) {
      logger.info('No session bus; no system tray.')
      return
    }
    const connection = await DBusConnection.session((e) => logger.error(`Session bus error: ${e.message}`))
    this.connection = connection
    await connection.subscribe({ sender: DBUS_NAME, interface: DBUS_NAME, member: 'NameOwnerChanged' }, (message) =>
      this.nameOwnerChanged(message),
    )
    connection.export(WATCHER_PATH, (call) => this.watcherCall(call))
    await connection.requestName(this.hostName)
    const reply = await connection.requestName(WATCHER_NAME)
    if (reply === PRIMARY_OWNER) {
      this.becomeWatcher()
    } else {
      const owner = await connection.nameOwner(WATCHER_NAME)
      if (owner !== undefined && owner !== connection.uniqueName) {
        await this.followWatcher(owner)
      } else if (reply !== IN_QUEUE) {
        logger.error(`Couldn't queue for ${WATCHER_NAME} (${reply}).`)
      }
    }
  }

  stop(): void {
    for (const item of this.items.values()) {
      this.forget(item)
    }
    this.items.clear()
    this.connection?.close()
    this.connection = undefined
  }

  // ---------------------------------------------------------------------------------------------------------------
  // what the viewer asks for

  /** A click: activate (left), secondary (middle) or context (right), at page coordinates. */
  async click(id: string, action: 'activate' | 'secondary' | 'context', x: number, y: number): Promise<void> {
    const item = this.shown(id)
    if (item === undefined || this.connection === undefined) {
      return
    }
    x = Math.round(x)
    y = Math.round(y)
    const showsMenu = action === 'context' || (action === 'activate' && item.state?.itemIsMenu)
    if (showsMenu && item.menuPath) {
      await this.showMenu(item, x, y)
      return
    }
    const member = action === 'activate' ? 'Activate' : action === 'secondary' ? 'SecondaryActivate' : 'ContextMenu'
    try {
      await this.connection.call(item.owner, item.path, ITEM_IFACE, member, 'ii', [x, y], ITEM_CALL_TIMEOUT_MS)
    } catch (e: any) {
      // items that only have a menu (some don't implement Activate at all)
      if (action === 'activate' && item.menuPath && e instanceof DBusError) {
        await this.showMenu(item, x, y)
      } else {
        logger.info(`${member} on ${id} failed: ${e.message}`)
      }
    }
  }

  /** The wheel: delta in wheel units, 120 per click, positive down / right (the viewer's direction). */
  scroll(id: string, delta: number, orientation: 'vertical' | 'horizontal'): void {
    const item = this.shown(id)
    if (item === undefined || !Number.isFinite(delta)) {
      return
    }
    this.connection
      // (positive is up / left for items, as Qt's wheel deltas: volume applets turn it up)
      ?.call(item.owner, item.path, ITEM_IFACE, 'Scroll', 'is', [-Math.round(delta), orientation], ITEM_CALL_TIMEOUT_MS)
      .catch((e: Error) => logger.info(`Scroll on ${id} failed: ${e.message}`))
  }

  /** A submenu of the open menu is shown: the app may fill it now. */
  async submenuShown(id: string, entry: number): Promise<void> {
    const item = this.shown(id)
    if (item?.menuPath === undefined || !item.menuOpen || !Number.isInteger(entry)) {
      return
    }
    this.menuEvent(item, entry, 'opened')
    if (await this.aboutToShow(item, entry)) {
      this.scheduleMenuUpdate(item)
    }
  }

  menuClicked(id: string, entry: number): void {
    const item = this.shown(id)
    if (item?.menuPath !== undefined && Number.isInteger(entry)) {
      this.menuEvent(item, entry, 'clicked')
    }
  }

  menuClosed(id: string): void {
    const item = this.shown(id)
    if (item?.menuPath !== undefined && item.menuOpen) {
      item.menuOpen = false
      clearTimeout(item.menuTimer)
      this.menuEvent(item, 0, 'closed')
    }
  }

  private shown(id: unknown): Item | undefined {
    const item = typeof id === 'string' ? this.items.get(id) : undefined
    return item?.state ? item : undefined
  }

  // ---------------------------------------------------------------------------------------------------------------
  // the watcher: ours, or another one we follow

  private becomeWatcher(): void {
    if (this.mode === 'watcher') {
      return
    }
    this.unsubscribeWatcher?.()
    this.unsubscribeWatcher = undefined
    this.watcherOwner = undefined
    this.mode = 'watcher'
    logger.info('System tray running (StatusNotifierWatcher).')
    // the items we knew from the previous watcher stay; items re-register with a new watcher anyway
    this.connection?.emitSignal(WATCHER_PATH, WATCHER_IFACE, 'StatusNotifierHostRegistered')
  }

  /** Another process is the watcher: register with it and follow its list. */
  private async followWatcher(owner: string): Promise<void> {
    const connection = this.connection
    if (connection === undefined || this.watcherOwner === owner) {
      return
    }
    this.unsubscribeWatcher?.()
    this.mode = 'host'
    this.watcherOwner = owner
    logger.info('Another StatusNotifierWatcher runs; the system tray follows it.')
    const unsubscribe = await connection.subscribe(
      { sender: owner, path: WATCHER_PATH, interface: WATCHER_IFACE },
      (message) => {
        const [service] = message.body
        if (typeof service !== 'string') {
          return
        }
        if (message.member === 'StatusNotifierItemRegistered') {
          this.addService(service, owner)
        } else if (message.member === 'StatusNotifierItemUnregistered') {
          const parsed = parseService(service, owner)
          const item = parsed && this.items.get(parsed.busName + parsed.path)
          if (item) {
            this.remove(item)
          }
        }
      },
    )
    if (this.watcherOwner !== owner) {
      unsubscribe()
      return
    }
    this.unsubscribeWatcher = unsubscribe
    try {
      await connection.call(owner, WATCHER_PATH, WATCHER_IFACE, 'RegisterStatusNotifierHost', 's', [this.hostName])
      const services = await connection.getProperty(owner, WATCHER_PATH, WATCHER_IFACE, 'RegisteredStatusNotifierItems')
      if (Array.isArray(services)) {
        for (const service of services) {
          if (typeof service === 'string') {
            this.addService(service, owner)
          }
        }
      }
    } catch (e: any) {
      logger.error(`Following the StatusNotifierWatcher failed: ${e.message}`)
    }
  }

  /** Method calls to our watcher object. */
  private watcherCall(call: IncomingMessage): MethodReply | undefined {
    const iface = call.interface
    if (iface === 'org.freedesktop.DBus.Introspectable' && call.member === 'Introspect') {
      return { signature: 's', body: [WATCHER_INTROSPECTION] }
    }
    if (iface === PROPERTIES_IFACE) {
      const properties = this.watcherProperties()
      if (call.member === 'GetAll') {
        return { signature: 'a{sv}', body: [call.body[0] === WATCHER_IFACE ? properties : {}] }
      }
      if (call.member === 'Get') {
        const value = call.body[0] === WATCHER_IFACE ? properties[String(call.body[1])] : undefined
        if (value === undefined) {
          throw new DBusError('org.freedesktop.DBus.Error.UnknownProperty', `No property ${call.body[1]}`)
        }
        return { signature: 'v', body: [value] }
      }
      if (call.member === 'Set') {
        throw new DBusError('org.freedesktop.DBus.Error.PropertyReadOnly', 'The properties are read-only')
      }
      return undefined
    }
    if (iface !== WATCHER_IFACE && iface !== '') {
      return undefined
    }
    if (call.member === 'RegisterStatusNotifierItem' && typeof call.body[0] === 'string') {
      if (!this.addService(call.body[0], call.sender)) {
        throw new DBusError('org.freedesktop.DBus.Error.InvalidArgs', `Not a service: ${call.body[0]}`)
      }
      return { signature: '', body: [] }
    }
    if (call.member === 'RegisterStatusNotifierHost' && typeof call.body[0] === 'string') {
      this.connection?.emitSignal(WATCHER_PATH, WATCHER_IFACE, 'StatusNotifierHostRegistered')
      return { signature: '', body: [] }
    }
    return undefined
  }

  private watcherProperties(): Record<string, Variant> {
    return {
      RegisteredStatusNotifierItems: new Variant('as', [...this.items.keys()]),
      // (we're one)
      IsStatusNotifierHostRegistered: new Variant('b', true),
      ProtocolVersion: new Variant('i', 0),
    }
  }

  private nameOwnerChanged(message: IncomingMessage): void {
    const [name, , newOwner] = message.body as [string, string, string]
    if (name === WATCHER_NAME) {
      if (newOwner === this.connection?.uniqueName) {
        this.becomeWatcher()
      } else if (newOwner) {
        this.followWatcher(newOwner).catch((e: Error) => logger.error(`Following the watcher failed: ${e.message}`))
      } else if (this.mode === 'host') {
        // gone; we're queued for the name, so we'll own it next
        this.unsubscribeWatcher?.()
        this.unsubscribeWatcher = undefined
        this.watcherOwner = undefined
        this.mode = 'none'
      }
      return
    }
    if (newOwner) {
      return
    }
    for (const item of [...this.items.values()]) {
      if (item.busName === name || item.owner === name) {
        this.remove(item)
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // items

  /** An item registered (with us or the watcher we follow). Returns false if `service` isn't one. */
  private addService(service: string, sender: string): boolean {
    const parsed = parseService(service, sender)
    if (parsed === undefined) {
      return false
    }
    const key = parsed.busName + parsed.path
    if (this.items.has(key)) {
      return true
    }
    if (this.items.size >= MAX_ITEMS) {
      logger.error(`Too many tray items, ignoring ${key}.`)
      return true
    }
    const item: Item = {
      key,
      busName: parsed.busName,
      owner: parsed.busName,
      path: parsed.path,
      foreign: false,
      unsubscribe: [],
      menuOpen: false,
      menuSubscribed: false,
    }
    this.items.set(key, item)
    if (this.mode === 'watcher') {
      this.connection?.emitSignal(WATCHER_PATH, WATCHER_IFACE, 'StatusNotifierItemRegistered', 's', [key])
    }
    this.setUp(item).catch((e: Error) => {
      logger.info(`Tray item ${key} failed: ${e.message}`)
      if (this.items.get(key) === item) {
        this.remove(item)
      }
    })
    return true
  }

  private async setUp(item: Item): Promise<void> {
    const connection = this.connection!
    const owner = item.busName.startsWith(':') ? item.busName : await connection.nameOwner(item.busName)
    if (owner === undefined) {
      throw new Error('its bus name has no owner')
    }
    item.owner = owner
    const pid = await connection.processId(owner)
    if (this.items.get(item.key) !== item) {
      return
    }
    // (unknown: shown; it registered on our bus after all)
    if (pid !== undefined && !this.environment.owns(pid)) {
      item.foreign = true
      logger.info(`Tray item ${item.key} belongs to another desktop (pid ${pid}), not shown.`)
      return
    }
    const unsubscribe = await connection.subscribe({ sender: owner, path: item.path, interface: ITEM_IFACE }, () =>
      this.scheduleRefresh(item),
    )
    if (this.items.get(item.key) !== item) {
      unsubscribe()
      return
    }
    item.unsubscribe.push(unsubscribe)
    await this.refresh(item)
  }

  private scheduleRefresh(item: Item): void {
    if (item.refreshTimer !== undefined) {
      return
    }
    item.refreshTimer = setTimeout(() => {
      item.refreshTimer = undefined
      this.refresh(item).catch((e: Error) => logger.info(`Reading tray item ${item.key} failed: ${e.message}`))
    }, REFRESH_DELAY_MS)
  }

  /** Reads the item's properties and sends what changed. */
  private async refresh(item: Item): Promise<void> {
    const properties = await this.connection!.getAllProperties(item.owner, item.path, ITEM_IFACE)
    if (this.items.get(item.key) !== item) {
      return
    }
    const status =
      properties.Status === 'Passive' ? 'passive' : properties.Status === 'NeedsAttention' ? 'attention' : 'active'
    const attention =
      status === 'attention'
        ? await this.icon(properties.AttentionIconName, properties.AttentionIconPixmap, properties)
        : null
    const icon = attention ?? (await this.icon(properties.IconName, properties.IconPixmap, properties))
    const id = typeof properties.Id === 'string' ? properties.Id : ''
    const title = plainText(typeof properties.Title === 'string' && properties.Title ? properties.Title : id).slice(
      0,
      200,
    )
    let tooltip: TrayItemState['tooltip']
    if (Array.isArray(properties.ToolTip)) {
      const [, , tipTitle, tipBody] = properties.ToolTip as unknown[]
      const text = { title: plainText(String(tipTitle ?? '')).slice(0, 200), body: plainText(String(tipBody ?? '')) }
      if (text.title || text.body) {
        tooltip = text
      }
    }
    const menuPath =
      typeof properties.Menu === 'string' && properties.Menu !== '/' && properties.Menu ? properties.Menu : undefined
    if (menuPath !== item.menuPath) {
      item.menuPath = menuPath
      item.menuSubscribed = false
    }
    const state: TrayItemState = {
      id: item.key,
      title,
      tooltip,
      status,
      icon,
      menu: menuPath !== undefined,
      itemIsMenu: properties.ItemIsMenu === true,
    }
    if (this.items.get(item.key) === item && JSON.stringify(state) !== JSON.stringify(item.state)) {
      item.state = state
      this.listener?.changed(state)
    }
  }

  /** The icon as a data URL: the named one if we find it (in the item's IconThemePath first), else its pixmap. */
  private async icon(name: unknown, pixmaps: unknown, properties: Record<string, unknown>): Promise<string | null> {
    if (typeof name === 'string' && name) {
      const themePath = typeof properties.IconThemePath === 'string' ? properties.IconThemePath : ''
      const url = themePath
        ? this.environment.icons.resolveWithThemePath(name, themePath)
        : this.environment.icons.resolve(name)
      if (url !== null) {
        return url
      }
    }
    const pixmap = pickPixmap(pixmaps)
    if (pixmap === undefined) {
      return null
    }
    const png = await encodePng(pixmap.rgba, pixmap.width, pixmap.height)
    return `data:image/png;base64,${png.toString('base64')}`
  }

  private remove(item: Item): void {
    if (this.items.get(item.key) !== item) {
      return
    }
    this.items.delete(item.key)
    this.forget(item)
    if (this.mode === 'watcher') {
      this.connection?.emitSignal(WATCHER_PATH, WATCHER_IFACE, 'StatusNotifierItemUnregistered', 's', [item.key])
    }
    if (item.state) {
      this.listener?.removed(item.key)
    }
  }

  private forget(item: Item): void {
    clearTimeout(item.refreshTimer)
    clearTimeout(item.menuTimer)
    item.unsubscribe.forEach((unsubscribe) => unsubscribe())
    item.unsubscribe = []
  }

  // ---------------------------------------------------------------------------------------------------------------
  // menus (com.canonical.dbusmenu)

  private async showMenu(item: Item, x: number, y: number): Promise<void> {
    if (!item.menuSubscribed && item.menuPath) {
      item.menuSubscribed = true
      // the menu changing while it's shown
      const unsubscribe = await this.connection!.subscribe(
        { sender: item.owner, path: item.menuPath, interface: MENU_IFACE },
        (message) => {
          if (item.menuOpen && (message.member === 'LayoutUpdated' || message.member === 'ItemsPropertiesUpdated')) {
            this.scheduleMenuUpdate(item)
          }
        },
      )
      item.unsubscribe.push(unsubscribe)
    }
    this.menuEvent(item, 0, 'opened')
    await this.aboutToShow(item, 0)
    const menu = await this.readMenu(item)
    if (menu !== undefined && this.items.get(item.key) === item) {
      item.menuOpen = true
      this.listener?.menu(item.key, menu, { x, y })
    }
  }

  private scheduleMenuUpdate(item: Item): void {
    if (item.menuTimer !== undefined) {
      return
    }
    item.menuTimer = setTimeout(async () => {
      item.menuTimer = undefined
      const menu = await this.readMenu(item)
      if (menu !== undefined && item.menuOpen && this.items.get(item.key) === item) {
        this.listener?.menu(item.key, menu, undefined)
      }
    }, REFRESH_DELAY_MS)
  }

  /** Whether the app says the menu (below `entry`) changed. */
  private async aboutToShow(item: Item, entry: number): Promise<boolean> {
    try {
      const [needUpdate] = await this.connection!.call(
        item.owner,
        item.menuPath!,
        MENU_IFACE,
        'AboutToShow',
        'i',
        [entry],
        ITEM_CALL_TIMEOUT_MS,
      )
      return needUpdate === true
    } catch {
      // optional
      return false
    }
  }

  private menuEvent(item: Item, entry: number, event: 'clicked' | 'opened' | 'closed'): void {
    this.connection
      ?.call(
        item.owner,
        item.menuPath!,
        MENU_IFACE,
        'Event',
        'isvu',
        [entry, event, new Variant('i', 0), Math.floor(Date.now() / 1000) >>> 0],
        ITEM_CALL_TIMEOUT_MS,
      )
      .catch((e: Error) => {
        if (!(e instanceof DBusError && e.type === UNKNOWN_METHOD)) {
          logger.info(`Menu event ${event} on ${item.key} failed: ${e.message}`)
        }
      })
  }

  private async readMenu(item: Item): Promise<TrayMenuEntry[] | undefined> {
    try {
      const [, layout] = await this.connection!.call(
        item.owner,
        item.menuPath!,
        MENU_IFACE,
        'GetLayout',
        'iias',
        [0, -1, []],
        ITEM_CALL_TIMEOUT_MS,
      )
      const budget = { entries: MAX_MENU_ENTRIES }
      return this.menuChildren(layout, 0, budget)
    } catch (e: any) {
      logger.info(`Reading the menu of ${item.key} failed: ${e.message}`)
      return undefined
    }
  }

  /** The children of a layout node (id, properties, children as variants), visible ones only. */
  private menuChildren(node: unknown, depth: number, budget: { entries: number }): TrayMenuEntry[] {
    if (!Array.isArray(node) || !Array.isArray(node[2]) || depth >= MAX_MENU_DEPTH) {
      return []
    }
    const entries: TrayMenuEntry[] = []
    for (const child of node[2] as unknown[]) {
      const value = child instanceof Variant ? child.value : child
      if (!Array.isArray(value) || typeof value[0] !== 'number' || budget.entries-- <= 0) {
        continue
      }
      const id = value[0]
      const properties: Record<string, unknown> = {}
      for (const [key, property] of Object.entries((value[1] ?? {}) as Record<string, unknown>)) {
        properties[key] = property instanceof Variant ? property.value : property
      }
      if (properties.visible === false) {
        continue
      }
      if (properties.type === 'separator') {
        entries.push({ id, separator: true })
        continue
      }
      const entry: TrayMenuEntry = {
        id,
        label: stripMnemonics(typeof properties.label === 'string' ? properties.label : '').slice(0, 200),
        enabled: properties.enabled !== false,
      }
      if (properties['toggle-type'] === 'checkmark' || properties['toggle-type'] === 'radio') {
        entry.toggle = properties['toggle-type']
        entry.checked = properties['toggle-state'] === 1
      }
      const iconData = properties['icon-data']
      if (Buffer.isBuffer(iconData) && iconData.length > 8 && iconData.length <= MAX_MENU_ICON_BYTES) {
        if (iconData.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
          entry.icon = `data:image/png;base64,${iconData.toString('base64')}`
        }
      } else if (typeof properties['icon-name'] === 'string' && properties['icon-name']) {
        entry.icon = this.environment.icons.resolve(properties['icon-name']) ?? undefined
      }
      if (properties['children-display'] === 'submenu' || (value[2] as unknown[] | undefined)?.length) {
        entry.children = this.menuChildren(value, depth + 1, budget)
      }
      entries.push(entry)
    }
    // no separators at the ends or next to each other (hidden entries leave them behind)
    const tidy: TrayMenuEntry[] = []
    for (const entry of entries) {
      if (!('separator' in entry) || (tidy.length > 0 && !('separator' in tidy[tidy.length - 1]))) {
        tidy.push(entry)
      }
    }
    if (tidy.length > 0 && 'separator' in tidy[tidy.length - 1]) {
      tidy.pop()
    }
    return tidy
  }
}
