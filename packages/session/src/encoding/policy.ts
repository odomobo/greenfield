/**
 * The per-surface encoding policy (see "Encoding policy" in ROADMAP.md). Pure, no Node or native dependencies.
 *
 * A surface has a priority class: normal, or streaming when it is relentless (it keeps sending new data before its old
 * data has gone out). Whether a surface is sent as video or as patches is decided separately, by the surface
 * encoder (video only for streaming surfaces, with a hardware encoder, when the surface isn't small).
 */
import { boundingBox, clip, disjoint, PatchShape, Rect, splitRect, subtract } from './region.js'

export type SurfaceClass = 'normal' | 'streaming'
/**
 * The transport's send tiers (deficit round-robin, see ViewerTransport.ts): the two classes, and below them settling,
 * the lossless resend of a surface's lossy areas.
 */
export type SendTier = SurfaceClass | 'settle'

/** Surfaces are judged on fixed, back-to-back periods of this length. */
export const CLASS_PERIOD_MS = 750
/**
 * Normal -> streaming at the end of a period in which the surface was backlogged at least this share of the time. Also
 * the busy share the previous period needs for a commit to count as backlogged.
 */
export const PROMOTE_FRACTION = 0.6
/** Streaming -> normal at the end of a period in which the backlogged share was below this. */
export const DEMOTE_FRACTION = 0.15
/**
 * Burst promotion and lossy mode (see SurfaceEncoder.ts, bandwidth.ts): the predicted backlog, in time at the link's
 * bandwidth, over which normal surfaces are promoted (the largest backlog first) and streaming surfaces go lossy.
 */
export const BURST_MS = 200
/** Max pixels per patch, larger areas are split. */
export const MAX_PATCH_PIXELS = 64 * 1024
/** A commit's damage in more pieces than this is sent as its bounding box instead (fewer, larger patches). */
export const MAX_PATCH_RECTS = 32

export type PeriodFractions = { busy: number; backlogged: number }

/**
 * Measures how relentless a surface is, on discrete periods, and decides its class from that. Times are in ms.
 *
 * - Busy: the surface has unsent work (`markBusyStart` / `markBusyEnd`).
 * - Backlogged: a commit with new damage (`markBackloggedStart`) counts if the previous completed period's busy share
 *   was at least PROMOTE_FRACTION; the surface then stays backlogged until it is no longer busy. Backlogged implies busy.
 *
 * At the end of each period its two shares are kept and the counters start again. Only whole periods count: the time
 * measure promotes only once two have completed. A surface can also be promoted at once (`promote`, a burst). It is
 * demoted when the last completed period was quiet (backlogged under DEMOTE_FRACTION) and `canDemote` says it may be
 * (no damage left, fully settled), at that period's end or any time later.
 */
export class RelentlessMeter {
  private periodStart: number
  private busySince?: number
  private backloggedSince?: number
  private busyMs = 0
  private backloggedMs = 0
  private previous?: PeriodFractions
  private completed = 0
  private _class: SurfaceClass = 'normal'

  constructor(
    startTime = 0,
    private readonly periodMs = CLASS_PERIOD_MS,
    private readonly canDemote: () => boolean = () => true,
  ) {
    this.periodStart = startTime
  }

  get surfaceClass(): SurfaceClass {
    return this._class
  }

  get busy(): boolean {
    return this.busySince !== undefined
  }

  get backlogged(): boolean {
    return this.backloggedSince !== undefined
  }

  /** The shares of the last completed period, if there is one. */
  get lastPeriod(): PeriodFractions | undefined {
    return this.previous
  }

  markBusyStart(now: number): void {
    this.advance(now)
    this.busySince ??= now
  }

  /** The surface has no unsent work anymore: it is not busy, and so not backlogged. */
  markBusyEnd(now: number): void {
    this.advance(now)
    if (this.backloggedSince !== undefined) {
      this.backloggedMs += now - this.backloggedSince
      this.backloggedSince = undefined
    }
    if (this.busySince !== undefined) {
      this.busyMs += now - this.busySince
      this.busySince = undefined
    }
  }

  /**
   * A commit with non-empty damage arrived (its work makes the surface busy): it becomes backlogged if the previous
   * completed period was busy enough. Idempotent.
   */
  markBackloggedStart(now: number): void {
    this.advance(now)
    if (this.previous !== undefined && this.previous.busy >= PROMOTE_FRACTION) {
      this.busySince ??= now
      this.backloggedSince ??= now
    }
  }

  /** Close the periods that ended by `now` and decide the class. Returns the (possibly new) class. */
  evaluate(now: number): SurfaceClass {
    this.advance(now)
    this.demoteIfQuiet()
    return this._class
  }

  /** Streaming from now on (a burst: a backlog the link needs too long for). */
  promote(): void {
    this._class = 'streaming'
  }

  private advance(now: number) {
    while (now >= this.periodStart + this.periodMs) {
      const end = this.periodStart + this.periodMs
      const busy = this.busyMs + (this.busySince !== undefined ? end - this.busySince : 0)
      const backlogged = this.backloggedMs + (this.backloggedSince !== undefined ? end - this.backloggedSince : 0)
      this.previous = { busy: busy / this.periodMs, backlogged: backlogged / this.periodMs }
      this.completed++
      this.periodStart = end
      this.busyMs = 0
      this.backloggedMs = 0
      if (this.busySince !== undefined) {
        this.busySince = end
      }
      if (this.backloggedSince !== undefined) {
        this.backloggedSince = end
      }
      if (this.completed >= 2) {
        if (this._class === 'normal' && this.previous.backlogged >= PROMOTE_FRACTION) {
          this._class = 'streaming'
        } else {
          this.demoteIfQuiet()
        }
      }
    }
  }

  private demoteIfQuiet() {
    if (this._class === 'streaming' && (this.previous?.backlogged ?? 0) < DEMOTE_FRACTION && this.canDemote()) {
      this._class = 'normal'
    }
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
  shape: PatchShape = 'bands',
): Rect[] {
  let region = subtract(disjoint(clip(damage, bounds)), queued)
  if (region.length > maxRects) {
    const box = boundingBox(region)
    region = box ? subtract([box], queued) : []
  }
  return region.flatMap((rect) => splitRect(rect, maxPixels, shape))
}
