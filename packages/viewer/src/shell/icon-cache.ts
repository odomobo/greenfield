import { glyphs } from './glyphs'

/**
 * App and notification icons, fetched from the session (shell.icons) by name once and kept as data URLs. Elements
 * created before an icon arrived are filled in when it does.
 */
export class IconCache {
  private readonly urls = new Map<string, string | null>()
  private readonly waiting = new Map<string, Set<HTMLElement>>()
  private readonly requested = new Set<string>()
  private requestScheduled = false

  constructor(private readonly request: (names: string[]) => void) {}

  /** The session sent icons. */
  received(icons: Record<string, string | null>): void {
    for (const [name, url] of Object.entries(icons)) {
      this.urls.set(name, url)
      for (const element of this.waiting.get(name) ?? []) {
        this.fill(element, url)
      }
      this.waiting.delete(name)
    }
  }

  /** Forget everything (another session). */
  clear(): void {
    this.urls.clear()
    this.waiting.clear()
    this.requested.clear()
  }

  /** An element showing the icon `name` (or the fallback), `size` px square. */
  element(name: string | undefined, size: number): HTMLElement {
    const element = document.createElement('span')
    element.className = 'app-icon'
    element.style.width = `${size}px`
    element.style.height = `${size}px`
    if (name === undefined) {
      this.fill(element, null)
      return element
    }
    const url = this.urls.get(name)
    if (url !== undefined) {
      this.fill(element, url)
      return element
    }
    this.fill(element, null)
    let waiting = this.waiting.get(name)
    if (waiting === undefined) {
      waiting = new Set()
      this.waiting.set(name, waiting)
    }
    waiting.add(element)
    this.want(name)
    return element
  }

  private want(name: string) {
    if (this.requested.has(name)) {
      return
    }
    this.requested.add(name)
    if (!this.requestScheduled) {
      this.requestScheduled = true
      queueMicrotask(() => {
        this.requestScheduled = false
        const names = [...this.requested].filter((n) => !this.urls.has(n) && this.waiting.has(n))
        for (let i = 0; i < names.length; i += 64) {
          this.request(names.slice(i, i + 64))
        }
      })
    }
  }

  private fill(element: HTMLElement, url: string | null) {
    const size = parseInt(element.style.width, 10) || 24
    if (url === null) {
      element.innerHTML = glyphs.app(size)
      element.classList.add('fallback')
      return
    }
    const image = document.createElement('img')
    image.src = url
    image.alt = ''
    image.width = size
    image.height = size
    image.draggable = false
    element.classList.remove('fallback')
    element.replaceChildren(image)
  }
}
