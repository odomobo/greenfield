/**
 * The web process: everything network-facing, running unprivileged. TLS, the page, Origin checks, failed-sign-in
 * throttling, the viewer's static files, the sign-in conversation on the page's WebSocket, and relaying that same
 * WebSocket to the user's session process over a Unix socket once signed in.
 *
 * It is started one of two ways, each with its own sign-in backend (until step 5 of SIGNIN-ROADMAP.md removes the
 * monitor):
 *
 *   - by a login helper (packages/login; the dev helper for now), with options (see `usage`): the listening TCP
 *     socket as an inherited fd and the helper's `login.sock`. Each sign-in is a connection to login.sock speaking
 *     the login protocol (login-protocol.ts): the client's address, Begin, the helper's prompts relayed to the page and
 *     its answers back, and a Result that carries, on success, our end of a connection to the user's desktop;
 *   - by the monitor (main.js, PAM mode), without options: its `start` message (IPC) brings the listening socket and
 *     the TLS key. It knows users only through tickets the monitor hands out on successful authentication, and uses
 *     each ticket once, right away, to attach to (or start) the user's desktop, whose socket path it connects to.
 *
 * Signing in works like unlocking a screen: the page's one WebSocket (`/ws`) is the sign-in. The page signs in on it
 * (in-band, see "Sign-in" in libs/scene-protocol) and the same WebSocket then carries the desktop. There are no
 * tokens or cookies: when the WebSocket closes (tab closed, reloaded, network gone, another sign-in took the desktop
 * over), the page has to sign in again. The desktop behind it keeps running until the user logs out.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { IncomingMessage, ServerResponse } from 'node:http'
import { createServer as createHTTPSServer } from 'node:https'
import { hostname } from 'node:os'
import { connect, Server as NetServer, Socket } from 'node:net'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  CLOSE_SIGN_IN_FAILED,
  SIGN_IN_MAX_FRAME_BYTES,
  SignInClientMessage,
  SignInServerMessage,
} from '@gfld/scene-protocol'
import { MonitorReply, MonitorReplyEnvelope, WebRequest, WebStart } from './ipc'
import { log } from './log'
import { fdPassing, Kind, MAX_ANSWER, MAX_USERNAME, Outcome, PromptStyle, RecordChannel } from './login-protocol'
import { errorPage, escapeHTML } from './pages'
import { RateLimiter } from './rate-limit'
import { loadTLS } from './tls'

process.title = 'gateway-web'

/** (monitor backend; a login helper keeps the minimum itself) */
const MIN_FAILED_LOGIN_MS = 3000
/** the page sends its `begin` right after the upgrade */
const BEGIN_TIMEOUT_MS = 10_000
/** a person answers each prompt (a password now, a one-time code later) within this time */
const ANSWER_TIMEOUT_MS = 60_000
/** the monitor backend's limits (a login helper's are the protocol's) */
const MONITOR_MAX_USERNAME = 64
const MONITOR_MAX_ANSWER = 1024
/** a login helper answers within its own limits (the failure delay, starting a desktop) */
const HELPER_TIMEOUT_MS = 90_000
const TOO_MANY_FAILURES = 'Too many failed attempts. Try again in a few minutes.'
/** the prompt the password is asked with (the only one until PAM's own prompts are relayed) */
const PASSWORD_PROMPT = 'Password: '
const TCP_NOTSENT_LOWAT_BYTES = 32 * 1024
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const staticDir = path.resolve(__dirname, '../static')

/** What the web process serves with; `loginSocket` is set when a login helper started it. */
type WebSettings = Omit<WebStart, 'type'> & { loginSocket?: string }
let start!: WebSettings
// per IP, generously, since many users may share an address (NAT). No per-user throttling: per-account lockout is
// PAM's job (pam_faillock)
const ipFailures = new RateLimiter(20)

// --- monitor RPC ---

let nextSerial = 1
const pending = new Map<number, (reply: MonitorReply) => void>()

function monitor(request: WebRequest): Promise<MonitorReply> {
  return new Promise((resolve) => {
    const serial = nextSerial++
    pending.set(serial, resolve)
    process.send!({ serial, request })
  })
}

