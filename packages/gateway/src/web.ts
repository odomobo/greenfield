/**
 * The web process: everything network-facing, running unprivileged. TLS, the page, sign-in tokens, Origin checks,
 * rate limiting, the viewer's static files, and relaying authenticated viewer WebSockets to the user's session process
 * over its Unix socket.
 *
 * It knows users only through tickets the monitor hands out on successful authentication.
 *
 * Signing in works like unlocking a screen: it's valid for one open page only. The page keeps its token in memory
 * (never in cookies or storage) and holds a presence WebSocket to /control; when that closes (tab closed, reloaded,
 * navigated away), the token is revoked after a short grace for network blips. A second tab has to sign in itself.
 * The desktop sessions behind it keep running regardless.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer as createHTTPServer, IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer as createHTTPSServer } from 'node:https'
import { connect, Server as NetServer, Socket } from 'node:net'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { MAX_SESSION_NAME_LENGTH, MonitorReply, MonitorReplyEnvelope, WebRequest, WebStart } from './ipc'
import { log } from './log'
import { errorPage, escapeHTML } from './pages'
import { RateLimiter } from './rate-limit'

process.title = 'gateway-web'

const MIN_FAILED_LOGIN_MS = 3000
const TOKEN_MAX_MS = 7 * 24 * 3600 * 1000
/** a new token must get its presence connection within this time */
const PRESENCE_ATTACH_MS = 10_000
/** a token survives losing its presence connection this long (network blips), not longer */
const PRESENCE_GRACE_MS = 5_000
/** divides the three delays above in tests (--dev-time-scale, only accepted together with --dev-auth); 1 otherwise */
const scaled = (ms: number) => ms / (start?.timeScale ?? 1)
const PRESENCE_PING_MS = 15_000
/** the first WebSocket message (the token) must arrive within this time */
const WS_AUTH_TIMEOUT_MS = 10_000
const MAX_BODY = 4096
const TCP_NOTSENT_LOWAT_BYTES = 32 * 1024
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** WebSocket close codes the page understands */
const CLOSE_UNAUTHORIZED = 4001
const CLOSE_NOT_FOUND = 4004
const staticDir = path.resolve(__dirname, '../static')

type SignIn = {
  ticket: string
  username: string
  createdAt: number
  /** the page's /control WebSocket */
  presence?: WebSocket
  revokeTimer?: NodeJS.Timeout
  /** viewer WebSockets relayed with this token, closed when it's revoked */
  relays: Set<Socket>
}

let start!: WebStart
const signIns = new Map<string, SignIn>()
// per username: few tries; per IP: more, since many users may share an address (NAT)
const userFailures = new RateLimiter(5)
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

// --- sign-ins ---

function revoke(token: string) {
  const signIn = signIns.get(token)
  if (signIn === undefined) {
    return
  }
  signIns.delete(token)
  clearTimeout(signIn.revokeTimer)
  signIn.presence?.close(CLOSE_UNAUTHORIZED, 'signed out')
  for (const relay of signIn.relays) {
    relay.destroy()
  }
  void monitor({ type: 'logout', ticket: signIn.ticket })
}

function lookup(token: string | undefined): [string, SignIn] | undefined {
  if (token === undefined) {
    return undefined
  }
  const signIn = signIns.get(token)
  if (signIn === undefined) {
    return undefined
  }
  if (Date.now() - signIn.createdAt > TOKEN_MAX_MS) {
    revoke(token)
    return undefined
  }
  return [token, signIn]
}

function bearer(request: IncomingMessage): [string, SignIn] | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(request.headers.authorization ?? '')
  return lookup(match?.[1])
}

// --- helpers ---

let tls = false
let indexHTML = ''

function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; " +
      "worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // not no-referrer: that makes browsers send "Origin: null" on same-origin POSTs, which the Origin check needs
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...(tls ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
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

function sendJSON(response: ServerResponse, status: number, body: unknown) {
  send(response, status, JSON.stringify(body), { 'Content-Type': 'application/json' })
}

function redirect(response: ServerResponse, location: string) {
  response.writeHead(303, { ...securityHeaders(), Location: location, 'Cache-Control': 'no-store' }).end()
}

/**
 * Same-origin check for state-changing requests and WebSockets: the browser-supplied Origin must match the host the
 * request was sent to (or an explicitly allowed origin). Requests without Origin are refused.
 */
function originAllowed(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) {
    return false
  }
  if (origin === `${tls ? 'https' : 'http'}://${host}`) {
    return true
  }
  return start.allowedOrigins.includes(origin)
}

function readJSONBody(request: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
      reject(new Error('not json'))
      return
    }
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (e) {
        reject(e)
      }
    })
    request.on('error', reject)
  })
}

