/**
 * Patch planning: which patches to queue for a surface's damage. Pure, no Node or native dependencies. (A surface's
 * priority class, and whether it may go lossy, are traffic policy's: see @nebula/traffic-policy.)
 */
import type { PatchShape, Rect } from '@nebula/session-contracts'
import { boundingBox, clip, disjoint, splitRect, subtract } from './region.js'

/** Max pixels per patch, larger areas are split. */
export const MAX_PATCH_PIXELS = 64 * 1024
/** A commit's damage in more pieces than this is sent as its bounding box instead (fewer, larger patches). */
export const MAX_PATCH_RECTS = 32

/**
 * The patches to queue for new damage.
 *
 * `queued` are patches that are queued but whose pixels haven't been read yet: they will pick up the latest content
 * when they are encoded, so the parts of the damage they cover are left out (possibly all of it). Patches that already
 * started encoding must not be passed here, their pixels are fixed and may be stale.
 */
export function planPatches(
  damage: Rect[],
  queued: Rect[],
  bounds: Rect,
  maxPixels = MAX_PATCH_PIXELS,
  maxRects = MAX_PATCH_RECTS,
  shape: PatchShape = 'bands',
): Rect[] {
  let region = subtract(disjoint(clip(damage, bounds)), queued)
  if (region.length > maxRects) {
    const box = boundingBox(region)
    region = box ? subtract([box], queued) : []
  }
  return region.flatMap((rect) => splitRect(rect, maxPixels, shape))
}
