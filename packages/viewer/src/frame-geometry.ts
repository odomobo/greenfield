/**
 * Pure geometry of window frames (no DOM), so it can be unit tested in Node. The frame is outside the app's window
 * geometry (see the scene protocol): everything the viewer reasons about in geometry rects stays that way, and these
 * helpers add the frame where a window's outer rectangle matters.
 */
import type { FrameInsets } from './protocol'
import type { Rect } from './windows'

type Point = { x: number; y: number }
type Size = { width: number; height: number }

/** The width of the invisible resize margin outside the visible border, in CSS pixels (Windows 11 has about 8). */
export const FRAME_GRAB = 8

/** A window geometry rect with its frame. */
export function outerRect(rect: Rect, insets: FrameInsets): Rect {
  return {
    x: rect.x - insets.left,
    y: rect.y - insets.top,
    width: rect.width + insets.left + insets.right,
    height: rect.height + insets.top + insets.bottom,
  }
}

/**
 * A position for a window (the origin of its surfaces' coordinates) such that at least `minVisible` of its outer
 * rectangle is inside the output, and its outer top edge (the title bar's, for a decorated window) isn't above the
 * output: that is the taskbar's edge, and a title bar under it couldn't be grabbed.
 */
export function keepOnScreen(
  geometry: Rect,
  insets: FrameInsets,
  position: Point,
  output: Size,
  minVisible: number,
): Point {
  if (output.width <= 0 || output.height <= 0) {
    return position
  }
  const outer = outerRect(geometry, insets)
  const visibleWidth = Math.min(minVisible, outer.width)
  const visibleHeight = Math.min(minVisible, outer.height)
  let x = position.x + outer.x
  let y = position.y + outer.y
  x = Math.max(visibleWidth - outer.width, Math.min(x, output.width - visibleWidth))
  y = Math.max(0, Math.min(y, output.height - visibleHeight))
  return { x: Math.round(x - outer.x), y: Math.round(y - outer.y) }
}

/**
 * Where a window's frame element goes. The element's box is the outer rectangle, in the window element's coordinates
 * (which the window's transform may stretch).
 *
 * The frame is drawn at its real size (a title bar must not stretch while a window is being resized, or when it grows
 * to the output while maximizing), so while the window's transform stretches by (scaleX, scaleY) the frame undoes the
 * stretch: its box has the real size of the shown geometry plus the insets, placed at the shown geometry's top left
 * minus the insets. `stretched` (minimizing and restoring: the whole window image shrinks to the taskbar) lets the frame
 * stretch with the window instead.
 */
export function frameBox(
  geometry: Rect,
  insets: FrameInsets,
  scaleX: number,
  scaleY: number,
  stretched: boolean,
): { left: number; top: number; width: number; height: number; transform: string } {
  const outer = outerRect(geometry, insets)
  if (stretched || (scaleX === 1 && scaleY === 1)) {
    return { left: outer.x, top: outer.y, width: outer.width, height: outer.height, transform: '' }
  }
  return {
    left: 0,
    top: 0,
    width: geometry.width * scaleX + insets.left + insets.right,
    height: geometry.height * scaleY + insets.top + insets.bottom,
    transform: `scale(${1 / scaleX}, ${1 / scaleY}) translate(${geometry.x * scaleX - insets.left}px, ${geometry.y * scaleY - insets.top}px)`,
  }
}
