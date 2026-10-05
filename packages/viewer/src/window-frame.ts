import { FRAME_BORDER, FRAME_TITLE_HEIGHT } from './protocol'
import { EDGE_BOTTOM, EDGE_LEFT, EDGE_RIGHT, EDGE_TOP, resizeCursor } from './window-menu'
import { FRAME_GRAB } from './frame-geometry'
import { glyphs } from './shell/glyphs'

/** The caption buttons' icons: 10 px, one pixel lines on whole pixels (crisp at a pixel ratio of 1, 2 or any whole one). */
function caption(paths: string): string {
  return `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1">${paths}</svg>`
}

const CAPTION_ICONS = {
  minimize: caption('<path d="M0 9.5h10"/>'),
  maximize: caption('<rect x="0.5" y="0.5" width="9" height="9"/>'),
  restore: caption('<rect x="0.5" y="2.5" width="7" height="7"/><path d="M2.5 2.5v-2h7v7h-2"/>'),
  close: caption('<path d="M0.5 0.5l9 9M9.5 0.5l-9 9"/>'),
}

/** What a frame shows of its window. */
export type FrameState = {
  title: string
  /** the app's icon (a URL), undefined: the generic one */
  icon?: string
  active: boolean
  maximized: boolean
  /** a dialog has a close button only */
  hasParent: boolean
  /** an app that can't be resized (its min and max sizes agree) can't be maximized either */
  resizable: boolean
}

/** The part of a frame an event happened on. */
export type FramePart =
  | { window: string; part: 'title' }
  | { window: string; part: 'minimize' | 'maximize' | 'close' }
  | { window: string; part: 'resize'; edges: number }

const BUTTONS = ['minimize', 'maximize', 'close'] as const

/** The resize margin's pieces: edge strips and corners, outside the visible border (see FRAME_GRAB). */
const GRABS: { name: string; edges: number }[] = [
  { name: 'n', edges: EDGE_TOP },
  { name: 's', edges: EDGE_BOTTOM },
  { name: 'w', edges: EDGE_LEFT },
  { name: 'e', edges: EDGE_RIGHT },
  // (after the edges: the corners win where they overlap)
  { name: 'nw', edges: EDGE_TOP | EDGE_LEFT },
  { name: 'ne', edges: EDGE_TOP | EDGE_RIGHT },
  { name: 'sw', edges: EDGE_BOTTOM | EDGE_LEFT },
  { name: 'se', edges: EDGE_BOTTOM | EDGE_RIGHT },
]

/**
 * The frame of a decorated window, drawn by the viewer: the title bar (the app's icon, the title, minimize, maximize and
 * close buttons), the thin border, and the invisible resize margin around them. HTML/CSS in an element of the window's
 * element (window-view.ts positions it); its box is the window's outer rectangle. All of it is imperative, React never
 * sees it, and the pointer handling that makes it do something lives in desktop.ts, which finds the parts by
 * `data-frame-part` (see `framePartOf`).
 */
export class WindowFrame {
  readonly element = document.createElement('div')
  private readonly icon = document.createElement('span')
  private readonly text = document.createElement('span')
  private readonly buttons = new Map<string, HTMLButtonElement>()
  private shown = ''

  constructor(readonly windowId: string) {
    const frame = this.element
    frame.className = 'frame'
    frame.dataset.frameWindow = windowId
    frame.style.setProperty('--frame-title-height', `${FRAME_TITLE_HEIGHT}px`)
    frame.style.setProperty('--frame-border', `${FRAME_BORDER}px`)
    frame.style.setProperty('--frame-grab', `${FRAME_GRAB}px`)

    const border = document.createElement('div')
    border.className = 'frame-border'

    const title = document.createElement('div')
    title.className = 'frame-title'
    title.dataset.framePart = 'title'
    this.icon.className = 'frame-icon'
    this.text.className = 'frame-text'
    const controls = document.createElement('div')
    controls.className = 'frame-buttons'
    for (const name of BUTTONS) {
      const button = document.createElement('button')
      button.type = 'button'
      button.tabIndex = -1
      button.className = `frame-button ${name}`
      button.dataset.framePart = name
      button.title = { minimize: 'Minimize', maximize: 'Maximize', close: 'Close' }[name]
      button.setAttribute('aria-label', button.title)
      this.buttons.set(name, button)
      controls.append(button)
    }
    title.append(this.icon, this.text, controls)
    frame.append(border, title)

    for (const { name, edges } of GRABS) {
      const grab = document.createElement('div')
      grab.className = `frame-grab ${name}`
      grab.dataset.framePart = 'resize'
      grab.dataset.edges = String(edges)
      grab.style.cursor = resizeCursor(edges)
      frame.append(grab)
    }
  }

  /** Show what the window has now (a scene arrived, an icon came). */
  update(state: FrameState): void {
    const key = JSON.stringify(state)
    if (key === this.shown) {
      return
    }
    this.shown = key
    const frame = this.element
    frame.classList.toggle('active', state.active)
    frame.classList.toggle('maximized', state.maximized)
    frame.classList.toggle('dialog', state.hasParent)
    frame.classList.toggle('fixed-size', !state.resizable || state.maximized)
    this.text.textContent = state.title
    this.icon.replaceChildren()
    if (state.icon) {
      const image = document.createElement('img')
      image.src = state.icon
      image.alt = ''
      image.draggable = false
      this.icon.append(image)
    } else {
      this.icon.innerHTML = glyphs.app(16)
    }
    const maximize = this.buttons.get('maximize')!
    maximize.innerHTML = state.maximized ? CAPTION_ICONS.restore : CAPTION_ICONS.maximize
    maximize.title = state.maximized ? 'Restore down' : 'Maximize'
    maximize.setAttribute('aria-label', maximize.title)
    maximize.disabled = !state.resizable
    this.buttons.get('minimize')!.innerHTML = CAPTION_ICONS.minimize
    this.buttons.get('close')!.innerHTML = CAPTION_ICONS.close
  }

  /** Where the frame is: its box (the outer rectangle) in the window element's coordinates, or hidden (no frame). */
  place(box: { left: number; top: number; width: number; height: number; transform: string } | undefined): void {
    const style = this.element.style
    if (box === undefined) {
      style.display = 'none'
      return
    }
    style.display = ''
    style.left = `${box.left}px`
    style.top = `${box.top}px`
    style.width = `${box.width}px`
    style.height = `${box.height}px`
    style.transform = box.transform
  }

  dispose(): void {
    this.element.remove()
  }
}

/** The part of a frame an event's target is, undefined if it isn't one. */
export function framePartOf(target: EventTarget | null): FramePart | undefined {
  const element = target instanceof Element ? target.closest<HTMLElement>('[data-frame-part]') : null
  const frame = element?.closest<HTMLElement>('.frame')
  if (element === null || element === undefined || frame === null || frame === undefined) {
    return undefined
  }
  const window = frame.dataset.frameWindow ?? ''
  const part = element.dataset.framePart
  if (part === 'resize') {
    return { window, part, edges: Number(element.dataset.edges) }
  }
  return { window, part: part as 'title' | 'minimize' | 'maximize' | 'close' }
}
