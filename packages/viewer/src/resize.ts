/**
 * Interactive resizing: the rectangle a drag shows. Pure; the interaction itself runs in desktop.ts. Nothing is sent to
 * the app while dragging; the final size is sent once on release.
 */
import { EDGE_BOTTOM, EDGE_LEFT, EDGE_RIGHT, EDGE_TOP } from './window-menu.js'

type Rect = { x: number; y: number; width: number; height: number }

/** Size limits in window geometry pixels; 0 or undefined is unbounded (as in xdg-shell). */
export type SizeLimits = { minWidth?: number; minHeight?: number; maxWidth?: number; maxHeight?: number }

/** Clamp one dimension to [min, max] (0/undefined: unbounded); never below 1. A min above the max wins. */
export function clampSize(size: number, min = 0, max = 0): number {
  let result = size
  if (max > 0 && result > max) {
    result = max
  }
  if (min > 0 && result < min) {
    result = min
  }
  return Math.max(1, result)
}

/**
 * The rect a resize drag shows: the edges being dragged move by (dx, dy) from `start`, the opposite edges stay put,
 * and the size stays within the window's limits (the dragged edge stops, the fixed edges don't move).
 */
export function resizedRect(start: Rect, edges: number, dx: number, dy: number, limits: SizeLimits = {}): Rect {
  let { x, y, width, height } = start
  if (edges & EDGE_RIGHT) {
    width = clampSize(Math.round(start.width + dx), limits.minWidth, limits.maxWidth)
  } else if (edges & EDGE_LEFT) {
    width = clampSize(Math.round(start.width - dx), limits.minWidth, limits.maxWidth)
    x = start.x + start.width - width
  }
  if (edges & EDGE_BOTTOM) {
    height = clampSize(Math.round(start.height + dy), limits.minHeight, limits.maxHeight)
  } else if (edges & EDGE_TOP) {
    height = clampSize(Math.round(start.height - dy), limits.minHeight, limits.maxHeight)
    y = start.y + start.height - height
  }
  return { x, y, width, height }
}
