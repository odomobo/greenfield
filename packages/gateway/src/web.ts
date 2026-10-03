/**
 * The web process: everything network-facing, running unprivileged. TLS, the login and session pages, cookies,
 * CSRF and Origin checks, rate limiting, the viewer's static files, and relaying authenticated viewer WebSockets
 * and app launches to the user's session process over its Unix socket.
 *
 * It knows users only through tickets the monitor hands out on successful authentication.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer as createHTTPServer, IncomingMessage, request as httpRequest, Server, ServerResponse } from 'node:http'
import { createServer as createHTTPSServer } from 'node:https'
import { connect, Server as NetServer, Socket } from 'node:net'
import path from 'node:path'
import { AppConfigSchema } from './app-config'
import { MonitorReply, MonitorReplyEnvelope, WebRequest, WebStart } from './ipc'
import { log } from './log'
import { errorPage, loginPage, sessionsPage } from './pages'
import { RateLimiter } from './rate-limit'

process.title = 'gateway-web'

const MIN_FAILED_LOGIN_MS = 3000
const SESSION_IDLE_MS = 12 * 3600 * 1000
const SESSION_MAX_MS = 7 * 24 * 3600 * 1000
const MAX_FORM_BODY = 4096
const TCP_NOTSENT_LOWAT_BYTES = 32 * 1024
const staticDir = path.resolve(__dirname, '../static')

type LoginSession = {
  ticket: string
  username: string
  csrf: string
  createdAt: number
  lastSeen: number
}

let start!: WebStart
const loginSessions = new Map<string, LoginSession>()
const failures = new RateLimiter()

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

let tls = false
let cookieName = 'gf_session'
let loginCookieName = 'gf_login'

function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; " +
      "worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // not no-referrer: that makes browsers send "Origin: null" on form posts, which the Origin check needs
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

function redirect(response: ServerResponse, location: string, headers: Record<string, string> = {}) {
  response.writeHead(303, { ...securityHeaders(), Location: location, 'Cache-Control': 'no-store', ...headers }).end()
}

function cookie(name: string, value: string, maxAgeSeconds?: number): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    ...(tls ? ['Secure'] : []),
    ...(maxAgeSeconds !== undefined ? [`Max-Age=${maxAgeSeconds}`] : []),
  ].join('; ')
}

function readCookies(request: IncomingMessage): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index > 0) {
      cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim()
    }
  }
  return cookies
}

function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) {
    return false
  }
  const bufferA = Buffer.from(a)
  const bufferB = Buffer.from(b)
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB)
}

function loginSession(request: IncomingMessage): [string, LoginSession] | undefined {
  const token = readCookies(request)[cookieName]
  if (token === undefined) {
    return undefined
  }
  const entry = loginSessions.get(token)
  if (entry === undefined) {
    return undefined
  }
  const now = Date.now()
  if (now - entry.lastSeen > SESSION_IDLE_MS || now - entry.createdAt > SESSION_MAX_MS) {
    loginSessions.delete(token)
    void monitor({ type: 'logout', ticket: entry.ticket })
    return undefined
  }
  entry.lastSeen = now
  return [token, entry]
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

function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    if (!(request.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
      reject(new Error('not a form'))
      return
    }
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_FORM_BODY) {
        reject(new Error('form too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))))
    request.on('error', reject)
  })
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
      if (size > MAX_FORM_BODY) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
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
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

function serveFile(response: ServerResponse, root: string, relative: string, cache: boolean) {
  const resolved = path.resolve(root, '.' + path.posix.normalize('/' + relative))
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    send(response, 404, errorPage(404))
    return
  }
  let file = resolved
  if (existsSync(file) && statSync(file).isDirectory()) {
    file = path.join(file, 'index.html')
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    send(response, 404, errorPage(404))
    return
  }
  response.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': contentTypes[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': cache ? 'private, max-age=3600' : 'no-store',
  })
  createReadStream(file).pipe(response)
}

// --- routes ---

async function handleLoginPost(request: IncomingMessage, response: ServerResponse) {
  const startedAt = Date.now()
  const respondFailure = async (username: string, message: string) => {
    // failures take the same minimum time whatever the reason
    const wait = MIN_FAILED_LOGIN_MS - (Date.now() - startedAt)
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
    const csrf = randomBytes(24).toString('base64url')
    send(response, 200, loginPage({ hostname: start.hostname, csrf, username, error: message }), {
      'Set-Cookie': cookie(loginCookieName, csrf),
    })
  }

  let form: URLSearchParams
  try {
    form = await readForm(request)
  } catch {
    send(response, 400, errorPage(400))
    return
  }
  const username = (form.get('username') ?? '').trim().slice(0, 64)
  const password = form.get('password') ?? ''

  if (!originAllowed(request) || !safeEqual(form.get('csrf') ?? undefined, readCookies(request)[loginCookieName])) {
    await respondFailure(username, 'Your sign-in form expired. Please try again.')
    return
  }

  const ip = clientIP(request)
  const userKey = `user:${username.toLowerCase()}`
  if (failures.blocked(`ip:${ip}`) || failures.blocked(userKey)) {
    await respondFailure(username, 'Too many failed attempts. Try again in a few minutes.')
    return
  }

  const reply =
    username.length > 0 && password.length > 0 && password.length <= 1024
      ? await monitor({ type: 'auth', username, password })
      : ({ ok: false, error: 'auth-failed' } as const)

  if (!reply.ok || reply.type !== 'auth') {
    failures.fail(`ip:${ip}`)
    failures.fail(userKey)
    log.info(`Failed login from ${ip}.`)
    await respondFailure(username, 'The username or password is incorrect.')
    return
  }

  failures.succeed(userKey)
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  loginSessions.set(token, {
    ticket: reply.ticket,
    username: reply.username,
    csrf: randomBytes(24).toString('base64url'),
    createdAt: now,
    lastSeen: now,
  })
  response.setHeader('Set-Cookie', [cookie(cookieName, token, SESSION_MAX_MS / 1000), cookie(loginCookieName, '', 0)])
  redirect(response, '/sessions')
}

async function handleSessionsPage(response: ServerResponse, session: LoginSession, error?: string) {
  const reply = await monitor({ type: 'listSessions', ticket: session.ticket })
  if (!reply.ok || reply.type !== 'sessions') {
    redirect(response, '/login')
    return
  }
  send(
    response,
    200,
    sessionsPage({ username: session.username, hostname: start.hostname, csrf: session.csrf, sessions: reply.sessions, error }),
  )
}

async function handlePost(request: IncomingMessage, response: ServerResponse, url: URL) {
  if (url.pathname === '/login') {
    await handleLoginPost(request, response)
    return
  }

  const current = loginSession(request)
  if (!originAllowed(request) || current === undefined) {
    send(response, 403, errorPage(403))
    return
  }
  const [token, session] = current

  if (url.pathname.startsWith('/api/')) {
    if (!safeEqual(request.headers['x-csrf-token'] as string | undefined, session.csrf)) {
      sendJSON(response, 403, { error: 'forbidden' })
      return
    }
    const launch = /^\/api\/sessions\/([A-Za-z0-9_-]{1,64})\/launch$/.exec(url.pathname)
    if (launch) {
      await handleLaunch(request, response, session, launch[1])
      return
    }
    sendJSON(response, 404, { error: 'not found' })
    return
  }

  let form: URLSearchParams
  try {
    form = await readForm(request)
  } catch {
    send(response, 400, errorPage(400))
    return
  }
  if (!safeEqual(form.get('csrf') ?? undefined, session.csrf)) {
    send(response, 403, errorPage(403))
    return
  }

  switch (url.pathname) {
    case '/logout':
      loginSessions.delete(token)
      await monitor({ type: 'logout', ticket: session.ticket })
      redirect(response, '/login', { 'Set-Cookie': cookie(cookieName, '', 0) })
      return
    case '/sessions/new': {
      const reply = await monitor({ type: 'createSession', ticket: session.ticket })
      if (!reply.ok || reply.type !== 'session') {
        await handleSessionsPage(response, session, 'The session could not be started.')
        return
      }
      redirect(response, `/desktop/?session=${encodeURIComponent(reply.session.id)}`)
      return
    }
    case '/sessions/end': {
      await monitor({ type: 'endSession', ticket: session.ticket, sessionId: form.get('session') ?? '' })
      redirect(response, '/sessions')
      return
    }
  }
  send(response, 404, errorPage(404))
}

async function handleLaunch(request: IncomingMessage, response: ServerResponse, session: LoginSession, sessionId: string) {
  let body: any
  try {
    body = await readJSONBody(request)
  } catch {
    sendJSON(response, 400, { error: 'bad request' })
    return
  }
  const app = (start.applications as AppConfigSchema)[typeof body?.app === 'string' ? body.app : '']
  if (app === undefined) {
    sendJSON(response, 404, { error: 'unknown application' })
    return
  }
  const reply = await monitor({ type: 'sessionSocket', ticket: session.ticket, sessionId })
  if (!reply.ok || reply.type !== 'socket') {
    sendJSON(response, 404, { error: 'not found' })
    return
  }
  const payload = JSON.stringify({ name: app.name, executable: app.executable, args: app.args, env: app.env })
  const upstream = httpRequest(
    {
      socketPath: reply.path,
      path: '/launch',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 15_000,
    },
    (upstreamResponse) => {
      upstreamResponse.resume()
      sendJSON(response, upstreamResponse.statusCode === 201 ? 201 : 500, {
        ok: upstreamResponse.statusCode === 201,
      })
    },
  )
  upstream.on('error', () => {
    if (!response.headersSent) {
      sendJSON(response, 502, { error: 'session unavailable' })
    }
  })
  upstream.end(payload)
}

async function handleGet(request: IncomingMessage, response: ServerResponse, url: URL) {
  if (url.pathname.startsWith('/static/')) {
    serveFile(response, staticDir, url.pathname.slice('/static/'.length), true)
    return
  }

  const current = loginSession(request)

  if (url.pathname === '/login') {
    if (current) {
      redirect(response, '/sessions')
      return
    }
    const csrf = randomBytes(24).toString('base64url')
    send(response, 200, loginPage({ hostname: start.hostname, csrf }), { 'Set-Cookie': cookie(loginCookieName, csrf) })
    return
  }

  if (current === undefined) {
    if (url.pathname.startsWith('/api/')) {
      sendJSON(response, 401, { error: 'unauthenticated' })
    } else if (url.pathname === '/' || url.pathname === '/sessions' || url.pathname.startsWith('/desktop')) {
      redirect(response, '/login')
    } else {
      // not a page: no redirect (a background fetch like /favicon.ico following it would reset the login form's
      // CSRF cookie)
      send(response, 404, errorPage(404))
    }
    return
  }
  const [, session] = current

  if (url.pathname === '/' || url.pathname === '/sessions') {
    await handleSessionsPage(response, session)
    return
  }
  if (url.pathname === '/desktop') {
    redirect(response, `/desktop/${url.search}`)
    return
  }
  if (url.pathname.startsWith('/desktop/')) {
    serveFile(response, start.viewerDir, url.pathname.slice('/desktop/'.length), false)
    return
  }
  if (url.pathname === '/api/me') {
    sendJSON(response, 200, { username: session.username, csrf: session.csrf })
    return
  }
  if (url.pathname === '/api/sessions') {
    const reply = await monitor({ type: 'listSessions', ticket: session.ticket })
    sendJSON(response, 200, reply.ok && reply.type === 'sessions' ? reply.sessions : [])
    return
  }
  if (url.pathname === '/api/apps') {
    sendJSON(
      response,
      200,
      Object.entries(start.applications as AppConfigSchema).map(([key, { name }]) => ({ path: key, name })),
    )
    return
  }
  send(response, 404, errorPage(404))
}

function rejectUpgrade(socket: Socket, status: number) {
  socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Not Found'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/**
 * Viewer WebSocket: authenticate, check the session belongs to the user, then relay bytes to the session's Unix
 * socket. The session process does the WebSocket handshake itself; TLS ends here, so its key never leaves this
 * process.
 */
