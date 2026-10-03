import { Point } from '../math/Point'
import Surface from '../Surface'
import View from '../View'

/**
 * Pure (DOM and GL free) bookkeeping of which views exist, their stacking order and hit testing.
 * Shared by the browser renderer and the server-side compositor.
 */
export class SceneGraph {
  topLevelViews: View[] = []
  /**
   * All views, in-order from bottom to top. Updated by updateViewStack.
   */
  viewStack: View[] = []

  constructor(private readonly onTopLevelViewDestroyed: () => void) {}

  raiseSurface(surface: Surface): void {
    const raisedViews = this.topLevelViews.filter((topLevelView) => topLevelView.surface === surface)
    const rest = this.topLevelViews.filter((topLevelView) => topLevelView.surface !== surface)
    this.topLevelViews = [...rest, ...raisedViews]
  }

  pickView(scenePoint: Point): View | undefined {
    // test views from front to back
    return [...this.viewStack].reverse().find((view) => {
      const surfacePoint = view.sceneToViewSpace(scenePoint)
      return view.surface.isWithinInputRegion(surfacePoint)
    })
  }

  removeTopLevelView(topLevelView: View): void {
    this.topLevelViews = this.topLevelViews.filter((view) => view !== topLevelView)
  }

  hasTopLevelView(topLevelView: View): boolean {
    return this.topLevelViews.includes(topLevelView)
  }

  addTopLevelView(topLevelView: View): void {
    this.topLevelViews = [...this.topLevelViews, topLevelView]
    topLevelView.onDestroy().then(() => {
      this.removeTopLevelView(topLevelView)
      this.onTopLevelViewDestroyed()
    })
  }

  updateViewStack(): View[] {
    const stack: View[] = []
    for (const topLevelView of this.topLevelViews) {
      // toplevel surface with a parent will be added automatically by the parent so we filter them out here.
      this.addToViewStack(stack, topLevelView)
    }
    this.viewStack = stack
    return stack
  }

  private addToViewStack(stack: View[], view: View) {
    for (const surfaceChild of view.surface.children) {
      const childViewOrParentView = surfaceChild.surface.role?.view
      if (childViewOrParentView) {
        stack.push(childViewOrParentView)
        if (childViewOrParentView !== view) {
          this.addToViewStack(stack, childViewOrParentView)
        }
      }
    }
  }
}