process.on('message', (message: any, handle: unknown) => {
  if (message?.type === 'start') {
    start = message as WebStart
    serve(handle as NetServer)
    return
  }
  const envelope = message as MonitorReplyEnvelope
  const resolve = pending.get(envelope.serial)
  if (resolve) {
    pending.delete(envelope.serial)
    resolve(envelope.reply)
  }
})
process.on('disconnect', () => process.exit(0))

// --- started by a login helper ---

const usage = `Usage: web.js --listen-fd <fd> --login-socket <path> [options]

Started by a login helper (packages/login), which passes these on from its own command line:
  --listen-fd <fd>           the listening TCP socket, inherited
  --login-socket <path>      the login helper's socket
  --cert <file> --key <file> TLS certificate and key (default: generate a self-signed one in the state dir)
  --state-dir <dir>          where the generated certificate is kept (default /var/lib/greenfield)
  --hide-hostname            don't show the host name on the sign-in page
  --allowed-origin <origin>  additionally accepted Origin (repeatable), e.g. https://desktop.example.com
`

async function startFromHelper(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      'listen-fd': { type: 'string' },
      'login-socket': { type: 'string' },
      cert: { type: 'string' },
      key: { type: 'string' },
      'state-dir': { type: 'string', default: '/var/lib/greenfield' },
      'hide-hostname': { type: 'boolean', default: false },
      'allowed-origin': { type: 'string', multiple: true, default: [] },
    },
  })
  const fd = Number(values['listen-fd'])
  if (!Number.isInteger(fd) || fd < 3 || values['login-socket'] === undefined) {
    throw new Error(`--listen-fd and --login-socket are required\n\n${usage}`)
  }
  if ((values.cert === undefined) !== (values.key === undefined)) {
    throw new Error('--cert and --key must be given together')
  }
  const tls = await loadTLS({
    certFile: values.cert,
    keyFile: values.key,
    stateDir: path.resolve(values['state-dir']!),
  })
  start = {
    tls,
    hostname: values['hide-hostname'] ? undefined : hostname(),
    allowedOrigins: values['allowed-origin'] as string[],
    viewerDir: path.resolve(__dirname, '../../viewer/dist'),
    loginSocket: path.resolve(values['login-socket']),
  }
  serve({ fd })
}

if (process.argv.length > 2) {
  startFromHelper(process.argv.slice(2)).catch((e) => {
    log.error(e.message)
    process.exit(2)
  })
}

// --- helpers ---

let indexHTML = ''

function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; " +
      "worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // not no-referrer: that makes browsers send "Origin: null" on same-origin requests, which the Origin check needs
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security': 'max-age=31536000',
  }
}

function send(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  response
    .writeHead(status, {
      ...securityHeaders(),
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    })
    .end(body)
}

function redirect(response: ServerResponse, location: string) {
  response.writeHead(303, { ...securityHeaders(), Location: location, 'Cache-Control': 'no-store' }).end()
}

/**
 * Same-origin check for the WebSocket: the browser-supplied Origin must match the host the request was sent to (or
 * an explicitly allowed origin). Requests without Origin are refused.
 */
function originAllowed(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) {
    return false
  }
  if (origin === `https://${host}`) {
    return true
  }
  return start.allowedOrigins.includes(origin)
}

/** The client's address as text, IPv4 without the IPv6 mapping prefix. */
function clientIP(socket: Socket): string {
  const address = socket.remoteAddress ?? ''
  return address.startsWith('::ffff:') && address.includes('.') ? address.slice('::ffff:'.length) : address
}

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

/** Public static files (no user data in them). */
function serveFile(response: ServerResponse, root: string, relative: string) {
  const file = path.resolve(root, '.' + path.posix.normalize('/' + relative))
  if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    send(response, 404, errorPage(404))
    return
  }
  response.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': contentTypes[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'private, max-age=3600',
  })
  createReadStream(file).pipe(response)
}

// --- routes ---

function handleGet(response: ServerResponse, url: URL) {
  if (url.pathname.startsWith('/static/')) {
    serveFile(response, staticDir, url.pathname.slice('/static/'.length))
    return
  }
  if (url.pathname.startsWith('/assets/')) {
    serveFile(response, start.viewerDir, url.pathname.slice(1))
    return
  }
  // the one page: sign-in and desktop
  if (url.pathname === '/') {
    send(response, 200, indexHTML)
    return
  }
  // old addresses
  if (url.pathname === '/login' || url.pathname === '/sessions' || url.pathname.startsWith('/desktop')) {
    redirect(response, '/')
    return
  }
  send(response, 404, errorPage(404))
}