async function handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer) {
  socket.on('error', () => socket.destroy())
  const url = new URL(request.url ?? '/', 'http://gateway')
  if (url.pathname !== '/ws') {
    rejectUpgrade(socket, 404)
    return
  }
  if (!originAllowed(request)) {
    rejectUpgrade(socket, 403)
    return
  }
  const current = loginSession(request)
  if (current === undefined) {
    rejectUpgrade(socket, 401)
    return
  }
  const [, session] = current
  const sessionId = url.searchParams.get('session') ?? ''
  const reply = await monitor({ type: 'sessionSocket', ticket: session.ticket, sessionId })
  if (!reply.ok || reply.type !== 'socket') {
    rejectUpgrade(socket, 404)
    return
  }

  const upstream = connect(reply.path)
  const destroyBoth = () => {
    socket.destroy()
    upstream.destroy()
  }
  upstream.on('error', destroyBoth)
  socket.on('error', destroyBoth)
  upstream.on('close', destroyBoth)
  socket.on('close', destroyBoth)
  upstream.once('connect', () => {
    const forwarded = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol']
    const lines = ['GET /viewer HTTP/1.1', 'Host: session', 'Upgrade: websocket', 'Connection: Upgrade']
    for (const name of forwarded) {
      const value = request.headers[name]
      if (typeof value === 'string' && !/[\r\n]/.test(value)) {
        lines.push(`${name}: ${value}`)
      }
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n')
    if (head.length > 0) {
      upstream.write(head)
    }
    socket.pipe(upstream)
    upstream.pipe(socket)
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
    const { setTcpNotSentLowat } = require('@gfld/compositor-proxy/dist/socket-options.js')
    setTcpNotSentLowat(fd, TCP_NOTSENT_LOWAT_BYTES)
  } catch {
    // tuning only
  }
}

function serve(listener: NetServer) {
  tls = start.tls !== undefined
  cookieName = tls ? '__Host-gf_session' : 'gf_session'
  loginCookieName = tls ? '__Host-gf_login' : 'gf_login'

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
  server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    handleUpgrade(request, socket, head).catch(() => socket.destroy())
  })
  server.on('clientError', (_error, socket) => socket.destroy())

  server.listen(listener, () => {
    const address = listener.address()
    const where = typeof address === 'object' && address ? `${address.address}:${address.port}` : `${address}`
    log.info(`Listening on ${tls ? 'https' : 'http'}://${where}`)
    if (!tls) {
      log.warn('!!! PLAINTEXT MODE: passwords and sessions travel unencrypted. Only use this on a trusted home LAN. !!!')
    }
    if (start.devMode) {
      log.warn('!!! DEV AUTH MODE: no PAM, sessions run as the current user. Never use this outside development. !!!')
    }
  })
}
