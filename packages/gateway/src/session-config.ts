/**
 * What a session process is started with: the `SessionConfig` record, passed on an extra pipe at fd 3 (the session
 * reads it once at startup, then closes the fd). Written by whatever starts the session: the monitor now, the dev and
 * production login helpers (Rust) later. The session has no other start-up input and no dev mode of its own.
 *
 * Wire format (version 1):
 *
 *   - one UTF-8 JSON object, no framing: the writer writes it and closes its end, EOF ends the record;
 *   - at most MAX_SESSION_CONFIG_BYTES (16384) bytes; a longer record is rejected;
 *   - keys (unknown keys are ignored, so a later writer may add some):
 *
 *       version             number, required, must be 1
 *       socketPath          string, required: where the session listens for the viewer connection (a Unix socket
 *                           path; replaced by an inherited listening fd in the login-protocol step)
 *       siteSettingsPath    string, optional: the site settings file the session reads itself (see site-settings.ts).
 *                           Missing: the default path, /etc/nebula/nebula.conf. A missing file means all defaults.
 *       devFlags            object, optional, written only by the dev helper. Missing: production behavior. Keys, all
 *                           optional:
 *         timeScale         number 1..100, default 1: divides how long apps get to quit when the session ends
 *         linkKbps          number >= 0, default 0: simulate a link to the viewer of this many kbit/s (0: none)
 *         patchOrder        'oldest' (default) or 'random': the order a window's queued patches are sent in
 *         patchShape        'bands' (default) or 'tiles': how a window's large damage is split into patches
 *
 * The session process finds it on fd 3; the starter must keep fd 3 open across any exec in between (the PAM helper
 * execs the command with its fds intact). Fd 4 carries the Node IPC channel for now (ready signal; the session ends
 * when the starter goes away), until the login helper replaces the monitor.
 */
import { createReadStream } from 'node:fs'

export const SESSION_CONFIG_FD = 3
export const MAX_SESSION_CONFIG_BYTES = 16384
export const DEFAULT_SITE_SETTINGS_PATH = '/etc/nebula/nebula.conf'

export type DevFlags = {
  timeScale: number
  linkKbps: number
  patchOrder: 'oldest' | 'random'
  patchShape: 'bands' | 'tiles'
}

export const DEFAULT_DEV_FLAGS: DevFlags = { timeScale: 1, linkKbps: 0, patchOrder: 'oldest', patchShape: 'bands' }

export type SessionConfig = {
  version: 1
  socketPath: string
  siteSettingsPath?: string
  devFlags?: Partial<DevFlags>
}

/** Parse and validate a record; throws an Error saying what is wrong. Returns the config and the dev flags filled in. */
export function parseSessionConfig(text: string): { config: SessionConfig; devFlags: DevFlags } {
  let value: any
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('not JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('not an object')
  }
  if (value.version !== 1) {
    throw new Error('unsupported version')
  }
  if (typeof value.socketPath !== 'string' || value.socketPath.length === 0) {
    throw new Error('socketPath missing')
  }
  if (value.siteSettingsPath !== undefined && typeof value.siteSettingsPath !== 'string') {
    throw new Error('invalid siteSettingsPath')
  }
  const devFlags = { ...DEFAULT_DEV_FLAGS }
  const dev = value.devFlags
  if (dev !== undefined) {
    if (typeof dev !== 'object' || dev === null || Array.isArray(dev)) {
      throw new Error('invalid devFlags')
    }
    if (dev.timeScale !== undefined) {
      if (typeof dev.timeScale !== 'number' || !(dev.timeScale >= 1 && dev.timeScale <= 100)) {
        throw new Error('invalid devFlags.timeScale')
      }
      devFlags.timeScale = dev.timeScale
    }
    if (dev.linkKbps !== undefined) {
      if (typeof dev.linkKbps !== 'number' || !(dev.linkKbps >= 0 && Number.isFinite(dev.linkKbps))) {
        throw new Error('invalid devFlags.linkKbps')
      }
      devFlags.linkKbps = dev.linkKbps
    }
    if (dev.patchOrder !== undefined) {
      if (dev.patchOrder !== 'oldest' && dev.patchOrder !== 'random') {
        throw new Error('invalid devFlags.patchOrder')
      }
      devFlags.patchOrder = dev.patchOrder
    }
    if (dev.patchShape !== undefined) {
      if (dev.patchShape !== 'bands' && dev.patchShape !== 'tiles') {
        throw new Error('invalid devFlags.patchShape')
      }
      devFlags.patchShape = dev.patchShape
    }
  }
  return { config: value as SessionConfig, devFlags }
}

/** Read the record from fd 3 to EOF (at most MAX_SESSION_CONFIG_BYTES), then close the fd. */
export function readSessionConfig(fd: number = SESSION_CONFIG_FD): Promise<{ config: SessionConfig; devFlags: DevFlags }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const stream = createReadStream('', { fd, autoClose: true })
    stream.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_SESSION_CONFIG_BYTES) {
        stream.destroy(new Error('session config too long'))
        return
      }
      chunks.push(chunk as Buffer)
    })
    stream.once('error', (e) => reject(new Error(`reading the session config from fd ${fd}: ${e.message}`)))
    stream.once('end', () => {
      try {
        resolve(parseSessionConfig(Buffer.concat(chunks).toString('utf8')))
      } catch (e: any) {
        reject(new Error(`invalid session config: ${e.message}`))
      }
    })
  })
}
