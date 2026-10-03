import { Point } from '../math/Point'
import Surface from '../Surface'
import View from '../View'
import type { Scene } from './Scene'
import type { CursorType } from '../browser/pointer'
import { SceneGraph } from './SceneGraph'

/**
 * What the protocol implementation needs from "the thing that shows surfaces". Implemented by the browser WebGL
 * renderer and by a headless server-side renderer.
 */
export interface CompositorRenderer {
  readonly sceneGraph: SceneGraph
  /**
   * Browser outputs (canvases). Always empty on the server.
   * TODO replace with logical outputs reported by the viewer, so maximize/fullscreen work server-side.
   */
  readonly scenes: { [key: string]: Scene }
  readonly topLevelViews: View[]
  renderFrame?: Promise<void>

  render(afterUpdatePixelContent?: () => void): void

  pickView(scenePoint: Point): View | undefined

  raiseSurface(surface: Surface): void

  addTopLevelView(topLevelView: View): void

  removeTopLevelView(topLevelView: View): void

  hasTopLevelView(topLevelView: View): boolean

  updateCursor(view: View, hotspot: Point): void

  hideCursor(): void

  resetCursor(): void

  /**
   * Show a compositor defined cursor, e.g. during interactive resize.
   */
  setCursorType(cursorType: CursorType): void

  clearDndImage(): void

  updateDndImage(view: View): void

  /**
   * Called when a view's scene region changed, so renderer specific per-view state can be updated.
   */
  onViewRegionUpdated(view: View): void

  onViewDestroyed(view: View): void
}
