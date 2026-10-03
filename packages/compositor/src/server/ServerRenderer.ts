import { queueCancellableMicrotask } from '../Loop'
import { Point } from '../math/Point'
import { CompositorRenderer } from '../render/CompositorRenderer'
import { SceneGraph } from '../render/SceneGraph'
import Session from '../Session'
import Surface from '../Surface'
import View from '../View'
import BufferImplementation from '../BufferImplementation'
import type { CursorType } from '../render/CompositorRenderer'

/**
 * Headless renderer. Keeps the scene graph (stacking, view transformations) up to date but draws nothing. Pixels are
 * encoded by the proxy and composited by the attached browser.
 */
export type ServerCursor =
  | { kind: 'default' }
  | { kind: 'hidden' }
  | { kind: 'named'; name: CursorType }
  | { kind: 'surface'; view: View; hotspot: Point }

export class ServerRenderer implements CompositorRenderer {
  readonly sceneGraph: SceneGraph = new SceneGraph(() => this.render())
  renderFrame?: Promise<void>
  /**
   * The viewer does hit testing. While set, pickView returns its pick instead of searching the scene.
   */
  pickOverride?: { view?: View }
  /**
   * Called after the scene graph was updated.
   */
  onRendered?: () => void
  onCursorChanged?: (cursor: ServerCursor) => void
  cursor: ServerCursor = { kind: 'default' }
  private renderTaskRegistration?: () => void

  constructor(private readonly session: Session) {}

  get topLevelViews(): View[] {
    return this.sceneGraph.topLevelViews
  }

  render(afterUpdatePixelContent?: () => void): void {
    if (this.renderTaskRegistration) {
      return
    }
    this.renderTaskRegistration = queueCancellableMicrotask(() => {
      this.renderTaskRegistration = undefined
      const viewStack = this.sceneGraph.updateViewStack()
      const now = Date.now()
      for (const view of viewStack) {
        view.applyTransformations()
        const { buffer } = view.surface.state
        if (buffer && view.mapped && view.surface.damaged) {
          const bufferImplementation = buffer.implementation as BufferImplementation<any>
          if (!bufferImplementation.released) {
            bufferImplementation.release()
          }
          view.surface.damaged = false
        }
        // Frame callbacks of proxied clients are handled by the proxy itself (see FrameFeedback), this only covers
        // callbacks that reach the protocol implementation.
        for (const callback of view.surface.state.frameCallbacks) {
          callback.done(now)
        }
        view.surface.state.frameCallbacks = []
      }
      afterUpdatePixelContent?.()
      this.session.flush()
      this.onRendered?.()
    })
  }

  pickView(scenePoint: Point): View | undefined {
    if (this.pickOverride) {
      return this.pickOverride.view
    }
    return this.sceneGraph.pickView(scenePoint)
  }

  raiseSurface(surface: Surface): void {
    this.sceneGraph.raiseSurface(surface)
  }

  addTopLevelView(topLevelView: View): void {
    this.sceneGraph.addTopLevelView(topLevelView)
  }

  removeTopLevelView(topLevelView: View): void {
    this.sceneGraph.removeTopLevelView(topLevelView)
  }

  hasTopLevelView(topLevelView: View): boolean {
    return this.sceneGraph.hasTopLevelView(topLevelView)
  }

  updateCursor(view: View, hotspot: Point): void {
    for (const callback of view.surface.state.frameCallbacks) {
      callback.done(Date.now())
    }
    view.surface.state.frameCallbacks = []
    this.session.flush()
    this.setCursor({ kind: 'surface', view, hotspot })
  }

  hideCursor(): void {
    this.setCursor({ kind: 'hidden' })
  }

  resetCursor(): void {
    this.setCursor({ kind: 'default' })
  }

  setCursorType(cursorType: CursorType): void {
    this.setCursor({ kind: 'named', name: cursorType })
  }

  private setCursor(cursor: ServerCursor) {
    this.cursor = cursor
    this.onCursorChanged?.(cursor)
  }

  // TODO drag-and-drop icons should be forwarded to the viewer
  clearDndImage(): void {
    /* noop */
  }

  updateDndImage(view: View): void {
    this.updateCursor(view, { x: 0, y: 0 })
  }

  onViewRegionUpdated(_view: View): void {
    /* noop, no per-view GPU state on the server */
  }

  onViewDestroyed(_view: View): void {
    /* noop */
  }
}
