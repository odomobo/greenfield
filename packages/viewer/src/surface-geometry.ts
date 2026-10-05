/**
 * Pure helpers for how a surface's content is laid onto its canvas (no DOM), so they can be unit tested in Node.
 */

import type { Rect } from './windows'

export type Size = { width: number; height: number }

/**
 * Where the image is in a decoded video frame. The encoder pads the image to its encoded size at the top left, so the
 * image is in the bottom right corner of the encoded area (which is the top left part of the decoded frame).
 */
export function videoSourceRect(size: Size, encodedSize: Size): Rect {
  return {
    x: encodedSize.width - size.width,
    y: encodedSize.height - size.height,
    width: size.width,
    height: size.height,
  }
}

/**
 * Whether an image shown at `shown` (CSS pixels, a position and size) maps each of its pixels onto a whole number of
 * device pixels. Such an image is shown without interpolation (e.g. an unstretched window at a pixel ratio of 2):
 * interpolating would blur text.
 */
export function isWholePixelScale(shown: Rect, image: Size, pixelRatio: number): boolean {
  if (image.width <= 0 || image.height <= 0) {
    return false
  }
  const isWhole = (value: number) => Math.abs(value - Math.round(value)) < 1e-6
  const scaleX = (Math.abs(shown.width) * pixelRatio) / image.width
  const scaleY = (Math.abs(shown.height) * pixelRatio) / image.height
  return (
    scaleX >= 1 &&
    scaleY >= 1 &&
    isWhole(scaleX) &&
    isWhole(scaleY) &&
    isWhole(shown.x * pixelRatio) &&
    isWhole(shown.y * pixelRatio)
  )
}

/** A CSS position rounded to a whole device pixel, so unstretched content isn't blurred by a half pixel offset. */
export function snapToDevicePixel(value: number, pixelRatio: number): number {
  return Math.round(value * pixelRatio) / pixelRatio
}

/** A CSS clip-path showing only the part of a surface (at `rect`) inside `area`, both in the window's coordinates. */
export function clipTo(rect: Rect, area: Rect): string {
  const top = Math.max(0, area.y - rect.y)
  const left = Math.max(0, area.x - rect.x)
  const bottom = Math.max(0, rect.y + rect.height - (area.y + area.height))
  const right = Math.max(0, rect.x + rect.width - (area.x + area.width))
  return top || right || bottom || left ? `inset(${top}px ${right}px ${bottom}px ${left}px)` : ''
}
