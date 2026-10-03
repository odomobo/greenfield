/**
 * The per-surface encoding policy (see "Encoding policy" in ROADMAP.md). Pure, no Node or native dependencies.
 *
 * A surface is either in fast mode (whole surface as H.264 video, damage only decides whether a frame is sent) or in
 * slow mode (lossless PNG patches of the damaged areas). Which one follows from how many pixels it changes per second.
 */
import { boundingBox, clip, disjoint, Rect, splitRect, subtract } from './region.js'

export type EncodingMode = 'fast' | 'slow'

/** Length of the sliding period the changed pixels per second are measured over. */
export const MEASURE_PERIOD_MS = 1500
/** Slow -> fast above this many changed pixels per second. */
export const FAST_ABOVE_PIXELS_PER_SECOND = 1_500_000
/** Fast -> slow below this many changed pixels per second. */
export const SLOW_BELOW_PIXELS_PER_SECOND = 500_000
/**
 * New surfaces start in fast mode and stay in it at least this long, so the first decision is based on some data
 * (their first frame alone is always ignored as the largest damage).
 */
export const INITIAL_FAST_MS = 300
/** Max pixels per PNG patch, larger areas are split. */
export const MAX_PATCH_PIXELS = 64 * 1024
/** A commit's damage in more pieces than this is sent as its bounding box instead (fewer, larger patches). */
export const MAX_PATCH_RECTS = 32

/**
 * Changed pixels per second of one surface over a sliding period. The single largest damage within the period is
 * ignored, so a one-off full repaint (a new window, an app switching to another view) doesn't make a surface look busy,
 * and every quiet surface can make an occasional large update.
 */
export class DamageMeter {
  private samples: { time: number; pixels: number }[] = []

  /**
   * @param startTime when the surface appeared: until a full period has passed, the rate is measured over the time
   * since then instead (but at least INITIAL_FAST_MS), so a young surface isn't judged by mostly empty history.
   */
  constructor(
    private readonly startTime = -Infinity,
    private readonly periodMs = MEASURE_PERIOD_MS,
  ) {}

  record(time: number, pixels: number): void {
    if (pixels > 0) {
      this.samples.push({ time, pixels })
    }
  }

  pixelsPerSecond(now: number): number {
    const since = now - this.periodMs
    this.samples = this.samples.filter((sample) => sample.time > since)
    let sum = 0
    let largest = 0
    for (const { pixels } of this.samples) {
      sum += pixels
      largest = Math.max(largest, pixels)
    }
    const measuredMs = Math.min(this.periodMs, Math.max(INITIAL_FAST_MS, now - this.startTime))
    return ((sum - largest) * 1000) / measuredMs
  }
}

/**
 * The mode a surface should be in, with hysteresis between the two thresholds.
 */
export function nextMode(
  current: EncodingMode,
  pixelsPerSecond: number,
  thresholds = { fastAbove: FAST_ABOVE_PIXELS_PER_SECOND, slowBelow: SLOW_BELOW_PIXELS_PER_SECOND },
): EncodingMode {
  if (current === 'fast' && pixelsPerSecond < thresholds.slowBelow) {
    return 'slow'
  }
  if (current === 'slow' && pixelsPerSecond > thresholds.fastAbove) {
    return 'fast'
  }
  return current
}

/**
 * The patches to queue for new damage in slow mode.
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
): Rect[] {
  let region = subtract(disjoint(clip(damage, bounds)), queued)
  if (region.length > maxRects) {
    const box = boundingBox(region)
    region = box ? subtract([box], queued) : []
  }
  return region.flatMap((rect) => splitRect(rect, maxPixels))
}
