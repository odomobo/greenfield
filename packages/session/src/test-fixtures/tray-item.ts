/**
 * Test fixtures for the system tray (tray.ts): an app's tray item (a StatusNotifierItem with a dbusmenu menu) and a
 * minimal StatusNotifierWatcher of someone else's, both on the session bus (DBUS_SESSION_BUS_ADDRESS).
 *
 * Also a program for the end-to-end test (scripts/e2e/tray.sh):
 *   node tray-item.js <events file> [title]
 * puts up an item and appends to the events file "started <pid>", then what it's asked to do, one line each
 * ("Activate 10 20", "Event 1 clicked", ...). SIGUSR1: it needs attention (another icon); SIGUSR2: its menu gets
 * another entry; SIGTERM: it exits (and its item goes with its bus connection).
 */
import { appendFileSync } from 'node:fs'
import { DBUS_NAME, DBusConnection, IncomingMessage, MethodReply, PRIMARY_OWNER, Variant } from '../shell/dbus'

const WATCHER_NAME = 'org.kde.StatusNotifierWatcher'
const WATCHER_PATH = '/StatusNotifierWatcher'
const WATCHER_IFACE = 'org.kde.StatusNotifierWatcher'
const ITEM_IFACE = 'org.kde.StatusNotifierItem'
const MENU_IFACE = 'com.canonical.dbusmenu'
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties'
export const ITEM_PATH = '/org/ayatana/NotificationItem/test_item'
export const MENU_PATH = '/MenuBar'

/** A square ARGB32 (network byte order) pixmap of one color. */
export function solidPixmap(size: number, [a, r, g, b]: [number, number, number, number]): [number, number, Buffer] {
  const data = Buffer.alloc(size * size * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = a
    data[i + 1] = r
    data[i + 2] = g
    data[i + 3] = b
  }
  return [size, size, data]
}

type MenuNode = { id: number; properties: Record<string, Variant>; children: MenuNode[] }

const entry = (id: number, properties: Record<string, Variant> = {}, children: MenuNode[] = []): MenuNode => ({
  id,
  properties,
  children,
})
const label = (text: string) => new Variant('s', text)

function defaultMenu(): MenuNode {
  return entry(0, { 'children-display': new Variant('s', 'submenu') }, [
    entry(1, { label: label('Open _Window') }),
    entry(2, {
      label: label('Enabled'),
      'toggle-type': new Variant('s', 'checkmark'),
      'toggle-state': new Variant('i', 1),
    }),
    entry(3, { type: new Variant('s', 'separator') }),
    entry(4, { label: label('More'), 'children-display': new Variant('s', 'submenu') }, [
      entry(5, { label: label('Sub entry') }),
    ]),
    entry(6, { label: label('Disabled'), enabled: new Variant('b', false) }),
    entry(7, { label: label('Hidden'), visible: new Variant('b', false) }),
    entry(8, { label: label('_Quit') }),
  ])
}

function layoutValue(node: MenuNode): unknown[] {
  return [node.id, node.properties, node.children.map((child) => new Variant('(ia{sv}av)', layoutValue(child)))]
}

export class TestTrayItem {
  readonly events: string[] = []
  onEvent?: (event: string) => void
  status = 'Active'
  menu = defaultMenu()
  private revision = 1
  private unsubscribe?: () => void

  private constructor(
    readonly connection: DBusConnection,
    readonly title: string,
    /** register with the object path (as libappindicator does) or with the bus name */
    private readonly registerBy: 'path' | 'name',
  ) {}

  /** Puts the item up and registers it with the watcher, now and whenever a new watcher comes. */
  static async start(title = 'Test Tray', registerBy: 'path' | 'name' = 'path'): Promise<TestTrayItem> {
    const connection = await DBusConnection.session(() => {})
    const item = new TestTrayItem(connection, title, registerBy)
    connection.export(item.path, (call) => item.itemCall(call))
    connection.export(MENU_PATH, (call) => item.menuCall(call))
    item.unsubscribe = await connection.subscribe(
      { sender: DBUS_NAME, interface: DBUS_NAME, member: 'NameOwnerChanged', arg0: WATCHER_NAME },
      (message) => {
        if (message.body[2]) {
          item.register().catch(() => {})
        }
      },
    )
    await item.register().catch(() => {})
    return item
  }

  get path(): string {
    return this.registerBy === 'path' ? ITEM_PATH : '/StatusNotifierItem'
  }

  /** The watcher's id for it. */
  get key(): string {
    return this.connection.uniqueName + this.path
  }

  async register(): Promise<void> {
    const service = this.registerBy === 'path' ? ITEM_PATH : this.connection.uniqueName
    await this.connection.call(WATCHER_NAME, WATCHER_PATH, WATCHER_IFACE, 'RegisterStatusNotifierItem', 's', [service])
  }

