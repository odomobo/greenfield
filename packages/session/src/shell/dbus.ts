/**
 * A small, low-level D-Bus connection for the session's own services: method calls with explicit signatures, signal
 * subscriptions by match rule, objects exported as plain method handlers, and signals sent. Nothing is introspected.
 *
 * It's the only place the session touches D-Bus: sd_bus (libsystemd) in the nebula-dbus-addon (native/dbus), which
 * converts between JS values and messages by the signature:
 *   - integers and doubles (y n q i u x t d) are numbers (64-bit integers lose precision past 2^53), b a boolean,
 *     s o g strings;
 *   - ay is a Buffer (any Uint8Array, or an array of numbers, when sending);
 *   - other arrays are arrays, structs are arrays of their fields;
 *   - a{..} dictionaries are plain objects keyed by the (string or number) key;
 *   - v is a `Variant` (signature and value), in both directions.
 */

/** A value of type v: its signature and the value. */
export class Variant<T = unknown> {
  constructor(
    readonly signature: string,
    readonly value: T,
  ) {}
}

/** The nebula-dbus-addon's functions (native/dbus/src/dbus.c). */
type Bus = { readonly __bus: unique symbol }
type ReceivedCall = { readonly __call: unique symbol }
type DBusAddon = {
  setVariantClass(constructor: typeof Variant): void
  /** onMessage says whether it handled a method call (sd_bus answers the others); onClose: the connection broke. */
  openSessionBus(
    onMessage: (
      isCall: boolean,
      sender: string,
      path: string,
      iface: string,
      member: string,
      signature: string,
      body: unknown[],
      call: ReceivedCall | undefined,
    ) => boolean,
    onClose: (error: string) => void,
  ): Bus
  /** Known once a reply came. */
  uniqueName(bus: Bus): string
  call(
    bus: Bus,
    destination: string,
    path: string,
    iface: string,
    member: string,
    signature: string,
    body: unknown[],
    timeoutMs: number,
    callback: (errorName: string | null, errorMessage: string | null, body: unknown[] | null) => void,
  ): void
  emitSignal(bus: Bus, path: string, iface: string, member: string, signature: string, body: unknown[]): void
  reply(bus: Bus, call: ReceivedCall, signature: string, body: unknown[]): void
  replyError(bus: Bus, call: ReceivedCall, name: string, message: string): void
  /** Sends what's queued, then closes; pending calls are forgotten. */
  close(bus: Bus): void
}

let addon: DBusAddon | undefined

function loadAddon(): DBusAddon {
  if (addon === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    addon = require('../addons/nebula-dbus-addon') as DBusAddon
    addon.setVariantClass(Variant)
  }
  return addon
}

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
export const ALREADY_OWNER = 4

export class DBusConnection {
  private readonly signalHandlers = new Set<{ rule: MatchRule; handler: (message: IncomingMessage) => void }>()
  private readonly exported = new Map<string, MethodHandler>()
  /** the calls waiting for replies, rejected when the connection goes */
  private readonly pending = new Set<(error: Error) => void>()
  private bus?: Bus
  /** our unique name */
  uniqueName = ''

  private constructor(private readonly onError: (e: Error) => void) {}

  /** Connects to the session bus (DBUS_SESSION_BUS_ADDRESS). */
  static async session(onError: (e: Error) => void): Promise<DBusConnection> {
    const connection = new DBusConnection(onError)
    connection.bus = loadAddon().openSessionBus(
      (isCall, sender, path, iface, member, signature, body, call) => {
        const message = { sender, path, interface: iface, member, signature, body }
        if (!isCall) {
          connection.dispatchSignal(message)
          return false
        }
        return connection.handleCall(message, call!)
      },
      (error) => connection.closed(new Error(`D-Bus connection lost: ${error}`)),
    )
    try {
      // the first reply comes after the bus's Hello, which gave us our name
      await connection.call(DBUS_NAME, DBUS_PATH, 'org.freedesktop.DBus.Peer', 'Ping')
      connection.uniqueName = loadAddon().uniqueName(connection.bus!)
    } catch (e) {
      connection.close()
      throw e
    }
    return connection
  }

