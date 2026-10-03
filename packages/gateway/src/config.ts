import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { isIP } from 'node:net'

export type AuthMode = 'pam' | 'dev'

export type GatewayConfig = {
  bindIP: string
  bindPort: number
  /** TLS unless --insecure-plaintext */
  tls: boolean
  certFile?: string
  keyFile?: string
  stateDir: string
  runtimeDir: string
  authMode: AuthMode
  /** dev auth: the only accepted user (the current user) and password */
  devUser?: string
  devPassword?: string
  /** unprivileged user the web process runs as (real mode) */
  webUser: string
  hostname?: string
  /** extra origins allowed besides the request's own host (e.g. behind a reverse proxy) */
  allowedOrigins: string[]
  encoder: 'x264' | 'nvh264' | 'vaapih264'
  renderDevice: string
  viewerDir: string
}

const usage = `Usage: gateway [options]

  --bind-ip <ip>             address to listen on (default 0.0.0.0)
  --bind-port <port>         port to listen on (default 8443)
  --cert <file> --key <file> TLS certificate and key (default: generate a self-signed one in the state dir)
  --insecure-plaintext       serve plain HTTP. Only allowed on loopback/private addresses. For home LANs.
  --state-dir <dir>          where generated certificates are kept
                             (default /var/lib/greenfield, or ~/.local/state/greenfield-dev with --dev-auth)
  --web-user <name>          unprivileged user for the web process (default greenfield)
  --hide-hostname            don't show the host name on the login page
  --allowed-origin <origin>  additionally accepted Origin (repeatable), e.g. https://desktop.example.com
  --encoder <x264|nvh264|vaapih264>
  --render-device <path>     (default /dev/dri/renderD128)
  --dev-auth                 DEVELOPMENT ONLY: no PAM, no privilege separation. Sessions run as the current user,
                             who logs in with the password from $GREENFIELD_DEV_PASSWORD. Loopback only.
`

function fail(message: string): never {
  console.error(`gateway: ${message}\n\n${usage}`)
  process.exit(2)
}

/** Loopback, RFC 1918, link-local and IPv6 unique-local addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase()
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')
  }
  return false
}

export function isLoopbackAddress(ip: string): boolean {
  return (isIP(ip) === 4 && ip.startsWith('127.')) || ip === '::1'
}

export function parseConfig(argv: string[]): GatewayConfig {
  if (argv.some((arg) => arg === '--applications' || arg.startsWith('--applications='))) {
    fail('--applications was removed: the Apps menu lists the installed applications (their .desktop files)')
  }
  let values
  try {
    values = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        help: { type: 'boolean', short: 'h' },
        'bind-ip': { type: 'string', default: '0.0.0.0' },
        'bind-port': { type: 'string', default: '8443' },
        cert: { type: 'string' },
        key: { type: 'string' },
        'insecure-plaintext': { type: 'boolean', default: false },
        'state-dir': { type: 'string' },
        'web-user': { type: 'string', default: 'greenfield' },
        'hide-hostname': { type: 'boolean', default: false },
        'allowed-origin': { type: 'string', multiple: true, default: [] },
        encoder: { type: 'string', default: 'x264' },
        'render-device': { type: 'string', default: '/dev/dri/renderD128' },
        'dev-auth': { type: 'boolean', default: false },
      },
    }).values
  } catch (e: any) {
    fail(e.message)
  }
  if (values.help) {
    console.log(usage)
    process.exit(0)
  }

  const bindIP = values['bind-ip']!
  const bindPort = Number(values['bind-port'])
  if (!Number.isInteger(bindPort) || bindPort <= 0 || bindPort > 65535) {
    fail('invalid --bind-port')
  }
  if (isIP(bindIP) === 0) {
    fail('--bind-ip must be an IP address')
  }

  const tls = !values['insecure-plaintext']
  if (!tls && !isPrivateAddress(bindIP)) {
    fail('--insecure-plaintext is only allowed when binding to a loopback or private address (not 0.0.0.0)')
  }
  if ((values.cert === undefined) !== (values.key === undefined)) {
    fail('--cert and --key must be given together')
  }

  const authMode: AuthMode = values['dev-auth'] ? 'dev' : 'pam'
  let devUser: string | undefined
  let devPassword: string | undefined
  if (authMode === 'dev') {
    if (process.getuid?.() === 0) {
      fail('--dev-auth must not run as root')
    }
    if (!isLoopbackAddress(bindIP)) {
      fail('--dev-auth only listens on loopback (use --bind-ip 127.0.0.1)')
    }
    devPassword = process.env.GREENFIELD_DEV_PASSWORD
    if (devPassword === undefined || devPassword.length < 8) {
      fail('--dev-auth needs GREENFIELD_DEV_PASSWORD (at least 8 characters)')
    }
    devUser = require('node:os').userInfo().username as string
  } else if (process.getuid?.() !== 0) {
    fail('PAM mode must be started as root (it drops privileges itself). For development use --dev-auth.')
  }

  const home = process.env.HOME ?? '/tmp'
  const stateDir =
    values['state-dir'] ??
    (authMode === 'dev' ? `${process.env.XDG_STATE_HOME ?? `${home}/.local/state`}/greenfield-dev` : '/var/lib/greenfield')
  const runtimeDir =
    authMode === 'dev'
      ? `${process.env.XDG_RUNTIME_DIR ?? '/tmp'}/greenfield-dev-${bindPort}`
      : '/run/greenfield'

  const encoder = values.encoder
  if (encoder !== 'x264' && encoder !== 'nvh264' && encoder !== 'vaapih264') {
    fail('invalid --encoder')
  }

  return {
    bindIP,
    bindPort,
    tls,
    certFile: values.cert,
    keyFile: values.key,
    stateDir,
    runtimeDir,
    authMode,
    devUser,
    devPassword,
    webUser: values['web-user']!,
    hostname: values['hide-hostname'] ? undefined : hostname(),
    allowedOrigins: values['allowed-origin'] as string[],
    encoder,
    renderDevice: values['render-device']!,
    viewerDir: require('node:path').resolve(__dirname, '../../viewer/dist'),
  }
}