function clientIP(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? 'unknown'
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

/** POST /api/login, body { username, password } -> { token, username } */
async function handleLogin(request: IncomingMessage, response: ServerResponse) {
  // a monotonic clock: wall clock adjustments mustn't shorten the minimum failure time
  const startedAt = performance.now()
  const respondFailure = async (message: string) => {
    // failures take the same minimum time whatever the reason
    const wait = scaled(MIN_FAILED_LOGIN_MS) - (performance.now() - startedAt)
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
    sendJSON(response, 401, { error: message })
  }

  let body: any
  try {
    body = await readJSONBody(request)
  } catch {
    sendJSON(response, 400, { error: 'bad request' })
    return
  }
  const username = (typeof body?.username === 'string' ? body.username : '').trim().slice(0, 64)
  const password = typeof body?.password === 'string' ? body.password : ''

  if (!originAllowed(request)) {
    await respondFailure('The sign-in request was refused. Please try again.')
    return
  }

  const ip = clientIP(request)
  const userKey = username.toLowerCase()
  if (ipFailures.blocked(ip) || userFailures.blocked(userKey)) {
    await respondFailure('Too many failed attempts. Try again in a few minutes.')
    return
  }

  const reply =
    username.length > 0 && password.length > 0 && password.length <= 1024
      ? await monitor({ type: 'auth', username, password })
      : ({ ok: false, error: 'auth-failed' } as const)

  if (!reply.ok || reply.type !== 'auth') {
    ipFailures.fail(ip)
    userFailures.fail(userKey)
    log.info(`Failed login from ${ip}.`)
    await respondFailure('The username or password is incorrect.')
    return
  }

  userFailures.succeed(userKey)
  const token = randomBytes(32).toString('base64url')
  signIns.set(token, {
    ticket: reply.ticket,
    username: reply.username,
    createdAt: Date.now(),
    relays: new Set(),
    revokeTimer: setTimeout(() => revoke(token), scaled(PRESENCE_ATTACH_MS)),
  })
  sendJSON(response, 200, { token, username: reply.username })
}

async function handlePost(request: IncomingMessage, response: ServerResponse, url: URL) {
  if (url.pathname === '/api/login') {
    await handleLogin(request, response)
    return
  }

  const current = bearer(request)
  if (current === undefined) {
    sendJSON(response, 401, { error: 'unauthenticated' })
    return
  }
  // the bearer header already can't come from another site; this is defense in depth
  if (!originAllowed(request)) {
    sendJSON(response, 403, { error: 'forbidden' })
    return
  }
  const [token, signIn] = current

  if (url.pathname === '/api/logout') {
    revoke(token)
    sendJSON(response, 200, { ok: true })
    return
  }
  if (url.pathname === '/api/sessions') {
    const reply = await monitor({ type: 'createSession', ticket: signIn.ticket })
    if (reply.ok && reply.type === 'session') {
      sendJSON(response, 201, reply.session)
    } else {
      sendJSON(response, 500, { error: 'The session could not be started.' })
    }
    return
  }
  const action = /^\/api\/sessions\/([A-Za-z0-9_-]{1,64})\/(rename|end)$/.exec(url.pathname)
  switch (action?.[2]) {
    case 'rename':
      await handleRename(request, response, signIn, action[1])
      return
    case 'end': {
      const reply = await monitor({ type: 'endSession', ticket: signIn.ticket, sessionId: action[1] })
      sendJSON(response, reply.ok ? 200 : 404, reply.ok ? { ok: true } : { error: 'not found' })
      return
    }
  }
  sendJSON(response, 404, { error: 'not found' })
}

/** POST /api/sessions/<id>/rename, body { name } */
async function handleRename(request: IncomingMessage, response: ServerResponse, signIn: SignIn, sessionId: string) {
  let body: any
  try {
    body = await readJSONBody(request)
  } catch {
    sendJSON(response, 400, { error: 'bad request' })
    return
  }
  const reply = await monitor({
    type: 'renameSession',
    ticket: signIn.ticket,
    sessionId,
    name: typeof body?.name === 'string' ? body.name : '',
  })
  if (reply.ok && reply.type === 'session') {
    sendJSON(response, 200, reply.session)
  } else if (!reply.ok && reply.error === 'invalid') {
    sendJSON(response, 400, { error: 'invalid name', maxLength: MAX_SESSION_NAME_LENGTH })
  } else {
    sendJSON(response, 404, { error: 'not found' })
  }
}

async function handleGet(request: IncomingMessage, response: ServerResponse, url: URL) {
  if (url.pathname.startsWith('/static/')) {
    serveFile(response, staticDir, url.pathname.slice('/static/'.length))
    return
  }
  if (url.pathname.startsWith('/assets/')) {
    serveFile(response, start.viewerDir, url.pathname.slice(1))
    return
  }
  // the one page: sign-in, session list and desktop
  if (url.pathname === '/') {
    send(response, 200, indexHTML)
    return
  }
  // old addresses
  if (url.pathname === '/login' || url.pathname === '/sessions' || url.pathname.startsWith('/desktop')) {
    redirect(response, '/')
    return
  }

  if (!url.pathname.startsWith('/api/')) {
    send(response, 404, errorPage(404))
    return
  }
  const current = bearer(request)
  if (current === undefined) {
    sendJSON(response, 401, { error: 'unauthenticated' })
    return
  }
  const [, signIn] = current

  if (url.pathname === '/api/me') {
    sendJSON(response, 200, { username: signIn.username })
    return
  }
  if (url.pathname === '/api/sessions') {
    const reply = await monitor({ type: 'listSessions', ticket: signIn.ticket })
    sendJSON(response, 200, reply.ok && reply.type === 'sessions' ? reply.sessions : [])
    return
  }
  sendJSON(response, 404, { error: 'not found' })
}

// --- WebSockets ---

function rejectUpgrade(socket: Socket, status: number) {
  const text = status === 400 ? 'Bad Request' : status === 403 ? 'Forbidden' : 'Not Found'
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

const presenceServer = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false })

