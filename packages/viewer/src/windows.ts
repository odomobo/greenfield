/**
 * Pure helpers for the window model (no DOM or GL), so they can be unit tested in Node.
 */
import type { SceneSurface, SceneWindow } from './protocol'

export type Rect = { x: number; y: number; width: number; height: number }

/**
 * Whether a surface takes pointer input at a surface local point: inside the surface and inside its input region (if
 * it has one; without one the whole surface does).
 */
export function acceptsInput(surface: SceneSurface, sx: number, sy: number): boolean {
  if (sx < 0 || sy < 0 || sx >= surface.width || sy >= surface.height) {
    return false
  }
  if (surface.input === undefined) {
    return true
  }
  return surface.input.some(
    (rect) => sx >= rect.x && sy >= rect.y && sx < rect.x + rect.width && sy < rect.y + rect.height,
  )
}

/**
 * Bottom to top stacking order with every child window (dialog) directly above its parent, keeping the server's order
 * otherwise: among top level windows, and among the children of one parent. Raising a parent raises its children.
 */
export function stackChildrenAboveParents(windows: SceneWindow[]): SceneWindow[] {
  const ids = new Set(windows.map((window) => window.id))
  const children = new Map<string, SceneWindow[]>()
  const roots: SceneWindow[] = []
  for (const window of windows) {
    // a child whose parent isn't in the scene (yet) is treated as a top level window
    if (window.parent !== undefined && ids.has(window.parent) && window.parent !== window.id) {
      const siblings = children.get(window.parent) ?? []
      siblings.push(window)
      children.set(window.parent, siblings)
    } else {
      roots.push(window)
    }
  }
  const stacked: SceneWindow[] = []
  const visited = new Set<string>()
  const add = (window: SceneWindow) => {
    if (visited.has(window.id)) {
      return
    }
    visited.add(window.id)
    stacked.push(window)
    for (const child of children.get(window.id) ?? []) {
      add(child)
    }
  }
  roots.forEach(add)
  // parent cycles (shouldn't happen): keep those windows rather than dropping them
  for (const window of windows) {
    add(window)
  }
  return stacked
}

/** The top level window a window belongs to: itself, or its parent's (recursively). */
export function rootWindow(windows: SceneWindow[], window: SceneWindow): SceneWindow {
  let root = window
  const seen = new Set<string>([root.id])
  while (root.parent !== undefined) {
    const parent = windows.find((w) => w.id === root.parent)
    if (parent === undefined || seen.has(parent.id)) {
      break
    }
    seen.add(parent.id)
    root = parent
  }
  return root
}

/**
 * Map a rect through the transform that takes `from` onto `to` (scale and translate). Child windows follow their
 * parent's minimize/restore/maximize animation this way.
 */
export function mapRect(rect: Rect, from: Rect, to: Rect): Rect {
  const scaleX = from.width > 0 ? to.width / from.width : 1
  const scaleY = from.height > 0 ? to.height / from.height : 1
  return {
    x: to.x + (rect.x - from.x) * scaleX,
    y: to.y + (rect.y - from.y) * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY,
  }
}
