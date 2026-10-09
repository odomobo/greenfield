import type { SurfaceView } from './surface-view'
import { clipTo, snapToDevicePixel } from './surface-geometry'
import type { Rect } from './windows'
import { FrameInsets } from './protocol'
import { frameBox } from './frame-geometry'
import { FrameState, WindowFrame } from './window-frame'
import { reducedMotion } from './animation'

/** How long a minimized window a peek shows takes to fade in (the others fade out as fast: .peek-faded in style.css). */
const PEEK_FADE_MS = 150

/** How a window is shown right now. */
export type WindowLayout = {
  /** where the window's origin (the origin of its surfaces' coordinates) is, in the desktop's CSS pixels */
  x: number
  y: number
  /** the window's content is stretched by this (a resize being dragged, a state animation) */
  scaleX: number
  scaleY: number
  opacity: number
  /** minimized: not shown, not pickable */
  hidden: boolean
  /** not pickable (minimizing, restoring) */
  inert: boolean
  /** another window is being peeked at (hovering its taskbar preview): this one fades out */
  peekFaded: boolean
  /** minimized, shown only because it's being peeked at: it fades in */
  peekRevealed: boolean
  pixelRatio: number
  /** the surfaces' rects in the window's coordinates, in the order of `setSurfaces` */
  surfaces: Rect[]
  /** the window geometry in the window's coordinates, which the frame goes around */
  geometry: Rect
  /** how far the frame reaches beyond the geometry (all zero: no frame) */
  insets: FrameInsets
  /** the frame stretches with the content (minimizing, restoring), else it keeps its real size */
  frameStretches: boolean
}

/**
 * The element of one window: a positioned element holding its surfaces' canvases in stacking order. The browser does
 * the stacking (the order of the window elements), clipping, hit testing and compositing; moving, stretching and
 * fading a window is a CSS transform and opacity on this element. Everything is imperative (see desktop.ts): React
 * never sees it.
 *
 * A decorated window's frame (window-frame.ts) is one more element inside this one, before the canvases. It lies
 * outside the window geometry, and the window's own surfaces are clipped to the geometry, so the app never covers the
 * frame (nor takes its clicks: clipping applies to hit testing too). It's drawn at its real size even while the content
 * is stretched (a resize being dragged), see frameBox.
 *
 * The window's popups (menus, tooltips) are in a second element, `popups`, in a layer above all windows (desktop.ts):
 * a menu or tooltip of a window that isn't on top isn't covered by the ones that are. It's moved, stretched, faded and
 * hidden with the window, and isn't clipped: popups reach past the window's edge on purpose.
 */
export class WindowView {
  readonly element = document.createElement('div')
  readonly popups = document.createElement('div')
  private views: SurfaceView[] = []
  private popupFlags: boolean[] = []
  private layoutKey = ''
  readonly frame: WindowFrame
  private peekFadeIn: Animation[] = []

  constructor(readonly id: string) {
    this.element.className = 'window'
    this.element.dataset.window = id
    this.popups.className = 'window-popups'
    this.popups.dataset.window = id
    this.frame = new WindowFrame(id)
    this.element.append(this.frame.element)
  }

  /** What the frame shows (its title, whether the window is active...). */
  setFrame(state: FrameState): void {
    this.frame.update(state)
  }

  /** The surfaces of the window, bottom to top, and which of them are its popups'. */
  setSurfaces(views: SurfaceView[], popup: boolean[]): void {
    this.views = views
    this.popupFlags = popup
    // (which surfaces are clipped may have changed)
    this.layoutKey = ''
    // (the frame is the first child of the window's element, its own surfaces' canvases follow)
    placeChildren(this.element, this.frame.element.nextSibling, views.filter((_, i) => !popup[i]))
    placeChildren(this.popups, this.popups.firstChild, views.filter((_, i) => popup[i]))
  }

  /**
   * A minimized window a peek shows fades in (as the others fade out). Activated meanwhile, it stays shown and the fade
   * in runs to its end; hidden again (the peek ended), it's put away.
   */
  private revealForPeek(revealed: boolean, hidden: boolean) {
    if (revealed && this.peekFadeIn.length === 0 && !reducedMotion()) {
      this.peekFadeIn = [this.element, this.popups].map((element) =>
        element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: PEEK_FADE_MS, easing: 'ease-out' }),
      )
      for (const animation of this.peekFadeIn) {
        animation.onfinish = () => (this.peekFadeIn = [])
      }
    } else if (!revealed && hidden && this.peekFadeIn.length > 0) {
      this.peekFadeIn.forEach((animation) => animation.cancel())
      this.peekFadeIn = []
    }
  }

  layout(layout: WindowLayout): void {
    const { x, y, scaleX, scaleY, opacity, hidden, inert, peekFaded, peekRevealed, pixelRatio } = layout
    this.revealForPeek(peekRevealed, hidden)
    for (const element of [this.element, this.popups]) {
      element.classList.toggle('peek-faded', peekFaded)
      const style = element.style
      style.display = hidden ? 'none' : ''
      style.pointerEvents = inert ? 'none' : ''
      style.opacity = opacity === 1 ? '' : String(opacity)
    }
    const stretched = scaleX !== 1 || scaleY !== 1
    const transform = stretched
      ? `translate(${x}px, ${y}px) scale(${scaleX}, ${scaleY})`
      : // unstretched content sits on whole device pixels: a half pixel offset would blur it
        `translate(${snapToDevicePixel(x, pixelRatio)}px, ${snapToDevicePixel(y, pixelRatio)}px)`
    if (hidden) {
      return
    }
    // (a surface's content size is part of it: whether it's shown without interpolation depends on it)
    const insets = layout.insets
    const decorated = insets.top + insets.left + insets.right + insets.bottom > 0
    const key = `${transform}|${pixelRatio}|${JSON.stringify(layout.geometry)}|${JSON.stringify(insets)}|${layout.frameStretches}|${layout.surfaces
      .map((r, i) => `${r.x},${r.y},${r.width},${r.height},${this.views[i]?.canvas.width}`)
      .join(';')}`
    if (key === this.layoutKey) {
      return
    }
    this.layoutKey = key
    this.element.style.transform = transform
    this.popups.style.transform = transform
    this.frame.place(
      decorated ? frameBox(layout.geometry, insets, scaleX, scaleY, layout.frameStretches) : undefined,
    )
    layout.surfaces.forEach((rect, i) => {
      const view = this.views[i]
      const drawn = { x: x + rect.x * scaleX, y: y + rect.y * scaleY, width: rect.width * scaleX, height: rect.height * scaleY }
      view?.place(rect, drawn, pixelRatio)
      if (view) {
        // with our frame, the window's own surfaces show only what's inside the geometry (popups aren't clipped)
        view.canvas.style.clipPath = decorated && !this.popupFlags[i] ? clipTo(rect, layout.geometry) : ''
      }
    })
  }

  dispose(): void {
    this.frame.dispose()
    this.element.remove()
    this.popups.remove()
    this.views = []
  }
}

/** Make `views`' canvases the children of `parent` from `expected` on, in order, moving only what's out of place. */
function placeChildren(parent: HTMLElement, expected: ChildNode | null, views: SurfaceView[]) {
  for (const view of views) {
    if (view.canvas === expected) {
      expected = expected.nextSibling
    } else {
      // (moves it if it's elsewhere, e.g. in another window, or between the window's two elements)
      parent.insertBefore(view.canvas, expected)
    }
  }
  while (expected !== null) {
    const next: ChildNode | null = expected.nextSibling
    expected.remove()
    expected = next
  }
}
