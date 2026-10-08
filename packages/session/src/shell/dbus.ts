/**
 * A small, low-level D-Bus connection for the session's own services: method calls with explicit signatures, signal
 * subscriptions by match rule, objects exported as plain method handlers, and signals sent. Nothing is introspected.
 *
 * It's deliberately the only place the system tray (tray.ts) touches the D-Bus library: replacing `dbus-next` with an
 * sd_bus addon (ROADMAP) means reimplementing this module, keeping its value mapping:
 *   - integers and doubles (y n q i u d) are numbers, b a boolean, s o g strings; 64-bit integers aren't used;
 *   - ay is a Buffer;
 *   - other arrays are arrays, structs are arrays of their fields;
 *   - a{..} dictionaries are plain objects keyed by the (string or number) key;
 *   - v is a `Variant` (signature and value), in both directions.
 */
import * as dbus from 'dbus-next'

export const Variant = dbus.Variant
export type Variant<T = unknown> = dbus.Variant<T>

export const DBUS_NAME = 'org.freedesktop.DBus'
const DBUS_PATH = '/org/freedesktop/DBus'
/** Calls are given up after this long (a hung app must not keep us waiting forever). */
const CALL_TIMEOUT_MS = 25_000

/** An error reply, received or to be sent. */
export class DBusError extends Error {
  constructor(
    /** the error name, e.g. org.freedesktop.DBus.Error.UnknownMethod */
    readonly type: string,
    message: string,
  ) {
    super(message)
  }
}

export const UNKNOWN_METHOD = 'org.freedesktop.DBus.Error.UnknownMethod'
export const INVALID_ARGS = 'org.freedesktop.DBus.Error.InvalidArgs'

/** A received method call or signal. */
export type IncomingMessage = {
  /** the sender's unique name */
  sender: string
  path: string
  interface: string
  member: string
  signature: string
  body: unknown[]
}

/** What a method handler answers: a reply (signature and body), or a DBusError thrown. */
export type MethodReply = { signature: string; body: unknown[] }

/** Handles the method calls to an exported path; undefined: no such method (UnknownMethod is answered). */
export type MethodHandler = (call: IncomingMessage) => MethodReply | undefined

/** A match rule (only the keys we use); every given key must match. */
export type MatchRule = { sender?: string; path?: string; interface?: string; member?: string; arg0?: string }

/** RequestName's answers */
export const PRIMARY_OWNER = 1
export const IN_QUEUE = 2

export class DBusConnection {
  private readonly signalHandlers = new Set<{ rule: MatchRule; handler: (message: IncomingMessage) => void }>()
  private readonly exported = new Map<string, MethodHandler>()

  private constructor(
    private readonly bus: dbus.MessageBus,
    /** our unique name */
    readonly uniqueName: string,
  ) {
    bus.on('message', (message: dbus.Message) => {
      if (message.type === dbus.MessageType.SIGNAL) {
        this.dispatchSignal(toIncoming(message))
      }
    })
    bus.addMethodHandler((message: dbus.Message) => this.handleCall(message))
  }

  /** Connects to the session bus (DBUS_SESSION_BUS_ADDRESS). */
  static session(onError: (e: Error) => void): Promise<DBusConnection> {
    return new Promise((resolve, reject) => {
      const bus = dbus.sessionBus()
      let connected = false
      bus.on('error', (e: Error) => (connected ? onError(e) : reject(e)))
      bus.on('connect', () => {
        connected = true
        resolve(new DBusConnection(bus, (bus as unknown as { name: string }).name))
      })
    })
  }

  close(): void {
    this.bus.disconnect()
  }