// --- the WebSocket: sign-in, then the relay to the desktop ---

function rejectUpgrade(socket: Socket, status: number) {
  const text = status === 400 ? 'Bad Request' : status === 403 ? 'Forbidden' : 'Not Found'
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/**
 * One client frame from the start of `buffer`: the payload of a masked, unfragmented text frame of at most
 * SIGN_IN_MAX_FRAME_BYTES and the frame's size; 'incomplete' if more bytes are needed; undefined if it's anything else.
 */
function parseTextFrame(buffer: Buffer): { payload: string; size: number } | 'incomplete' | undefined {
  if (buffer.length < 2) {
    return 'incomplete'
  }
  const fin = buffer[0] & 0x80
  const reserved = buffer[0] & 0x70
  const opcode = buffer[0] & 0x0f
  const masked = buffer[1] & 0x80
  let length = buffer[1] & 0x7f
  let offset = 2
  if (!fin || reserved || opcode !== 1 || !masked || length === 127) {
    return undefined
  }
  if (length === 126) {
    if (buffer.length < 4) {
      return 'incomplete'
    }
    length = buffer.readUInt16BE(2)
    offset = 4
  }
  if (length > SIGN_IN_MAX_FRAME_BYTES) {
    return undefined
  }
  if (buffer.length < offset + 4 + length) {
    return 'incomplete'
  }
  const mask = buffer.subarray(offset, offset + 4)
  const payload = Buffer.alloc(length)
  for (let i = 0; i < length; i++) {
    payload[i] = buffer[offset + 4 + i] ^ mask[i % 4]
  }
  return { payload: payload.toString('utf8'), size: offset + 4 + length }
}

/**
 * Reads the page's sign-in frames from the socket (we did the WebSocket handshake ourselves: the bytes after the
 * sign-in are relayed as they are). Once the sign-in is over, `detach` stops reading and returns what came after.
 */
class SignInReader {
  private buffer: Buffer
  private broken = false
  private waiting?: (payload: string | undefined) => void

  constructor(
    private readonly socket: Socket,
    head: Buffer,
  ) {
    this.buffer = head
    socket.on('data', this.onData)
    socket.on('close', this.onClose)
  }

  /** The next frame's payload; undefined if the page sent something else, went away or took longer than timeoutMs. */
  next(timeoutMs: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(undefined), timeoutMs)
      const finish = (payload: string | undefined) => {
        clearTimeout(timer)
        this.waiting = undefined
        resolve(payload)
      }
      this.waiting = finish
      this.parse()
    })
  }

  /** Stop reading (the socket stays paused): the bytes received after the last frame. */
  detach(): Buffer {
    this.socket.pause()
    this.socket.off('data', this.onData)
    this.socket.off('close', this.onClose)
    return this.buffer
  }

  private readonly onData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk])
    // a frame and a bit: the page sends one frame and waits for the answer
    if (this.buffer.length > 2 * SIGN_IN_MAX_FRAME_BYTES) {
      this.broken = true
    }
    this.parse()
  }

  private readonly onClose = () => {
    this.broken = true
    this.parse()
  }

  private parse() {
    if (this.waiting === undefined) {
      return
    }
    const frame = this.broken ? undefined : parseTextFrame(this.buffer)
    if (frame === 'incomplete') {
      return
    }
    if (frame === undefined) {
      this.broken = true
      this.waiting(undefined)
      return
    }
    this.buffer = this.buffer.subarray(frame.size)
    this.waiting(frame.payload)
  }
}

/** The page's sign-in message in a frame, if it is one. */
function parseSignInMessage(payload: string | undefined): SignInClientMessage | undefined {
  if (payload === undefined) {
    return undefined
  }
  let message: any
  try {
    message = JSON.parse(payload)
  } catch {
    return undefined
  }
  if (message?.type === 'begin' && typeof message.username === 'string') {
    return { type: 'begin', username: message.username }
  }
  if (message?.type === 'answer' && typeof message.text === 'string') {
    return { type: 'answer', text: message.text }
  }
  return undefined
}

