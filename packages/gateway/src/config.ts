import { parseArgs } from 'node:util'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { isIP } from 'node:net'
import { ENCODER_OPTIONS, EncoderOption } from './encoder'

export type GatewayConfig = {
  bindIP: string
  bindPort: number
  certFile?: string
  keyFile?: string
  stateDir: string
  runtimeDir: string
  /** unprivileged user the web process runs as */
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
}

const usage = `Usage: gateway [options]

The production entry point (PAM, started as root), until the login helper replaces it. For development, start the dev
login helper instead (packages/login: nebula-dev-login, which has the --dev-* options).

  --bind-ip <ip>             address to listen on (default 0.0.0.0)
  --bind-port <port>         port to listen on (default 8443)
  --cert <file> --key <file> TLS certificate and key (default: generate a self-signed one in the state dir)
  --state-dir <dir>          where generated certificates are kept (default /var/lib/greenfield)
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
`

function fail(message: string): never {
  console.error(`gateway: ${message}\n\n${usage}`)
  process.exit(2)
}

export function parseConfig(argv: string[]): GatewayConfig {
  if (argv.some((arg) => arg === '--applications' || arg.startsWith('--applications='))) {
    fail('--applications was removed: the Apps menu lists the installed applications (their .desktop files)')
  }
  if (argv.some((arg) => arg.startsWith('--dev-'))) {
    fail('the --dev-* options moved to the dev login helper (packages/login: nebula-dev-login)')
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
        'state-dir': { type: 'string' },
        'web-user': { type: 'string', default: 'greenfield' },
        'hide-hostname': { type: 'boolean', default: false },
        'allowed-origin': { type: 'string', multiple: true, default: [] },
        'site-config': { type: 'string' },
        encoder: { type: 'string' },
        'render-device': { type: 'string' },
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

  if ((values.cert === undefined) !== (values.key === undefined)) {
    fail('--cert and --key must be given together')
  }

  if (process.getuid?.() !== 0) {
    fail('the gateway must be started as root (it drops privileges itself). For development use the dev login helper.')
  }

  const stateDir = values['state-dir'] ?? '/var/lib/greenfield'
  const runtimeDir = '/run/greenfield'

  const encoder = values.encoder as EncoderOption | undefined
  if (encoder !== undefined && !ENCODER_OPTIONS.includes(encoder)) {
    fail('invalid --encoder (use auto, none, nvh264 or vaapih264)')
  }

  return {
    bindIP,
    bindPort,
    certFile: values.cert,
    keyFile: values.key,
    stateDir,
    runtimeDir,
    webUser: values['web-user']!,
    hostname: values['hide-hostname'] ? undefined : hostname(),
    allowedOrigins: values['allowed-origin'] as string[],
    encoder,
    renderDevice: values['render-device'],
    siteConfig: values['site-config'] === undefined ? undefined : resolve(values['site-config']),
    viewerDir: resolve(__dirname, '../../viewer/dist'),
  }
}
