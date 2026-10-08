/**
 * Installed applications, from the user's and the system's .desktop files (XDG Desktop Entry spec, the parts a launcher
 * needs).
 */
import { accessSync, constants, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

export type DesktopEntry = {
  /** desktop file ID, e.g. org.codeberg.dnkl.foot.desktop */
  id: string
  name: string
  genericName?: string
  comment?: string
  keywords: string[]
  categories: string[]
  icon?: string
  exec: string
  terminal: boolean
  startupWMClass?: string
  /** working directory */
  path?: string
}

/** Applications directories, most important first (user data dir before system data dirs). */
export function applicationDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME ?? ''
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local/share')
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean)
  return [dataHome, ...dataDirs].map((dir) => path.join(dir, 'applications'))
}

/** Parse the [Desktop Entry] group. Localized keys are picked for `locales` (most specific first). */
export function parseDesktopFile(text: string, locales: string[]): Map<string, string> {
  const values = new Map<string, string>()
  const localized = new Map<string, { rank: number; value: string }>()
  let inEntry = false
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) {
      continue
    }
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]'
      continue
    }
    if (!inEntry) {
      continue
    }
    const separator = line.indexOf('=')
    if (separator <= 0) {
      continue
    }
    const key = line.slice(0, separator).trim()
    const value = unescapeValue(line.slice(separator + 1).trim())
    const locale = /^([A-Za-z0-9-]+)\[([^\]]+)\]$/.exec(key)
    if (locale) {
      const rank = locales.indexOf(locale[2])
      const previous = localized.get(locale[1])
      if (rank >= 0 && (previous === undefined || rank < previous.rank)) {
        localized.set(locale[1], { rank, value })
      }
    } else if (!values.has(key)) {
      values.set(key, value)
    }
  }
  for (const [key, { value }] of localized) {
    values.set(key, value)
  }
  return values
}

function unescapeValue(value: string): string {
  return value.replace(
    /\\([sntr\\;])/g,
    (_, c: string) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\', ';': '\\;' })[c]!,
  )
}

function list(value: string | undefined): string[] {
  if (!value) {
    return []
  }
  // ';' separated, '\;' is a literal semicolon (kept escaped by unescapeValue)
  return value
    .split(/(?<!\\);/)
    .map((item) => item.replace(/\\;/g, ';').trim())
    .filter(Boolean)
}

/** Locale names to try for localized keys, e.g. LANG=de_DE.UTF-8 -> de_DE, de. */
export function localesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const lang = env.LC_ALL || env.LC_MESSAGES || env.LANG || ''
  const match = /^([a-z]{2,3})(_[A-Z]{2})?/.exec(lang)
  if (!match) {
    return []
  }
  return match[2] ? [`${match[1]}${match[2]}`, match[1]] : [match[1]]
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** Find a program in PATH (or check an absolute path). */
export function findProgram(program: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (program.includes('/')) {
    return isExecutable(program) ? program : undefined
  }
  for (const dir of (env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':')) {
    const candidate = path.join(dir || '.', program)
    if (isExecutable(candidate)) {
      return candidate
    }
  }
  return undefined
}

function walk(dir: string, prefix: string, found: Map<string, string>) {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names.sort()) {
    const file = path.join(dir, name)
    let stat
    try {
      stat = statSync(file)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      // subdirectories are part of the ID: kde/foo.desktop -> kde-foo.desktop
      walk(file, `${prefix}${name}-`, found)
    } else if (name.endsWith('.desktop')) {
      const id = `${prefix}${name}`
      // the first directory wins
      if (!found.has(id)) {
        found.set(id, file)
      }
    }
  }
}

/**
 * The applications to offer in a launcher, sorted by name. Hidden, NoDisplay, other desktops' (OnlyShowIn/NotShowIn)
 * and uninstalled (TryExec) entries are left out.
 */
