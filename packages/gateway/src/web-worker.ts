/**
 * A web worker: one per TCP connection, started by the listener (web.ts) and exiting when its connection closes. It
 * does everything network-facing for that one connection, running unprivileged: TLS, the page, Origin checks, the
 * viewer's static files, the sign-in conversation on the page's WebSocket, and relaying that same WebSocket to the
 * user's desktop once signed in. An exploit here reaches only the attacker's own connection: other users' sessions and
 * passwords are in other workers, which can't inspect each other (each marks itself not dumpable first thing).
 *
 * What the listener hands it (see `startWorker` in web.ts):
 *
 *   - fd 3: the accepted TCP connection, not read yet;
 *   - fd 4: a connection to the login helper's login.sock, on which the listener has already written the client's
 *     address (ClientAddress, login-protocol.ts). The worker writes Begin, relays the helper's prompts to the page and
 *     its answers back, and gets a Result that carries, on success, its end of a connection to the user's desktop.
 *     Missing when the listener didn't open one (the client's IP is throttled, or the helper can't be reached);
 *   - an IPC channel (Node's): the listener sends `WorkerStart` (the TLS certificate and key, the page, ...); the
 *     worker reports a refused sign-in (`WorkerReport`), for the listener's per-IP throttle. The worker exits when the
 *     channel closes (the listener is gone).
 *
 * Signing in works like unlocking a screen: the page's one WebSocket (`/ws`) is the sign-in. The page signs in on it
 * (in-band, see "Sign-in" in libs/scene-protocol) and the same WebSocket then carries the desktop. There are no
 * tokens or cookies: when the WebSocket closes (tab closed, reloaded, network gone, another sign-in took the desktop
 * over), the page has to sign in again. The desktop behind it keeps running until the user logs out.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { IncomingMessage, ServerResponse } from 'node:http'
import { createServer as createHTTPSServer } from 'node:https'
import { Socket } from 'node:net'
import path from 'node:path'
import {
  CLOSE_SIGN_IN_FAILED,
  SIGN_IN_MAX_FRAME_BYTES,
  SignInClientMessage,
  SignInServerMessage,
} from '@gfld/scene-protocol'
import { log } from './log'
import { fdPassing, Kind, MAX_ANSWER, MAX_USERNAME, Outcome, PromptStyle, RecordChannel } from './login-protocol'
import { errorPage } from './pages'

process.title = 'nebula-web-worker'

/** The listener's first (and only) message. */
export type WorkerStart = {
  type: 'start'
  tls: { cert: string; key: string }
  /** the page, with the host name filled in */
  indexHTML: string
  /** additionally accepted Origins */
  allowedOrigins: string[]
  viewerDir: string
  /** helper: login.sock is on fd 4; blocked: the client's IP is throttled; unavailable: the helper can't be reached */
  signIn: 'helper' | 'blocked' | 'unavailable'
}

/** The worker's report to the listener: a sign-in was refused (at most one per worker). */
export type WorkerReport = { type: 'refused' }

const WORKER_TCP_FD = 3
const WORKER_HELPER_FD = 4

/** the page sends its `begin` right after the upgrade */
const BEGIN_TIMEOUT_MS = 10_000
/** a person answers each prompt (a password now, a one-time code later) within this time */
const ANSWER_TIMEOUT_MS = 60_000
/** a login helper answers within its own limits (the failure delay, starting a desktop) */
const HELPER_TIMEOUT_MS = 90_000
const TOO_MANY_FAILURES = 'Too many failed attempts. Try again in a few minutes.'
/** the prompt the password is asked with when the listener refused the IP (nothing reaches the helper then) */
const PASSWORD_PROMPT = 'Password: '
const TCP_NOTSENT_LOWAT_BYTES = 32 * 1024
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const staticDir = path.resolve(__dirname, '../static')

let start!: WorkerStart
/** one sign-in per worker: a WebSocket takes the connection over, and a failed sign-in closes it */
let signedInOnce = false

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
    send(response, 200, start.indexHTML)
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
  await signIn(socket, reader, ip, begin.username.trim())
}

/**
 * The sign-in through the login helper, on the connection to its login.sock the listener opened for us (fd 4; the
 * listener has written the client's address): we write the user name, relay its prompts to the page and the page's
 * answers back, and get the result, which on success carries our end of a connection to the user's desktop
 * (login-protocol.ts). The helper does everything else: the minimum failure time, attaching to or starting the
 * desktop.
 */
async function signIn(socket: Socket, reader: SignInReader, ip: string, username: string) {
  const refuse = () => closeWebSocket(socket, CLOSE_SIGN_IN_FAILED, 'sign-in failed')
  const failed = (message: string) => {
    sendFrame(socket, { type: 'result', ok: false, message })
    refuse()
  }
  if (start.signIn === 'blocked') {
    // nothing reaches the helper (the page answers its password prompt first)
    sendFrame(socket, { type: 'prompt', text: PASSWORD_PROMPT, echo: false })
    if (parseSignInMessage(await reader.next(ANSWER_TIMEOUT_MS))?.type === 'answer') {
      failed(TOO_MANY_FAILURES)
    } else {
      refuse()
    }
    return
  }
  if (start.signIn !== 'helper' || signedInOnce) {
    failed('Signing in is not possible right now.')
    return
  }
  signedInOnce = true
  const { closeFd } = fdPassing()
  const channel = new RecordChannel(WORKER_HELPER_FD)
  const onClose = () => channel.close()
  socket.once('close', onClose)
  try {
    // a name over the protocol's limit goes as an empty one: it fails like an unknown user
    if (!channel.write({ kind: Kind.Begin, username: Buffer.byteLength(username) <= MAX_USERNAME ? username : '' })) {
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
        relay(socket, reader, new Socket({ fd: next.fd, readable: true, writable: true }), ip, record.text)
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
        // before the page hears of it: its next attempt must find the listener's throttle up to date
        process.send?.({ type: 'refused' } satisfies WorkerReport)
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
 * Connect the signed-in page to its desktop over `upstream` (the connection the helper's Result carried): a WebSocket
 * handshake with the session, then the result frame, then bytes both ways.
 */
function relay(socket: Socket, reader: SignInReader, upstream: Socket, ip: string, username: string) {
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
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`,
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
  handshake()
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

/**
 * Serve our one connection (fd 3): TLS, any number of requests on it (HTTP keep-alive: the page and its files), or one
 * WebSocket. Exit when it closes.
 */
function serve() {
  const server = createHTTPSServer({ cert: start.tls.cert, key: start.tls.key, minVersion: 'TLSv1.2' })
  server.headersTimeout = 20_000
  server.requestTimeout = 30_000
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

  // (in the same tick as wrapping it: TLS takes the socket over before anything is read)
  const connection = new Socket({ fd: WORKER_TCP_FD, readable: true, writable: true })
  connection.on('close', () => process.exit(0))
  tuneSocket(connection)
  server.emit('connection', connection)
}

// workers can't inspect each other (ptrace, /proc/<pid>/mem, environ, fds)
const notDumpable = fdPassing().setNotDumpable()
if (notDumpable < 0) {
  log.error(`Can't mark the worker not dumpable (errno ${-notDumpable}).`)
  process.exit(1)
}
process.once('message', (message: WorkerStart) => {
  start = message
  serve()
})
process.on('disconnect', () => process.exit(0))
