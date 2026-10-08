/**
 * The login protocol's records, the TypeScript side of `packages/login/protocol` (the byte layout is documented there,
 * in src/lib.rs): a session receives `Handover` records on its inherited `desktop.sock` listener (the web front, in
 * Rust, speaks the rest on `login.sock`; the other records are here for the tests that check the shared layout). Some records carry an fd (a connection), so these sockets are
 * raw fds driven through the fd-passing functions of the compositor proxy's small poll addon.
 */
import { isIPv4, isIPv6 } from 'node:net'

export const HEADER_LEN = 4
export const ADDRESS_LEN = 18
export const MAX_USERNAME = 256
export const MAX_PROMPT = 512
export const MAX_ANSWER = 1024
export const MAX_RESULT_TEXT = 256
export const MAX_RECORD = HEADER_LEN + MAX_ANSWER

export const enum Kind {
  ClientAddress = 1,
  Begin = 2,
  Prompt = 3,
  Answer = 4,
  Result = 5,
  Handover = 6,
}

export const enum PromptStyle {
  EchoOff = 1,
  EchoOn = 2,
  Info = 3,
  Error = 4,
}

export const enum Outcome {
  SignedIn = 0,
  Refused = 1,
  Failed = 2,
}

export type LoginRecord =
  | { kind: Kind.ClientAddress; address: string }
  | { kind: Kind.Begin; username: string }
  | { kind: Kind.Prompt; style: PromptStyle; text: string }
  | { kind: Kind.Answer; text: string }
  | { kind: Kind.Result; outcome: Outcome; text: string }
  | { kind: Kind.Handover; address: string }

/** Whether a record carries an fd: a signed-in Result and a Handover. */
export function carriesFd(record: LoginRecord): boolean {
  return (record.kind === Kind.Result && record.outcome === Outcome.SignedIn) || record.kind === Kind.Handover
}

// --- addresses ---

/** An IP address as 16 bytes (IPv4 in the first 4). Throws if it isn't one. */
function addressBytes(address: string): { family: 4 | 6; bytes: Buffer } {
  const bytes = Buffer.alloc(16)
  if (isIPv4(address)) {
    address.split('.').forEach((part, i) => (bytes[i] = Number(part)))
    return { family: 4, bytes }
  }
  if (!isIPv6(address)) {
    throw new Error(`not an IP address: ${address}`)
  }
  let text = address.split('%')[0]
  // an embedded IPv4 address (::ffff:1.2.3.4) as two groups
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number)
    text = text.slice(0, v4.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, undefined]
  const headGroups = head === '' ? [] : head.split(':')
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':')
  const groups =
    tail === undefined
      ? headGroups
      : [...headGroups, ...new Array(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups]
  groups.forEach((group, i) => bytes.writeUInt16BE(parseInt(group, 16), i * 2))
  return { family: 6, bytes }
}

