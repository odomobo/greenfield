/**
 * The window menu's Move and Size (Windows' keyboard-and-pointer move and size modes): the pure parts. The interaction
 * itself runs in desktop.ts, on the same drag code as the interactions apps ask for.
 */

// xdg_toplevel resize edges
export const EDGE_TOP = 1
export const EDGE_BOTTOM = 2
export const EDGE_LEFT = 4
export const EDGE_RIGHT = 8

type Point = { x: number; y: number }
type Rect = { x: number; y: number; width: number; height: number }

/** How far an arrow key nudges, in pixels (with Shift: one pixel). */
export const NUDGE_STEP = 10

/**
 * The edges of a window that Size moves for a pointer at `point`: the sides of the window's outer thirds the pointer is
 * in (a corner when it's in a corner third), else the nearest edge.
 */
export function nearestEdges(rect: Rect, point: Point): number {
  let edges = 0
  if (point.x < rect.x + rect.width / 3) {
    edges |= EDGE_LEFT
  } else if (point.x > rect.x + (rect.width * 2) / 3) {
    edges |= EDGE_RIGHT
  }
  if (point.y < rect.y + rect.height / 3) {
    edges |= EDGE_TOP
  } else if (point.y > rect.y + (rect.height * 2) / 3) {
    edges |= EDGE_BOTTOM
  }
  if (edges !== 0) {
    return edges
  }
  const distances: [number, number][] = [
    [point.x - rect.x, EDGE_LEFT],
    [rect.x + rect.width - point.x, EDGE_RIGHT],
    [point.y - rect.y, EDGE_TOP],
    [rect.y + rect.height - point.y, EDGE_BOTTOM],
  ]
  return distances.reduce((best, candidate) => (candidate[0] < best[0] ? candidate : best))[1]
}

/** The arrow key's direction, or undefined for other keys. */
export function arrowOf(key: string): Point | undefined {
  switch (key) {
    case 'ArrowLeft':
      return { x: -1, y: 0 }
    case 'ArrowRight':
      return { x: 1, y: 0 }
    case 'ArrowUp':
      return { x: 0, y: -1 }
    case 'ArrowDown':
      return { x: 0, y: 1 }
  }
  return undefined
}

/** The edge an arrow key picks in Size: the side it points to. */
export function edgeOfArrow(arrow: Point): number {
  return arrow.x < 0 ? EDGE_LEFT : arrow.x > 0 ? EDGE_RIGHT : arrow.y < 0 ? EDGE_TOP : EDGE_BOTTOM
}

/**
 * The edges after an arrow key in Size. The first key picks its side (replacing the pointer's choice); a key along the
 * other axis then adds its side (a corner); a key along the same axis keeps the edge (it moves it).
 */
export function edgesAfterArrow(edges: number, keyChosen: boolean, arrow: Point): number {
  const picked = edgeOfArrow(arrow)
  if (!keyChosen) {
    return picked
  }
  const horizontal = EDGE_LEFT | EDGE_RIGHT
  const vertical = EDGE_TOP | EDGE_BOTTOM
  const axis = picked & horizontal ? horizontal : vertical
  return edges & axis ? edges : edges | picked
}

/** The CSS cursor of a Size interaction: its edges' resize cursor. */
export function resizeCursor(edges: number): string {
  const horizontal = edges & EDGE_LEFT ? 'w' : edges & EDGE_RIGHT ? 'e' : ''
  const vertical = edges & EDGE_TOP ? 'n' : edges & EDGE_BOTTOM ? 's' : ''
  return `${vertical}${horizontal}-resize`
}
