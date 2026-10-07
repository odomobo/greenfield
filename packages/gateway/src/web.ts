/**
 * The web process: everything network-facing, running unprivileged. TLS, the page, Origin checks, failed-sign-in
 * throttling, the viewer's static files, the sign-in conversation on the page's WebSocket, and relaying that same
 * WebSocket to the user's session process over its Unix socket once signed in.
 *
 * It knows users only through tickets the monitor hands out on successful authentication, and uses each ticket once,
 * right away, to attach to (or start) the user's desktop.
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
import { connect, Server as NetServer, Socket } from 'node:net'
import path from 'node:path'
import {
  CLOSE_SIGN_IN_FAILED,
  SIGN_IN_MAX_FRAME_BYTES,
  SignInClientMessage,
  SignInServerMessage,
} from '@gfld/scene-protocol'
import { MonitorReply, MonitorReplyEnvelope, WebRequest, WebStart } from './ipc'
import { log } from './log'
import { errorPage, escapeHTML } from './pages'
import { RateLimiter } from './rate-limit'

process.title = 'gateway-web'

const MIN_FAILED_LOGIN_MS = 3000
/** divides the failed-sign-in delay in tests (--dev-time-scale, only accepted together with --dev-auth); 1 otherwise */
const scaled = (ms: number) => ms / (start?.timeScale ?? 1)
/** the page sends its `begin` right after the upgrade */
const BEGIN_TIMEOUT_MS = 10_000
/** a person answers each prompt (a password now, a one-time code later) within this time */
const ANSWER_TIMEOUT_MS = 60_000
const MAX_USERNAME = 64
const MAX_ANSWER = 1024
/** the prompt the password is asked with (the only one until PAM's own prompts are relayed) */
const PASSWORD_PROMPT = 'Password: '
const TCP_NOTSENT_LOWAT_BYTES = 32 * 1024
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const staticDir = path.resolve(__dirname, '../static')

let start!: WebStart
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
    const wait = scaled(MIN_FAILED_LOGIN_MS) - (performance.now() - startedAt)
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
    sendFrame(socket, { type: 'result', ok: false, message })
    refuse()
  }
  if (ipFailures.blocked(ip)) {
    await fail('Too many failed attempts. Try again in a few minutes.')
    return
  }
  const password = answer.text
  const reply =
    username.length > 0 && username.length <= MAX_USERNAME && password.length > 0 && password.length <= MAX_ANSWER
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
  relay(socket, reader, desktop.path, ip, reply.username)
}

/**
 * Connect the signed-in page to its desktop: a WebSocket handshake with the session (telling it the client's IP, for
 * the takeover message of the page it replaces), then the result frame, then bytes both ways.
 */
function relay(socket: Socket, reader: SignInReader, socketPath: string, ip: string, username: string) {
  const upstream = connect(socketPath)
  const destroyBoth = () => {
    socket.destroy()
    upstream.destroy()
  }
  const unavailable = () => {
    if (!socket.destroyed) {
      sendFrame(socket, { type: 'result', ok: false, message: 'The desktop could not be reached.' })
      closeWebSocket(socket, CLOSE_SIGN_IN_FAILED, 'sign-in failed')
    }
    upstream.destroy()
  }
  upstream.on('error', unavailable)
  socket.on('error', destroyBoth)
  socket.on('close', destroyBoth)
  upstream.once('connect', () => {
    upstream.write(
      'GET /viewer HTTP/1.1\r\nHost: session\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
        `X-Client-IP: ${ip}\r\n\r\n`,
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
  })
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

function serve(listener: NetServer) {
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
    const address = listener.address()
    const where = typeof address === 'object' && address ? `${address.address}:${address.port}` : `${address}`
    log.info(`Listening on https://${where}`)
    if (start.devMode) {
      log.warn('!!! DEV AUTH MODE: no PAM, sessions run as the current user. Never use this outside development. !!!')
    }
  })
}
