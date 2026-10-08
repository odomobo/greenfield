/**
 * The web listener (nebula-web): accepts TCP connections and starts a fresh worker process (web-worker.ts) for each,
 * which does everything network-facing for that one connection (TLS, the page, the sign-in, the relay to the desktop)
 * and exits when it closes. The listener never reads network data: connections are accepted paused and handed over
 * as they are. So an exploit in the network-facing code reaches only the attacker's own connection.
 *
 * Started by a login helper (packages/login: the dev helper, or the production one of step 5 of SIGNIN-ROADMAP.md)
 * with the listening TCP socket as an inherited fd and where the helper's login.sock is (see `usage`). For each
 * connection the listener:
 *
 *   - refuses it if it's over the connection caps (in all, and per client IP);
 *   - connects to login.sock and writes the client's address (the login protocol's ClientAddress record, from the
 *     accepted socket's peer address): the worker can't choose the IP that the helper (PAM, the takeover message)
 *     sees. Not when the IP is throttled (the worker then refuses any sign-in without asking the helper);
 *   - starts the worker with the TCP connection as fd 3, the helper connection as fd 4 and a Node IPC channel, on which
 *     it sends `WorkerStart` (the TLS certificate and key, the page) and hears of refused sign-ins (`WorkerReport`).
 *
 * Failed sign-ins are throttled per IP here (until the helper does it, step 10), generously, since many users may
 * share an address (NAT). No per-user throttling: per-account lockout is PAM's job (pam_faillock).
 *
 * Every TCP connection costs a Node process (about 50 ms to start and 30–50 MB) and a forked child in the helper,
 * waiting for the Begin record that comes only if the connection becomes a sign-in. A page load opens a few
 * connections (the page and its files, then the WebSocket).
 */
