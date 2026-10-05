import type { SurfaceView } from './surface-view'
import { snapToDevicePixel } from './surface-geometry'
import type { Rect } from './windows'
import { FrameInsets } from './protocol'
import { frameBox } from './frame-geometry'
import { FrameState, WindowFrame } from './window-frame'

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
 * A decorated window's frame (window-frame.ts) is one more element inside this one, after the canvases. It's drawn at
 * its real size even while the content is stretched (a resize being dragged), see frameBox.
 */
export class WindowView {
  readonly element = document.createElement('div')
  private views: SurfaceView[] = []
  private layoutKey = ''
  readonly frame: WindowFrame

  constructor(readonly id: string) {
    this.element.className = 'window'
    this.element.dataset.window = id
    this.frame = new WindowFrame(id)
    this.element.append(this.frame.element)
  }

  /** What the frame shows (its title, whether the window is active...). */
  setFrame(state: FrameState): void {
    this.frame.update(state)
  }

  /** The surfaces of the window, bottom to top. */
  setSurfaces(views: SurfaceView[]): void {
    this.views = views
    // (the canvases come first, the frame is the last child)
    let expected = this.element.firstChild
    for (const view of views) {
      if (view.canvas === expected) {
        expected = expected.nextSibling
      } else {
        // (moves it if it's elsewhere, e.g. in another window)
        this.element.insertBefore(view.canvas, expected)
      }
    }
    while (expected !== null && expected !== this.frame.element) {
      const next: ChildNode | null = expected.nextSibling
      expected.remove()
      expected = next
    }
  }

  layout(layout: WindowLayout): void {
    const { x, y, scaleX, scaleY, opacity, hidden, inert, pixelRatio } = layout
    const style = this.element.style
    style.display = hidden ? 'none' : ''
    style.pointerEvents = inert ? 'none' : ''
    style.opacity = opacity === 1 ? '' : String(opacity)
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
    style.transform = transform
    this.frame.place(
      decorated ? frameBox(layout.geometry, insets, scaleX, scaleY, layout.frameStretches) : undefined,
    )
    layout.surfaces.forEach((rect, i) => {
      const view = this.views[i]
      const drawn = { x: x + rect.x * scaleX, y: y + rect.y * scaleY, width: rect.width * scaleX, height: rect.height * scaleY }
      view?.place(rect, drawn, pixelRatio)
    })
  }

  dispose(): void {
    this.frame.dispose()
    this.element.remove()
    this.views = []
  }
}