/** The text of an address: dotted IPv4, or IPv6 with the longest run of zero groups compressed (RFC 5952). */
function addressText(family: number, bytes: Buffer): string {
  if (family === 4) {
    return [...bytes.subarray(0, 4)].join('.')
  }
  const groups = [...Array(8)].map((_, i) => bytes.readUInt16BE(i * 2))
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `::ffff:${[...bytes.subarray(12, 16)].join('.')}`
  }
  let bestStart = -1
  let bestLength = 1
  for (let i = 0; i < 8; ) {
    let j = i
    while (j < 8 && groups[j] === 0) j++
    if (j - i > bestLength) {
      bestStart = i
      bestLength = j - i
    }
    i = j === i ? i + 1 : j
  }
  const hex = groups.map((g) => g.toString(16))
  if (bestStart < 0) {
    return hex.join(':')
  }
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`
}

// --- records ---

function textBytes(text: string, limit: number): Buffer {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length > limit) {
    throw new Error('text over its limit')
  }
  return bytes
}

/** A record's bytes. Throws if a text is over its limit or an address isn't one. */
export function encodeRecord(record: LoginRecord): Buffer {
  let payload: Buffer
  switch (record.kind) {
    case Kind.ClientAddress:
    case Kind.Handover: {
      const { family, bytes } = addressBytes(record.address)
      payload = Buffer.alloc(ADDRESS_LEN)
      payload[0] = family
      bytes.copy(payload, 2, 0, family === 4 ? 4 : 16)
      break
    }
    case Kind.Begin:
      payload = textBytes(record.username, MAX_USERNAME)
      break
    case Kind.Answer:
      payload = textBytes(record.text, MAX_ANSWER)
      break
    case Kind.Prompt:
      payload = Buffer.concat([Buffer.from([record.style]), textBytes(record.text, MAX_PROMPT)])
      break
    case Kind.Result:
      payload = Buffer.concat([Buffer.from([record.outcome]), textBytes(record.text, MAX_RESULT_TEXT)])
      break
  }
  const header = Buffer.from([record.kind, 0, payload.length >> 8, payload.length & 0xff])
  return Buffer.concat([header, payload])
}

const decoder = new TextDecoder('utf-8', { fatal: true })

/**
 * One record from the start of `bytes` and its size; 'incomplete' if more bytes are needed. Throws on anything
 * malformed (as soon as the header shows it, so a reader never buffers more than MAX_RECORD).
 */
export function decodeRecord(bytes: Buffer): { record: LoginRecord; size: number } | 'incomplete' {
  if (bytes.length < HEADER_LEN) {
    return 'incomplete'
  }
  const kind = bytes[0]
  if (bytes[1] !== 0) {
    throw new Error('reserved byte not 0')
  }
  const length = bytes.readUInt16BE(2)
  const limits: Record<number, [number, boolean]> = {
    [Kind.ClientAddress]: [ADDRESS_LEN, true],
    [Kind.Handover]: [ADDRESS_LEN, true],
    [Kind.Begin]: [MAX_USERNAME, false],
    [Kind.Prompt]: [1 + MAX_PROMPT, false],
    [Kind.Answer]: [MAX_ANSWER, false],
    [Kind.Result]: [1 + MAX_RESULT_TEXT, false],
  }
  const limit = limits[kind]
  if (limit === undefined) {
    throw new Error(`unknown record kind ${kind}`)
  }
  const minimum = kind === Kind.Prompt || kind === Kind.Result ? 1 : 0
  if (length > limit[0] || (limit[1] && length !== limit[0]) || length < minimum) {
    throw new Error(`invalid length ${length} for record kind ${kind}`)
  }
  if (bytes.length < HEADER_LEN + length) {
    return 'incomplete'
  }
  const payload = bytes.subarray(HEADER_LEN, HEADER_LEN + length)
  const text = (slice: Buffer) => decoder.decode(slice)
  const size = HEADER_LEN + length
  switch (kind) {
    case Kind.ClientAddress:
    case Kind.Handover: {
      const family = payload[0]
      if (payload[1] !== 0 || (family === 4 && payload.subarray(6).some((b) => b !== 0))) {
        throw new Error('reserved byte not 0')
      }
      if (family !== 4 && family !== 6) {
        throw new Error(`unknown address family ${family}`)
      }
      const address = addressText(family, payload.subarray(2))
      return { record: { kind, address }, size }
    }
    case Kind.Begin:
      return { record: { kind, username: text(payload) }, size }
    case Kind.Answer:
      return { record: { kind, text: text(payload) }, size }
    case Kind.Prompt: {
      const style = payload[0]
      if (style < PromptStyle.EchoOff || style > PromptStyle.Error) {
        throw new Error(`unknown prompt style ${style}`)
      }
      return { record: { kind, style, text: text(payload.subarray(1)) }, size }
    }
    default: {
      const outcome = payload[0]
      if (outcome > Outcome.Failed) {
        throw new Error(`unknown outcome ${outcome}`)
      }
      return { record: { kind: Kind.Result, outcome, text: text(payload.subarray(1)) }, size }
    }
  }
}

// --- a connection carrying records ---

/** The fd-passing functions of @gfld/compositor-proxy/dist/fd-passing.js (see its proxy-poll-addon.d.ts). */
type FdPassingModule = {
  startPoll(fd: number, onEvent: (status: number, events: number) => void): unknown
  stopPoll(handle: unknown): void
  unixConnect(path: string): number
  acceptConnection(listenFd: number): number
  sendWithFd(fd: number, data: Buffer, passFd: number): number
  receiveWithFds(fd: number, maxBytes: number): { data: Buffer; fds: number[] } | number
  setCloseOnExec(fd: number): number
  closeFd(fd: number): number
}
let fdPassingModule: FdPassingModule | undefined

/** The fd-passing functions (a lazy require: the addon is only needed by the processes that speak this protocol). */
export function fdPassing(): FdPassingModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  fdPassingModule ??= require('@gfld/compositor-proxy/dist/fd-passing.js') as FdPassingModule
  return fdPassingModule
}

const EAGAIN = 11
const MAX_BUFFERED = 4 * MAX_RECORD

/**
 * A Unix stream socket (a raw fd, owned from now on) carrying records. `read` delivers them one at a time, with the
 * fd a record carries; `write` sends one.
 */
export class RecordChannel {
  private buffer = Buffer.alloc(0)
  private readonly fds: number[] = []
  private poll?: unknown
  private broken = false
  private closed = false
  private waiting?: (result: { record: LoginRecord; fd?: number } | undefined) => void

  constructor(readonly fd: number) {
    this.poll = fdPassing().startPoll(fd, (status) => this.onReadable(status))
  }

  /** The next record (with its fd, if it is a kind that carries one); undefined on EOF, a malformed record or timeout. */
  read(timeoutMs: number): Promise<{ record: LoginRecord; fd?: number } | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(undefined), timeoutMs)
      const finish = (result: { record: LoginRecord; fd?: number } | undefined) => {
        clearTimeout(timer)
        this.waiting = undefined
        resolve(result)
      }
      this.waiting = finish
      this.deliver()
    })
  }

  /** Send a record (with `passFd` if it is a kind that carries one). False if it couldn't be sent. */
  write(record: LoginRecord, passFd = -1): boolean {
    if (this.closed) {
      return false
    }
    const bytes = encodeRecord(record)
    // records are small: one non-blocking send fits in any socket buffer
    return fdPassing().sendWithFd(this.fd, bytes, passFd) === bytes.length
  }

  /** Close the socket and any fds received but not handed out. */
  close() {
    if (this.closed) {
      return
    }
    this.closed = true
    const { stopPoll, closeFd } = fdPassing()
    if (this.poll !== undefined) {
      stopPoll(this.poll)
      this.poll = undefined
    }
    closeFd(this.fd)
    this.fds.splice(0).forEach((fd) => closeFd(fd))
    this.waiting?.(undefined)
  }

  private onReadable(status: number) {
    if (this.closed) {
      return
    }
    if (status < 0) {
      this.broken = true
    }
    while (!this.broken) {
      // a few records at most are ever waiting to be read (the peer waits for an answer)
      const room = MAX_BUFFERED - this.buffer.length
      if (room <= 0) {
        this.broken = true
        break
      }
      const received = fdPassing().receiveWithFds(this.fd, room)
      if (typeof received === 'number') {
        if (received !== -EAGAIN) {
          this.broken = true
        }
        break
      }
      this.fds.push(...received.fds)
      if (received.data.length === 0 || this.fds.length > 1) {
        // EOF, or more fds than one record carries
        this.broken = true
        break
      }
      this.buffer = Buffer.concat([this.buffer, received.data])
    }
    if (this.broken && this.poll !== undefined) {
      fdPassing().stopPoll(this.poll)
      this.poll = undefined
    }
    this.deliver()
  }

  private deliver() {
    if (this.waiting === undefined) {
      return
    }
    let decoded: ReturnType<typeof decodeRecord>
    try {
      decoded = decodeRecord(this.buffer)
    } catch {
      this.broken = true
      this.waiting(undefined)
      return
    }
    if (decoded === 'incomplete') {
      if (this.broken || this.closed) {
        this.waiting(undefined)
      }
      return
    }
    this.buffer = this.buffer.subarray(decoded.size)
    if (!carriesFd(decoded.record)) {
      this.waiting({ record: decoded.record })
      return
    }
    const fd = this.fds.shift()
    if (fd === undefined) {
      this.broken = true
      this.waiting(undefined)
      return
    }
    this.waiting({ record: decoded.record, fd })
  }
}