import { ChildProcess, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { createServer, Socket } from 'node:net'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { log } from './log'
import { encodeRecord, fdPassing, Kind } from './login-protocol'
import { escapeHTML } from './pages'
import { RateLimiter } from './rate-limit'
import { loadTLS } from './tls'
import type { WorkerReport, WorkerStart } from './web-worker'

/** workers alive at once, in all and per client IP (a browser opens about 6 connections per site) */
export const MAX_WORKERS = 256
export const MAX_WORKERS_PER_IP = 32
const workerScript = path.join(__dirname, 'web-worker.js')

const usage = `Usage: web.js --listen-fd <fd> --login-socket <path> [options]

Started by a login helper (packages/login), which passes these on from its own command line:
  --listen-fd <fd>           the listening TCP socket, inherited
  --login-socket <path>      the login helper's socket
  --cert <file> --key <file> TLS certificate and key (default: generate a self-signed one in the state dir)
  --state-dir <dir>          where the generated certificate is kept (default /var/lib/greenfield)
  --hide-hostname            don't show the host name on the sign-in page
  --allowed-origin <origin>  additionally accepted Origin (repeatable), e.g. https://desktop.example.com
`

/** Counts the workers alive, in all and per client IP, against the caps. */
export class WorkerCount {
  private total = 0
  private readonly perIP = new Map<string, number>()

  constructor(
    private readonly max: number,
    private readonly maxPerIP: number,
  ) {}

  /** Count one more worker for `ip`, unless that's over a cap: whether it was counted. */
  add(ip: string): boolean {
    const forIP = this.perIP.get(ip) ?? 0
    if (this.total >= this.max || forIP >= this.maxPerIP) {
      return false
    }
    this.total++
    this.perIP.set(ip, forIP + 1)
    return true
  }

  remove(ip: string) {
    const forIP = this.perIP.get(ip) ?? 0
    if (forIP <= 0) {
      return
    }
    this.total--
    if (forIP === 1) {
      this.perIP.delete(ip)
    } else {
      this.perIP.set(ip, forIP - 1)
    }
  }

  get size(): number {
    return this.total
  }
}

/** The client's address as text, IPv4 without the IPv6 mapping prefix. */
export function clientIP(address: string): string {
  return address.startsWith('::ffff:') && address.includes('.') ? address.slice('::ffff:'.length) : address
}

type Settings = Omit<WorkerStart, 'type' | 'signIn'> & { loginSocket: string }

async function main(argv: string[]) {
  process.title = 'nebula-web'
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
  const viewerDir = path.resolve(__dirname, '../../viewer/dist')
  const host = values['hide-hostname'] ? undefined : hostname()
  const settings: Settings = {
    tls,
    // the host name is shown on the sign-in form without needing scripts or a request
    indexHTML: readFileSync(path.join(viewerDir, 'index.html'), 'utf8').replace(
      '<!--hostname-->',
      host ? escapeHTML(host) : '&nbsp;',
    ),
    allowedOrigins: values['allowed-origin'] as string[],
    viewerDir,
    loginSocket: path.resolve(values['login-socket']),
  }
  listen(fd, settings)
}

function listen(fd: number, settings: Settings) {
  const ipFailures = new RateLimiter(20)
  const workers = new WorkerCount(MAX_WORKERS, MAX_WORKERS_PER_IP)
  let refusedAt = 0

  const server = createServer({ pauseOnConnect: true }, (socket: Socket) => {
    const address = socket.remoteAddress
    if (address === undefined) {
      // gone already
      socket.destroy()
      return
    }
    const ip = clientIP(address)
    if (!workers.add(ip)) {
      socket.destroy()
      // (at most once a second: a flood mustn't flood the log too)
      if (Date.now() - refusedAt > 1000) {
        refusedAt = Date.now()
        log.warn(`Too many connections (${workers.size} in all); refused one from ${ip}.`)
      }
      return
    }
    let worker: ChildProcess
    try {
      worker = startWorker(socket, ip, settings, ipFailures)
    } catch (e: any) {
      workers.remove(ip)
      log.error(`Starting a worker failed: ${e.message}`)
      return
    }
    worker.once('exit', () => workers.remove(ip))
  })
  server.on('error', (e) => {
    log.error(`Listening failed: ${e.message}`)
    process.exit(1)
  })
  server.listen({ fd }, () => {
    const address = server.address()
    const where = typeof address === 'object' && address ? `${address.address}:${address.port}` : `${address}`
    log.info(`Listening on https://${where}`)
  })
}

/**
 * Start a worker for the accepted (paused, unread) `socket`: open its helper connection and write the client's
 * address to it, hand it both, and send it its settings. Our copies of both connections are closed here.
 */
function startWorker(socket: Socket, ip: string, settings: Settings, ipFailures: RateLimiter): ChildProcess {
  const { unixConnect, sendWithFd, closeFd } = fdPassing()
  let signIn: WorkerStart['signIn'] = 'helper'
  let helperFd = -1
  if (ipFailures.blocked(ip)) {
    signIn = 'blocked'
  } else {
    helperFd = unixConnect(settings.loginSocket)
    if (helperFd < 0) {
      log.error(`Connecting to the login helper failed (errno ${-helperFd}).`)
      signIn = 'unavailable'
    } else {
      const record = encodeRecord({ kind: Kind.ClientAddress, address: ip })
      // (a fresh socket: a record fits in its buffer)
      if (sendWithFd(helperFd, record, -1) !== record.length) {
        log.error('Writing to the login helper failed.')
        closeFd(helperFd)
        helperFd = -1
        signIn = 'unavailable'
      }
    }
  }
  let worker: ChildProcess
  try {
    // fd 3: the TCP connection, fd 4: the helper connection, then the IPC channel
    worker = spawn(process.execPath, [workerScript], {
      stdio: ['ignore', 'inherit', 'inherit', socket, helperFd >= 0 ? helperFd : 'ignore', 'ipc'],
    })
  } finally {
    // the worker has its own copies now
    socket.destroy()
    if (helperFd >= 0) {
      closeFd(helperFd)
    }
  }
  let reported = false
  worker.on('message', (message: WorkerReport) => {
    // one sign-in per worker, so at most one failure: a worker can't throttle anyone but its own IP
    if (message?.type === 'refused' && !reported) {
      reported = true
      ipFailures.fail(ip)
    }
  })
  worker.on('error', (e) => {
    log.error(`Worker: ${e.message}`)
    if (worker.pid === undefined) {
      // it never started, so it won't exit
      worker.emit('exit', null, null)
    }
  })
  const { loginSocket: _, ...start } = settings
  worker.send({ type: 'start', ...start, signIn } satisfies WorkerStart)
  return worker
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    log.error(e.message)
    process.exit(2)
  })
}