  close(): void {
    if (this.bus !== undefined) {
      loadAddon().close(this.bus)
      this.bus = undefined
      this.rejectPending(new DBusError('org.freedesktop.DBus.Error.Disconnected', 'the D-Bus connection was closed'))
    }
  }

  /** Calls a method; resolves with the reply's body, rejects with a DBusError (or a timeout). */
  call(
    destination: string,
    path: string,
    iface: string,
    member: string,
    signature = '',
    body: unknown[] = [],
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      if (this.bus === undefined) {
        reject(new DBusError('org.freedesktop.DBus.Error.Disconnected', 'the D-Bus connection is closed'))
        return
      }
      loadAddon().call(
        this.bus,
        destination,
        path,
        iface,
        member,
        signature,
        body,
        timeoutMs,
        (errorName, errorMessage, replyBody) => {
          this.pending.delete(reject)
          if (errorName !== null) {
            reject(new DBusError(errorName, errorMessage ?? ''))
          } else {
            resolve(replyBody ?? [])
          }
        },
      )
      // (not before: a body that doesn't match the signature throws, and that's the only answer)
      this.pending.add(reject)
    })
  }

  /** org.freedesktop.DBus.Properties.Get, the variant unwrapped. */
  async getProperty(destination: string, path: string, iface: string, name: string): Promise<unknown> {
    const [value] = await this.call(destination, path, 'org.freedesktop.DBus.Properties', 'Get', 'ss', [iface, name])
    return value instanceof Variant ? value.value : value
  }

  /** org.freedesktop.DBus.Properties.GetAll, the variants unwrapped. */
  async getAllProperties(destination: string, path: string, iface: string): Promise<Record<string, unknown>> {
    const [values] = await this.call(destination, path, 'org.freedesktop.DBus.Properties', 'GetAll', 's', [iface])
    const properties: Record<string, unknown> = {}
    for (const [key, value] of Object.entries((values ?? {}) as Record<string, unknown>)) {
      properties[key] = value instanceof Variant ? value.value : value
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
      if (this.signalHandlers.delete(entry) && this.bus !== undefined) {
        this.call(DBUS_NAME, DBUS_PATH, DBUS_NAME, 'RemoveMatch', 's', [text]).catch(() => {})
      }
    }
  }

  /** Answers the method calls to `path` with `handler` (and org.freedesktop.DBus.Peer.Ping by itself). */
  export(path: string, handler: MethodHandler): void {
    this.exported.set(path, handler)
  }

  emitSignal(path: string, iface: string, member: string, signature = '', body: unknown[] = []): void {
    if (this.bus !== undefined) {
      loadAddon().emitSignal(this.bus, path, iface, member, signature, body)
    }
  }

  private closed(error: Error): void {
    this.bus = undefined
    this.rejectPending(new DBusError('org.freedesktop.DBus.Error.Disconnected', error.message))
    this.onError(error)
  }

  private rejectPending(error: Error): void {
    const pending = [...this.pending]
    this.pending.clear()
    for (const reject of pending) {
      reject(error)
    }
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

  /** Whether the call was ours (to an exported path): then it's answered here. */
  private handleCall(message: IncomingMessage, call: ReceivedCall): boolean {
    const handler = this.exported.get(message.path)
    const bus = this.bus
    if (handler === undefined || bus === undefined) {
      return false
    }
    const native = loadAddon()
    let reply: MethodReply | undefined
    try {
      reply = handler(message)
      if (reply === undefined && message.interface === 'org.freedesktop.DBus.Peer' && message.member === 'Ping') {
        reply = { signature: '', body: [] }
      }
      if (reply === undefined) {
        throw new DBusError(
          UNKNOWN_METHOD,
          `No method ${message.member} on ${message.interface || '(none)'} at ${message.path}`,
        )
      }
      // (sd_bus doesn't send it if the caller expects no reply)
      native.reply(bus, call, reply.signature, reply.body)
    } catch (e: any) {
      const error = e instanceof DBusError ? e : new DBusError('org.freedesktop.DBus.Error.Failed', String(e?.message))
      native.replyError(bus, call, error.type, error.message)
    }
    return true
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