/**
 * The page's presence: the first message is its token. The token stays valid while this connection is open (and
 * for a short grace after it closes).
 */
function handlePresence(ws: WebSocket) {
  let token: string | undefined
  let alive = true
  const authTimer = setTimeout(() => ws.close(CLOSE_UNAUTHORIZED, 'unauthorized'), WS_AUTH_TIMEOUT_MS)
  const pingTimer = setInterval(() => {
    if (!alive) {
      ws.terminate()
      return
    }
    alive = false
    ws.ping()
  }, PRESENCE_PING_MS)
  ws.on('pong', () => (alive = true))
  ws.on('message', (data) => {
    if (token !== undefined) {
      return
    }
    clearTimeout(authTimer)
    const current = lookup(data.toString())
    if (current === undefined) {
      ws.close(CLOSE_UNAUTHORIZED, 'unauthorized')
      return
    }
    const [currentToken, signIn] = current
    token = currentToken
    const previous = signIn.presence
    signIn.presence = ws
    clearTimeout(signIn.revokeTimer)
    signIn.revokeTimer = undefined
    // a reconnect after a blip; the old connection may not have noticed yet
    previous?.terminate()
    ws.send(JSON.stringify({ type: 'ok' }))
  })
  ws.on('close', () => {
    clearTimeout(authTimer)
    clearInterval(pingTimer)
    const signIn = token === undefined ? undefined : signIns.get(token)
    if (signIn?.presence === ws) {
      signIn.presence = undefined
      const closedToken = token!
      signIn.revokeTimer = setTimeout(() => revoke(closedToken), scaled(PRESENCE_GRACE_MS))
    }
  })
  ws.on('error', () => ws.terminate())
}

/**
 * Reads the client's first WebSocket frame (masked, unfragmented text, at most 1 KiB) from the socket. Resolves
 * with its payload and whatever bytes followed it, with the socket paused; undefined if the client sent something
 * else, went away or took too long.
 */
function readFirstFrame(socket: Socket, head: Buffer): Promise<{ payload: string; rest: Buffer } | undefined> {
  return new Promise((resolve) => {
    let buffer = head
    const finish = (result: { payload: string; rest: Buffer } | undefined) => {
      clearTimeout(timer)
      socket.pause()
      socket.off('data', onData)
      socket.off('close', onClose)
      resolve(result)
    }
    const tryParse = () => {
      if (buffer.length < 2) {
        return
      }
      const fin = buffer[0] & 0x80
      const reserved = buffer[0] & 0x70
      const opcode = buffer[0] & 0x0f
      const masked = buffer[1] & 0x80
      let length = buffer[1] & 0x7f
      let offset = 2
      if (!fin || reserved || opcode !== 1 || !masked || length === 127) {
        finish(undefined)
        return
      }
      if (length === 126) {
        if (buffer.length < 4) {
          return
        }
        length = buffer.readUInt16BE(2)
        offset = 4
      }
      if (length > 1024) {
        finish(undefined)
        return
      }
      if (buffer.length < offset + 4 + length) {
        return
      }
      const mask = buffer.subarray(offset, offset + 4)
      const payload = Buffer.alloc(length)
      for (let i = 0; i < length; i++) {
        payload[i] = buffer[offset + 4 + i] ^ mask[i % 4]
      }
      finish({ payload: payload.toString('utf8'), rest: buffer.subarray(offset + 4 + length) })
    }
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > 4096) {
        finish(undefined)
        return
      }
      tryParse()
    }
    const onClose = () => finish(undefined)
    const timer = setTimeout(() => finish(undefined), WS_AUTH_TIMEOUT_MS)
    socket.on('data', onData)
    socket.on('close', onClose)
    tryParse()
  })
}

