/**
 * Icon lookup (XDG Icon Theme spec, simplified): the user's icon theme and the themes it inherits, then hicolor, then
 * /usr/share/pixmaps. Prefers scalable icons, else the bitmap closest to ICON_SIZE (larger rather than smaller).
 * Icons go to the viewer as data URLs.
 */
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import path from 'node:path'

const ICON_SIZE = 48
const MAX_ICON_BYTES = 512 * 1024
const EXTENSIONS = ['.svg', '.png'] as const
const MIME: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png' }

type ThemeDir = { dir: string; size: number; scalable: boolean }
type Theme = { name: string; dirs: ThemeDir[]; inherits: string[] }

export class IconResolver {
  private readonly baseDirs: string[]
  private readonly themes = new Map<string, Theme | null>()
  private readonly cache = new Map<string, string | null>()
  private readonly themeChain: string[]

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const home = env.HOME ?? ''
    const dataHome = env.XDG_DATA_HOME || path.join(home, '.local/share')
    const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean)
    this.baseDirs = [
      path.join(home, '.icons'),
      path.join(dataHome, 'icons'),
      ...dataDirs.map((d) => path.join(d, 'icons')),
    ]
    this.themeChain = this.resolveChain(userIconTheme(env))
  }

  /** A data URL for an icon name or absolute path, or null if there's none. */
  resolve(name: string): string | null {
    let url = this.cache.get(name)
    if (url === undefined) {
      url = this.load(name)
      this.cache.set(name, url)
    }
    return url
  }

  private load(name: string): string | null {
    if (name.length === 0 || name.length > 512 || name.includes('\0')) {
      return null
    }
    const file =
      name.startsWith('/') || name.startsWith('file://')
        ? this.absolute(name)
        : // newer themes (Adwaita) only have symbolic versions of many icons
          this.lookup(name) ?? this.lookup(`${name}-symbolic`)
    return file ? dataURL(file) : null
  }

  /** Icon= with a path, or an image path from a notification. Only image files. */
  private absolute(name: string): string | undefined {
    let file = name
    if (file.startsWith('file://')) {
      try {
        file = decodeURIComponent(new URL(file).pathname)
      } catch {
        return undefined
      }
    }
    file = path.normalize(file)
    return EXTENSIONS.some((extension) => file.endsWith(extension)) && isFile(file) ? file : undefined
  }

  private lookup(name: string): string | undefined {
    if (name.includes('/')) {
      return undefined
    }
    // Icon=foo.png means a file name in a theme or pixmaps
    const base = EXTENSIONS.find((extension) => name.endsWith(extension)) ? name.slice(0, name.lastIndexOf('.')) : name
    for (const themeName of this.themeChain) {
      const found = this.lookupInTheme(this.theme(themeName), base)
      if (found) {
        return found
      }
    }
    for (const dir of ['/usr/share/pixmaps', ...this.baseDirs]) {
      for (const extension of EXTENSIONS) {
        const file = path.join(dir, base + extension)
        if (isFile(file)) {
          return file
        }
      }
    }
    return undefined
  }

  private lookupInTheme(theme: Theme | null, name: string): string | undefined {
    if (theme === null) {
      return undefined
    }
    let best: { file: string; score: number } | undefined
    for (const { dir, size, scalable } of theme.dirs) {
      for (const extension of EXTENSIONS) {
        if (extension === '.svg' && !scalable && size < ICON_SIZE) {
          continue
        }
        const file = path.join(dir, name + extension)
        if (!isFile(file)) {
          continue
        }
        // lower is better: scalable first, then the closest size, preferring larger
        const score =
          scalable || extension === '.svg' ? 0 : size >= ICON_SIZE ? size - ICON_SIZE + 1 : (ICON_SIZE - size) * 4
        if (best === undefined || score < best.score) {
          best = { file, score }
        }
      }
    }
    return best?.file
  }

  private resolveChain(userTheme: string | undefined): string[] {
    const chain: string[] = []
    const visit = (name: string) => {
      if (chain.includes(name) || chain.length > 16) {
        return
      }
      const theme = this.theme(name)
      if (theme === null) {
        return
      }
      chain.push(name)
      theme.inherits.forEach(visit)
    }
    if (userTheme) {
      visit(userTheme)
    }
    visit('Adwaita')
    visit('hicolor')
    return chain
  }

  private theme(name: string): Theme | null {
    let theme = this.themes.get(name)
    if (theme === undefined) {
      theme = this.loadTheme(name)
      this.themes.set(name, theme)
    }
    return theme
  }

  private loadTheme(name: string): Theme | null {
    if (name.includes('/') || name.startsWith('.')) {
      return null
    }
    const roots = this.baseDirs.map((dir) => path.join(dir, name)).filter((dir) => existsSync(dir))
    const index = roots.map((root) => path.join(root, 'index.theme')).find(isFile)
    if (index === undefined) {
      return null
    }
    const groups = parseIni(readFileSync(index, 'utf8'))
    const main = groups.get('Icon Theme') ?? new Map()
    const dirs: ThemeDir[] = []
    const subdirs = [main.get('Directories'), main.get('ScaledDirectories')]
      .filter(Boolean)
      .join(',')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean)
    for (const subdir of subdirs) {
      const group = groups.get(subdir)
      if (group === undefined || (group.get('Scale') ?? '1') !== '1') {
        continue
      }
      const size = Number(group.get('Size')) || 0
      const type = group.get('Type') ?? 'Threshold'
      // only app-ish contexts: launcher and notification icons
      const context = group.get('Context') ?? ''
      if (
        context &&
        !['Applications', 'Apps', 'Status', 'Devices', 'Places', 'Categories', 'Legacy'].includes(context)
      ) {
        continue
      }
      for (const root of roots) {
        const dir = path.join(root, subdir)
        if (existsSync(dir)) {
          dirs.push({ dir, size, scalable: type === 'Scalable' })
        }
      }
    }
    const inherits = (main.get('Inherits') ?? '')
      .split(',')
      .map((t: string) => t.trim())
      .filter(Boolean)
    return { name, dirs, inherits }
  }
}

function userIconTheme(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const output = execFileSync('gsettings', ['get', 'org.gnome.desktop.interface', 'icon-theme'], {
      env,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const theme = output.trim().replace(/^'(.*)'$/, '$1')
    return theme || undefined
  } catch {
    return undefined
  }
}

function parseIni(text: string): Map<string, Map<string, string>> {
  const groups = new Map<string, Map<string, string>>()
  let group: Map<string, string> | undefined
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) {
      continue
    }
    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      group = new Map()
      groups.set(header[1], group)
      continue
    }
    const separator = line.indexOf('=')
    if (group && separator > 0) {
      group.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
    }
  }
  return groups
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** Check the content really is what the extension says (it's shown as an image, but don't ship arbitrary files). */
function dataURL(file: string): string | null {
  try {
    const { size } = statSync(file)
    if (size === 0 || size > MAX_ICON_BYTES) {
      return null
    }
    const extension = path.extname(file)
    const fd = openSync(file, 'r')
    let data: Buffer
    try {
      data = Buffer.alloc(size)
      readSync(fd, data, 0, size, 0)
    } finally {
      closeSync(fd)
    }
    if (
      extension === '.png' &&
      !data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      return null
    }
    if (extension === '.svg' && !/<svg[\s>]/.test(data.subarray(0, 16384).toString('utf8'))) {
      return null
    }
    return `data:${MIME[extension]};base64,${data.toString('base64')}`
  } catch {
    return null
  }
}
