import { Point } from '../math/Point'
import Surface from '../Surface'
import View from '../View'
import { SceneGraph } from './SceneGraph'

/**
 * What the protocol implementation needs from "the thing that shows surfaces". Implemented by the browser WebGL
 * renderer and by a headless server-side renderer.
 */
export interface CompositorRenderer {
  readonly sceneGraph: SceneGraph
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

/**
 * CSS cursor names, used for compositor defined cursors (e.g. during interactive resize).
 */
export type CursorType =
  | 'default'
  | 'unset'
  | 'inherit'
  | 'none'
  | 'context-menu'
  | 'help'
  | 'pointer'
  | 'progress'
  | 'wait'
  | 'cell'
  | 'crosshair'
  | 'text'
  | 'vertical-text'
  | 'alias'
  | 'copy'
  | 'move'
  | 'no-drop'
  | 'not-allowed'
  | 'all_scroll'
  | 'col-resize'
  | 'row-resize'
  | 'n-resize'
  | 'e-resize'
  | 's-resize'
  | 'w-resize'
  | 'ne-resize'
  | 'nw-resize'
  | 'se-resize'
  | 'sw-resize'
  | 'ew-resize'
  | 'ns-resize'
  | 'nesw-resize'
  | 'nwse-resize'
  | 'zoom-in'
  | 'zoom-out'
  | 'grab'
  | 'grabbing'
  | 'all-scroll'