/** Close a WebSocket we did the handshake for (server frames are unmasked). */
function closeWebSocket(socket: Socket, code: number, reason: string) {
  const text = Buffer.from(reason)
  socket.end(Buffer.concat([Buffer.from([0x88, 2 + text.length, code >> 8, code & 0xff]), text]))
}

/**
 * Viewer WebSocket: complete the handshake, take the token from the first message, check the session belongs to the
 * user, then relay bytes to the session's Unix socket (with a handshake of our own there). TLS ends here, so its key
 * never leaves this process. The token isn't in the URL, so it doesn't end up in logs or history.
 */
async function handleViewer(request: IncomingMessage, socket: Socket, head: Buffer, url: URL) {
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

  const first = await readFirstFrame(socket, head)
  const current = lookup(first?.payload)
  if (first === undefined || current === undefined) {
    closeWebSocket(socket, CLOSE_UNAUTHORIZED, 'unauthorized')
    return
  }
  const [, signIn] = current
  const reply = await monitor({
    type: 'sessionSocket',
    ticket: signIn.ticket,
    sessionId: url.searchParams.get('session') ?? '',
  })
  if (!reply.ok || reply.type !== 'socket') {
    closeWebSocket(socket, CLOSE_NOT_FOUND, 'not found')
    return
  }
  if (socket.destroyed || !signIns.has(current[0])) {
    socket.destroy()
    return
  }

  signIn.relays.add(socket)
  const upstream = connect(reply.path)
  const destroyBoth = () => {
    signIn.relays.delete(socket)
    socket.destroy()
    upstream.destroy()
  }
  upstream.on('error', destroyBoth)
  socket.on('error', destroyBoth)
  upstream.on('close', destroyBoth)
  socket.on('close', destroyBoth)
  upstream.once('connect', () => {
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
          destroyBoth()
        }
        return
      }
      upstream.off('data', onResponse)
      if (!response.subarray(0, end).toString('latin1').startsWith('HTTP/1.1 101')) {
        closeWebSocket(socket, 1011, 'session unavailable')
        upstream.destroy()
        return
      }
      const upstreamRest = response.subarray(end + 4)
      if (upstreamRest.length > 0) {
        socket.write(upstreamRest)
      }
      if (first.rest.length > 0) {
        upstream.write(first.rest)
      }
      socket.pipe(upstream)
      upstream.pipe(socket)
    }
    upstream.on('data', onResponse)
  })
}

function handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer) {
  socket.on('error', () => socket.destroy())
  const url = new URL(request.url ?? '/', 'http://gateway')
  if (url.pathname !== '/ws' && url.pathname !== '/control') {
    rejectUpgrade(socket, 404)
    return
  }
  if (!originAllowed(request)) {
    rejectUpgrade(socket, 403)
    return
  }
  if (url.pathname === '/control') {
    presenceServer.handleUpgrade(request, socket, head, handlePresence)
  } else {
    handleViewer(request, socket, head, url).catch(() => socket.destroy())
  }
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
  tls = start.tls !== undefined
  // the host name is shown on the sign-in form without needing scripts or a request
  indexHTML = readFileSync(path.join(start.viewerDir, 'index.html'), 'utf8').replace(
    '<!--hostname-->',
    start.hostname ? escapeHTML(start.hostname) : '&nbsp;',
  )

  const server: Server = tls
    ? createHTTPSServer({ cert: start.tls!.cert, key: start.tls!.key, minVersion: 'TLSv1.2' })
    : createHTTPServer()
  server.headersTimeout = 20_000
  server.requestTimeout = 30_000

  server.on('connection', (socket: Socket) => tuneSocket(socket))
  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://gateway')
    const handler =
      request.method === 'GET' || request.method === 'HEAD'
        ? handleGet(request, response, url)
        : request.method === 'POST'
          ? handlePost(request, response, url)
          : Promise.resolve(send(response, 405, errorPage(405), { Allow: 'GET, POST' }))
    handler.catch((e) => {
      log.error(`Request failed: ${e.message}`)
      if (!response.headersSent) {
        send(response, 500, errorPage(500))
      }
    })
  })
  server.on('upgrade', handleUpgrade)
  server.on('clientError', (_error, socket) => socket.destroy())

  server.listen(listener, () => {
    const address = listener.address()
    const where = typeof address === 'object' && address ? `${address.address}:${address.port}` : `${address}`
    log.info(`Listening on ${tls ? 'https' : 'http'}://${where}`)
    if (!tls) {
      log.warn(
        '!!! PLAINTEXT MODE: passwords and sessions travel unencrypted. Only use this on a trusted home LAN. !!!',
      )
    }
    if (start.devMode) {
      log.warn('!!! DEV AUTH MODE: no PAM, sessions run as the current user. Never use this outside development. !!!')
    }
  })
}
