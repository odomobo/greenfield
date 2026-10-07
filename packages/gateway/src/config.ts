import { parseArgs } from 'node:util'
import { hostname, userInfo } from 'node:os'
import { resolve } from 'node:path'
import { isIP } from 'node:net'
import { ENCODER_OPTIONS, EncoderOption } from './encoder'

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
  /** the `--encoder` option as given, if any: overrides the site settings file (`auto` is resolved by the session) */
  encoder?: EncoderOption
  /** the `--render-device` option as given, if any */
  renderDevice?: string
  /** the site settings file sessions read (--site-config); undefined: they use their default path */
  siteConfig?: string
  viewerDir: string
  /** dev auth only: divides the sign-in delays so tests run fast (1 = production timing) */
  timeScale: number
  /** dev auth only: sessions send to their viewer through a simulated link of this many kbit/s (0: none) */
  linkKbps: number
  /** dev auth only: the order surfaces send their queued patches in (an experiment) */
  patchOrder: 'oldest' | 'random'
  /** dev auth only: how windows' large damage is split into patches (an experiment) */
  patchShape: 'bands' | 'tiles'
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
  --site-config <file>       site settings file the sessions read (default /etc/nebula/nebula.conf; see
                             src/site-settings.ts for its format)
  --encoder <auto|none|nvh264|vaapih264>
                             video encoder for busy windows, overriding the site settings file (default there: auto,
                             vaapih264 or nvh264 if the machine has GPU acceleration, else none). With none everything
                             is sent as patches.
  --render-device <path>     GPU render node, overriding the site settings file (default /dev/dri/renderD128)
  --dev-auth                 DEVELOPMENT ONLY: no PAM, no privilege separation. Sessions run as the current user,
                             who logs in with the password from $GREENFIELD_DEV_PASSWORD. Loopback only.
  --dev-time-scale <n>       with --dev-auth only: divide the failed-sign-in delay and the presence timeouts by n (tests)
  --dev-link-kbps <n>        with --dev-auth only: sessions send to their viewer through a simulated link of n kbit/s
                             (a FIFO that drains at that rate), to try the encoding on a slow link (tests)
  --dev-patch-order <order>  with --dev-auth only: oldest (default) or random, the order a window's queued patches
                             are sent in (an experiment: what a slow repaint looks like in random order)
  --dev-patch-shape <shape>  with --dev-auth only: bands (default, full-width strips) or tiles (squarish, about
                             256 x 256), how a window's large damage is split into patches (an experiment)
`

function fail(message: string): never {
  console.error(`gateway: ${message}\n\n${usage}`)
  process.exit(2)
}

/** Loopback, RFC 1918, link-local and IPv6 unique-local addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
    )
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
        'site-config': { type: 'string' },
        encoder: { type: 'string' },
        'render-device': { type: 'string' },
        'dev-auth': { type: 'boolean', default: false },
        'dev-time-scale': { type: 'string', default: '1' },
        'dev-link-kbps': { type: 'string', default: '0' },
        'dev-patch-order': { type: 'string', default: 'oldest' },
        'dev-patch-shape': { type: 'string', default: 'bands' },
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

  const timeScale = Number(values['dev-time-scale'])
  if (!Number.isFinite(timeScale) || timeScale < 1 || timeScale > 100) {
    fail('invalid --dev-time-scale')
  }
  if (timeScale !== 1 && !values['dev-auth']) {
    fail('--dev-time-scale is only allowed together with --dev-auth')
  }
  const linkKbps = Number(values['dev-link-kbps'])
  if (!Number.isFinite(linkKbps) || linkKbps < 0) {
    fail('invalid --dev-link-kbps')
  }
  if (linkKbps !== 0 && !values['dev-auth']) {
    fail('--dev-link-kbps is only allowed together with --dev-auth')
  }
  const patchOrder = values['dev-patch-order']
  if (patchOrder !== 'oldest' && patchOrder !== 'random') {
    fail('invalid --dev-patch-order (oldest or random)')
  }
  if (patchOrder !== 'oldest' && !values['dev-auth']) {
    fail('--dev-patch-order is only allowed together with --dev-auth')
  }
  const patchShape = values['dev-patch-shape']
  if (patchShape !== 'bands' && patchShape !== 'tiles') {
    fail('invalid --dev-patch-shape (bands or tiles)')
  }
  if (patchShape !== 'bands' && !values['dev-auth']) {
    fail('--dev-patch-shape is only allowed together with --dev-auth')
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
    devUser = userInfo().username
  } else if (process.getuid?.() !== 0) {
    fail('PAM mode must be started as root (it drops privileges itself). For development use --dev-auth.')
  }

  const home = process.env.HOME ?? '/tmp'
  const stateDir =
    values['state-dir'] ??
    (authMode === 'dev'
      ? `${process.env.XDG_STATE_HOME ?? `${home}/.local/state`}/greenfield-dev`
      : '/var/lib/greenfield')
  const runtimeDir =
    authMode === 'dev' ? `${process.env.XDG_RUNTIME_DIR ?? '/tmp'}/greenfield-dev-${bindPort}` : '/run/greenfield'

  const encoder = values.encoder as EncoderOption | undefined
  if (encoder !== undefined && !ENCODER_OPTIONS.includes(encoder)) {
    fail('invalid --encoder (use auto, none, nvh264 or vaapih264)')
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
    timeScale,
    linkKbps,
    patchOrder,
    patchShape,
    devUser,
    devPassword,
    webUser: values['web-user']!,
    hostname: values['hide-hostname'] ? undefined : hostname(),
    allowedOrigins: values['allowed-origin'] as string[],
    encoder,
    renderDevice: values['render-device'],
    siteConfig: values['site-config'] === undefined ? undefined : resolve(values['site-config']),
    viewerDir: resolve(__dirname, '../../viewer/dist'),
  }
}
