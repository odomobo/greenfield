import { useEffect } from 'react'
import { shellStore } from '../state'
import { useCore } from '../core'
import { useStorePart } from '../store'
import { glyphs } from './glyphs'

/**
 * App and notification icons, fetched from the session (shell.icons) by name once and kept as data URLs in the
 * shell store. Components render an AppIcon, which shows the fallback until the icon arrives.
 */
export class IconCache {
  private readonly waiting = new Set<string>()
  private readonly requested = new Set<string>()
  private requestScheduled = false

  constructor(private readonly request: (names: string[]) => void) {}

  /** The session sent icons. */
  received(icons: Record<string, string | null>): void {
    for (const name of Object.keys(icons)) {
      this.waiting.delete(name)
    }
    shellStore.update({ icons: { ...shellStore.get().icons, ...icons } })
  }

  /** Forget everything (another session). */
  clear(): void {
    this.waiting.clear()
    this.requested.clear()
    shellStore.update({ icons: {} })
  }

  /** Remember that `name` is shown and ask the session for it, batched per microtask. */
  want(name: string): void {
    this.waiting.add(name)
    if (this.requested.has(name)) {
      return
    }
    this.requested.add(name)
    if (!this.requestScheduled) {
      this.requestScheduled = true
      queueMicrotask(() => {
        this.requestScheduled = false
        const icons = shellStore.get().icons
        const names = [...this.requested].filter((n) => !(n in icons) && this.waiting.has(n))
        for (let i = 0; i < names.length; i += 64) {
          this.request(names.slice(i, i + 64))
        }
      })
    }
  }
}

/** The icon's URL: a data URL, null (no such icon) or undefined (not arrived yet). */
function useIconUrl(name: string | undefined): string | null | undefined {
  return useStorePart(shellStore, (state) => (name === undefined ? null : state.icons[name]))
}

/**
 * An element showing the icon `name` (or the fallback), `size` px square. The fallback also shows while an icon is
 * on its way from the session.
 */
export function AppIcon({ name, size }: { name: string | undefined; size: number }) {
  const url = useIconUrl(name)
  const { shell } = useCore()
  useEffect(() => {
    if (name !== undefined) {
      shell.icons.want(name)
    }
  }, [name, shell])
  return (
    <span className={typeof url === 'string' ? 'app-icon' : 'app-icon fallback'} style={{ width: size, height: size }}>
      {typeof url === 'string' ? (
        <img src={url} alt="" width={size} height={size} draggable={false} />
      ) : (
        <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: glyphs.app(size) }} />
      )}
    </span>
  )
}
