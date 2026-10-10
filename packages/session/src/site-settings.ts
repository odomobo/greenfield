/**
 * Site settings: what the administrator decides for the whole machine, in a root-owned file the session reads itself
 * (default /etc/nebula/nebula.conf, see SessionConfig.siteSettingsPath). A missing file means all defaults.
 *
 * Format: one `key = value` per line; blank lines and lines starting with `#` are ignored; whitespace around key and
 * value is trimmed; a later line replaces an earlier one. At most MAX_SITE_SETTINGS_BYTES (16384) bytes. Keys:
 *
 *   encoder        auto (default) | none | nvh264 | vaapih264: the video encoder for busy windows. auto picks a
 *                  hardware encoder if the machine has GPU acceleration, else none (everything is sent as PNG patches).
 *   render-device  path (default /dev/dri/renderD128): the GPU render node
 *
 * Unknown keys and invalid values are errors (a typo must not silently change the encoder).
 */
import { readFileSync, statSync } from 'node:fs'
import { ENCODER_OPTIONS, type EncoderOption } from '@nebula/video-codec'

export const MAX_SITE_SETTINGS_BYTES = 16384

export type SiteSettings = {
  encoder: EncoderOption
  renderDevice: string
}

export const DEFAULT_SITE_SETTINGS: SiteSettings = { encoder: 'auto', renderDevice: '/dev/dri/renderD128' }

export function parseSiteSettings(text: string): SiteSettings {
  const settings = { ...DEFAULT_SITE_SETTINGS }
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) {
      return
    }
    const eq = line.indexOf('=')
    if (eq < 0) {
      throw new Error(`line ${index + 1}: expected key = value`)
    }
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key === 'encoder') {
      if (!ENCODER_OPTIONS.includes(value as EncoderOption)) {
        throw new Error(`line ${index + 1}: invalid encoder "${value}" (use ${ENCODER_OPTIONS.join(', ')})`)
      }
      settings.encoder = value as EncoderOption
    } else if (key === 'render-device') {
      if (value === '') {
        throw new Error(`line ${index + 1}: empty render-device`)
      }
      settings.renderDevice = value
    } else {
      throw new Error(`line ${index + 1}: unknown setting "${key}"`)
    }
  })
  return settings
}

/** The settings in a file, or the defaults if it doesn't exist. Throws if it exists but can't be used. */
export function readSiteSettings(file: string): SiteSettings {
  let size: number
  try {
    size = statSync(file).size
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return { ...DEFAULT_SITE_SETTINGS }
    }
    throw new Error(`${file}: ${e.message}`)
  }
  if (size > MAX_SITE_SETTINGS_BYTES) {
    throw new Error(`${file}: too long`)
  }
  try {
    return parseSiteSettings(readFileSync(file, 'utf8'))
  } catch (e: any) {
    throw new Error(`${file}: ${e.message}`)
  }
}

/** The file text for settings (the format the login helpers write for --encoder and --render-device). */
export function formatSiteSettings(settings: SiteSettings): string {
  return `encoder = ${settings.encoder}\nrender-device = ${settings.renderDevice}\n`
}
