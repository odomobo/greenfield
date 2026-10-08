import { readFileSync } from 'fs'

/** XKB names for the viewer's keyboard map; a missing one is xkbcommon's default (or its XKB_DEFAULT_* variable). */
export type KeyboardConfig = { model?: string; layout?: string; variant?: string; options?: string }

const KEYS: Record<string, keyof KeyboardConfig> = {
  XKBMODEL: 'model',
  XKBLAYOUT: 'layout',
  XKBVARIANT: 'variant',
  XKBOPTIONS: 'options',
}

/** Parses /etc/default/keyboard (shell style `NAME="value"` lines). */
export function parseKeyboardConfig(text: string): KeyboardConfig {
  const config: KeyboardConfig = {}
  for (const line of text.split('\n')) {
    const match = /^\s*(XKB[A-Z]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]*))\s*(?:#.*)?$/.exec(line)
    const name = match && KEYS[match[1]]
    const value = match && (match[2] ?? match[3] ?? match[4] ?? '').trim()
    if (name && value) {
      config[name] = value
    }
  }
  return config
}

/**
 * The keyboard configuration of this machine (/etc/default/keyboard: XKBLAYOUT, XKBVARIANT, XKBOPTIONS, XKBMODEL),
 * leaving out what XKB_DEFAULT_* in the environment overrides. Nothing readable: the default layout (us).
 */
export function systemKeyboardConfig(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): KeyboardConfig {
  let config: KeyboardConfig = {}
  try {
    config = parseKeyboardConfig(read('/etc/default/keyboard'))
  } catch {
    // no such file (not a Debian-style system)
  }
  const overrides: [keyof KeyboardConfig, string][] = [
    ['model', 'XKB_DEFAULT_MODEL'],
    ['layout', 'XKB_DEFAULT_LAYOUT'],
    ['variant', 'XKB_DEFAULT_VARIANT'],
    ['options', 'XKB_DEFAULT_OPTIONS'],
  ]
  for (const [key, variable] of overrides) {
    if (env[variable]) {
      delete config[key]
    }
  }
  return config
}