export function loadDesktopEntries(env: NodeJS.ProcessEnv = process.env): DesktopEntry[] {
  const files = new Map<string, string>()
  for (const dir of applicationDirs(env)) {
    walk(dir, '', files)
  }
  const locales = localesFromEnv(env)
  const desktops = (env.XDG_CURRENT_DESKTOP ?? '').split(':').filter(Boolean)
  const entries: DesktopEntry[] = []
  for (const [id, file] of files) {
    let values: Map<string, string>
    try {
      values = parseDesktopFile(readFileSync(file, 'utf8'), locales)
    } catch {
      continue
    }
    if (values.get('Type') !== 'Application' || values.get('Hidden') === 'true' || values.get('NoDisplay') === 'true') {
      continue
    }
    const onlyShowIn = list(values.get('OnlyShowIn'))
    if (onlyShowIn.length > 0 && !onlyShowIn.some((desktop) => desktops.includes(desktop))) {
      continue
    }
    if (list(values.get('NotShowIn')).some((desktop) => desktops.includes(desktop))) {
      continue
    }
    const name = values.get('Name')
    const exec = values.get('Exec')
    if (!name || !exec) {
      continue
    }
    const tryExec = values.get('TryExec')
    if (tryExec && findProgram(tryExec, env) === undefined) {
      continue
    }
    entries.push({
      id,
      name,
      genericName: values.get('GenericName') || undefined,
      comment: values.get('Comment') || undefined,
      keywords: list(values.get('Keywords')),
      categories: list(values.get('Categories')),
      icon: values.get('Icon') || undefined,
      exec,
      terminal: values.get('Terminal') === 'true',
      startupWMClass: values.get('StartupWMClass') || undefined,
      path: values.get('Path') || undefined,
    })
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Split an Exec value into arguments (spec quoting rules) and drop the field codes: we never pass files or URLs.
 * Returns undefined if it can't be parsed.
 */
export function parseExec(exec: string, entry: { name: string; icon?: string }): string[] | undefined {
  const args: string[] = []
  let current = ''
  let inArg = false
  let quoted = false
  for (let i = 0; i < exec.length; i++) {
    const c = exec[i]
    if (quoted) {
      if (c === '\\' && i + 1 < exec.length && '"`$\\'.includes(exec[i + 1])) {
        current += exec[++i]
      } else if (c === '"') {
        quoted = false
      } else {
        current += c
      }
    } else if (c === '"') {
      quoted = true
      inArg = true
    } else if (c === ' ' || c === '\t') {
      if (inArg) {
        args.push(current)
        current = ''
        inArg = false
      }
    } else {
      current += c
      inArg = true
    }
  }
  if (quoted) {
    return undefined
  }
  if (inArg) {
    args.push(current)
  }
  const expanded: string[] = []
  for (const arg of args) {
    if (arg === '%i') {
      if (entry.icon) {
        expanded.push('--icon', entry.icon)
      }
      continue
    }
    if (/^%[fFuUdDnNvm]$/.test(arg)) {
      continue
    }
    const value = arg.replace(/%([a-zA-Z%])/g, (_, code: string) => {
      switch (code) {
        case '%':
          return '%'
        case 'c':
          return entry.name
        default:
          // %f, %u etc. inside an argument, %k: nothing to pass
          return ''
      }
    })
    expanded.push(value)
  }
  return expanded.length > 0 ? expanded : undefined
}

/** How to run a terminal program (Terminal=true): the first installed terminal, with its "run this" option. */
const TERMINALS: [string, string[]][] = [
  ['foot', []],
  ['kitty', []],
  ['alacritty', ['-e']],
  ['wezterm', ['start', '--']],
  ['gnome-terminal', ['--']],
  ['konsole', ['-e']],
  ['xfce4-terminal', ['-x']],
  ['xterm', ['-e']],
]

export function terminalCommand(args: string[], env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  for (const [program, prefix] of TERMINALS) {
    const found = findProgram(program, env)
    if (found) {
      return [found, ...prefix, ...args]
    }
  }
  return undefined
}