  /** Calls a method; resolves with the reply's body, rejects with a DBusError (or a timeout). */
  async call(
    destination: string,
    path: string,
    iface: string,
    member: string,
    signature = '',
    body: unknown[] = [],
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<unknown[]> {
    const message = new dbus.Message({ destination, path, interface: iface, member, signature, body })
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new DBusError('org.freedesktop.DBus.Error.NoReply', `${member} on ${destination} timed out`)),
        timeoutMs,
      )
    })
    try {
      const reply = await Promise.race([this.bus.call(message), timeout])
      return reply?.body ?? []
    } catch (e: any) {
      if (e instanceof dbus.DBusError) {
        throw new DBusError(e.type, e.text)
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  /** org.freedesktop.DBus.Properties.Get, the variant unwrapped. */
  async getProperty(destination: string, path: string, iface: string, name: string): Promise<unknown> {
    const [value] = await this.call(destination, path, 'org.freedesktop.DBus.Properties', 'Get', 'ss', [iface, name])
    return value instanceof dbus.Variant ? value.value : value
  }

  /** org.freedesktop.DBus.Properties.GetAll, the variants unwrapped. */
  async getAllProperties(destination: string, path: string, iface: string): Promise<Record<string, unknown>> {
    const [values] = await this.call(destination, path, 'org.freedesktop.DBus.Properties', 'GetAll', 's', [iface])
    const properties: Record<string, unknown> = {}
    for (const [key, value] of Object.entries((values ?? {}) as Record<string, unknown>)) {
      properties[key] = value instanceof dbus.Variant ? value.value : value
    }
    return properties
  }

  /** RequestName: PRIMARY_OWNER, IN_QUEUE, ... */
  async requestName(name: string, flags = 0): Promise<number> {
    const [reply] = await this.call(DBUS_NAME, DBUS_PATH, DBUS_NAME, 'RequestName', 'su', [name, flags])
    return reply as number
  }

  /** The unique name owning `name`, undefined if it has none. */
  async nameOwner(name: string): Promise<string | undefined> {
    try {
      const [owner] = await this.call(DBUS_NAME, DBUS_PATH, DBUS_NAME, 'GetNameOwner', 's', [name])
      return owner as string
    } catch (e) {
      if (e instanceof DBusError && e.type === 'org.freedesktop.DBus.Error.NameHasNoOwner') {
        return undefined
      }
      throw e
    }
  }

  /** The pid of a connection (by unique name), undefined if the bus doesn't say. */
  async processId(name: string): Promise<number | undefined> {
    try {
      const [pid] = await this.call(DBUS_NAME, DBUS_PATH, DBUS_NAME, 'GetConnectionUnixProcessID', 's', [name])
      return typeof pid === 'number' ? pid : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Calls `handler` for the signals matching `rule` (an AddMatch on the bus, and the same filter here). Returns the
   * unsubscribe function. `sender` must be a unique name: signals carry their sender's.
   */
  async subscribe(rule: MatchRule, handler: (message: IncomingMessage) => void): Promise<() => void> {
    const text = matchRuleText(rule)
    await this.call(DBUS_NAME, DBUS_PATH, DBUS_NAME, 'AddMatch', 's', [text])
    const entry = { rule, handler }
    this.signalHandlers.add(entry)
    return () => {
      if (this.signalHandlers.delete(entry)) {
        this.call(DBUS_NAME, DBUS_PATH, DBUS_NAME, 'RemoveMatch', 's', [text]).catch(() => {})
      }
    }
  }

  /** Answers the method calls to `path` with `handler` (and org.freedesktop.DBus.Peer.Ping by itself). */
  export(path: string, handler: MethodHandler): void {
    this.exported.set(path, handler)
  }

  emitSignal(path: string, iface: string, member: string, signature = '', body: unknown[] = []): void {
    this.bus.send(dbus.Message.newSignal(path, iface, member, signature, body))
  }

  private dispatchSignal(message: IncomingMessage): void {
    for (const { rule, handler } of [...this.signalHandlers]) {
      if (
        (rule.sender === undefined || rule.sender === message.sender) &&
        (rule.path === undefined || rule.path === message.path) &&
        (rule.interface === undefined || rule.interface === message.interface) &&
        (rule.member === undefined || rule.member === message.member) &&
        (rule.arg0 === undefined || rule.arg0 === message.body[0])
      ) {
        handler(message)
      }
    }
  }

  private handleCall(message: dbus.Message): boolean {
    const handler = this.exported.get(message.path)
    if (handler === undefined) {
      return false
    }
    const incoming = toIncoming(message)
    let reply: MethodReply | undefined
    try {
      reply = handler(incoming)
      if (reply === undefined && incoming.interface === 'org.freedesktop.DBus.Peer' && incoming.member === 'Ping') {
        reply = { signature: '', body: [] }
      }
    } catch (e: any) {
      const error = e instanceof DBusError ? e : new DBusError('org.freedesktop.DBus.Error.Failed', String(e?.message))
      this.bus.send(dbus.Message.newError(message as never, error.type, error.message))
      return true
    }
    if (reply === undefined) {
      this.bus.send(
        dbus.Message.newError(
          message as never,
          UNKNOWN_METHOD,
          `No method ${message.member} on ${message.interface || '(none)'} at ${message.path}`,
        ),
      )
    } else if (!(message.flags & dbus.MessageFlag.NO_REPLY_EXPECTED)) {
      this.bus.send(dbus.Message.newMethodReturn(message, reply.signature, reply.body))
    }
    return true
  }
}

function toIncoming(message: dbus.Message): IncomingMessage {
  return {
    sender: message.sender,
    path: message.path,
    interface: message.interface ?? '',
    member: message.member,
    signature: message.signature ?? '',
    body: message.body ?? [],
  }
}

function matchRuleText(rule: MatchRule): string {
  const parts = ['type=signal']
  for (const [key, value] of Object.entries(rule)) {
    if (value !== undefined) {
      parts.push(`${key}='${value.replace(/'/g, "'\\''")}'`)
    }
  }
  return parts.join(',')
}
