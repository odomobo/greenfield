/**
 * The per-surface encoding policy (see "Encoding policy" in ROADMAP.md). Pure, no Node or native dependencies.
 *
 * A surface has a priority class: normal, or streaming when it is relentless (it keeps sending new data before its old
 * data has gone out). Whether a surface is sent as video or as PNG patches is decided separately, by the surface
 * encoder (video only for streaming surfaces, with a hardware encoder, when the surface isn't small).
 */
import { boundingBox, clip, disjoint, Rect, splitRect, subtract } from './region.js'

export type SurfaceClass = 'normal' | 'streaming'

/** The backlog fraction is measured over this sliding period. A surface younger than this can't be promoted. */
export const CLASS_PERIOD_MS = 1500
/** Normal -> streaming when the share of the period spent backlogged is at least this. */
export const PROMOTE_FRACTION = 0.85
/** Streaming -> normal once the fraction has stayed below this ... */
export const DEMOTE_FRACTION = 0.4
/** ... for this long without interruption. */
export const DEMOTE_HOLD_MS = 2000
/** Max pixels per PNG patch, larger areas are split. */
export const MAX_PATCH_PIXELS = 64 * 1024
/** A commit's damage in more pieces than this is sent as its bounding box instead (fewer, larger patches). */
export const MAX_PATCH_RECTS = 32

/**
 * Measures how relentless a surface is: the share of the last period it spent backlogged (committing new damage while
 * earlier damage hasn't gone out yet, see SurfaceEncoder), and decides its class from that. Times are in ms.
 */
export class RelentlessMeter {
  /** finished backlogged intervals within (or just before) the period, oldest first */
  private intervals: { start: number; end: number }[] = []
  private backloggedSince?: number
  private belowSince?: number
  private _class: SurfaceClass = 'normal'

  /**
   * @param startTime when the surface appeared; it can't be promoted before one whole period has passed
   */
  constructor(
    private readonly startTime = -Infinity,
    private readonly periodMs = CLASS_PERIOD_MS,
  ) {}

  get surfaceClass(): SurfaceClass {
    return this._class
  }

  get backlogged(): boolean {
    return this.backloggedSince !== undefined
  }

  /** Idempotent: nothing changes if the surface is backlogged already. */
  markBackloggedStart(now: number): void {
    this.backloggedSince ??= now
  }

  /** Idempotent. */
  markBackloggedEnd(now: number): void {
    if (this.backloggedSince !== undefined) {
      this.intervals.push({ start: this.backloggedSince, end: now })
      this.backloggedSince = undefined
    }
  }

  /** The share (0 to 1) of the last period that was spent backlogged. */
  fraction(now: number): number {
    const from = now - this.periodMs
    this.intervals = this.intervals.filter((interval) => interval.end > from)
    let backlogged = 0
    for (const { start, end } of this.intervals) {
      backlogged += end - Math.max(start, from)
    }
    if (this.backloggedSince !== undefined) {
      backlogged += now - Math.max(this.backloggedSince, from)
    }
    return Math.min(1, Math.max(0, backlogged / this.periodMs))
  }

  /**
   * Decide the class at `now` (called on every commit and on a regular tick). Returns the (possibly new) class.
   */
  evaluate(now: number): SurfaceClass {
    const fraction = this.fraction(now)
    if (this._class === 'normal') {
      if (now - this.startTime >= this.periodMs && fraction >= PROMOTE_FRACTION) {
        this._class = 'streaming'
        this.belowSince = undefined
      }
    } else if (fraction < DEMOTE_FRACTION) {
      this.belowSince ??= now
      if (now - this.belowSince >= DEMOTE_HOLD_MS) {
        this._class = 'normal'
        this.belowSince = undefined
      }
    } else {
      this.belowSince = undefined
    }
    return this._class
  }
}

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
): Rect[] {
  let region = subtract(disjoint(clip(damage, bounds)), queued)
  if (region.length > maxRects) {
    const box = boundingBox(region)
    region = box ? subtract([box], queued) : []
  }
  return region.flatMap((rect) => splitRect(rect, maxPixels))
}