  needAttention(): void {
    this.status = 'NeedsAttention'
    this.connection.emitSignal(this.path, ITEM_IFACE, 'NewStatus', 's', [this.status])
  }

  addMenuEntry(id: number, text: string): void {
    this.menu.children.push(entry(id, { label: label(text) }))
    this.revision++
    this.connection.emitSignal(MENU_PATH, MENU_IFACE, 'LayoutUpdated', 'ui', [this.revision, 0])
  }

  close(): void {
    this.unsubscribe?.()
    this.connection.close()
  }

  private record(event: string): void {
    this.events.push(event)
    this.onEvent?.(event)
  }

  private itemCall(call: IncomingMessage): MethodReply | undefined {
    if (call.interface === PROPERTIES_IFACE && call.member === 'GetAll') {
      return { signature: 'a{sv}', body: [call.body[0] === ITEM_IFACE ? this.properties() : {}] }
    }
    if (call.interface === PROPERTIES_IFACE && call.member === 'Get') {
      return { signature: 'v', body: [this.properties()[String(call.body[1])]] }
    }
    if (['Activate', 'SecondaryActivate', 'ContextMenu', 'Scroll'].includes(call.member)) {
      this.record(`${call.member} ${call.body.join(' ')}`)
      return { signature: '', body: [] }
    }
    return undefined
  }

  private properties(): Record<string, Variant> {
    return {
      Category: new Variant('s', 'ApplicationStatus'),
      Id: new Variant('s', 'test-tray'),
      Title: new Variant('s', this.title),
      Status: new Variant('s', this.status),
      // red; blue when it needs attention
      IconName: new Variant('s', ''),
      IconPixmap: new Variant('a(iiay)', [solidPixmap(16, [255, 255, 0, 0]), solidPixmap(32, [255, 255, 0, 0])]),
      AttentionIconName: new Variant('s', ''),
      AttentionIconPixmap: new Variant('a(iiay)', [solidPixmap(32, [255, 0, 0, 255])]),
      ToolTip: new Variant('(sa(iiay)ss)', ['', [], `${this.title} tip`, 'Tooltip <b>body</b> &amp; more']),
      ItemIsMenu: new Variant('b', false),
      Menu: new Variant('o', MENU_PATH),
    }
  }

  private menuCall(call: IncomingMessage): MethodReply | undefined {
    switch (call.member) {
      case 'GetLayout':
        return { signature: 'u(ia{sv}av)', body: [this.revision, layoutValue(this.menu)] }
      case 'AboutToShow':
        this.record(`AboutToShow ${call.body[0]}`)
        return { signature: 'b', body: [false] }
      case 'Event':
        this.record(`Event ${call.body[0]} ${call.body[1]}`)
        return { signature: '', body: [] }
    }
    return undefined
  }
}

/** Someone else's StatusNotifierWatcher (the user's Plasma, say): items and hosts register with it. */
export class TestWatcher {
  readonly items: string[] = []
  readonly hosts: string[] = []

  private constructor(readonly connection: DBusConnection) {}

  static async start(): Promise<TestWatcher> {
    const connection = await DBusConnection.session(() => {})
    const watcher = new TestWatcher(connection)
    connection.export(WATCHER_PATH, (call) => watcher.call(call))
    if ((await connection.requestName(WATCHER_NAME, 4 /* DO_NOT_QUEUE */)) !== PRIMARY_OWNER) {
      connection.close()
      throw new Error('the watcher name is taken')
    }
    return watcher
  }

  close(): void {
    this.connection.close()
  }

  private call(call: IncomingMessage): MethodReply | undefined {
    if (call.member === 'RegisterStatusNotifierItem') {
      const service = String(call.body[0])
      const key = service.startsWith('/') ? call.sender + service : service
      this.items.push(key)
      this.connection.emitSignal(WATCHER_PATH, WATCHER_IFACE, 'StatusNotifierItemRegistered', 's', [key])
      return { signature: '', body: [] }
    }
    if (call.member === 'RegisterStatusNotifierHost') {
      this.hosts.push(String(call.body[0]))
      return { signature: '', body: [] }
    }
    if (call.interface === PROPERTIES_IFACE && call.member === 'Get') {
      return { signature: 'v', body: [new Variant('as', this.items)] }
    }
    return undefined
  }
}

if (require.main === module) {
  const [eventsFile, title] = process.argv.slice(2)
  TestTrayItem.start(title || 'Test Tray').then((item) => {
    item.onEvent = (event) => appendFileSync(eventsFile, event + '\n')
    let added = 100
    process.on('SIGUSR1', () => item.needAttention())
    process.on('SIGUSR2', () => item.addMenuEntry(added++, `Added ${added - 100}`))
    process.on('SIGTERM', () => {
      item.close()
      process.exit(0)
    })
    appendFileSync(eventsFile, `started ${process.pid}\n`)
  })
}