/** Send a text frame (server frames are unmasked). */
function sendFrame(socket: Socket, message: SignInServerMessage) {
  const payload = Buffer.from(JSON.stringify(message))
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
  socket.write(Buffer.concat([header, payload]))
}

/** Close a WebSocket we did the handshake for. */
function closeWebSocket(socket: Socket, code: number, reason: string) {
  const text = Buffer.from(reason)
  socket.end(Buffer.concat([Buffer.from([0x88, 2 + text.length, code >> 8, code & 0xff]), text]))
}

/**
 * The page's WebSocket: complete the handshake, run the sign-in on it (prompts and answers, see "Sign-in" in
 * libs/scene-protocol), attach to or start the user's desktop, then relay the bytes to its Unix socket (with a
 * handshake of our own there). TLS ends here, so its key never leaves this process.
 */
async function handleWebSocket(request: IncomingMessage, socket: Socket, head: Buffer) {
  const key = request.headers['sec-websocket-key']
  if (
    typeof key !== 'string' ||
    !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
    request.headers['sec-websocket-version'] !== '13'
  ) {
    rejectUpgrade(socket, 400)
    return
  }
  // no extensions or subprotocols: the bytes are relayed as they are
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${createHash('sha1')
        .update(key + WS_GUID)
        .digest('base64')}\r\n\r\n`,
  )
  const ip = clientIP(socket)
  const reader = new SignInReader(socket, head)
  const refuse = () => closeWebSocket(socket, CLOSE_SIGN_IN_FAILED, 'sign-in failed')

  const begin = parseSignInMessage(await reader.next(BEGIN_TIMEOUT_MS))
  if (begin?.type !== 'begin') {
    refuse()
    return
  }
  // (an unusable name is asked for its password like any other, and fails like a wrong password)
  const username = begin.username.trim()
  if (start.loginSocket !== undefined) {
    await signInWithHelper(socket, reader, ip, username, start.loginSocket)
    return
  }
  sendFrame(socket, { type: 'prompt', text: PASSWORD_PROMPT, echo: false })
  const answer = parseSignInMessage(await reader.next(ANSWER_TIMEOUT_MS))
  if (answer?.type !== 'answer') {
    refuse()
    return
  }

  // a monotonic clock: wall clock adjustments mustn't shorten the minimum failure time
  const startedAt = performance.now()
  const fail = async (message: string) => {
    // failures take the same minimum time whatever the reason
    const wait = MIN_FAILED_LOGIN_MS - (performance.now() - startedAt)
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
    sendFrame(socket, { type: 'result', ok: false, message })
    refuse()
  }
  if (ipFailures.blocked(ip)) {
    await fail(TOO_MANY_FAILURES)
    return
  }
  const password = answer.text
  const reply =
    username.length > 0 &&
    username.length <= MONITOR_MAX_USERNAME &&
    password.length > 0 &&
    password.length <= MONITOR_MAX_ANSWER
      ? await monitor({ type: 'auth', username, password, ip })
      : ({ ok: false, error: 'auth-failed' } as const)
  if (!reply.ok || reply.type !== 'auth') {
    ipFailures.fail(ip)
    log.info(`Failed sign-in from ${ip}.`)
    await fail('The username or password is incorrect.')
    return
  }
  if (socket.destroyed) {
    return
  }

  // attach or create
  const desktop = await monitor({ type: 'desktop', ticket: reply.ticket })
  if (!desktop.ok || desktop.type !== 'socket') {
    sendFrame(socket, { type: 'result', ok: false, message: 'The desktop could not be started.' })
    refuse()
    return
  }
  if (socket.destroyed) {
    return
  }
  // the session learns the client's IP (for the takeover message of the page it replaces) from a header
  relay(socket, reader, connect(desktop.path), ip, reply.username, `X-Client-IP: ${ip}\r\n`)
}

/**
 * The sign-in through a login helper: a connection to its login.sock per sign-in, on which we write the client's
 * address and the user name, relay its prompts to the page and the page's answers back, and get the result, which on
 * success carries our end of a connection to the user's desktop (login-protocol.ts). The helper does everything
 * else: the minimum failure time, attaching to or starting the desktop.
 */
async function signInWithHelper(
  socket: Socket,
  reader: SignInReader,
  ip: string,
  username: string,
  loginSocket: string,
) {
  const refuse = () => closeWebSocket(socket, CLOSE_SIGN_IN_FAILED, 'sign-in failed')
  const failed = (message: string) => {
    sendFrame(socket, { type: 'result', ok: false, message })
    refuse()
  }
  if (ipFailures.blocked(ip)) {
    // nothing reaches the helper (the page answers its password prompt first)
    sendFrame(socket, { type: 'prompt', text: PASSWORD_PROMPT, echo: false })
    if (parseSignInMessage(await reader.next(ANSWER_TIMEOUT_MS))?.type === 'answer') {
      failed(TOO_MANY_FAILURES)
    } else {
      refuse()
    }
    return
  }
  const { unixConnect, closeFd } = fdPassing()
  const fd = unixConnect(loginSocket)
  if (fd < 0) {
    log.error(`Connecting to the login helper failed (errno ${-fd}).`)
    failed('Signing in is not possible right now.')
    return
  }
  const channel = new RecordChannel(fd)
  const onClose = () => channel.close()
  socket.once('close', onClose)
  try {
    // until the listener writes it (step 6 of SIGNIN-ROADMAP.md), the client's address comes from us. A name over the
    // protocol's limit goes as an empty one: it fails like an unknown user
    const sent =
      channel.write({ kind: Kind.ClientAddress, address: ip }) &&
      channel.write({ kind: Kind.Begin, username: Buffer.byteLength(username) <= MAX_USERNAME ? username : '' })
    if (!sent) {
      failed('Signing in is not possible right now.')
      return
    }
    for (;;) {
      const next = await channel.read(HELPER_TIMEOUT_MS)
      if (socket.destroyed) {
        if (next?.fd !== undefined) {
          closeFd(next.fd)
        }
        return
      }
      if (next === undefined) {
        failed('The sign-in could not be completed.')
        return
      }
      const { record } = next
      if (record.kind === Kind.Prompt) {
        if (record.style === PromptStyle.Info || record.style === PromptStyle.Error) {
          sendFrame(socket, { type: record.style === PromptStyle.Info ? 'info' : 'error', text: record.text })
          continue
        }
        sendFrame(socket, { type: 'prompt', text: record.text, echo: record.style === PromptStyle.EchoOn })
        const answer = parseSignInMessage(await reader.next(ANSWER_TIMEOUT_MS))
        if (answer?.type !== 'answer' || Buffer.byteLength(answer.text) > MAX_ANSWER) {
          refuse()
          return
        }
        if (!channel.write({ kind: Kind.Answer, text: answer.text })) {
          failed('The sign-in could not be completed.')
          return
        }
        continue
      }
      if (record.kind === Kind.Result && record.outcome === Outcome.SignedIn && next.fd !== undefined) {
        relay(socket, reader, new Socket({ fd: next.fd, readable: true, writable: true }), ip, record.text, '')
        return
      }
      if (next.fd !== undefined) {
        closeFd(next.fd)
      }
      if (record.kind !== Kind.Result) {
        log.error('The login helper sent something unexpected.')
        failed('The sign-in could not be completed.')
        return
      }
      if (record.outcome === Outcome.Refused) {
        ipFailures.fail(ip)
        log.info(`Failed sign-in from ${ip}.`)
      }
      failed(record.text)
      return
    }
  } finally {
    socket.off('close', onClose)
    channel.close()
  }
}

/**
 * Connect the signed-in page to its desktop over `upstream` (connecting, or connected already): a WebSocket handshake
 * with the session (with `extraHeaders`), then the result frame, then bytes both ways.
 */
function relay(
  socket: Socket,
  reader: SignInReader,
  upstream: Socket,
  ip: string,
  username: string,
  extraHeaders: string,
) {
  const destroyBoth = () => {
    socket.destroy()
    upstream.destroy()
  }
  let failed = false
  const unavailable = () => {
    if (failed) {
      return
    }
    failed = true
    if (!socket.destroyed) {
      sendFrame(socket, { type: 'result', ok: false, message: 'The desktop could not be reached.' })
      closeWebSocket(socket, CLOSE_SIGN_IN_FAILED, 'sign-in failed')
    }
    upstream.destroy()
  }
  upstream.on('error', unavailable)
  // (a desktop that went away closes the connection without an error)
  upstream.on('close', unavailable)
  socket.on('error', destroyBoth)
  socket.on('close', destroyBoth)
  const handshake = () => {
    upstream.write(
      'GET /viewer HTTP/1.1\r\nHost: session\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
        `${extraHeaders}\r\n`,
    )
    let response = Buffer.alloc(0)
    const onResponse = (chunk: Buffer) => {
      response = Buffer.concat([response, chunk])
      const end = response.indexOf('\r\n\r\n')
      if (end < 0) {
        if (response.length > 8192) {
          unavailable()
        }
        return
      }
      upstream.off('data', onResponse)
      if (!response.subarray(0, end).toString('latin1').startsWith('HTTP/1.1 101')) {
        unavailable()
        return
      }
      upstream.off('error', unavailable)
      upstream.off('close', unavailable)
      upstream.on('error', destroyBoth)
      upstream.on('close', destroyBoth)
      const rest = reader.detach()
      log.info(`Signed in: ${username} from ${ip}.`)
      sendFrame(socket, { type: 'result', ok: true, username })
      const upstreamRest = response.subarray(end + 4)
      if (upstreamRest.length > 0) {
        socket.write(upstreamRest)
      }
      if (rest.length > 0) {
        upstream.write(rest)
      }
      socket.pipe(upstream)
      upstream.pipe(socket)
    }
    upstream.on('data', onResponse)
  }
  if (upstream.connecting) {
    upstream.once('connect', handshake)
  } else {
    handshake()
  }
}

function handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer) {
  socket.on('error', () => socket.destroy())
  const url = new URL(request.url ?? '/', 'https://gateway')
  if (url.pathname !== '/ws') {
    rejectUpgrade(socket, 404)
    return
  }
  if (!originAllowed(request)) {
    rejectUpgrade(socket, 403)
    return
  }
  handleWebSocket(request, socket, head).catch((e) => {
    log.error(`Sign-in failed: ${e.message}`)
    socket.destroy()
  })
}

function tuneSocket(socket: Socket) {
  socket.setNoDelay(true)
  const fd: number | undefined = (socket as any)._handle?.fd
  if (fd === undefined || fd < 0) {
    return
  }
  try {
    // keep unsent data in the session's priority queue rather than in the kernel (see ViewerTransport)
    // a lazy require: it pulls in the proxy's native addon, which must stay optional here
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { setTcpNotSentLowat } = require('@gfld/compositor-proxy/dist/socket-options.js')
    setTcpNotSentLowat(fd, TCP_NOTSENT_LOWAT_BYTES)
  } catch {
    // tuning only
  }
}

function serve(listener: NetServer | { fd: number }) {
  // the host name is shown on the sign-in form without needing scripts or a request
  indexHTML = readFileSync(path.join(start.viewerDir, 'index.html'), 'utf8').replace(
    '<!--hostname-->',
    start.hostname ? escapeHTML(start.hostname) : '&nbsp;',
  )

  const server = createHTTPSServer({ cert: start.tls.cert, key: start.tls.key, minVersion: 'TLSv1.2' })
  server.headersTimeout = 20_000
  server.requestTimeout = 30_000

  server.on('connection', (socket: Socket) => tuneSocket(socket))
  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (request.method === 'GET' || request.method === 'HEAD') {
        handleGet(response, new URL(request.url ?? '/', 'https://gateway'))
      } else {
        send(response, 405, errorPage(405), { Allow: 'GET' })
      }
    } catch (e: any) {
      log.error(`Request failed: ${e.message}`)
      if (!response.headersSent) {
        send(response, 500, errorPage(500))
      }
    }
  })
  server.on('upgrade', handleUpgrade)
  server.on('clientError', (_error, socket) => socket.destroy())

  server.listen(listener, () => {
    const address = server.address()
    const where = typeof address === 'object' && address ? `${address.address}:${address.port}` : `${address}`
    log.info(`Listening on https://${where}`)
  })
}
