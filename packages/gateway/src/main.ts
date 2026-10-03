#!/usr/bin/env node
/**
 * Gateway entry point. Starts the monitor (privileged in PAM mode), which starts the unprivileged web process and,
 * on demand, per-user session processes.
 */
import { parseConfig } from './config'
import { log } from './log'
import { Monitor } from './monitor'

process.title = 'gateway'

const config = parseConfig(process.argv.slice(2))
new Monitor(config).start().catch((e) => {
  log.error(e.message)
  process.exit(1)
})
