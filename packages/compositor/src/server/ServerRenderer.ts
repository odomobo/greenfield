import { queueCancellableMicrotask } from '../Loop'
import { Point } from '../math/Point'
import { CompositorRenderer } from '../render/CompositorRenderer'
import type { Scene } from '../render/Scene'
import { SceneGraph } from '../render/SceneGraph'
import Session from '../Session'
import Surface from '../Surface'
import View from '../View'
import BufferImplementation from '../BufferImplementation'
import type { CursorType } from '../browser/pointer'

/**
 * Headless renderer. Keeps the scene graph (stacking, view transformations) up to date but draws nothing. Pixels are
 * encoded by the proxy and composited by the attached browser.
 */
export class ServerRenderer implements CompositorRenderer {
  readonly sceneGraph: SceneGraph = new SceneGraph(() => this.render())
  readonly scenes: { [key: string]: Scene } = {}
  renderFrame?: Promise<void>
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
    })
  }

  pickView(scenePoint: Point): View | undefined {
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

  // TODO cursor and drag-and-drop images should be forwarded to the attached browser
  updateCursor(view: View, _hotspot: Point): void {
    for (const callback of view.surface.state.frameCallbacks) {
      callback.done(Date.now())
    }
    view.surface.state.frameCallbacks = []
    this.session.flush()
  }

  hideCursor(): void {
    /* noop */
  }

  resetCursor(): void {
    /* noop */
  }

  setCursorType(_cursorType: CursorType): void {
    /* noop */
  }

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
